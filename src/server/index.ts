import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { access, readdir, realpath, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { basename, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { serve, type ServerType } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { zValidator } from "@hono/zod-validator"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"
import { createNodeBackendRuntime } from "@openfairygui/backend/node"
import { createOpenFairyGuiMcpServer, type OpenFairyGuiBackendRuntime, type OpenFairyGuiMcpToolPolicy } from "@openfairygui/mcp"
import { Hono, type Context } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { HTTPException } from "hono/http-exception"
import pino from "pino"
import { z } from "zod"

import {
  ASSET_ANALYSIS_MAX_REFERENCES,
  ASSET_ANALYSIS_MAX_RESOURCES,
  ASSET_ANALYSIS_SCHEMA_VERSION,
  ASSET_ISSUE_KINDS,
  ASSET_RESOURCE_ID_PATTERN,
  type ProjectAssetAnalysis,
} from "../asset-analysis"
import { ImportDraftStore } from "../design-import/draft-store"
import { applyProjectReimport, planProjectReimport } from "../design-import/node"
import { ArtifactStore, artifactSourceSchema } from "./artifacts"
import { createHostBackendFileSystem } from "./backend-files"
import { registerImportDraftApi } from "./import-drafts"
import { createHostProjectSnapshot, type HostProjectSnapshot } from "./project-snapshot"
import { HostSaveGrants, hostBackendFailure, saveGrantFailureSchema } from "./save-grants"
import { uploadLimits } from "./upload-limits"
import { UploadError } from "../upload"
import {
  ViewerRenderBroker,
  registerViewerMcpTools,
  rendererInteractionSchema,
  rendererRegistrationSchema,
  rendererResultSchema,
  renderSessionCommandSchema,
} from "./viewer"

const require = createRequire(import.meta.url)
const { version: PACKAGE_VERSION } = require("../../package.json") as { version: string }
const COOKIE_NAME = "fairygui_maker_token"
const OWNER_COOKIE_NAME = "fairygui_maker_owner"
const OWNER_COOKIE_PATH = "/api/save-approvals"
const MAX_OWNER_SESSIONS = 32
const WEB_DIST = fileURLToPath(new URL("../../dist/web", import.meta.url))
const MAX_MCP_SESSIONS = 32
export const MCP_SESSION_IDLE_TTL_MS = 30 * 60_000
const HOST_INSTRUCTIONS = "FairyGUI authoring, Viewer, and Player service. Use backend sessions for revision-checked project edits. Every save requires expectedRevision. The owner can allow ordinary saves for one project session in Workbench; force-save, explicit target paths and materialization still require a one-time Host Save Grant. On save_approval_required, ask the owner to verify once in Workbench and choose the save permission, then retry unchanged arguments; never obtain owner credentials or approve yourself. Session permission ends on revoke, project close/reopen or Host restart. Use stable IDs returned by list/inspect tools; Viewer and Player operations affect render-session memory only."
const VIEW_ONLY_INSTRUCTIONS = "Read-only FairyGUI Viewer and Player service. Use stable IDs returned by list tools. Viewer operations never write project files; backend authoring and save tools are unavailable in this mode."
const logger = pino({ level: process.env.FAIRYGUI_MAKER_LOG_LEVEL ?? "info" })
const TRACKED_METHODS = new Set([
  "getCapabilities",
  "openSession",
  "openProjectSession",
  "getSession",
  "getProjectOutline",
  "queryEntity",
  "readSessionState",
  "readResourceBytes",
  "validateSession",
  "preflightTransaction",
  "applyTransaction",
  "saveSession",
  "materializeSession",
  "closeSession",
  "getEvents",
  "getJob",
  "listJobs",
  "cancelJob",
  "getCacheSnapshot",
  "refreshCache",
])

type BackendSession = {
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

type McpSession = {
  id: string | null
  createdAt: string
  lastActivityAt: string
  lastError: string | null
  activeRequests: number
  transport: WebStandardStreamableHTTPServerTransport
  server: McpServer
}

type BackendActivity = { method: string; sessionId: string | null; at: string; errorCode: string | null }

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

const hostOptionsSchema = z.object({
  port: z.number().int().min(0).max(65_535),
  token: z.string().min(24, "FAIRYGUI_MAKER_TOKEN must contain at least 24 characters").optional(),
  approvalToken: z.string().min(24, "FAIRYGUI_MAKER_APPROVAL_TOKEN must contain at least 24 characters").max(256).optional(),
})

const projectRegistrationSchema = z.object({
  bindingId: z.string().uuid(),
  fairyguiProjectId: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(200),
  directoryName: z.string().trim().min(1).max(255),
  fairyPath: z.string().trim().min(1).max(1_024).refine((value) => (
    value.toLowerCase().endsWith(".fairy")
    && !value.includes("\\")
    && value.split("/").every((segment) => segment && segment !== "." && segment !== "..")
  ), "fairyPath must be a safe relative .fairy path"),
  sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
})

const sessionPreviewInput = z.object({ sessionId: z.string().min(1).max(256), expectedRevision: z.number().int().nonnegative() }).strict()

function sessionPreviewResult(runtime: OpenFairyGuiBackendRuntime, sessionId: string, expectedRevision: number) {
  const result = runtime.readSessionState({ sessionId, expectedRevision })
  if (!result.ok) return { ok: false as const, error: result.error }
  const state = result.data
  if (!state.readComplete || state.uamFidelity !== "full") return { ok: false as const, error: {
    code: "session_preview_incomplete", message: "The Backend session model is incomplete or unsupported; inspect its read diagnostics before previewing.", readDiagnostics: state.readDiagnostics,
  } }
  const packageIds = new Set<string>()
  let components = 0
  for (const pkg of state.project.packages) {
    const resourceIds = new Set<string>()
    if (packageIds.has(pkg.id) || pkg.resources.some((resource) => { if (resourceIds.has(resource.id)) return true; resourceIds.add(resource.id); return false })) {
      return { ok: false as const, error: { code: "session_preview_ambiguous", message: "Duplicate package or resource IDs cannot identify a Viewer source." } }
    }
    packageIds.add(pkg.id)
    components += pkg.resources.filter((resource) => resource.kind === "component").length
  }
  if (packageIds.size > 5_000 || components > 5_000) return { ok: false as const, error: { code: "session_preview_budget_exceeded", message: "Viewer supports at most 5000 packages and components." } }
  return { ok: true as const, state }
}

function advanceSessionPreview(project: RegisteredProject, snapshot: NonNullable<RegisteredProject["backendSession"]>): RegisteredProject {
  const revision = project.revision + 1
  const backendSession = { sessionId: snapshot.sessionId, revision: snapshot.revision, lastSavedRevision: snapshot.lastSavedRevision, dirty: snapshot.dirty }
  // A preview generation identifies reads of the session, including save bookkeeping; it is not a file-content digest.
  const sourceRevision = createHash("sha256").update(JSON.stringify({ bindingId: project.bindingId, generation: revision, ...backendSession })).digest("hex")
  return { ...project, revision, sourceRevision, backendSession, updatedAt: new Date().toISOString() }
}

const assetResourceKeySchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}\/[A-Za-z0-9_-]{1,128}$/)
const assetAnalysisSchema = z.object({
  schemaVersion: z.literal(ASSET_ANALYSIS_SCHEMA_VERSION),
  // Accept older v1 uploads, but never allow a caller to claim Host verification.
  analysisOwner: z.literal("browser").default("browser"),
  trust: z.literal("advisory").default("advisory"),
  projectId: z.string().min(1).max(128),
  sourceRevision: z.string().min(1).max(128),
  resources: z.array(z.object({
    key: assetResourceKeySchema,
    packageId: z.string().regex(ASSET_RESOURCE_ID_PATTERN),
    packageName: z.string().min(1).max(256),
    resourceId: z.string().regex(ASSET_RESOURCE_ID_PATTERN),
    kind: z.enum(["image", "sound", "misc", "swf", "font", "movieClip", "spine", "dragonBones", "component"]),
    name: z.string().min(1).max(256),
    path: z.string().max(1_024),
    branch: z.string().max(128),
    exported: z.boolean(),
    byteLength: z.number().int().nonnegative().max(1_073_741_824).nullable(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
    incomingReferences: z.number().int().nonnegative().max(ASSET_ANALYSIS_MAX_REFERENCES),
    outgoingReferences: z.number().int().nonnegative().max(ASSET_ANALYSIS_MAX_REFERENCES),
  }).strict()).max(ASSET_ANALYSIS_MAX_RESOURCES),
  references: z.array(z.object({
    sourceKey: z.union([z.literal("project"), assetResourceKeySchema]),
    targetKey: assetResourceKeySchema,
    path: z.string().min(1).max(2_048),
  }).strict()).max(ASSET_ANALYSIS_MAX_REFERENCES),
  issues: z.array(z.object({
    kind: z.enum(ASSET_ISSUE_KINDS),
    severity: z.enum(["error", "warning"]),
    label: z.string().min(1).max(1_000),
    detail: z.string().min(1).max(2_000),
    resourceKeys: z.array(assetResourceKeySchema).max(ASSET_ANALYSIS_MAX_RESOURCES),
  }).strict()).max(ASSET_ANALYSIS_MAX_REFERENCES),
}).strict().superRefine((analysis, context) => {
  const keys = new Set<string>()
  for (const [index, resource] of analysis.resources.entries()) {
    if (resource.key !== `${resource.packageId}/${resource.resourceId}`) {
      context.addIssue({ code: "custom", path: ["resources", index, "key"], message: "Resource key does not match its IDs" })
    }
    if (keys.has(resource.key)) context.addIssue({ code: "custom", path: ["resources", index, "key"], message: "Duplicate resource key" })
    keys.add(resource.key)
  }
  const incoming = new Map<string, number>()
  const outgoing = new Map<string, number>()
  for (const reference of analysis.references) {
    if (reference.sourceKey !== "project" && !keys.has(reference.sourceKey)) {
      context.addIssue({ code: "custom", path: ["references"], message: `Unknown source resource ${reference.sourceKey}` })
    }
    outgoing.set(reference.sourceKey, (outgoing.get(reference.sourceKey) ?? 0) + 1)
    if (keys.has(reference.targetKey)) incoming.set(reference.targetKey, (incoming.get(reference.targetKey) ?? 0) + 1)
  }
  for (const [index, resource] of analysis.resources.entries()) {
    if (resource.incomingReferences !== (incoming.get(resource.key) ?? 0) || resource.outgoingReferences !== (outgoing.get(resource.key) ?? 0)) {
      context.addIssue({ code: "custom", path: ["resources", index], message: "Reference totals do not match the reference list" })
    }
  }
  for (const [index, issue] of analysis.issues.entries()) {
    if (issue.resourceKeys.some((key) => !keys.has(key))) {
      context.addIssue({ code: "custom", path: ["issues", index, "resourceKeys"], message: "Issue contains an unknown resource key" })
    }
  }
})

function tokensMatch(actual: string | undefined | null, expected: string) {
  if (typeof actual !== "string") return false
  const actualBuffer = Buffer.from(actual)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}

function publicBackendSession(session: BackendSession) {
  return {
    id: session.id,
    projectName: session.projectName,
    revision: session.revision,
    lastSavedRevision: session.lastSavedRevision,
    dirty: session.dirty,
    lockHeld: session.lockHeld,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    lastMethod: session.lastMethod,
    lastError: session.lastError,
  }
}

function trackBackendResult(sessions: Map<string, BackendSession>, activity: BackendActivity[], method: string, input: any, result: any) {
  const sessionId = result?.data?.sessionId ?? input?.sessionId
  const now = new Date().toISOString()
  const errorCode = result?.ok === false ? String(result.error?.code ?? "backend_error").slice(0, 128) : null
  activity.push({ method, sessionId: sessionId ?? null, at: now, errorCode })
  if (activity.length > 100) activity.shift()
  if (method === "closeSession" && result?.ok && sessionId) {
    sessions.delete(sessionId)
    return
  }
  // Failed calls with invented IDs are activity, not new long-lived project sessions.
  if (!sessionId || (!sessions.has(sessionId) && !result?.ok)) return
  const current: BackendSession = sessions.get(sessionId) ?? {
    id: sessionId,
    projectName: "In-memory project",
    createdAt: now,
  }
  const snapshot = result?.ok && typeof result.data?.revision === "number" ? result.data : undefined
  sessions.set(sessionId, {
    ...current,
    projectName: snapshot?.canonicalProjectPath ? basename(snapshot.canonicalProjectPath) : current.projectName,
    revision: snapshot?.revision ?? current.revision,
    lastSavedRevision: snapshot?.lastSavedRevision ?? current.lastSavedRevision,
    dirty: snapshot?.dirty ?? current.dirty,
    lockHeld: snapshot?.lockHeld ?? current.lockHeld,
    lastActivityAt: now,
    lastMethod: method,
    lastError: errorCode,
  })
}

function createTrackedRuntime(runtime: OpenFairyGuiBackendRuntime, sessions: Map<string, BackendSession>, activity: BackendActivity[], saveGrants: HostSaveGrants, onResult: (method: string, input: any, result: any) => void) {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== "function") return value
      if (typeof property !== "string" || !TRACKED_METHODS.has(property)) return value.bind(target)
      return (...args: any[]) => {
        const closingId = property === "closeSession" ? args[0]?.sessionId as string : undefined
        if (closingId) saveGrants.beginClose(closingId)
        const finish = (result: any) => {
          trackBackendResult(sessions, activity, property, args[0], result)
          if (result?.ok && (property === "openSession" || property === "openProjectSession")) saveGrants.invalidateSession(result.data.sessionId)
          onResult(property, args[0], result)
          return result
        }
        const fail = () => finish(hostBackendFailure("backend_unhandled_error", "Backend tool execution failed."))
        try {
          const result = value.apply(target, args)
          if (result && typeof result.then === "function") return result.then(finish, fail).finally(() => { if (closingId) saveGrants.endClose(closingId) })
          if (closingId) saveGrants.endClose(closingId)
          return finish(result)
        } catch {
          if (closingId) saveGrants.endClose(closingId)
          return fail()
        }
      }
    },
  })
}

