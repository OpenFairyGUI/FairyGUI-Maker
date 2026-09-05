import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createNodeBackendRuntime } from "@openfairygui/backend/node"
import { Document } from "@openfairygui/core"
import { liftDocumentToUamProject } from "@openfairygui/core/uam"
import { MCP_SESSION_IDLE_TTL_MS, startMakerHost } from "../src/server/index"

type Host = Awaited<ReturnType<typeof startMakerHost>>
const headers = (host: Host, sessionId?: string) => ({
  Authorization: `Bearer ${host.token}`, Accept: "application/json, text/event-stream", "Content-Type": "application/json",
  "MCP-Protocol-Version": "2025-11-25", ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
})
const rpc = (host: Host, sessionId: string | undefined, method: string, params?: unknown) => fetch(`${host.origin}/mcp`, {
  method: "POST", headers: headers(host, sessionId), body: JSON.stringify({ jsonrpc: "2.0", id: randomUUID(), method, params }),
})
async function initialize(host: Host) {
  const response = await rpc(host, undefined, "initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "lifecycle-test", version: "1" } })
  assert.equal(response.status, 200)
  assert.ok((await response.json()).result)
  const id = response.headers.get("mcp-session-id")
  assert.ok(id)
  return id
}
const sessions = (host: Host) => fetch(`${host.origin}/api/sessions`, { headers: headers(host) }).then((response) => response.json())
async function tool(host: Host, sessionId: string, name: string, args: unknown) {
  const response = await rpc(host, sessionId, "tools/call", { name: `openfairygui_backend_${name}`, arguments: args })
  assert.equal(response.status, 200)
  const result = await response.json()
  assert.ok(result.result?.structuredContent, JSON.stringify(result))
  return result.result.structuredContent.backendResult
}

test("MCP releases 32-session capacity, expires idle SSE, and preserves in-flight calls plus a fresh idle window", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() })
  const root = await mkdtemp(join(tmpdir(), "maker-mcp-lifecycle-"))
  const runtime = createNodeBackendRuntime()
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const released = new Promise<void>((resolve) => { release = resolve })
  t.mock.method(runtime, "openSession", async () => { enter(); await released; throw new Error("private failure detail") })
  const host = await startMakerHost({ port: 0, dataDir: root, runtime })
  try {
    for (let i = 0; i < 35; i++) assert.equal((await rpc(host, undefined, "ping")).status, 400)
    const ids: string[] = []
    for (let i = 0; i < 32; i++) ids.push(await initialize(host))
    const full = await rpc(host, undefined, "initialize", {})
    assert.equal(full.status, 503)
    assert.equal((await full.json()).error.data.code, "mcp_session_limit")
    const pending = tool(host, ids[0], "open_session", { projectPath: "unused" })
    await entered
    const stream = await fetch(`${host.origin}/mcp`, { headers: headers(host, ids[1]) })
    assert.equal(stream.status, 200)
    t.mock.timers.tick(MCP_SESSION_IDLE_TTL_MS + 60_000)
    await stream.text()
    const active = await sessions(host)
    assert.equal(active.mcp.length, 1)
    assert.equal(active.mcp[0].id, ids[0])
    assert.equal(active.mcp[0].activeRequests, 1)
    const expired = await rpc(host, ids[1], "ping")
    assert.equal(expired.status, 404)
    assert.equal((await expired.json()).error.data.code, "mcp_session_not_found")
    await initialize(host)
    release()
    assert.equal((await pending).error.code, "backend_unhandled_error")
    assert.equal((await rpc(host, ids[0], "ping")).status, 200)
    const completed = await sessions(host)
    assert.equal(completed.mcp.find((session: { id: string }) => session.id === ids[0]).activeRequests, 0)
    assert.equal(completed.activity[0].errorCode, "backend_unhandled_error")
    assert.ok(!JSON.stringify(completed).includes("private failure detail"))
    t.mock.timers.setTime(Date.now() + MCP_SESSION_IDLE_TTL_MS)
    assert.equal((await rpc(host, ids[0], "ping")).status, 404, "requests also prune before the periodic sweep")
    const fresh = await initialize(host)
    assert.equal((await fetch(`${host.origin}/mcp`, { method: "DELETE", headers: headers(host, fresh) })).status, 200)
    assert.equal((await sessions(host)).mcp.length, 0)
  } finally { release(); await host.close(); await rm(root, { recursive: true, force: true }) }
})

test("Backend sync/async failures are recorded without leaking details or creating phantom sessions; activity is bounded", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "maker-host-activity-"))
  const runtime = createNodeBackendRuntime()
  const host = await startMakerHost({ port: 0, dataDir: root, runtime })
  try {
    const id = await initialize(host)
    const document = new Document()
    document.getRoot().setProjectId("activity-test")
    const opened = await tool(host, id, "open_project_session", { project: liftDocumentToUamProject(document), sessionId: "real-session" })
    assert.equal(opened.ok, true)
    const syncFailure = t.mock.method(runtime, "validateSession", () => { throw new Error("sync private path") })
    const asyncFailure = t.mock.method(runtime, "applyTransaction", async () => { throw new Error("async private path") })
    for (const [name, args] of [
      ["validate_session", { sessionId: "real-session" }],
      ["apply_transaction", { sessionId: "real-session", expectedRevision: 0, operations: [{ kind: "addBranch", branch: "test" }] }],
    ] as const) {
      assert.equal((await tool(host, id, name, args)).error.code, "backend_unhandled_error")
      const state = await sessions(host)
      assert.equal(state.projects[0].lastError, "backend_unhandled_error")
      assert.equal(state.activity[0].errorCode, "backend_unhandled_error")
      assert.ok(!JSON.stringify(state).includes("private path"))
    }
    syncFailure.mock.restore(); asyncFailure.mock.restore()
    assert.equal((await tool(host, id, "get_session", { sessionId: "real-session" })).ok, true)
    assert.equal((await sessions(host)).projects[0].lastError, null)
    for (let i = 0; i < 105; i++) assert.equal((await tool(host, id, "get_session", { sessionId: `unknown-${i}` })).ok, false)
    const bounded = await sessions(host)
    assert.equal(bounded.projects.length, 1)
    assert.equal(bounded.activity.length, 100)
    assert.equal(bounded.activity[0].sessionId, "unknown-104")
    assert.equal((await tool(host, id, "close_session", { sessionId: "real-session" })).ok, true)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})
