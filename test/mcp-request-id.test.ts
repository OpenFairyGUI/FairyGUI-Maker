import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

import { startMakerHost } from "../src/server/index"

// The first Agent evaluation saw Codex send requestId "render-card-1", get "Invalid UUID" and stop.
test("requestId tells Agents what it is for and how to fix an invalid value", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "maker-request-id-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const host = await startMakerHost({ port: 0, dataDir })
  const client = new Client({ name: "request-id-test", version: "1" })
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${host.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${host.token}` } } }))
    const { tools } = await client.listTools()
    const withRequestId = tools.filter((tool) => (tool.inputSchema.properties as Record<string, unknown> | undefined)?.requestId)
    assert.ok(withRequestId.length >= 9, withRequestId.map(({ name }) => name).join(", "))
    for (const tool of withRequestId) {
      const requestId = (tool.inputSchema.properties as Record<string, { description?: string; format?: string }>).requestId
      assert.equal(requestId.format, "uuid", tool.name)
      assert.match(requestId.description ?? "", /new random UUID .* for each new request/, tool.name)
    }

    const result = await client.callTool({ name: "render_component_preview", arguments: { projectId: "project_x", packageId: "MAIN0001", componentId: "CARD0001", requestId: "render-card-1" } }) as CallToolResult
    assert.equal(result.isError, true)
    const text = result.content.find((item) => item.type === "text")
    assert.ok(text?.type === "text")
    assert.match(text.text, /requestId must be a UUID such as [0-9a-f-]{36}: use a new random UUID for each new request/)
  } finally {
    await client.close()
    await host.close()
  }
})