function registerApi(
  app: Hono,
  readState: () => {
    origin: string
    startedAt: string
    mcpSessions: Map<string, McpSession>
    backendSessions: Map<string, BackendSession>
    backendActivity: BackendActivity[]
    projects: Map<string, RegisteredProject>
    projectSources: Map<string, HostProjectSnapshot>
    assetAnalyses: Map<string, ProjectAssetAnalysis>
    renderBroker: ViewerRenderBroker
    artifactStore: ArtifactStore
    importDraftStore: ImportDraftStore
    importsEnabled: boolean
    saveGrants: HostSaveGrants
    approvalToken: string
    ownerSessions: Set<string>
    saveApprovalsEnabled: boolean
    runtime: OpenFairyGuiBackendRuntime
    ensureSessionPreview(sessionId: string, expectedRevision: number): { ok: true; project: RegisteredProject } | Extract<ReturnType<typeof sessionPreviewResult>, { ok: false }>
    ensureDraftPreview(draftId: string): Promise<RegisteredProject>
    removeDraftPreview(draftId: string): void
  },
) {
  const ownerVerified = (c: Context) => readState().ownerSessions.has(getCookie(c, OWNER_COOKIE_NAME) ?? "")
  const canApprove = (c: Context) => tokensMatch(c.req.header("x-maker-approval-token"), readState().approvalToken)
    || (c.req.header("origin") === readState().origin && ownerVerified(c))
  return registerImportDraftApi(app, () => {
    const { importDraftStore, importsEnabled, ensureDraftPreview, removeDraftPreview } = readState()
    return { importDraftStore, importsEnabled, ensureDraftPreview, removeDraftPreview }
  })
    .get("/api/status", (c) => {
      const { origin, startedAt, mcpSessions, backendSessions, assetAnalyses, artifactStore, importDraftStore, importsEnabled } = readState()
      return c.json({
        host: {
          name: "FairyGUI Maker",
          version: PACKAGE_VERSION,
          status: "running" as const,
          startedAt,
          uptimeSeconds: Math.floor((Date.now() - Date.parse(startedAt)) / 1000),
          origin,
        },
        mcp: { transport: "streamable-http" as const, endpoint: `${origin}/mcp`, sessions: mcpSessions.size },
        backend: { sessions: backendSessions.size },
        viewer: { entry: `${origin}/viewer`, artifacts: artifactStore.count() },
        player: { entry: `${origin}/player`, artifacts: artifactStore.count() },
        assetManager: { entry: `${origin}/asset-manager`, analyses: assetAnalyses.size },
        imports: { enabled: importsEnabled, drafts: importsEnabled ? importDraftStore.count() : 0, entry: `${origin}/design-import` },
      })
    })
    .get("/api/sessions", (c) => {
      const { mcpSessions, backendSessions, backendActivity } = readState()
      return c.json({
        mcp: [...mcpSessions.values()].map(({ id, createdAt, lastActivityAt, lastError, activeRequests }) => ({ id, createdAt, lastActivityAt, lastError, activeRequests })),
        projects: [...backendSessions.values()].map(publicBackendSession),
        activity: [...backendActivity].reverse(),
      })
    })
    .post("/api/session-previews", zValidator("json", sessionPreviewInput), (c) => {
      const { ensureSessionPreview, saveApprovalsEnabled } = readState()
      if (!saveApprovalsEnabled) return c.json({ error: "Backend session previews are unavailable in read-only CLI mode" }, 403)
      const { sessionId, expectedRevision } = c.req.valid("json")
      const result = ensureSessionPreview(sessionId, expectedRevision)
      return result.ok ? c.json(result) : c.json({ error: result.error.message, backendError: result.error }, 409)
    })
    .get("/api/save-approvals", (c) => {
      const { saveGrants, saveApprovalsEnabled } = readState()
      return c.json({ enabled: saveApprovalsEnabled, ownerVerified: saveApprovalsEnabled && ownerVerified(c), approvals: saveApprovalsEnabled ? saveGrants.list() : [] })
    })
    .post("/api/save-approvals/owner-session", (c) => {
      const { approvalToken, ownerSessions, saveApprovalsEnabled } = readState()
      if (!saveApprovalsEnabled) return c.json({ error: "Owner verification is unavailable in read-only mode" }, 403)
      if (!tokensMatch(c.req.header("x-maker-approval-token"), approvalToken)) return c.json({ error: "Host owner approval token required; the MCP token cannot verify ownership" }, 403)
      if (ownerVerified(c)) return c.json({ ownerVerified: true })
      if (ownerSessions.size >= MAX_OWNER_SESSIONS) return c.json({ error: "Owner session limit reached; lock an existing browser session or restart Host" }, 503)
      const session = randomBytes(24).toString("base64url")
      ownerSessions.add(session)
      setCookie(c, OWNER_COOKIE_NAME, session, { httpOnly: true, sameSite: "Strict", path: OWNER_COOKIE_PATH })
      return c.json({ ownerVerified: true })
    })
    .delete("/api/save-approvals/owner-session", (c) => {
      if (c.req.header("origin") !== readState().origin) return c.json({ error: "Same-origin owner session required" }, 403)
      readState().ownerSessions.delete(getCookie(c, OWNER_COOKIE_NAME) ?? "")
      deleteCookie(c, OWNER_COOKIE_NAME, { path: OWNER_COOKIE_PATH })
      return c.json({ ownerVerified: false })
    })
    .post("/api/save-approvals/:approvalRequestId/decision", zValidator("json", z.object({ decision: z.enum(["approve", "approve-session", "reject", "revoke"]) }).strict()), (c) => {
      const { saveGrants, saveApprovalsEnabled } = readState()
      if (!saveApprovalsEnabled) return c.json({ error: "Save approvals are unavailable in read-only mode" }, 403)
      // Cookie decisions need an exact Origin; normal bearer/cookie auth cannot create owner authority.
      if (!canApprove(c)) return c.json({ error: "Verify Host ownership in Workbench before changing save permissions" }, 403)
      const result = saveGrants.decide(c.req.param("approvalRequestId"), c.req.valid("json").decision)
      return "error" in result ? c.json({ error: result.error }, result.status) : c.json(result)
    })
    .get("/api/projects", (c) => {
      const { projects } = readState()
      return c.json({ projects: [...projects.values()] })
    })
    .post("/api/projects", zValidator("json", projectRegistrationSchema), (c) => {
      const { origin, projects } = readState()
      const input = c.req.valid("json")
      const existing = [...projects.values()].find((project) => project.bindingId === input.bindingId)
      if (existing) {
        if (existing.sourceOwner !== "browser") return c.json({ error: "Host snapshots cannot be replaced by browser bindings" }, 403)
        if (Object.entries(input).some(([key, value]) => existing[key as keyof RegisteredProject] !== value)) {
          return c.json({ error: "Binding already registered. Use the revision-checked project refresh endpoint." }, 409)
        }
        return c.json({ project: existing }, 200)
      }

      const now = new Date().toISOString()
      const projectId = `project_${randomUUID()}`
      const project: RegisteredProject = {
        ...input,
        projectId,
        revision: 1,
        sourceOwner: "browser",
        access: "read-only",
        status: "ready",
        viewerUrl: `${origin}/projects/${projectId}/viewer`,
        assetManagerUrl: `${origin}/projects/${projectId}/assets`,
        createdAt: now,
        updatedAt: now,
      }
      projects.set(projectId, project)
      return c.json({ project }, 201)
    })
    .get("/api/projects/:projectId", (c) => {
      const project = readState().projects.get(c.req.param("projectId"))
      return project ? c.json({ project }) : c.json({ error: "Project not found" }, 404)
    })
    .get("/api/projects/:projectId/session-state", zValidator("query", z.object({ sourceRevision: z.string().regex(/^[a-f0-9]{64}$/) }).strict()), (c) => {
      const { projects, runtime } = readState()
      const project = projects.get(c.req.param("projectId"))
      if (!project?.backendSession) return c.json({ error: "Session preview not found" }, 404)
      if (project.sourceRevision !== c.req.valid("query").sourceRevision) return c.json({ error: "session_preview_stale: refresh the preview" }, 409)
      const result = sessionPreviewResult(runtime, project.backendSession.sessionId, project.backendSession.revision)
      return result.ok ? c.json({ state: result.state }) : c.json({ error: result.error.message, backendError: result.error }, 409)
    })
    .get("/api/projects/:projectId/resource-bytes", zValidator("query", z.object({
      sourceRevision: z.string().regex(/^[a-f0-9]{64}$/), packageId: z.string().min(1).max(256), resourceId: z.string().min(1).max(256),
    }).strict()), (c) => {
      const { projects, runtime } = readState()
      const project = projects.get(c.req.param("projectId"))
      if (!project?.backendSession) return c.json({ error: "Session preview not found" }, 404)
      const { sourceRevision, packageId, resourceId } = c.req.valid("query")
      if (project.sourceRevision !== sourceRevision) return c.json({ error: "session_preview_stale: refresh the preview" }, 409)
      const result = runtime.readResourceBytes({ sessionId: project.backendSession.sessionId, expectedRevision: project.backendSession.revision, selector: { packageId, resourceId } })
      if (!result.ok) return c.json({ error: result.error.message, backendError: result.error }, 409)
      c.header("Content-Type", "application/octet-stream")
      c.header("Content-Disposition", "attachment")
      c.header("Content-Security-Policy", "default-src 'none'; sandbox")
      c.header("Content-Length", String(result.data.sourceBytes.byteLength))
      return c.body(Uint8Array.from(result.data.sourceBytes).buffer)
    })
    .post("/api/projects/:projectId/refresh", zValidator("json", z.object({
      bindingId: z.uuid(), fairyguiProjectId: z.string().min(1).max(128),
      expectedSourceRevision: z.string().regex(/^[a-f0-9]{64}$/), nextSourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
    }).strict()), (c) => {
      const { projects, assetAnalyses, renderBroker } = readState()
      const projectId = c.req.param("projectId"), input = c.req.valid("json")
      const current = projects.get(projectId)
      if (!current) return c.json({ error: "Project not found" }, 404)
      if (current.sourceOwner !== "browser") return c.json({ error: "Host snapshots are immutable; reopen through the CLI to read new content" }, 403)
      if (current.bindingId !== input.bindingId || current.fairyguiProjectId !== input.fairyguiProjectId || current.sourceRevision !== input.expectedSourceRevision) {
        return c.json({ error: "Project binding or revision changed. Read the current project and retry." }, 409)
      }
      if (current.sourceRevision === input.nextSourceRevision) return c.json({ project: current })
      const project = { ...current, sourceRevision: input.nextSourceRevision, revision: current.revision + 1, updatedAt: new Date().toISOString() }
      projects.set(projectId, project)
      assetAnalyses.delete(projectId)
      renderBroker.invalidateProject(projectId)
      return c.json({ project })
    })
    .delete("/api/projects/:projectId", zValidator("query", z.object({ bindingId: z.uuid(), expectedRevision: z.coerce.number().int().positive() }).strict()), (c) => {
      const { projects, projectSources, assetAnalyses, renderBroker } = readState()
      const projectId = c.req.param("projectId"), input = c.req.valid("query")
      const project = projects.get(projectId)
      if (!project) return c.json({ error: "Project not found" }, 404)
      if (project.bindingId !== input.bindingId || project.revision !== input.expectedRevision) return c.json({ error: "Project binding or revision changed. Reload before removing." }, 409)
      projects.delete(projectId)
      projectSources.delete(projectId)
      assetAnalyses.delete(projectId)
      renderBroker.invalidateProject(projectId)
      return c.json({ removed: true })
    })
    .get("/api/projects/:projectId/asset-analysis", (c) => {
      const analysis = readState().assetAnalyses.get(c.req.param("projectId"))
      return analysis ? c.json({ analysis }) : c.json({ error: "Project asset analysis not found" }, 404)
    })
    .put("/api/projects/:projectId/asset-analysis", zValidator("json", assetAnalysisSchema), (c) => {
      const { projects, assetAnalyses } = readState()
      const projectId = c.req.param("projectId")
      const project = projects.get(projectId)
      if (!project) return c.json({ error: "Project not found" }, 404)
      if (project.sourceOwner === "session") return c.json({ error: "Session previews do not provide full-project asset analysis" }, 409)
      const analysis = c.req.valid("json")
      if (analysis.projectId !== projectId || analysis.sourceRevision !== project.sourceRevision) {
        return c.json({ error: "Asset analysis does not match the current project revision" }, 409)
      }
      assetAnalyses.set(projectId, analysis)
      return c.json({ analysis })
    })
    .get("/api/projects/:projectId/source-index", (c) => {
      const source = readState().projectSources.get(c.req.param("projectId"))
      if (source && c.req.query("sourceRevision") && c.req.query("sourceRevision") !== source.sourceRevision) return c.json({ error: "Project source revision changed" }, 409)
      return source
        ? c.json({ sourceRevision: source.sourceRevision, files: source.listFiles() })
        : c.json({ error: "Host project source not found" }, 404)
    })
    .get(
      "/api/projects/:projectId/source-file",
      zValidator("query", z.object({ path: z.string().min(1).max(1_024), sourceRevision: z.string().regex(/^[a-f0-9]{64}$/).optional() })),
      (c) => {
        try {
          const source = readState().projectSources.get(c.req.param("projectId"))
          const query = c.req.valid("query")
          if (source && query.sourceRevision && query.sourceRevision !== source.sourceRevision) return c.json({ error: "Project source revision changed" }, 409)
          const data = source?.readFile(query.path)
          if (!data) return c.json({ error: "Host project file not found" }, 404)
          c.header("Content-Type", "application/octet-stream")
          c.header("Content-Disposition", "attachment")
          c.header("Content-Security-Policy", "default-src 'none'; sandbox")
          c.header("Content-Length", String(data.byteLength))
          return c.body(Uint8Array.from(data).buffer)
        } catch (error) {
          return c.json({ error: formatPublicError(error) }, 400)
        }
      },
    )
    .post("/api/renderers", zValidator("json", rendererRegistrationSchema), (c) => {
      const session = readState().renderBroker.registerRenderer(c.req.valid("json"))
      return session ? c.json({ session }, 201) : c.json({ error: "Render source not found" }, 404)
    })
    .get("/api/render-sessions/:renderSessionId", (c) => {
      const session = readState().renderBroker.getSession(c.req.param("renderSessionId"))
      return session ? c.json({ session }) : c.json({ error: readState().renderBroker.getSessionError(c.req.param("renderSessionId")) }, 404)
    })
    .delete("/api/render-sessions/:renderSessionId", (c) => {
      readState().renderBroker.disconnectRenderer(c.req.param("renderSessionId"))
      return c.body(null, 204)
    })
    .post("/api/render-sessions/:renderSessionId/commands", zValidator("json", renderSessionCommandSchema), async (c) => {
      const broker = readState().renderBroker
      const id = c.req.param("renderSessionId")
      try {
        const pending = broker.executeCommand(id, c.req.valid("json"))
        return pending ? c.json({ result: await pending, session: broker.getSession(id) }) : c.json({ error: broker.getSessionError(id) }, 404)
      } catch (error) {
        const message = formatPublicError(error)
        return c.json({ error: message, session: broker.getSession(id) }, /(?:conflict|not_reached):/.test(message) ? 409 : 422)
      }
    })
    .get(
      "/api/render-sessions/:renderSessionId/commands",
      zValidator("query", z.object({ after: z.coerce.number().int().nonnegative().default(0) })),
      async (c) => {
        const result = await readState().renderBroker.readCommands(
          c.req.param("renderSessionId"),
          c.req.valid("query").after,
          c.req.raw.signal,
        )
        return result ? c.json(result) : c.json({ error: readState().renderBroker.getSessionError(c.req.param("renderSessionId")) }, 404)
      },
    )
    .post(
      "/api/render-sessions/:renderSessionId/results",
      zValidator("json", rendererResultSchema),
      (c) => {
        const input = c.req.valid("json")
        try {
          return readState().renderBroker.submitResult(c.req.param("renderSessionId"), input)
            ? c.json({ accepted: true, commandSeq: input.commandSeq, requestId: input.requestId, session: readState().renderBroker.getSession(c.req.param("renderSessionId")) })
            : c.json({ error: readState().renderBroker.getSessionError(c.req.param("renderSessionId")) }, 404)
        } catch (error) {
          return c.json({ error: formatPublicError(error) }, 409)
        }
      },
    )
    .post(
      "/api/render-sessions/:renderSessionId/interactions",
      zValidator("json", rendererInteractionSchema),
      (c) => {
        try {
          const session = readState().renderBroker.recordInteraction(c.req.param("renderSessionId"), c.req.valid("json"))
          return session ? c.json({ accepted: true, runtimeEventSeq: c.req.valid("json").runtimeEventSeq, session }) : c.json({ error: readState().renderBroker.getSessionError(c.req.param("renderSessionId")) }, 404)
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
        }
      },
    )
    .post(
      "/api/artifact-imports",
      zValidator("json", z.object({
        name: z.string().trim().min(1).max(200),
        source: artifactSourceSchema.default({ kind: "published-folder" }),
        files: z.array(z.object({ path: z.string().min(1).max(1_024), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(5_000),
      }).strict()),
      async (c) => {
        try {
          return c.json(await readState().artifactStore.createImport(c.req.valid("json")), 201)
        } catch (error) {
          return c.json({ error: formatPublicError(error) }, error instanceof UploadError ? error.status : 400)
        }
      },
    )
    .put(
      "/api/artifact-imports/:importId/files",
      zValidator("query", z.object({ path: z.string().min(1).max(1_024) })),
      async (c) => {
        try {
          const result = await readState().artifactStore.writeImportFile(c.req.param("importId"), c.req.valid("query").path, c.req.raw.body, c.req.raw.signal)
          return result ? c.json(result) : c.json({ error: "Artifact import not found" }, 404)
        } catch (error) {
          return c.json({ error: formatPublicError(error) }, error instanceof UploadError ? error.status : 400)
        }
      },
    )
    .post("/api/artifact-imports/:importId/complete", async (c) => {
      try {
        const artifact = await readState().artifactStore.completeImport(c.req.param("importId"), readState().origin)
        return artifact ? c.json({ artifact }, 201) : c.json({ error: "Artifact import not found" }, 404)
      } catch (error) {
        return c.json({ error: formatPublicError(error) }, error instanceof UploadError ? error.status : 400)
      }
    })
    .delete("/api/artifact-imports/:importId", async (c) => {
      try {
        const removed = await readState().artifactStore.cancelImport(c.req.param("importId"))
        return removed ? c.body(null, 204) : c.json({ error: "Artifact import not found" }, 404)
      } catch (error) {
        return c.json({ error: formatPublicError(error) }, error instanceof UploadError ? error.status : 400)
      }
    })
    .get(
      "/api/artifacts",
      zValidator("query", z.object({ limit: z.coerce.number().int().min(1).max(100).default(50) })),
      (c) => c.json({ artifacts: readState().artifactStore.list(c.req.valid("query").limit) }),
    )
    .get("/api/artifacts/:artifactId", zValidator("query", z.object({ importId: z.string().min(1).max(128).optional() })), (c) => {
      const artifact = readState().artifactStore.get(c.req.param("artifactId"), c.req.valid("query").importId)
      return artifact ? c.json({ artifact }) : c.json({ error: "Artifact not found" }, 404)
    })
    .get("/api/artifacts/:artifactId/import-records", zValidator("query", z.object({ cursor: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) })), (c) => {
      const { cursor, limit } = c.req.valid("query")
      const result = readState().artifactStore.importRecords(c.req.param("artifactId"), cursor, limit)
      return result ? c.json(result) : c.json({ error: "Artifact not found" }, 404)
    })
    .get("/api/artifacts/:artifactId/components", zValidator("query", z.object({ cursor: z.coerce.number().int().min(0).max(50_000).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) })), (c) => {
      const { cursor, limit } = c.req.valid("query")
      const result = readState().artifactStore.components(c.req.param("artifactId"), cursor, limit)
      return result ? c.json(result) : c.json({ error: "Artifact not found" }, 404)
    })
    .get("/api/artifacts/:artifactId/files/*", async (c) => {
      try {
        const filePath = c.req.path.split(`/api/artifacts/${c.req.param("artifactId")}/files/`)[1] ?? ""
        const file = await readState().artifactStore.readFile(c.req.param("artifactId"), decodeURIComponent(filePath), c.req.raw.signal)
        if (!file) return c.json({ error: "Artifact file not found" }, 404)
        const { data, metadata } = file
        c.header("Content-Type", "application/octet-stream")
        c.header("Content-Disposition", "attachment")
        c.header("Content-Security-Policy", "default-src 'none'; sandbox")
        c.header("Content-Length", String(data.byteLength))
        c.header("ETag", `"${metadata.sha256}"`)
        c.header("Cache-Control", "no-store")
        return c.body(data)
      } catch (error) {
        return c.json({ error: formatPublicError(error) }, error instanceof UploadError ? error.status : 400)
      }
    })
}

export async function startMakerHost(options: StartMakerHostOptions = {}) {
  await access(resolve(WEB_DIST, "index.html")).catch(() => {
    throw new Error("FairyGUI Maker web assets are missing. Reinstall the package or run `pnpm build`.")
  })
  // Only installed build outputs are anonymous/CORS-readable; never user uploads or APIs.
  const publicAssets = new Set([
    ...(await readdir(resolve(WEB_DIST, "assets"), { withFileTypes: true })).filter((entry) => entry.isFile()).map(({ name }) => `/assets/${name}`),
    "/viewer-runtime/laya.core.js", "/viewer-runtime/laya.webgl_2D.js", "/viewer-runtime/fairygui.js",
  ])
  const parsed = hostOptionsSchema.parse({
    port: options.port ?? Number(process.env.FAIRYGUI_MAKER_PORT ?? 3847),
    token: options.token ?? process.env.FAIRYGUI_MAKER_TOKEN,
    approvalToken: options.approvalToken ?? process.env.FAIRYGUI_MAKER_APPROVAL_TOKEN,
  })
  const host = "127.0.0.1"
  const token = parsed.token ?? randomBytes(24).toString("base64url")
  const approvalToken = parsed.approvalToken ?? randomBytes(24).toString("base64url")
  if (tokensMatch(approvalToken, token)) throw new Error("FAIRYGUI_MAKER_APPROVAL_TOKEN must differ from FAIRYGUI_MAKER_TOKEN")
  const startedAt = new Date().toISOString()
  const backendSessions = new Map<string, BackendSession>()
  const backendActivity: BackendActivity[] = []
  const mcpSessions = new Map<string, McpSession>()
  const projects = new Map<string, RegisteredProject>()
  const projectSources = new Map<string, HostProjectSnapshot>()
  const assetAnalyses = new Map<string, ProjectAssetAnalysis>()
  const projectSource = options.projectPath ? await createHostProjectSnapshot(options.projectPath) : null
  const dataDir = resolve(options.dataDir ?? process.env.FAIRYGUI_MAKER_DATA_DIR ?? ".fairygui-maker")
  const artifactStore = new ArtifactStore(dataDir)
  const importDraftStore = new ImportDraftStore(dataDir)
  await artifactStore.init()
  await importDraftStore.init()
  const renderBroker = new ViewerRenderBroker((projectId) => projects.get(projectId), (artifactId) => artifactStore.get(artifactId))
  const allowedProjectRoot = await realpath(options.projectPath ?? process.cwd())
  const backend = options.runtime ?? createNodeBackendRuntime({
    allowedProjectRoots: [allowedProjectRoot], fileSystem: await createHostBackendFileSystem(dataDir),
  })
  const saveGrants = new HostSaveGrants(backend)
  const ownerSessions = new Set<string>()
  const savePolicy = (operation: "saveSession" | "materializeSession"): OpenFairyGuiMcpToolPolicy => ({
    failureSchema: saveGrantFailureSchema,
    beforeCall(input) {
      const failure = saveGrants.authorize(operation, input)
      if (failure) trackBackendResult(backendSessions, backendActivity, operation, input, failure)
      return failure
    },
  })
  const runtime = createTrackedRuntime(backend, backendSessions, backendActivity, saveGrants, (method, input, result) => {
    if (!result?.ok || !["openSession", "openProjectSession", "applyTransaction", "saveSession", "materializeSession", "closeSession"].includes(method)) return
    const sessionId = result.data?.sessionId ?? input?.sessionId
    for (const project of projects.values()) {
      if (project.backendSession?.sessionId !== sessionId) continue
      if (["openSession", "openProjectSession", "closeSession"].includes(method)) projects.delete(project.projectId)
      else projects.set(project.projectId, advanceSessionPreview(project, result.data))
      assetAnalyses.delete(project.projectId)
      renderBroker.invalidateProject(project.projectId)
    }
  })
  const viewOnly = projectSource !== null
  const app = new Hono()
  let origin = ""
  let allowedHosts = new Set<string>()
  let allowedOrigins = new Set<string>()
  let closing = false
  let pendingMcpSessions = 0

  const ensureSessionPreview = (sessionId: string, expectedRevision: number) => {
    const result = sessionPreviewResult(runtime, sessionId, expectedRevision)
    if (!result.ok) return result
    const existing = [...projects.values()].find((project) => project.backendSession?.sessionId === sessionId)
    if (existing && existing.backendSession?.revision === result.state.revision && existing.backendSession.dirty === result.state.dirty
      && existing.backendSession.lastSavedRevision === result.state.lastSavedRevision) return { ok: true as const, project: existing }
    const now = new Date().toISOString()
    const projectId = existing?.projectId ?? `project_${randomUUID()}`
    const project = advanceSessionPreview({
      projectId, bindingId: existing?.bindingId ?? randomUUID(), fairyguiProjectId: result.state.project.projectId,
      name: backendSessions.get(sessionId)?.projectName ?? "Backend session", directoryName: "Backend session", fairyPath: "",
      revision: existing?.revision ?? 0, sourceRevision: "", sourceOwner: "session", access: "read-only", status: "ready",
      viewerUrl: `${origin}/projects/${projectId}/viewer`, assetManagerUrl: "", createdAt: existing?.createdAt ?? now, updatedAt: now,
    }, result.state)
    projects.set(projectId, project)
    renderBroker.invalidateProject(projectId)
    return { ok: true as const, project }
  }

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

  const previewProjectId = (draftId: string) => `project_${draftId.slice("draft_".length)}`
  const draftPreviewGenerations = new Map<string, string>()
  const ensureDraftPreview = async (draftId: string) => {
    const projectId = previewProjectId(draftId)
    const draft = importDraftStore.get(draftId)
    const generatedRoot = importDraftStore.getGeneratedProjectPath(draftId)
    if (!draft?.generated || !generatedRoot) throw new Error("Import draft has not been compiled")
    const existing = projects.get(projectId)
    if (existing && draftPreviewGenerations.get(projectId) === generatedRoot) return existing
    if (existing) removeDraftPreview(draftId)
    const source = await createHostProjectSnapshot(generatedRoot)
    if (importDraftStore.getGeneratedProjectPath(draftId) !== generatedRoot) throw new Error("Import draft generation changed during preview loading")
    const now = new Date().toISOString()
    const project: RegisteredProject = {
      projectId,
      fairyguiProjectId: source.fairyguiProjectId,
      bindingId: draftId.slice("draft_".length),
      name: `${draft.input.name} Preview`,
      directoryName: "Import Draft",
      fairyPath: source.fairyPath,
      revision: 1,
      sourceRevision: source.sourceRevision,
      sourceOwner: "host",
      access: "read-only",
      status: "ready",
      viewerUrl: `${origin}/projects/${projectId}/viewer`,
      assetManagerUrl: `${origin}/projects/${projectId}/assets`,
      createdAt: now,
      updatedAt: now,
    }
    projects.set(projectId, project)
    projectSources.set(projectId, source)
    draftPreviewGenerations.set(projectId, generatedRoot)
    return project
  }
  const removeDraftPreview = (draftId: string) => {
    const projectId = previewProjectId(draftId)
    projects.delete(projectId)
    projectSources.delete(projectId)
    draftPreviewGenerations.delete(projectId)
    assetAnalyses.delete(projectId)
    renderBroker.invalidateProject(projectId)
  }

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store")
    if (closing) return c.json({ error: "Host is closing" }, 503)
    c.header("Content-Security-Policy", "default-src 'self' blob:; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self'; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'")
    c.header("Referrer-Policy", "no-referrer")
    c.header("X-Content-Type-Options", "nosniff")
    c.header("X-Frame-Options", "SAMEORIGIN")

    if (!allowedHosts.has((c.req.header("host") ?? "").toLowerCase())) {
      return c.json({ error: "Invalid Host header" }, 403)
    }
    const runtimePage = /^\/(viewer|player)-runtime\.html$/.test(c.req.path)
    if ((c.req.method === "GET" || c.req.method === "HEAD") && (publicAssets.has(c.req.path) || runtimePage)) {
      if (runtimePage) {
        const assetOrigin = new URL(c.req.url).origin
        c.header("Content-Security-Policy", `default-src 'none'; sandbox allow-scripts; script-src ${assetOrigin}/assets/ ${assetOrigin}/viewer-runtime/; style-src 'unsafe-inline'; img-src blob: data:; media-src blob:; font-src blob: data:; connect-src blob:; worker-src blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`)
      } else {
        c.header("Access-Control-Allow-Origin", "*")
      }
      await next()
      return
    }
    const requestOrigin = c.req.header("origin")
    if (requestOrigin && !allowedOrigins.has(requestOrigin)) {
      return c.json({ error: "Invalid Origin header" }, 403)
    }
    const url = new URL(c.req.url)
    const queryToken = url.searchParams.get("token")
    if (c.req.method === "GET" && tokensMatch(queryToken, token)) {
      url.searchParams.delete("token")
      setCookie(c, COOKIE_NAME, token, { httpOnly: true, sameSite: "Strict", path: "/" })
      return c.redirect(`${url.pathname}${url.search}`)
    }

    // Opaque frames also make GET/no-cors/navigation requests without an Origin header.
    // A valid explicit bootstrap token above is allowed; Cookie alone is not.
    const site = c.req.header("sec-fetch-site")
    if (site && site !== "same-origin" && site !== "none") return c.json({ error: "Cross-origin Host access denied" }, 403)

    const authorization = c.req.header("authorization")
    const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined
    if (!tokensMatch(bearer, token) && !tokensMatch(getCookie(c, COOKIE_NAME), token)) {
      return c.json({ error: "Authentication required" }, 401)
    }
    await next()
  })

  app.use("*", uploadLimits())

  app.all("/mcp", async (c) => {
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
      const server = viewOnly
        ? new McpServer({ name: "fairygui-maker", version: PACKAGE_VERSION }, { instructions: VIEW_ONLY_INSTRUCTIONS })
        : createOpenFairyGuiMcpServer({ runtime, name: "fairygui-maker", version: PACKAGE_VERSION, instructions: HOST_INSTRUCTIONS, toolPolicies: {
          openfairygui_backend_save_session: savePolicy("saveSession"),
          openfairygui_backend_materialize_session: savePolicy("materializeSession"),
        } })
      registerViewerMcpTools(
        server,
        renderBroker,
        (projectId) => projects.get(projectId),
        (artifactId) => artifactStore.get(artifactId),
        () => artifactStore.list(artifactStore.count()).map(({ artifactId }) => artifactStore.get(artifactId)!),
        () => [...projects.values()],
        (projectId) => assetAnalyses.get(projectId),
      )
      if (!viewOnly) server.registerTool("open_session_preview", {
        title: "Open an unsaved Backend session in Viewer",
        description: "Create a read-only Viewer source for an explicit Backend session revision. Uses public session-model and resource-byte reads; does not save files or request a Save Grant. Open viewerUrl in a browser, then use the existing Viewer tools. Edits and saves invalidate the previous renderer.",
        inputSchema: sessionPreviewInput,
        annotations: { readOnlyHint: true },
      }, async ({ sessionId, expectedRevision }) => {
        const result = ensureSessionPreview(sessionId, expectedRevision)
        const value = result.ok ? { ok: true, project: result.project, browserRequired: !renderBroker.getViewerRenderer(result.project.projectId) } : result
        return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: !result.ok }
      })
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
  })

  registerApi(app, () => ({
    origin,
    startedAt,
    mcpSessions,
    backendSessions,
    backendActivity,
    projects,
    projectSources,
    assetAnalyses,
    renderBroker,
    artifactStore,
    importDraftStore,
    importsEnabled: !viewOnly,
    saveGrants,
    approvalToken,
    ownerSessions,
    saveApprovalsEnabled: !viewOnly,
    runtime,
    ensureSessionPreview,
    ensureDraftPreview,
    removeDraftPreview,
  }))

  app.get("/assets/*", serveStatic({ root: WEB_DIST }))
  app.get("/viewer-runtime/*", serveStatic({ root: WEB_DIST }))
  app.get("/viewer-runtime.html", serveStatic({ root: WEB_DIST, path: "viewer-runtime.html" }))
  app.get("/player-runtime.html", serveStatic({ root: WEB_DIST, path: "player-runtime.html" }))
  const indexFile = serveStatic({ root: WEB_DIST, path: "index.html" })
  app.get("/", indexFile)
  app.get("/viewer", indexFile)
  app.get("/player", indexFile)
  app.get("/asset-manager", indexFile)
  app.get("/design-import", indexFile)
  app.get("/imports/:draftId", indexFile)
  app.get("/artifacts/:artifactId/player", indexFile)
  app.get("/projects/:projectId/viewer", indexFile)
  app.get("/projects/:projectId/assets", indexFile)
  app.notFound((c) => c.json({ error: "Not found" }, 404))
  app.onError((error, c) => {
    if (error instanceof UploadError) return c.json({ error: error.message }, error.status)
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status)
    logger.error({ err: error, method: c.req.method, path: c.req.path }, "Maker Host request failed")
    return c.json({ error: "Internal server error" }, 500)
  })

  let httpServer!: ServerType
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    httpServer = serve({ fetch: app.fetch, hostname: host, port: parsed.port }, resolve)
    httpServer.once("error", reject)
  })
  origin = `http://${host}:${address.port}`
  artifactStore.setOrigin(origin)
  allowedHosts = new Set([`${host}:${address.port}`, `localhost:${address.port}`])
  allowedOrigins = new Set([origin, `http://localhost:${address.port}`])
  const uploadCleanup = setInterval(() => {
    renderBroker.pruneExpiredSessions()
    saveGrants.prune()
    void Promise.allSettled([pruneMcpSessions(), artifactStore.pruneExpiredImports(), importDraftStore.pruneExpiredUploads()])
  }, 60_000)
  uploadCleanup.unref()

  const project = projectSource ? {
    projectId: `project_${randomUUID()}`,
    fairyguiProjectId: projectSource.fairyguiProjectId,
    bindingId: randomUUID(),
    name: projectSource.name,
    directoryName: projectSource.rootName,
    fairyPath: projectSource.fairyPath,
    revision: 1,
    sourceRevision: projectSource.sourceRevision,
    sourceOwner: "host" as const,
    access: "read-only" as const,
    status: "ready" as const,
    viewerUrl: "",
    assetManagerUrl: "",
    createdAt: startedAt,
    updatedAt: startedAt,
  } : null
  if (project && projectSource) {
    project.viewerUrl = `${origin}/projects/${project.projectId}/viewer`
    project.assetManagerUrl = `${origin}/projects/${project.projectId}/assets`
    projects.set(project.projectId, project)
    projectSources.set(project.projectId, projectSource)
  }

  return {
    origin,
    token,
    approvalToken,
    project,
    async close() {
      if (closing) return
      closing = true
      clearInterval(uploadCleanup)
      saveGrants.close()
      ownerSessions.clear()
      await Promise.all([artifactStore.close(), importDraftStore.close()])
      renderBroker.close()
      await Promise.allSettled([...mcpSessions.values()].map((record) => record.server.close()))
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()))
    },
  }
}

