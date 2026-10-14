import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import type { OpenFairyGuiBackendRuntime } from "@openfairygui/mcp"

export type BackendSession = {
  id: string
  projectName: string
  revision?: number
  lastSavedRevision?: number
  dirty?: boolean
  lockHeld?: boolean
  createdAt: string
  lastActivityAt?: string
  lastMethod?: string
  lastError?: string | null
}

export type McpSession = {
  id: string | null
  createdAt: string
  lastActivityAt: string
  lastError: string | null
  activeRequests: number
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
}

export type BackendActivity = { method: string; sessionId: string | null; at: string; errorCode: string | null }

export type RegisteredProject = {
  projectId: string
  fairyguiProjectId: string
  bindingId: string
  name: string
  directoryName: string
  fairyPath: string
  revision: number
  sourceRevision: string
  sourceOwner: "browser" | "host" | "session"
  backendSession?: { sessionId: string; revision: number; lastSavedRevision: number; dirty: boolean }
  access: "read-only"
  status: "ready"
  viewerUrl: string
  assetManagerUrl: string
  createdAt: string
  updatedAt: string
}

export type StartMakerHostOptions = {
  port?: number
  token?: string
  approvalToken?: string
  runtime?: OpenFairyGuiBackendRuntime
  dataDir?: string
  projectPath?: string
}
