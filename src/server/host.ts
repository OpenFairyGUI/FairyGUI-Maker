import { randomBytes, randomUUID } from "node:crypto"
import { access, readdir, realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { serve, type ServerType } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { createNodeBackendRuntime } from "@openfairygui/backend/node"
import { createOpenFairyGuiMcpServer, type OpenFairyGuiMcpToolPolicy } from "@openfairygui/mcp"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"

import type { ProjectAssetAnalysis } from "../asset-analysis"
import { ImportDraftStore } from "../design-import/draft-store"
import { UploadError } from "../upload"
import { registerApi } from "./api"
import { ArtifactStore } from "./artifacts"
import { hostGuard, tokensMatch } from "./auth"
import { createHostBackendFileSystem } from "./backend-files"
import { createTrackedRuntime, trackBackendResult } from "./backend-tracking"
import { HOST_INSTRUCTIONS, PACKAGE_VERSION, VIEW_ONLY_INSTRUCTIONS, WEB_DIST, logger } from "./host-config"
import type { BackendActivity, BackendSession, McpSession, RegisteredProject, StartMakerHostOptions } from "./host-types"
import { createMcpEndpoint } from "./mcp-endpoint"
import { createHostProjectSnapshot, type HostProjectSnapshot } from "./project-snapshot"
import { createSessionPublisher, sessionPublishInput } from "./publish"
import { createHeadlessBrowser } from "./headless-browser"
import { HostSaveGrants, saveGrantFailureSchema } from "./save-grants"
import { advanceSessionPreview, sessionPreviewInput, sessionPreviewResult } from "./session-preview"
import { uploadLimits } from "./upload-limits"
import { ViewerRenderBroker, registerViewerMcpTools, type RendererTarget } from "./viewer"

// A cold browser start plus LayaAir runtime boot; well under the MCP client timeout.
const HEADLESS_RENDERER_TIMEOUT_MS = 30_000

const hostOptionsSchema = z.object({
  port: z.number().int().min(0).max(65_535),
  token: z.string().min(24, "FAIRYGUI_MAKER_TOKEN must contain at least 24 characters").optional(),
  approvalToken: z.string().min(24, "FAIRYGUI_MAKER_APPROVAL_TOKEN must contain at least 24 characters").max(256).optional(),
})

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
  const publisher = createSessionPublisher({ runtime, artifactStore, workRoot: resolve(dataDir, "publishes") })
  await publisher.init()
  const app = new Hono()
  let origin = ""
  let allowedHosts = new Set<string>()
  let allowedOrigins = new Set<string>()
  let closing = false

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

  const headless = options.headless
    ? createHeadlessBrowser({ token, channel: options.headless === true ? undefined : options.headless.channel })
    : null
  const ensureRenderer = headless ? async (target: RendererTarget) => {
    const connected = () => "projectId" in target
      ? Boolean(renderBroker.getViewerRenderer(target.projectId)?.catalog)
      : Boolean(renderBroker.getSessionForArtifact(target.artifactId))
    if (connected()) return true
    let url: string | undefined
    if ("projectId" in target) {
      const project = projects.get(target.projectId)
      // Browser-authorized projects are read through the person's own directory handle, which a Host browser cannot use.
      if (!project || project.sourceOwner === "browser") return false
      url = project.viewerUrl
    } else url = artifactStore.get(target.artifactId)?.playerUrl
    if (!url) return false
    await headless.open(url)
    for (const deadline = Date.now() + HEADLESS_RENDERER_TIMEOUT_MS; Date.now() < deadline; await new Promise((done) => setTimeout(done, 100))) {
      if (connected()) return true
    }
    return false
  } : undefined

  const createMcpServer = () => {
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
      ensureRenderer,
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
    if (!viewOnly) server.registerTool("publish_artifact", {
      title: "Publish a saved Backend session as a Player artifact",
      description: "Publish the saved project of an explicit, clean Backend session revision with the Player's LayaAir profile and import the output as an immutable artifact (verification.source host-published). Save first; unsaved edits are refused. Writes only Maker's private data directory, never the project, and skips project plugins and code generation. Then open playerUrl in a browser and use the Player tools.",
      inputSchema: sessionPublishInput,
    }, async (input) => {
      const result = await publisher.publish(input)
      const value = result.ok ? {
        ok: true,
        artifact: {
          artifactId: result.artifact.artifactId, importId: result.artifact.importId, name: result.artifact.name, digest: result.artifact.digest,
          source: result.artifact.source, verification: result.artifact.verification, playerUrl: result.artifact.playerUrl,
          packages: result.artifact.packages.map(({ packageId, packageName, components }) => ({ packageId, packageName, components: components.length })),
        },
        browserRequired: !renderBroker.getSessionForArtifact(result.artifact.artifactId),
      } : result
      return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value, isError: !result.ok }
    })
    return server
  }
  const mcp = createMcpEndpoint(mcpSessions, createMcpServer)

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

  app.use("*", hostGuard({
    token,
    publicAssets,
    isClosing: () => closing,
    allowedHosts: () => allowedHosts,
    allowedOrigins: () => allowedOrigins,
  }))

  app.use("*", uploadLimits())

  app.all("/mcp", mcp.handle)

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
    void Promise.allSettled([mcp.prune(), artifactStore.pruneExpiredImports(), importDraftStore.pruneExpiredUploads()])
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
      // Its pages hold long-poll requests; close them before the HTTP server waits for connections.
      await headless?.close()
      saveGrants.close()
      ownerSessions.clear()
      await Promise.all([artifactStore.close(), importDraftStore.close()])
      renderBroker.close()
      await Promise.allSettled([...mcpSessions.values()].map((record) => record.server.close()))
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()))
    },
  }
}