function formatPublicError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export type AppType = ReturnType<typeof registerApi>

export function readCliArguments(argv: string[]) {
  let port: number | undefined
  let dataDir: string | undefined
  let outputPath: string | undefined
  let dryRun = false
  let applyDigest: string | undefined
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") continue
    if (argument === "--help" || argument === "-h") return { help: true as const }
    if (argument === "--version" || argument === "-v") return { version: true as const }
    if (argument === "--port") {
      port = Number(argv[++index])
      continue
    }
    if (argument === "--data-dir") {
      dataDir = argv[++index]
      if (!dataDir) throw new Error("--data-dir requires a path")
      continue
    }
    if (argument === "--out") {
      outputPath = argv[++index]
      if (!outputPath) throw new Error("--out requires a path")
      continue
    }
    if (argument === "--dry-run") {
      dryRun = true
      continue
    }
    if (argument === "--apply") {
      if (applyDigest !== undefined) throw new Error("--apply may only be specified once")
      applyDigest = argv[++index]
      if (!applyDigest || !/^[a-f0-9]{64}$/.test(applyDigest)) throw new Error("--apply requires the planDigest from a fresh --dry-run")
      continue
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`)
    positional.push(argument)
  }
  if (positional[0] === "import") {
    if (applyDigest !== undefined) throw new Error("--apply requires a reimport command")
    if (port !== undefined) {
      throw new Error("Usage: fairygui-maker import <source.fig|source.psd|bundle-directory> --out <new-directory>")
    }
    if (positional[1] === "inspect") {
      if (positional.length !== 3 || outputPath !== undefined || dryRun) {
        throw new Error("Usage: fairygui-maker import inspect <source.fig|source.psd|bundle-directory> [--data-dir <path>]")
      }
      return { help: false as const, importAction: "inspect" as const, importSource: positional[2]!, ...(dataDir ? { dataDir } : {}) }
    }
    if (positional[1] === "plan") {
      if (positional.length !== 3 || !outputPath || dryRun) {
        throw new Error("Usage: fairygui-maker import plan <source.fig|source.psd|bundle-directory> --out <plan.json> [--data-dir <path>]")
      }
      return { help: false as const, importAction: "plan" as const, importSource: positional[2]!, outputPath, ...(dataDir ? { dataDir } : {}) }
    }
    const importSource = positional[1]
    if (positional.length !== 2 || !importSource || dryRun === (outputPath !== undefined)) {
      throw new Error("Usage: fairygui-maker import <source.fig|source.psd|bundle-directory> (--out <new-directory> | --dry-run) [--data-dir <path>]")
    }
    return {
      help: false as const,
      importSource,
      ...(outputPath ? { outputPath } : {}),
      ...(dataDir ? { dataDir } : {}),
      ...(dryRun ? { dryRun: true as const } : {}),
    }
  }
  if (positional[0] === "reimport") {
    if (positional.length !== 2 || dryRun === (applyDigest !== undefined) || outputPath !== undefined || port !== undefined) {
      throw new Error("Usage: fairygui-maker reimport <project-directory> (--dry-run | --apply <planDigest>) [--data-dir <path>]")
    }
    return { help: false as const, reimportPath: positional[1]!, ...(dryRun ? { dryRun: true as const } : { applyDigest: applyDigest! }), ...(dataDir ? { dataDir } : {}) }
  }
  if (applyDigest !== undefined) throw new Error("--apply requires a reimport command")
  if (outputPath !== undefined || dryRun) throw new Error("--out and --dry-run require an import or reimport command")
  if (positional.length === 0) return { help: false as const, port, dataDir, projectPath: undefined }
  if (positional[0] !== "view" || positional.length !== 2) throw new Error("Usage: fairygui-maker view <project-path> [--port <port>] [--data-dir <path>]")
  return { help: false as const, port, dataDir, projectPath: positional[1] }
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = readCliArguments(argv)
  if ("version" in options) {
    process.stdout.write(`${PACKAGE_VERSION}\n`)
    return null
  }
  if (options.help) {
    process.stdout.write(`Usage:
  fairygui-maker [view <project-path>] [--port <port>] [--data-dir <path>]
  fairygui-maker import <source.fig|source.psd|bundle-directory> --out <new-directory> [--data-dir <path>]
  fairygui-maker import <source.fig|source.psd|bundle-directory> --dry-run [--data-dir <path>]
  fairygui-maker import inspect <source.fig|source.psd|bundle-directory> [--data-dir <path>]
  fairygui-maker import plan <source.fig|source.psd|bundle-directory> --out <plan.json> [--data-dir <path>]
  fairygui-maker reimport <project-directory> --dry-run [--data-dir <path>]
  fairygui-maker reimport <project-directory> --apply <planDigest> [--data-dir <path>]

Options:
  --out <path>       New project directory, or plan JSON for import plan
  --dry-run          Compile a draft or plan reimport changes without writing the target project
  --apply <digest>   Explicitly approve the exact reimport planDigest from --dry-run; conflicts and stale inputs are refused
  --port <port>      Localhost port (default: 3847)
  --data-dir <path>  Private artifact, draft, and runtime data directory (default: .fairygui-maker)
  --version          Print the installed Maker version

Environment: FAIRYGUI_MAKER_TOKEN, FAIRYGUI_MAKER_APPROVAL_TOKEN, FAIRYGUI_MAKER_PORT, FAIRYGUI_MAKER_DATA_DIR, FAIRYGUI_MAKER_LOG_LEVEL
Host save approval: verify ownership once in Workbench using the separate approval token, then allow ordinary saves for a project session or approve once. Force-save, explicit target paths and materialization still require one-time approval. Every save remains revision-checked.
CLI reimport approval: close the project in Host/editor, review --dry-run, then explicitly run --apply <planDigest>. This is a local owner command, not an MCP save approval bypass.
`)
    return null
  }
  if ("reimportPath" in options) {
    const fileSystem = await createHostBackendFileSystem(resolve(options.dataDir ?? process.env.FAIRYGUI_MAKER_DATA_DIR ?? ".fairygui-maker"))
    const result = "applyDigest" in options
      ? { ...await applyProjectReimport(options.reimportPath!, options.applyDigest!, fileSystem), applied: true }
      : await planProjectReimport(options.reimportPath!, fileSystem)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  if ("importSource" in options) {
    const dataDir = resolve(("dataDir" in options ? options.dataDir : undefined) ?? process.env.FAIRYGUI_MAKER_DATA_DIR ?? ".fairygui-maker")
    const drafts = new ImportDraftStore(dataDir)
    await drafts.init()
    let draft = await drafts.create(options.importSource!)
    draft = await drafts.parse(draft.draftId, draft.revision)
    if ("importAction" in options && options.importAction === "inspect") {
      process.stdout.write(`${JSON.stringify({ draft }, null, 2)}\n`)
      return draft
    }
    const planned = await drafts.plan(draft.draftId, draft.revision)
    draft = planned.draft
    if ("importAction" in options && options.importAction === "plan") {
      const planPath = resolve(options.outputPath!)
      await writeFile(planPath, `${JSON.stringify(planned.buildPlan, null, 2)}\n`, { flag: "wx" })
      const result = { draft, planPath }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return result
    }
    draft = await drafts.compile(draft.draftId, draft.revision)
    if ("dryRun" in options && options.dryRun) {
      process.stdout.write(`${JSON.stringify({ draft }, null, 2)}\n`)
      return draft
    }
    const materialized = await drafts.materialize(draft.draftId, draft.revision, options.outputPath!)
    const result = { ...materialized.result, draftId: draft.draftId, draftRevision: materialized.draft.revision }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  const configuredToken = process.env.FAIRYGUI_MAKER_TOKEN
  if (!configuredToken && !process.stdout.isTTY) {
    throw new Error("FAIRYGUI_MAKER_TOKEN is required when stdout is not an interactive terminal.")
  }
  const host = await startMakerHost(options)
  logger.info({ origin: host.origin, mcpEndpoint: `${host.origin}/mcp` }, "FairyGUI Maker started")
  process.stdout.write(`Maker Host: ${host.origin}\nMaker MCP: ${host.origin}/mcp\n`)
  if (!configuredToken) {
    process.stdout.write(`Open Maker Workbench: ${host.origin}/?token=${host.token}\n`)
    if (host.project) process.stdout.write(`Open Viewer: ${host.project.viewerUrl}?token=${host.token}\n`)
  } else {
    process.stdout.write(`Open Maker Workbench: ${host.origin}/\n`)
    if (host.project) process.stdout.write(`Open Viewer: ${host.project.viewerUrl}\n`)
  }
  if (!host.project) {
    if (!process.env.FAIRYGUI_MAKER_APPROVAL_TOKEN && process.stdout.isTTY) {
      process.stdout.write(`Host save approval token (owner only; do not give to MCP clients): ${host.approvalToken}\n`)
    } else {
      process.stdout.write(process.env.FAIRYGUI_MAKER_APPROVAL_TOKEN
        ? "Verify ownership once in Workbench with FAIRYGUI_MAKER_APPROVAL_TOKEN, then choose session or one-time save permission.\n"
        : "Host saves are blocked: restart interactively or set a separate FAIRYGUI_MAKER_APPROVAL_TOKEN for owner confirmation.\n")
    }
  }
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await host.close()
  }
  process.once("SIGINT", () => void stop())
  process.once("SIGTERM", () => void stop())
  return host
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    logger.error({ err: error }, "FairyGUI Maker failed to start")
    process.exitCode = 1
  })
}
