export {}

const origin = process.env.PLAYER_SMOKE_ORIGIN
const token = process.env.PLAYER_SMOKE_TOKEN
const artifactId = process.env.PLAYER_SMOKE_ARTIFACT
if (!origin || !token || !artifactId) throw new Error("PLAYER_SMOKE_ORIGIN, PLAYER_SMOKE_TOKEN and PLAYER_SMOKE_ARTIFACT are required")

const headers = { Accept: "application/json, text/event-stream", Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
const initialize = await fetch(`${origin}/mcp`, {
  method: "POST",
  headers,
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "player-smoke", version: "1.0.0" } } }),
})
if (!initialize.ok) throw new Error(await initialize.text())
const sessionId = initialize.headers.get("mcp-session-id")
if (!sessionId) throw new Error("MCP session id missing")

const call = async (id: number, name: string, args: Record<string, unknown>) => {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  })
  const body = await response.json() as any
  if (!response.ok || body.error || body.result?.isError) throw new Error(JSON.stringify(body))
  return { body, value: JSON.parse(body.result.content[0].text) as any }
}

const listed = await call(2, "list_artifact_components", { artifactId })
if (listed.value.artifacts[0]?.packages[0]?.components[0]?.id !== "MAIN0001") throw new Error("Artifact catalog mismatch")
const rendered = await call(3, "render_artifact_component", { artifactId, requestId: crypto.randomUUID(), packageId: "SMOKE001", componentId: "MAIN0001", capture: true })
if (rendered.value.stateVersion !== 1 || rendered.body.result.content[1]?.type !== "image") throw new Error("Artifact render or capture failed")
const renderSessionId = rendered.value.renderSessionId
const updated = await call(4, "update_render_session", {
  renderSessionId,
  requestId: crypto.randomUUID(),
  expectedStateVersion: 1,
  operations: [{ op: "set-property", targetId: "/SMOKE001/MAIN0001/TITLE001", property: "text", value: "Agent updated Player" }],
})
if (updated.value.stateVersion !== 2) throw new Error("Artifact update failed")
const observed = await call(5, "get_render_observation", { renderSessionId, requestId: crypto.randomUUID(), afterStateVersion: 2 })
const title = observed.value.value.observation.objectTree.children.find((child: any) => child.id.endsWith("/TITLE001"))
if (title?.text !== "Agent updated Player") throw new Error("Updated Player text not observed")
process.stdout.write(JSON.stringify({ artifactId, renderSessionId, stateVersion: observed.value.stateVersion, title: title.text, screenshot: true }))
