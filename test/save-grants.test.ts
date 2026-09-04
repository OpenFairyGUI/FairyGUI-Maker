import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { BackendRuntime } from "@openfairygui/backend"
import { createNodeBackendRuntime } from "@openfairygui/backend/node"
import { Document } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"
import { liftDocumentToUamProject } from "@openfairygui/core/uam"
import { startMakerHost } from "../src/server/index"
import { HostSaveGrants, MAX_SAVE_APPROVALS, SAVE_GRANT_TTL_MS, type SaveApproval } from "../src/server/save-grants"

function errorCode(result: any) { assert.equal(result.ok, false); return result.error.code as string }
function approval(result: any): SaveApproval {
  assert.equal(errorCode(result), "save_approval_required")
  assert.equal(result.error.approvalPath, "/#save-approvals")
  return result.error.approval
}

test("save grants bind exact operations, expire, revoke, invalidate and stay bounded", async (t) => {
  const runtime = new BackendRuntime()
  const project = liftDocumentToUamProject(new Document())
  assert.ok(runtime.openProjectSession({ project, sessionId: "one" }).ok)
  assert.ok(runtime.openProjectSession({ project, sessionId: "two" }).ok)
  const grants = new HostSaveGrants(runtime)
  const save = t.mock.method(runtime, "saveSession", async (input: Parameters<BackendRuntime["saveSession"]>[0]) => runtime.getSession(input))
  const input = { sessionId: "one", expectedRevision: 0 }
  const first = approval(grants.execute("saveSession", input))
  assert.equal(approval(grants.execute("saveSession", input)).approvalRequestId, first.approvalRequestId)
  assert.equal(approval(grants.execute("saveSession", { ...input, force: false })).approvalRequestId, first.approvalRequestId)
  assert.equal(save.mock.callCount(), 0)
  assert.ok("approval" in grants.decide(first.approvalRequestId, "approve"))
  for (const changed of [{ ...input, sessionId: "two" }, { ...input, force: true }, { ...input, mode: "materializeCleanSession" }, { ...input, targetPath: "another.fairy" }]) {
    assert.notEqual(approval(grants.execute("saveSession", changed)).approvalRequestId, first.approvalRequestId)
  }
  const materialize = approval(grants.execute("materializeSession", input))
  assert.notEqual(materialize.operationDigest, first.operationDigest)
  assert.notEqual(approval(grants.execute("materializeSession", { ...input, reason: "different operation" })).operationDigest, materialize.operationDigest)
  assert.equal(errorCode(grants.execute("saveSession", { sessionId: "one" })), "save_input_invalid")
  assert.equal(errorCode(grants.execute("saveSession", { ...input, expectedRevision: 1 })), "save_revision_stale")
  assert.equal(errorCode(grants.execute("saveSession", { ...input, fileSystem: {} })), "save_input_invalid")
  assert.equal(errorCode(grants.execute("materializeSession", { ...input, storage: {} })), "save_input_invalid")
  assert.equal(errorCode(grants.execute("materializeSession", { ...input, reason: "x".repeat(1_001) })), "save_input_invalid")
  // Reading or modifying a returned view cannot create authority.
  grants.list().find(({ approvalRequestId }) => approvalRequestId === materialize.approvalRequestId)!.status = "approved"
  assert.equal(grants.list().find(({ approvalRequestId }) => approvalRequestId === materialize.approvalRequestId)!.status, "pending")
  const attempts = await Promise.all([grants.execute("saveSession", input), grants.execute("saveSession", input)])
  assert.equal(attempts.filter((result) => result.ok).length, 1)
  assert.equal(save.mock.callCount(), 1)

  const closingInput = { sessionId: "two", expectedRevision: 0 }
  const closingRequest = approval(grants.execute("saveSession", closingInput))
  grants.decide(closingRequest.approvalRequestId, "approve")
  grants.beginClose("two")
  grants.beginClose("two")
  assert.equal(errorCode(grants.execute("saveSession", closingInput)), "save_session_closing")
  grants.endClose("two")
  assert.equal(errorCode(grants.execute("saveSession", closingInput)), "save_session_closing")
  grants.endClose("two")
  assert.notEqual(approval(grants.execute("saveSession", closingInput)).approvalRequestId, closingRequest.approvalRequestId)
  runtime.openProjectSession({ project, sessionId: "long-target", canonicalProjectPath: "x".repeat(4_097) })
  assert.equal(errorCode(grants.execute("saveSession", { sessionId: "long-target", expectedRevision: 0 })), "save_target_invalid")
  assert.equal(grants.decide(first.approvalRequestId, "approve").status, 409)
  assert.equal(grants.decide(first.approvalRequestId, "revoke").status, 409)
  const retry = approval(attempts.find((result) => !result.ok))
  grants.decide(retry.approvalRequestId, "approve")
  grants.decide(retry.approvalRequestId, "revoke")
  assert.notEqual(approval(grants.execute("saveSession", input)).approvalRequestId, retry.approvalRequestId)
  grants.decide(materialize.approvalRequestId, "reject")
  assert.equal(grants.decide(materialize.approvalRequestId, "approve").status, 409)
  assert.equal(grants.decide("missing", "approve").status, 404)

  const pending = grants.list().find((request) => request.status === "pending")!
  grants.decide(pending.approvalRequestId, "approve")
  const now = Date.now()
  const clock = t.mock.method(Date, "now", () => now + SAVE_GRANT_TTL_MS)
  assert.ok(grants.list().every((request) => !["pending", "approved"].includes(request.status)))
  assert.equal(grants.decide(pending.approvalRequestId, "approve").status, 409)
  assert.notEqual(approval(grants.execute("saveSession", input)).approvalRequestId, pending.approvalRequestId)
  clock.mock.restore()
  const stale = approval(grants.execute("saveSession", { ...input, force: true }))
  grants.decide(stale.approvalRequestId, "approve")
  assert.ok((await runtime.applyTransaction({ sessionId: "one", expectedRevision: 0, operations: [{ kind: "addBranch", branch: "edited" }] })).ok)
  assert.equal(grants.list().find(({ approvalRequestId }) => approvalRequestId === stale.approvalRequestId)!.status, "stale")
  assert.equal(errorCode(grants.execute("saveSession", { ...input, force: true })), "save_revision_stale")
  assert.equal(save.mock.callCount(), 1)

  const bounded = new HostSaveGrants(runtime)
  for (let i = 0; i < MAX_SAVE_APPROVALS; i++) approval(bounded.execute("materializeSession", { ...input, expectedRevision: 1, reason: String(i) }))
  assert.equal(errorCode(bounded.execute("materializeSession", { ...input, expectedRevision: 1, reason: "overflow" })), "save_approval_limit")
  const expired = bounded.list()[0]
  bounded.decide(expired.approvalRequestId, "reject")
  approval(bounded.execute("materializeSession", { ...input, expectedRevision: 1, reason: "room after rejection" }))
  assert.equal(bounded.list().length, MAX_SAVE_APPROVALS)
  bounded.close()
  assert.equal(bounded.list().length, 0)
})

