import { randomUUID } from "node:crypto"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { Context } from "hono"

import { MAX_MCP_SESSIONS, MCP_SESSION_IDLE_TTL_MS } from "./host-config"
import type { McpSession } from "./host-types"

// Owns MCP session capacity, idle expiry and per-session transports; createServer decides which tools a new session exposes.
export function createMcpEndpoint(mcpSessions: Map<string, McpSession>, createServer: () => McpServer) {
  let pendingMcpSessions = 0

  const pruneMcpSessions = async () => {
    const now = Date.now()
    await Promise.allSettled([...mcpSessions.values()].filter((record) => (
      record.activeRequests === 0 && now - Date.parse(record.lastActivityAt) >= MCP_SESSION_IDLE_TTL_MS
    )).map((record) => {
      // Release capacity before awaiting close; a new request cannot revive an expired session.
      if (record.id) mcpSessions.delete(record.id)
      return record.server.close()
    }))
  }
  const handleMcpRequest = async (record: McpSession, request: Request) => {
    record.activeRequests += 1
    record.lastActivityAt = new Date().toISOString()
    try {
      // JSON response mode resolves only after the tool call completes; idle SSE GETs do not pin capacity.
      const response = await record.transport.handleRequest(request)
      record.lastError = response.ok ? null : `mcp_http_${response.status}`
      return response
    } catch (error) {
      record.lastError = "mcp_request_failed"
      throw error
    } finally {
      record.activeRequests -= 1
      record.lastActivityAt = new Date().toISOString()
    }
  }

  const handle = async (c: Context) => {
    await pruneMcpSessions()
    const sessionId = c.req.header("mcp-session-id")
    if (sessionId) {
      const record = mcpSessions.get(sessionId)
      if (!record) {
        return c.json({ jsonrpc: "2.0", error: { code: -32001, message: "Session not found", data: { code: "mcp_session_not_found" } }, id: null }, 404)
      }
      return handleMcpRequest(record, c.req.raw)
    }
    if (c.req.method !== "POST") {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Missing MCP session ID", data: { code: "mcp_session_id_required" } }, id: null }, 400)
    }
    if (mcpSessions.size + pendingMcpSessions >= MAX_MCP_SESSIONS) {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "MCP session limit reached", data: { code: "mcp_session_limit" } }, id: null }, 503)
    }

    pendingMcpSessions += 1
    let record: McpSession | undefined
    try {
      const now = new Date().toISOString()
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        enableJsonResponse: true,
        onsessioninitialized(id) {
          record!.id = id
          mcpSessions.set(id, record!)
        },
      })
      const server = createServer()
      record = { id: null, createdAt: now, lastActivityAt: now, lastError: null, activeRequests: 0, transport, server }
      transport.onerror = () => {
        record!.lastError = "mcp_transport_error"
      }
      transport.onclose = () => {
        if (record?.id) mcpSessions.delete(record.id)
      }
      await server.connect(transport)
      const response = await handleMcpRequest(record, c.req.raw)
      if (!transport.sessionId || !response.ok) await server.close()
      return response
    } catch (error) {
      if (record) await record.server.close().catch(() => undefined)
      throw error
    } finally {
      pendingMcpSessions -= 1
    }
  }

  return { handle, prune: pruneMcpSessions }
}
