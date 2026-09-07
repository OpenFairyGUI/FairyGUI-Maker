import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { BackendRuntime } from "@openfairygui/backend"
import { Resvg } from "@resvg/resvg-js"
import { Document, liftDocumentToUamProject } from "@openfairygui/core"
import { startMakerHost } from "../src/server/index"
import { VIEWER_PROTOCOL_VERSION } from "../src/viewer-protocol"

test("public session preview reads unsaved UAM and bytes at one revision and expires on edits/close", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "maker-session-preview-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const document = new Document()
  document.getRoot().setProjectId("preview")
  document.createPackage("Main").setId("MAIN0001").addResource(document.createComponent("Main").setId("ROOT0001").setSize(200, 100)
    .addChild(document.createGTextField("label").setId("TEXT0001").setText("Before")))
  document.createPackage("Shared").setId("SHARED01").addResource(document.createImageResource("Icon").setId("ICON0001").setFileName("Icon.png").setWidth(1).setHeight(1))
  const project = liftDocumentToUamProject(document)
  const png = (color: string) => [...new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"><path fill="${color}" d="M0 0h1v1H0z"/></svg>`).render().asPng()]
  const before = png("red"), after = png("blue")
  Object.assign(project.packages[1].resources[0], { sourceBytes: before })
  const runtime = new BackendRuntime()
  const host = await startMakerHost({ port: 0, runtime, dataDir: root })
  const headers = { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" }
  const client = new Client({ name: "session-preview-test", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(`${host.origin}/mcp`), { requestInit: { headers } })
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    return result.structuredContent as any
  }
  const backend = async (method: string, args: Record<string, unknown>) => (await call(`openfairygui_backend_${method}`, args)).backendResult
  const read = (url: string) => fetch(`${host.origin}${url}`, { headers })
  const preview = (revision: number) => call("open_session_preview", { sessionId: "test-session", expectedRevision: revision })
  const selector = { packageId: "MAIN0001", componentResourceId: "ROOT0001", displayNodeId: "TEXT0001" }
  try {
    await client.connect(transport)
    assert.equal((await backend("open_project_session", { project, sessionId: "test-session" })).ok, true)
    const first = await preview(0)
    assert.equal(first.ok, true, JSON.stringify(first))
    assert.equal(first.project.sourceOwner, "session")
    const base = `/api/projects/${first.project.projectId}`
    const oldQuery = `sourceRevision=${first.project.sourceRevision}`
    assert.equal((await fetch(`${host.origin}${base}/session-state?${oldQuery}`)).status, 401)
    assert.equal((await read(`${base}/source-index`)).status, 404, "session source must not fall back to files")
    const state = (await (await read(`${base}/session-state?${oldQuery}`)).json()).state
    assert.equal(state.revision, 0)
    assert.equal(state.project.packages[1].resources[0].sourceBytes, undefined)
    assert.deepEqual([...new Uint8Array(await (await read(`${base}/resource-bytes?${oldQuery}&packageId=SHARED01&resourceId=ICON0001`)).arrayBuffer())], before)
    const failedBytes = await read(`${base}/resource-bytes?${oldQuery}&packageId=MAIN0001&resourceId=ROOT0001`)
    assert.equal(failedBytes.status, 409)
    assert.equal((await failedBytes.json()).backendError.code, "session_read_failed")
    const registered = await fetch(`${host.origin}/api/renderers`, { method: "POST", headers, body: JSON.stringify({
      projectId: first.project.projectId, sourceRevision: first.project.sourceRevision, protocolVersion: VIEWER_PROTOCOL_VERSION,
      catalog: { schemaVersion: 1, source: { projectId: "preview" }, packages: [{ packageId: "MAIN0001", packageName: "Main", components: [{ id: "ROOT0001", name: "Main" }] }] },
    }) })
    assert.equal(registered.status, 201, await registered.clone().text())
    const renderer = (await registered.json()).session
    const edit = await backend("apply_transaction", { sessionId: "test-session", expectedRevision: 0, operations: [
      { kind: "setDisplayNodeProps", selector, props: { text: "After" } },
      { kind: "replaceResourceBytes", selector: { packageId: "SHARED01", resourceId: "ICON0001" }, sourceBytes: after },
    ] })
    assert.equal(edit.ok, true, JSON.stringify(edit))
    assert.equal((await read(`/api/render-sessions/${renderer.renderSessionId}`)).status, 404)
    assert.equal((await read(`${base}/session-state?${oldQuery}`)).status, 409)
    assert.equal((await read(`${base}/resource-bytes?${oldQuery}&packageId=SHARED01&resourceId=ICON0001`)).status, 409)
    assert.equal((await preview(0)).error.code, "stale_read")
    const queried = await backend("query_entity", { sessionId: "test-session", target: { kind: "displayNode", selector } })
    assert.equal(queried.data.revision, 1)
    assert.equal(queried.data.entity.properties.text, "After")
    const second = await preview(1)
    assert.equal(second.project.backendSession.dirty, true)
    assert.notEqual(second.project.sourceRevision, first.project.sourceRevision)
    assert.equal(second.project.projectId, first.project.projectId)
    assert.equal((await preview(1)).project.sourceRevision, second.project.sourceRevision)
    const nextQuery = `sourceRevision=${second.project.sourceRevision}`
    assert.deepEqual([...new Uint8Array(await (await read(`${base}/resource-bytes?${nextQuery}&packageId=SHARED01&resourceId=ICON0001`)).arrayBuffer())], after)
    // SDK callers bypass the MCP tracking proxy; public read CAS must still prevent mixed revisions.
    assert.equal((await runtime.applyTransaction({ sessionId: "test-session", expectedRevision: 1, operations: [{ kind: "addBranch", branch: "external" }] })).ok, true)
    const stale = await read(`${base}/session-state?${nextQuery}`)
    assert.equal(stale.status, 409)
    assert.equal((await stale.json()).backendError.code, "stale_read")
    assert.equal((await preview(2)).ok, true)
    assert.equal((await backend("close_session", { sessionId: "test-session" })).ok, true)
    assert.equal((await read(base)).status, 404)
    assert.equal((await backend("open_project_session", { project, sessionId: "test-session" })).ok, true)
    const reopened = await preview(0)
    assert.notEqual(reopened.project.projectId, first.project.projectId)
    assert.notEqual(reopened.project.sourceRevision, first.project.sourceRevision)
  } finally {
    await backend("close_session", { sessionId: "test-session" }).catch(() => undefined)
    await transport.terminateSession().catch(() => undefined)
    await client.close()
    await host.close()
  }
})