test("a failed or throwing backend attempt consumes its grant and never auto-retries", async (t) => {
  const runtime = new BackendRuntime()
  runtime.openProjectSession({ project: liftDocumentToUamProject(new Document()), sessionId: "failure" })
  const grants = new HostSaveGrants(runtime)
  const input = { sessionId: "failure", expectedRevision: 0 }
  const first = approval(grants.execute("materializeSession", input))
  grants.decide(first.approvalRequestId, "approve")
  assert.equal(errorCode(await grants.execute("materializeSession", input)), "capability_unavailable")
  assert.equal(grants.list()[0].status, "consumed")
  assert.notEqual(approval(grants.execute("materializeSession", input)).approvalRequestId, first.approvalRequestId)
  const throwing = approval(grants.execute("saveSession", input))
  grants.decide(throwing.approvalRequestId, "approve")
  const saved = t.mock.method(runtime, "saveSession", () => { throw new Error("injected write failure") })
  assert.throws(() => grants.execute("saveSession", input), /injected write failure/)
  approval(grants.execute("saveSession", input))
  assert.equal(saved.mock.callCount(), 1)
})

test("an edit already queued in the backend cannot be saved using an older approved revision", async () => {
  const runtime = new BackendRuntime()
  runtime.openProjectSession({ project: liftDocumentToUamProject(new Document()), sessionId: "queued" })
  const grants = new HostSaveGrants(runtime)
  const input = { sessionId: "queued", expectedRevision: 0 }
  const request = approval(grants.execute("materializeSession", input))
  grants.decide(request.approvalRequestId, "approve")
  const edit = runtime.applyTransaction({ ...input, operations: [{ kind: "addBranch", branch: "queued-edit" }] })
  const save = grants.execute("materializeSession", input)
  assert.equal(grants.list()[0].status, "consumed")
  assert.ok((await edit).ok)
  assert.equal(errorCode(await save), "stale_write")
  const session = runtime.getSession(input)
  assert.ok(session.ok)
  assert.equal(session.data.lastSavedRevision, 0)
})

