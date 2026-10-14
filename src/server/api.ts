import { randomBytes, randomUUID } from "node:crypto"
import { zValidator } from "@hono/zod-validator"
import type { OpenFairyGuiBackendRuntime } from "@openfairygui/mcp"
import type { Context, Hono } from "hono"
import { deleteCookie, getCookie, setCookie } from "hono/cookie"
import { z } from "zod"

import {
  ASSET_ANALYSIS_MAX_REFERENCES,
  ASSET_ANALYSIS_MAX_RESOURCES,
  ASSET_ANALYSIS_SCHEMA_VERSION,
  ASSET_ISSUE_KINDS,
  ASSET_RESOURCE_ID_PATTERN,
  type ProjectAssetAnalysis,
} from "../asset-analysis"
import type { ImportDraftStore } from "../design-import/draft-store"
import { UploadError } from "../upload"
import { type ArtifactStore, artifactSourceSchema } from "./artifacts"
import { MAX_OWNER_SESSIONS, OWNER_COOKIE_NAME, OWNER_COOKIE_PATH, tokensMatch } from "./auth"
import { publicBackendSession } from "./backend-tracking"
import { PACKAGE_VERSION } from "./host-config"
import type { BackendActivity, BackendSession, McpSession, RegisteredProject } from "./host-types"
import { registerImportDraftApi } from "./import-drafts"
import type { HostProjectSnapshot } from "./project-snapshot"
import type { HostSaveGrants } from "./save-grants"
import { sessionPreviewInput, sessionPreviewResult } from "./session-preview"
import {
  type ViewerRenderBroker,
  rendererInteractionSchema,
  rendererRegistrationSchema,
  rendererResultSchema,
  renderSessionCommandSchema,
} from "./viewer"

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

export function registerApi(
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
      return c.json({
        enabled: saveApprovalsEnabled, ownerVerified: saveApprovalsEnabled && ownerVerified(c), approvals: saveApprovalsEnabled ? saveGrants.list() : [],
        preauthorizedProjects: saveApprovalsEnabled ? saveGrants.preauthorized() : [],
      })
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
      const session = readState().renderBroker.registerRenderer(c.req.valid("json"), { userAgent: c.req.header("user-agent") })
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

function formatPublicError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export type AppType = ReturnType<typeof registerApi>
