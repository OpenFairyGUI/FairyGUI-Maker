import assert from "node:assert/strict"
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Document } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"

import { startMakerHost } from "../src/server/index"

test("publish_artifact turns a saved Backend session revision into a host-published Player artifact", async () => {
  // The default Host allowlist is process.cwd(), so the project must live under it.
  const root = await mkdtemp(join(process.cwd(), ".maker-path-test-"))
  const dataDir = join(root, "data")
  const projectDir = join(root, "project")
  const document = new Document()
  document.getRoot().setProjectId("publish-test")
  document.createPackage("Main").setId("MAIN0001").addResource(document.createComponent("Before").setId("PANL0001").setExported(true).setSize(120, 80))
  await mkdir(projectDir, { recursive: true })
  await new NodeIO().writeProject(document, join(projectDir, "Publish.fairy"))

  let host = await startMakerHost({ port: 0, dataDir })
  const client = new Client({ name: "publish-test", version: "1" })
  let sessionId: string | undefined
  const call = async (name: string, args: Record<string, unknown>) => (await client.callTool({ name, arguments: args })).structuredContent as any
  const backend = async (method: string, args: Record<string, unknown>) => (await call(`openfairygui_backend_${method}`, args)).backendResult
  const api = (path: string, init: RequestInit = {}) => fetch(`${host.origin}${path}`, { ...init, headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json", ...init.headers } })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${host.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${host.token}` } } }))
    const opened = await backend("open_session", { projectPath: projectDir })
    assert.equal(opened.ok, true, JSON.stringify(opened))
    sessionId = opened.data.sessionId
    const projectFiles = (await readdir(projectDir, { recursive: true })).sort()

    // A freshly opened session is its own saved revision.
    const first = await call("publish_artifact", { sessionId, expectedRevision: 0 })
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.deepEqual(first.artifact.source, { kind: "host-publish", sessionId, revision: 0 })
    assert.deepEqual(first.artifact.verification, { content: "host-validated", source: "host-published" })
    assert.deepEqual(first.artifact.packages, [{ packageId: "MAIN0001", packageName: "Main", components: 1 }])
    assert.equal(first.browserRequired, true)
    assert.match(first.artifact.playerUrl, /\/artifacts\/artifact_[a-f0-9]{24}\/player$/)
    assert.deepEqual((await readdir(projectDir, { recursive: true })).sort(), projectFiles, "publish must not write into the project")
    assert.deepEqual(await readdir(join(dataDir, "publishes")), [], "staging is removed after import")

    assert.equal((await call("publish_artifact", { sessionId, expectedRevision: 1 })).error.code, "publish_revision_stale")
    assert.equal((await call("publish_artifact", { sessionId: "missing-session", expectedRevision: 0 })).error.code, "publish_session_unavailable")

    const edited = await backend("apply_transaction", { sessionId, expectedRevision: 0, operations: [{ kind: "renameResource", selector: { packageId: "MAIN0001", resourceId: "PANL0001" }, newName: "After" }] })
    assert.equal(edited.ok, true, JSON.stringify(edited))
    assert.equal((await call("publish_artifact", { sessionId, expectedRevision: 1 })).error.code, "publish_requires_saved_session")

    const saveInput = { sessionId, expectedRevision: 1 }
    const approval = (await backend("save_session", saveInput)).error.approval
    assert.equal((await api(`/api/save-approvals/${approval.approvalRequestId}/decision`, {
      method: "POST", headers: { "x-maker-approval-token": host.approvalToken }, body: '{"decision":"approve"}',
    })).status, 200)
    assert.equal((await backend("save_session", saveInput)).ok, true)

    const second = await call("publish_artifact", { sessionId, expectedRevision: 1, name: "After save" })
    assert.equal(second.ok, true, JSON.stringify(second))
    assert.notEqual(second.artifact.digest, first.artifact.digest)
    assert.equal(second.artifact.name, "After save")
    const stored = await (await api(`/api/artifacts/${second.artifact.artifactId}`)).json()
    assert.deepEqual(stored.artifact.packages[0].components.map(({ name }: { name: string }) => name), ["After"])

    // Clients can only declare provenance; host-publish is reserved for the Host itself.
    const forged = await api("/api/artifact-imports", { method: "POST", body: JSON.stringify({
      name: "Forged", source: { kind: "host-publish", sessionId, revision: 1 }, files: [{ path: "Main.fui", size: 1, sha256: "0".repeat(64) }],
    }) })
    assert.equal(forged.status, 400)

    await backend("close_session", { sessionId }); sessionId = undefined
    await client.close()
    await host.close()
    host = await startMakerHost({ port: 0, dataDir })
    const reloaded = await (await api(`/api/artifacts/${second.artifact.artifactId}`)).json()
    assert.deepEqual(reloaded.artifact.source, { kind: "host-publish", sessionId: second.artifact.source.sessionId, revision: 1 })
    assert.equal(reloaded.artifact.verification.source, "host-published")
  } finally {
    if (sessionId) await backend("close_session", { sessionId }).catch(() => undefined)
    await client.close().catch(() => undefined)
    await host.close()
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  }
})