test("real Host MCP saves require independent owner approval and preserve backend disk/CAS guards", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "maker-save-grants-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "project"))
  const fairyPath = path.join(root, "project", "Demo.fairy")
  const document = new Document()
  document.getRoot().setProjectId("save-grant-test")
  document.createPackage("Demo").setId("DEMO0001").addResource(document.createComponent("Before").setId("MAIN0001").setSize(100, 100)
    .addChild(document.createGTextField("label").setId("TEXT0001").setSize(100, 40).setText("Before")))
  await new NodeIO().writeProject(document, fairyPath)
  const componentPath = path.join(root, "project", "assets", "Demo", "Before.xml")
  const original = await readFile(componentPath)
  const runtime = createNodeBackendRuntime({ allowedProjectRoots: [root] })
  const token = "save-grant-mcp-token-with-24-chars"
  const host = await startMakerHost({ port: 0, token, runtime, dataDir: path.join(root, "host-data") })
  const client = new Client({ name: "save-grants-test", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(`${host.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  let sessionId = ""
  const call = async (method: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: `openfairygui_backend_${method}`, arguments: args })
    const backend = (result.structuredContent as { backendResult?: any } | undefined)?.backendResult
    assert.ok(backend, JSON.stringify(result))
    assert.equal(Boolean(result.isError), !backend.ok)
    return backend
  }
  const decision = (id: string, key?: string, action = "approve", extraHeaders: Record<string, string> = {}) => fetch(`${host.origin}/api/save-approvals/${id}/decision`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(key ? { "x-maker-approval-token": key } : {}), ...extraHeaders }, body: JSON.stringify({ decision: action }),
  })
  const list = async () => (await (await fetch(`${host.origin}/api/save-approvals`, { headers: { Authorization: `Bearer ${token}` } })).json()).approvals as SaveApproval[]
  try {
    assert.notEqual(host.approvalToken, host.token)
    await client.connect(transport)
    assert.match(client.getInstructions()!, /one-time Host Save Grant/)
    const tools = await client.listTools()
    assert.ok(!tools.tools.some(({ name }) => /approve|restore/.test(name)))
    const opened = await call("open_session", { projectPath: fairyPath })
    assert.ok(opened.ok, JSON.stringify(opened))
    sessionId = opened.data.sessionId
    assert.ok((await call("apply_transaction", { sessionId, expectedRevision: 0, operations: [{ kind: "renameResource", selector: { packageId: "DEMO0001", resourceId: "MAIN0001" }, newName: "After" }] })).ok)
    const input = { sessionId, expectedRevision: 1 }
    const first = approval(await call("save_session", input))
    assert.deepEqual(await readFile(componentPath), original)
    for (const key of [undefined, token, "wrong-owner-key-long-enough"]) assert.equal((await decision(first.approvalRequestId, key)).status, 403)
    const bootstrap = await fetch(`${host.origin}/?token=${token}`, { redirect: "manual" })
    const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]
    assert.equal((await decision(first.approvalRequestId, undefined, "approve", { Cookie: cookie, Origin: host.origin, "Sec-Fetch-Site": "same-origin" })).status, 403)
    assert.equal((await decision(first.approvalRequestId, host.approvalToken, "approve", { Origin: "https://evil.invalid" })).status, 403)
    assert.equal((await fetch(`${host.origin}/api/save-approvals/${first.approvalRequestId}/decision`, { method: "POST", headers: { "x-maker-approval-token": host.approvalToken, "Content-Type": "application/json" }, body: '{"decision":"approve"}' })).status, 401)
    assert.equal((await decision(first.approvalRequestId, host.approvalToken)).status, 200)
    assert.deepEqual(await readFile(componentPath), original, "approval alone must not execute a write")
    assert.notEqual(approval(await call("save_session", { ...input, force: true })).approvalRequestId, first.approvalRequestId)
    const simultaneous = await Promise.all([call("save_session", input), call("save_session", input)])
    assert.equal(simultaneous.filter((result) => result.ok).length, 1)
    await assert.rejects(readFile(componentPath), { code: "ENOENT" })
    assert.ok((await readFile(path.join(root, "project", "assets", "Demo", "After.xml"))).length)
    assert.equal((await list()).find(({ approvalRequestId }) => approvalRequestId === first.approvalRequestId)!.status, "consumed")
    assert.equal((await decision(first.approvalRequestId, host.approvalToken)).status, 409)

    for (const options of [{ force: true }, { mode: "materializeCleanSession" }]) {
      const request = approval(await call("save_session", { ...input, ...options }))
      await decision(request.approvalRequestId, host.approvalToken)
      assert.ok((await call("save_session", { ...input, ...options })).ok)
    }
    const materializedInput = { ...input, mode: "fullProject", reason: "owner requested" }
    const materialized = approval(await call("materialize_session", materializedInput))
    await decision(materialized.approvalRequestId, host.approvalToken)
    assert.ok((await call("materialize_session", materializedInput)).ok)

    // Omitted revisions and a changed destination do not borrow an existing grant.
    assert.equal(errorCode(await call("save_session", { sessionId })), "save_input_invalid")
    const wrongTarget = { ...input, targetPath: path.join(root, "elsewhere.fairy") }
    const target = approval(await call("save_session", wrongTarget))
    await decision(target.approvalRequestId, host.approvalToken)
    assert.equal(errorCode(await call("save_session", wrongTarget)), "path_policy_violation")
    await assert.rejects(readFile(wrongTarget.targetPath), { code: "ENOENT" })
    assert.equal((await list()).find(({ approvalRequestId }) => approvalRequestId === target.approvalRequestId)!.status, "consumed")

    const full = approval(await call("materialize_session", { ...input, mode: "fullProject", reason: "owner requested" }))
    await decision(full.approvalRequestId, host.approvalToken)
    // An in-flight edit is serialized by the existing backend and invalidates the pinned save revision.
    const edit = runtime.applyTransaction({ ...input, operations: [{ kind: "addBranch", branch: "queued-edit" }] })
    const staleSave = call("materialize_session", { ...input, mode: "fullProject", reason: "owner requested" })
    assert.ok((await edit).ok)
    assert.ok(["save_revision_stale", "stale_write"].includes(errorCode(await staleSave)))
    assert.ok(["stale", "consumed"].includes((await list()).find(({ approvalRequestId }) => approvalRequestId === full.approvalRequestId)!.status))

    // Closing and reopening a client-chosen session ID cannot resurrect revision-zero grants.
    const memoryInput = { project: liftDocumentToUamProject(document), sessionId: "reused-id" }
    assert.ok((await call("open_project_session", memoryInput)).ok)
    const memorySave = { sessionId: memoryInput.sessionId, expectedRevision: 0 }
    const old = approval(await call("save_session", memorySave))
    await decision(old.approvalRequestId, host.approvalToken)
    assert.ok((await call("close_session", { sessionId: memoryInput.sessionId })).ok)
    assert.ok((await call("open_project_session", memoryInput)).ok)
    assert.notEqual(approval(await call("save_session", memorySave)).approvalRequestId, old.approvalRequestId)
    assert.equal((await decision(old.approvalRequestId, host.approvalToken)).status, 409)
    const publicState = JSON.stringify(await list()) + JSON.stringify(await (await fetch(`${host.origin}/api/status`, { headers: { Authorization: `Bearer ${token}` } })).json())
    assert.ok(!publicState.includes(host.approvalToken) && !publicState.includes(token))
  } finally {
    if (sessionId) await runtime.closeSession({ sessionId })
    await client.close()
    await host.close()
  }
})

test("read-only Hosts cannot issue grants and normal and approval credentials must differ", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "maker-readonly-grants-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(path.join(root, "project"))
  const document = new Document()
  document.getRoot().setProjectId("readonly-save-grants")
  await new NodeIO().writeProject(document, path.join(root, "project", "Demo.fairy"))
  const token = "read-only-grants-token-with-24-chars"
  await assert.rejects(startMakerHost({ port: 0, token, approvalToken: token, dataDir: path.join(root, "data") }), /must differ/)
  const host = await startMakerHost({ port: 0, token, dataDir: path.join(root, "data"), projectPath: path.join(root, "project") })
  try {
    const headers = { Authorization: `Bearer ${token}`, "x-maker-approval-token": host.approvalToken, "Content-Type": "application/json" }
    assert.deepEqual(await (await fetch(`${host.origin}/api/save-approvals`, { headers })).json(), { enabled: false, approvals: [] })
    assert.equal((await fetch(`${host.origin}/api/save-approvals/anything/decision`, { method: "POST", headers, body: '{"decision":"approve"}' })).status, 403)
  } finally { await host.close() }
})
