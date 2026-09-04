import { createHash, randomUUID } from "node:crypto"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { z } from "zod"

import {
  VIEWER_PROTOCOL_VERSION,
  MAX_RENDERER_INTERACTION_BYTES,
  type ViewerBrokerCommand,
  type ViewerInteractionEvent,
  type ViewerObservation,
  type ViewerProjectCatalog,
  type ViewerRendered,
  type ViewerViewState,
  type RenderCommandResult,
} from "../viewer-protocol"
import type { ArtifactManifest } from "../artifact-protocol"
import { assetResourceKey, summarizeAssetAnalysis, type ProjectAssetAnalysis } from "../asset-analysis"

const MAX_RENDER_REQUESTS_PER_SESSION = 256
const RENDER_SESSION_TTL_MS = 5 * 60_000

const viewerSetPropertySchema = z.object({
  op: z.literal("set-property"),
  targetId: z.string().min(1).max(128),
  property: z.enum(["text", "visible", "enabled", "selected", "value", "selectedIndex", "icon"]),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
})

const viewerDispatchEventSchema = z.object({
  op: z.literal("dispatch-event"),
  targetId: z.string().min(1).max(128),
  event: z.enum(["click", "input", "scroll"]),
  data: z.object({
    text: z.string().max(100_000).optional(),
    value: z.number().finite().optional(),
    selectedIndex: z.number().int().nonnegative().optional(),
    deltaX: z.number().finite().min(-100_000).max(100_000).optional(),
    deltaY: z.number().finite().min(-100_000).max(100_000).optional(),
  }).optional(),
})

export const viewerOperationSchema = z.discriminatedUnion("op", [
  viewerSetPropertySchema,
  z.object({
    op: z.literal("set-controller-page"),
    targetId: z.string().min(1).max(128),
    controllerName: z.string().min(1).max(128),
    pageId: z.string().min(1).max(128),
  }),
  z.object({
    op: z.literal("play-transition"),
    targetId: z.string().min(1).max(128),
    transitionName: z.string().min(1).max(128),
    times: z.number().int().min(1).max(100).optional(),
  }),
  viewerDispatchEventSchema,
])

export const renderViewSchema = z.object({
  zoom: z.number().finite().min(0.1).max(4).optional(),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  width: z.number().int().min(1).max(8192).optional(),
  height: z.number().int().min(1).max(8192).optional(),
}).strict().refine((view) => Object.keys(view).length > 0, "View patch must not be empty")

const versionSchema = z.number().int().nonnegative()
const commandIdentity = { requestId: z.string().uuid() }
export const renderSessionCommandSchema = z.discriminatedUnion("kind", [
  z.object({ ...commandIdentity, kind: z.literal("render"), expectedStateVersion: versionSchema,
    payload: z.object({ packageId: z.string().min(1).max(128), componentId: z.string().min(1).max(128), capture: z.boolean().default(false) }).strict() }).strict(),
  z.object({ ...commandIdentity, kind: z.literal("update"), expectedStateVersion: versionSchema,
    payload: z.object({ operations: z.array(viewerOperationSchema).min(1).max(100) }).strict() }).strict(),
  z.object({ ...commandIdentity, kind: z.literal("view"), expectedViewStateVersion: versionSchema, payload: renderViewSchema }).strict(),
  z.object({ ...commandIdentity, kind: z.enum(["observe", "capture"]), afterStateVersion: versionSchema,
    afterViewStateVersion: versionSchema }).strict(),
])

export const rendererInteractionSchema = z.object({
  runtimeEventSeq: z.number().int().positive(),
  targetId: z.string().min(1).max(128),
  event: z.enum(["click", "input", "change", "scroll"]),
  data: z.record(z.string().max(128), z.union([z.string().max(16_384), z.number().finite(), z.boolean(), z.null()]))
    .refine((data) => Object.keys(data).length <= 32, "Too many interaction fields").optional(),
}).strict().refine((input) => Buffer.byteLength(JSON.stringify(input)) <= MAX_RENDERER_INTERACTION_BYTES, "Interaction exceeds 64 KiB")

const viewerProjectCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.object({ projectId: z.string().min(1).max(128) }),
  packages: z.array(z.object({
    packageId: z.string().min(1).max(128),
    packageName: z.string().min(1).max(256),
    components: z.array(z.object({
      id: z.string().min(1).max(128),
      name: z.string().min(1).max(256),
    })).max(5_000),
  })).max(5_000),
}).refine((catalog) => catalog.packages.reduce((count, pkg) => count + pkg.components.length, 0) <= 5_000, {
  message: "Viewer catalog exceeds 5,000 components.",
})

export const rendererRegistrationSchema = z.union([
  z.object({
    mode: z.literal("viewer").optional(),
    projectId: z.string().min(1),
    protocolVersion: z.literal(VIEWER_PROTOCOL_VERSION),
    sourceRevision: z.string().min(1).max(128),
    catalog: viewerProjectCatalogSchema.optional(),
  }),
  z.object({
    mode: z.literal("player"),
    artifactId: z.string().min(1),
    protocolVersion: z.literal(VIEWER_PROTOCOL_VERSION),
    sourceRevision: z.string().min(1).max(128),
  }),
])

export const rendererResultSchema = z.object({
  commandSeq: z.number().int().positive(),
  requestId: z.string().uuid(),
  ok: z.boolean(),
  value: z.object({ runtimeEventSeq: versionSchema, screenshotBase64: z.string().max(14_000_000).optional() }).loose().optional(),
  error: z.string().max(2_000).optional(),
})

type ViewerProject = {
  projectId: string
  viewerUrl: string
  fairyguiProjectId?: string
  name?: string
  sourceOwner?: "browser" | "host"
  sourceRevision: string
  assetManagerUrl?: string
}
type PlayerArtifact = Pick<ArtifactManifest, "artifactId" | "playerUrl" | "digest" | "packages">
type CommandResult = RenderCommandResult
type PendingCommand = {
  resolve(value: CommandResult): void
  reject(error: Error): void
  timeout: ReturnType<typeof setTimeout>
}

type RenderSession = {
  renderSessionId: string
  mode: "viewer" | "player"
  sourceId: string
  sourceRevision: string
  status: "ready" | "running" | "failed" | "closed"
  stateVersion: number
  stateSeq: number
  viewStateVersion: number
  runtimeEventSeq: number
  interactionSeq: number
  commandSeq: number
  rendererLastSeen: number
  commands: ViewerBrokerCommand[]
  pending: Map<string, PendingCommand>
  requests: Map<string, { fingerprint: string; promise: Promise<CommandResult> }>
  resultReceipts: Map<number, { requestId: string; digest: string }>
  interactionReceipts: Map<number, string>
  waiters: Set<() => void>
  interactions: Array<ViewerInteractionEvent & { interactionSeq: number; stateVersion: number; at: number }>
  observation: ViewerObservation | null
  rendered: ViewerRendered | null
  view: ViewerViewState
  catalog: ViewerProjectCatalog | null
}

export class ViewerRenderBroker {
  private readonly sessions = new Map<string, RenderSession>()
  private readonly sessionBySource = new Map<string, string>()

  constructor(
    private readonly getProject: (projectId: string) => ViewerProject | undefined,
    private readonly getArtifact: (artifactId: string) => PlayerArtifact | null = () => null,
  ) {}

  registerRenderer(input: z.infer<typeof rendererRegistrationSchema>) {
    const mode = input.mode === "player" ? "player" : "viewer"
    const sourceId = input.mode === "player" ? input.artifactId : input.projectId
    const expectedRevision = this.sourceRevision(mode, sourceId)
    if (!expectedRevision || input.sourceRevision !== expectedRevision) return null
    if (mode === "viewer" && "catalog" in input && input.catalog) {
      const project = this.getProject(sourceId)
      if (project?.fairyguiProjectId && input.catalog.source.projectId !== project.fairyguiProjectId) return null
    }
    const sourceKey = `${mode}:${sourceId}`
    const currentId = this.sessionBySource.get(sourceKey)
    const current = currentId ? this.currentSession(currentId) : undefined
    if (current) this.removeSession(current, "A newer Viewer renderer replaced this render session.")
    const session: RenderSession = {
      renderSessionId: `render_${randomUUID()}`,
      mode,
      sourceId,
      sourceRevision: input.sourceRevision,
      status: "ready",
      stateVersion: 0,
      stateSeq: 0,
      viewStateVersion: 0,
      runtimeEventSeq: 0,
      interactionSeq: 0,
      commandSeq: 0,
      rendererLastSeen: Date.now(),
      commands: [],
      pending: new Map(),
      requests: new Map(),
      resultReceipts: new Map(),
      interactionReceipts: new Map(),
      waiters: new Set(),
      interactions: [],
      observation: null,
      rendered: null,
      view: { zoom: 1, background: "#202226", width: 1, height: 1 },
      catalog: mode === "viewer" && "catalog" in input ? input.catalog ?? null : null,
    }
    this.sessions.set(session.renderSessionId, session)
    this.sessionBySource.set(sourceKey, session.renderSessionId)
    return this.publicSession(session)
  }

  async readCommands(renderSessionId: string, after: number, signal: AbortSignal) {
    const session = this.currentSession(renderSessionId)
    if (!session || session.status === "closed") return null
    session.rendererLastSeen = Date.now()
    const read = () => {
      while (session.commands.length) {
        const command = session.commands[0]
        if (command.commandSeq <= after) return []
        if (!command.executionState) {
          const conflict = this.commandConflict(session, command)
          if (conflict) {
            const pending = session.pending.get(command.requestId)!
            clearTimeout(pending.timeout)
            session.pending.delete(command.requestId)
            session.commands.shift()
            pending.reject(new Error(conflict))
            continue
          }
          command.executionState = { semanticStateVersion: session.stateVersion, viewStateVersion: session.viewStateVersion, runtimeEventSeq: session.runtimeEventSeq }
        }
        return [command]
      }
      session.status = "ready"
      return []
    }
    let commands = read()
    if (commands.length === 0) {
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timeout)
          session.waiters.delete(done)
          signal.removeEventListener("abort", done)
          resolve()
        }
        const timeout = setTimeout(done, 25_000)
        session.waiters.add(done)
        signal.addEventListener("abort", done, { once: true })
        if (signal.aborted) done()
      })
      if (this.currentSession(renderSessionId) !== session || String(session.status) === "closed") return null
      commands = read()
    }
    session.rendererLastSeen = Date.now()
    return { session: this.publicSession(session), commands }
  }

  submitResult(renderSessionId: string, input: z.infer<typeof rendererResultSchema>) {
    const session = this.currentSession(renderSessionId)
    if (!session) return false
    const digest = wireFingerprint(input)
    const receipt = session.resultReceipts.get(input.commandSeq)
    if (receipt) {
      if (receipt.requestId !== input.requestId || receipt.digest !== digest) throw new Error("result_conflict: command already acknowledged with a different result")
      session.rendererLastSeen = Date.now()
      return true
    }
    const command = session.commands[0]
    const pending = session.pending.get(input.requestId)
    if (!command || command.commandSeq !== input.commandSeq || command.requestId !== input.requestId || !pending) {
      throw new Error("result_conflict: command is stale or out of order")
    }
    const execution = command.executionState
    if (!execution) throw new Error("result_conflict: command was not dispatched")
    const runtimeEventSeq = input.value?.runtimeEventSeq
    if (input.ok && (!Number.isSafeInteger(runtimeEventSeq) || runtimeEventSeq! < execution.runtimeEventSeq || runtimeEventSeq! > session.runtimeEventSeq)) {
      throw new Error("result_conflict: snapshot interaction watermark is not acknowledged")
    }
    // Receipts retain only hashes, never another copy of screenshot/observation payloads.
    session.resultReceipts.set(input.commandSeq, { requestId: input.requestId, digest })
    if (session.resultReceipts.size > MAX_RENDER_REQUESTS_PER_SESSION) session.resultReceipts.delete(session.resultReceipts.keys().next().value!)
    clearTimeout(pending.timeout)
    session.pending.delete(input.requestId)
    session.commands = session.commands.filter(({ commandSeq }) => commandSeq > input.commandSeq)
    session.rendererLastSeen = Date.now()
    const semanticMutation = command.kind === "render" || command.kind === "update"
    session.stateSeq += 1
    // A failed operation batch can have applied a prefix. Invalidate the old version, never imply rollback.
    const conflict = !input.ok && input.error?.startsWith("state_version_conflict:")
    if (!conflict) {
      if (semanticMutation) session.stateVersion += 1
      if (command.kind === "view") session.viewStateVersion += 1
    }
    if (input.ok) {
      const semanticStateVersion = execution.semanticStateVersion + runtimeEventSeq! - execution.runtimeEventSeq + Number(semanticMutation)
      const viewStateVersion = execution.viewStateVersion + Number(command.kind === "view")
      const observation = input.value?.observation
      if (semanticMutation) session.observation = null
      if (isViewerObservation(observation) && semanticStateVersion === session.stateVersion) session.observation = observation
      if (command.kind === "render") session.rendered = input.value?.rendered as ViewerRendered ?? null
      if (command.kind === "view") session.view = { ...session.view, ...command.payload } as ViewerViewState
      session.status = "ready"
      const value = { ...input.value }
      if (typeof value.screenshotBase64 === "string") {
        const rendered = session.rendered
        value.component = rendered ? { packageId: rendered.packageId, componentId: rendered.componentId, packageName: rendered.packageName, componentName: rendered.componentName } : null
        value.view = { ...session.view }
      }
      pending.resolve({ renderSessionId, sourceRevision: session.sourceRevision, stateVersion: semanticStateVersion, semanticStateVersion, viewStateVersion, value })
    } else {
      if (semanticMutation && !conflict) session.observation = null
      if (command.kind === "render" && !conflict) session.rendered = null
      session.status = "failed"
      pending.reject(new Error(input.error || "Viewer renderer command failed."))
      if (command.kind === "view" || input.error?.includes("runtime command timed out")) {
        this.removeSession(session, "render_state_uncertain: the renderer may have changed; reopen Viewer or Player")
      }
    }
    return true
  }

  executeForProject(projectId: string, kind: ViewerBrokerCommand["kind"], payload: Record<string, unknown>, requestId?: string) {
    return this.executeForSource("viewer", projectId, kind, payload, requestId)
  }

  executeForArtifact(artifactId: string, kind: ViewerBrokerCommand["kind"], payload: Record<string, unknown>, requestId?: string) {
    return this.executeForSource("player", artifactId, kind, payload, requestId)
  }

  private executeForSource(mode: "viewer" | "player", sourceId: string, kind: ViewerBrokerCommand["kind"], payload: Record<string, unknown>, requestId?: string) {
    const sessionId = this.sessionBySource.get(`${mode}:${sourceId}`)
    const session = sessionId ? this.currentSession(sessionId) : undefined
    if (!session || Date.now() - session.rendererLastSeen > 45_000) return null
    return this.enqueue(session, kind, payload, requestId)
  }

  executeForSession(renderSessionId: string, expectedStateVersion: number, kind: "update" | "render", payload: Record<string, unknown>, requestId?: string) {
    const session = this.currentSession(renderSessionId)
    if (!session || Date.now() - session.rendererLastSeen > 45_000) return null
    if (!session.requests.has(requestId ?? "") && session.stateVersion !== expectedStateVersion) {
      throw new Error(`state_version_conflict: expected ${expectedStateVersion}, current ${session.stateVersion}`)
    }
    return this.enqueue(session, kind, payload, requestId, { expectedStateVersion })
  }

  executeViewForSession(renderSessionId: string, expectedViewStateVersion: number, payload: z.infer<typeof renderViewSchema>, requestId?: string) {
    const session = this.currentSession(renderSessionId)
    if (!session || Date.now() - session.rendererLastSeen > 45_000) return null
    if (!session.requests.has(requestId ?? "") && session.viewStateVersion !== expectedViewStateVersion) {
      throw new Error(`view_state_version_conflict: expected ${expectedViewStateVersion}, current ${session.viewStateVersion}`)
    }
    return this.enqueue(session, "view", payload, requestId, { expectedViewStateVersion })
  }

  executeCommand(renderSessionId: string, input: z.infer<typeof renderSessionCommandSchema>) {
    if (input.kind === "render" || input.kind === "update") return this.executeForSession(renderSessionId, input.expectedStateVersion, input.kind, input.payload, input.requestId)
    if (input.kind === "view") return this.executeViewForSession(renderSessionId, input.expectedViewStateVersion, input.payload, input.requestId)
    return this.executeReadForSession(renderSessionId, input.afterStateVersion, input.kind, input.requestId, input.afterViewStateVersion)
  }

  executeReadForSession(renderSessionId: string, afterStateVersion: number, kind: "capture" | "observe", requestId?: string, afterViewStateVersion = 0) {
    const session = this.currentSession(renderSessionId)
    if (!session || Date.now() - session.rendererLastSeen > 45_000) return null
    const payload = { afterStateVersion, afterViewStateVersion }
    if (requestId && session.requests.has(requestId)) return this.enqueue(session, kind, payload, requestId)
    if (session.stateVersion < afterStateVersion) {
      throw new Error(`state_version_not_reached: requested ${afterStateVersion}, current ${session.stateVersion}`)
    }
    if (session.viewStateVersion < afterViewStateVersion) throw new Error(`view_state_version_not_reached: requested ${afterViewStateVersion}, current ${session.viewStateVersion}`)
    return this.enqueue(session, kind, payload, requestId)
  }

  getSession(renderSessionId: string) {
    const session = this.currentSession(renderSessionId)
    return session ? this.publicSession(session) : null
  }

  getBrowserTarget(renderSessionId: string) {
    const session = this.currentSession(renderSessionId)
    if (!session) return null
    if (session.mode === "viewer") {
      const project = this.getProject(session.sourceId)
      return project ? {
        projectId: session.sourceId,
        sourceRevision: project.sourceRevision,
        viewerUrl: project.viewerUrl,
      } : null
    }
    const artifact = this.getArtifact(session.sourceId)
    return artifact ? {
      artifactId: session.sourceId,
      digest: artifact.digest,
      playerUrl: artifact.playerUrl,
    } : null
  }

  getSessionForArtifact(artifactId: string) {
    const sessionId = this.sessionBySource.get(`player:${artifactId}`)
    const session = sessionId ? this.currentSession(sessionId) : undefined
    return session && Date.now() - session.rendererLastSeen <= 45_000 ? this.publicSession(session) : null
  }

  getViewerRenderer(projectId: string) {
    const sessionId = this.sessionBySource.get(`viewer:${projectId}`)
    const session = sessionId ? this.currentSession(sessionId) : undefined
    if (!session || Date.now() - session.rendererLastSeen > 45_000) return null
    return { session: this.publicSession(session), catalog: session.catalog }
  }

  recordInteraction(renderSessionId: string, input: z.infer<typeof rendererInteractionSchema>) {
    const session = this.currentSession(renderSessionId)
    if (!session || session.status === "closed") return null
    const digest = wireFingerprint(input)
    if (input.runtimeEventSeq <= session.runtimeEventSeq) {
      if (session.interactionReceipts.get(input.runtimeEventSeq) !== digest) throw new Error("interaction_conflict: event differs or its receipt has expired")
      session.rendererLastSeen = Date.now()
      return this.publicSession(session)
    }
    if (input.runtimeEventSeq !== session.runtimeEventSeq + 1) throw new Error(`interaction_sequence_gap: expected ${session.runtimeEventSeq + 1}, received ${input.runtimeEventSeq}`)
    session.runtimeEventSeq = input.runtimeEventSeq
    session.interactionSeq += 1
    session.stateSeq += 1
    session.stateVersion += 1
    session.observation = null
    session.rendererLastSeen = Date.now()
    session.interactionReceipts.set(input.runtimeEventSeq, digest)
    if (session.interactionReceipts.size > MAX_RENDER_REQUESTS_PER_SESSION) session.interactionReceipts.delete(session.interactionReceipts.keys().next().value!)
    session.interactions.push({ ...input, interactionSeq: session.interactionSeq, stateVersion: session.stateVersion, at: Date.now() })
    if (session.interactions.length > 100) session.interactions.splice(0, session.interactions.length - 100)
    return this.publicSession(session)
  }

  disconnectRenderer(renderSessionId: string) {
    const session = this.sessions.get(renderSessionId)
    if (session) this.removeSession(session, "Renderer disconnected. Reopen Viewer or Player to start a new session.")
  }

  pruneExpiredSessions() {
    for (const id of this.sessions.keys()) this.currentSession(id)
  }

  close() {
    for (const session of this.sessions.values()) {
      this.closeSession(session, "Maker Host closed the render session.")
    }
    this.sessions.clear()
    this.sessionBySource.clear()
  }

  private enqueue(session: RenderSession, kind: ViewerBrokerCommand["kind"], payload: Record<string, unknown>, requestedId: string = randomUUID(), expected: Pick<ViewerBrokerCommand, "expectedStateVersion" | "expectedViewStateVersion"> = {}) {
    const fingerprint = wireFingerprint({ kind, payload, ...expected })
    const existing = session.requests.get(requestedId)
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("request_id_conflict: requestId was already used for a different Viewer command")
      return existing.promise
    }
    this.trimRequestCache(session)
    if (session.requests.size >= MAX_RENDER_REQUESTS_PER_SESSION) {
      throw new Error("render_request_limit_exceeded: too many commands are still pending")
    }
    session.commandSeq += 1
    session.status = "running"
    const command: ViewerBrokerCommand = { commandSeq: session.commandSeq, requestId: requestedId, kind, payload, ...expected }
    session.commands.push(command)
    const promise = new Promise<CommandResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // An unacknowledged command may already have mutated the iframe. Never reuse this uncertain session.
        this.removeSession(session, "render_command_timeout: Viewer renderer did not answer within 30 seconds; execution status is unknown. Reopen Viewer or Player.")
      }, 30_000)
      session.pending.set(command.requestId, { resolve, reject, timeout })
    })
    session.requests.set(requestedId, { fingerprint, promise })
    for (const wake of session.waiters) wake()
    return promise
  }

  private trimRequestCache(session: RenderSession) {
    for (const requestId of session.requests.keys()) {
      if (session.requests.size < MAX_RENDER_REQUESTS_PER_SESSION) return
      if (!session.pending.has(requestId)) session.requests.delete(requestId)
    }
  }

  private publicSession(session: RenderSession) {
    return {
      renderSessionId: session.renderSessionId,
      mode: session.mode,
      ...(session.mode === "viewer" ? { projectId: session.sourceId } : { artifactId: session.sourceId }),
      sourceRevision: session.sourceRevision,
      status: session.status,
      stateSeq: session.stateSeq,
      stateVersion: session.stateVersion,
      semanticStateVersion: session.stateVersion,
      viewStateVersion: session.viewStateVersion,
      commandSeq: session.commandSeq,
      interactionSeq: session.interactionSeq,
      lastAcceptedRuntimeEventSeq: session.runtimeEventSeq,
      latestInteraction: session.interactions.at(-1) ?? null,
      observation: session.observation,
      rendered: session.rendered,
      view: session.view,
    }
  }

  private commandConflict(session: RenderSession, command: ViewerBrokerCommand) {
    if (command.expectedStateVersion !== undefined && command.expectedStateVersion !== session.stateVersion) return `state_version_conflict: expected ${command.expectedStateVersion}, current ${session.stateVersion}`
    if (command.expectedViewStateVersion !== undefined && command.expectedViewStateVersion !== session.viewStateVersion) return `view_state_version_conflict: expected ${command.expectedViewStateVersion}, current ${session.viewStateVersion}`
    return null
  }

  private sourceRevision(mode: "viewer" | "player", sourceId: string) {
    return mode === "viewer" ? this.getProject(sourceId)?.sourceRevision : this.getArtifact(sourceId)?.digest
  }

  private currentSession(renderSessionId: string) {
    const session = this.sessions.get(renderSessionId)
    if (!session) return undefined
    if (Date.now() - session.rendererLastSeen > RENDER_SESSION_TTL_MS) {
      this.removeSession(session, "Renderer session expired. Reopen Viewer or Player.")
      return undefined
    }
    if (this.sourceRevision(session.mode, session.sourceId) !== session.sourceRevision) {
      this.removeSession(session, "The render source revision changed.")
      return undefined
    }
    return session
  }

  private removeSession(session: RenderSession, message: string) {
    this.closeSession(session, message)
    this.sessions.delete(session.renderSessionId)
    const sourceKey = `${session.mode}:${session.sourceId}`
    if (this.sessionBySource.get(sourceKey) === session.renderSessionId) this.sessionBySource.delete(sourceKey)
  }

  private closeSession(session: RenderSession, message: string) {
    session.status = "closed"
    for (const pending of session.pending.values()) {
      clearTimeout(pending.timeout)
      pending.reject(new Error(message))
    }
    session.pending.clear()
    session.requests.clear()
    session.resultReceipts.clear()
    session.interactionReceipts.clear()
    session.commands = []
    for (const wake of session.waiters) wake()
    session.waiters.clear()
  }
}

function wireFingerprint(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value, (_key, item) => (
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item
  ))).digest("hex")
}

export function registerViewerMcpTools(
  server: McpServer,
  broker: ViewerRenderBroker,
  getProject: (projectId: string) => ViewerProject | undefined,
  getArtifact: (artifactId: string) => PlayerArtifact | null = () => null,
  listArtifacts: () => PlayerArtifact[] = () => [],
  listProjects: () => ViewerProject[] = () => [],
  getAssetAnalysis: (projectId: string) => ProjectAssetAnalysis | undefined = () => undefined,
) {
  const sessionBrowserRequired = (renderSessionId: string) => {
    const target = broker.getBrowserTarget(renderSessionId)
    return target
      ? toolResult({ ok: false, code: "browser_required", renderSessionId, ...target })
      : toolResult({ ok: false, code: "render_session_not_found", renderSessionId }, true)
  }

  server.registerTool("list_viewer_components", {
    title: "List FairyGUI Viewer components",
    description: "List Viewer projects and their stable package/component IDs. Open the returned Viewer URL and retry when browserRequired is true.",
    inputSchema: z.object({ projectId: z.string().min(1).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ projectId }) => {
    const projects = projectId ? [getProject(projectId)].filter((value): value is ViewerProject => value !== undefined) : listProjects()
    if (projectId && projects.length === 0) return toolResult({ ok: false, code: "project_not_found", projectId }, true)
    return toolResult({
      ok: true,
      projects: projects.map((project) => {
        const renderer = broker.getViewerRenderer(project.projectId)
        return {
          projectId: project.projectId,
          fairyguiProjectId: project.fairyguiProjectId,
          name: project.name,
          sourceOwner: project.sourceOwner,
          sourceRevision: project.sourceRevision,
          viewerUrl: project.viewerUrl,
          browserRequired: renderer?.catalog === null || !renderer,
          renderSession: renderer ? {
            renderSessionId: renderer.session.renderSessionId,
            sourceRevision: renderer.session.sourceRevision,
            status: renderer.session.status,
            stateVersion: renderer.session.stateVersion,
            semanticStateVersion: renderer.session.semanticStateVersion,
            viewStateVersion: renderer.session.viewStateVersion,
          } : null,
          packages: renderer?.catalog?.packages ?? [],
        }
      }),
    })
  })

  server.registerTool("render_component_preview", {
    title: "Render FairyGUI component preview",
    description: "Render a component in an open Maker Workbench Viewer using stable package and component resource IDs.",
    inputSchema: z.object({
      projectId: z.string().min(1),
      requestId: z.string().uuid(),
      packageId: z.string().min(1),
      componentId: z.string().min(1),
      capture: z.boolean().default(true),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ projectId, requestId, packageId, componentId, capture }) => {
    const project = getProject(projectId)
    if (!project) return toolResult({ ok: false, code: "project_not_found", projectId }, true)
    try {
      const result = broker.executeForProject(projectId, "render", { packageId, componentId, capture }, requestId)
      if (!result) return toolResult({ ok: false, code: "browser_required", projectId, sourceRevision: project.sourceRevision, viewerUrl: project.viewerUrl })
      return commandToolResult(await result)
    } catch (error) {
      return toolResult({ ok: false, code: "render_failed", message: formatError(error) }, true)
    }
  })

  server.registerTool("update_render_session", {
    title: "Update FairyGUI render session",
    description: "Apply whitelisted temporary UI properties, controller changes, transitions, or semantic interactions to a connected Viewer or Player session.",
    inputSchema: z.object({
      renderSessionId: z.string().min(1),
      requestId: z.string().uuid(),
      expectedStateVersion: z.number().int().nonnegative(),
      operations: z.array(viewerOperationSchema).min(1).max(100),
    }),
  }, async ({ renderSessionId, requestId, expectedStateVersion, operations }) => {
    try {
      const result = broker.executeForSession(renderSessionId, expectedStateVersion, "update", { operations }, requestId)
      return result ? commandToolResult(await result) : sessionBrowserRequired(renderSessionId)
    } catch (error) {
      return toolResult({ ok: false, code: "render_session_error", message: formatError(error) }, true)
    }
  })

  server.registerTool("set_render_view", {
    title: "Set FairyGUI render view",
    description: "Change zoom, background or viewport through the shared Broker. Uses viewStateVersion, independently of semanticStateVersion (the legacy stateVersion).",
    inputSchema: z.object({ renderSessionId: z.string().min(1), requestId: z.string().uuid(), expectedViewStateVersion: versionSchema, view: renderViewSchema }),
  }, async ({ renderSessionId, requestId, expectedViewStateVersion, view }) => {
    try {
      const result = broker.executeViewForSession(renderSessionId, expectedViewStateVersion, view, requestId)
      return result ? commandToolResult(await result) : sessionBrowserRequired(renderSessionId)
    } catch (error) {
      return toolResult({ ok: false, code: "render_session_error", message: formatError(error) }, true)
    }
  })

  server.registerTool("inspect_project_assets", {
    title: "Inspect FairyGUI project assets",
    description: "Read a fixed-revision Asset Manager summary or inspect incoming and outgoing references for one stable package/resource ID.",
    inputSchema: z.object({
      projectId: z.string().min(1),
      packageId: z.string().min(1).optional(),
      resourceId: z.string().min(1).optional(),
      direction: z.enum(["incoming", "outgoing", "both"]).default("both"),
      limit: z.number().int().min(1).max(500).default(100),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ projectId, packageId, resourceId, direction, limit }) => {
    const project = getProject(projectId)
    if (!project) return toolResult({ ok: false, code: "project_not_found", projectId }, true)
    const analysis = getAssetAnalysis(projectId)
    if (!analysis || analysis.sourceRevision !== project.sourceRevision) {
      return toolResult({
        ok: false,
        code: "browser_required",
        projectId,
        sourceRevision: project.sourceRevision,
        assetManagerUrl: project.assetManagerUrl,
        message: "Open Asset Manager to scan and register the current browser-authorized project revision.",
      })
    }
    if ((packageId && !resourceId) || (!packageId && resourceId)) {
      return toolResult({ ok: false, code: "invalid_resource_selector", message: "packageId and resourceId must be provided together." }, true)
    }

    if (!packageId || !resourceId) {
      return toolResult({
        ok: true,
        projectId,
        sourceRevision: analysis.sourceRevision,
        assetManagerUrl: project.assetManagerUrl,
        summary: summarizeAssetAnalysis(analysis),
        issues: analysis.issues.slice(0, limit).map(compactAssetIssue),
        truncated: analysis.issues.length > limit,
      })
    }

    const key = assetResourceKey(packageId, resourceId)
    const resource = analysis.resources.find((candidate) => candidate.key === key)
    if (!resource) return toolResult({ ok: false, code: "resource_not_found", projectId, packageId, resourceId }, true)
    const resourceByKey = new Map(analysis.resources.map((candidate) => [candidate.key, candidate]))
    const incoming = direction === "outgoing" ? [] : analysis.references.filter(({ targetKey }) => targetKey === key)
    const outgoing = direction === "incoming" ? [] : analysis.references.filter(({ sourceKey }) => sourceKey === key)
    const compactReference = (reference: ProjectAssetAnalysis["references"][number]) => ({
      ...reference,
      source: reference.sourceKey === "project" ? { key: "project", name: "Project settings" } : resourceByKey.get(reference.sourceKey) ?? { key: reference.sourceKey, missing: true },
      target: resourceByKey.get(reference.targetKey) ?? { key: reference.targetKey, missing: true },
    })
    return toolResult({
      ok: true,
      projectId,
      sourceRevision: analysis.sourceRevision,
      assetManagerUrl: project.assetManagerUrl,
      resource,
      issues: analysis.issues.filter(({ resourceKeys }) => resourceKeys.includes(key)).map(compactAssetIssue),
      references: {
        incoming: incoming.slice(0, limit).map(compactReference),
        outgoing: outgoing.slice(0, limit).map(compactReference),
        incomingTotal: incoming.length,
        outgoingTotal: outgoing.length,
        truncated: incoming.length > limit || outgoing.length > limit,
      },
    })
  })

  server.registerTool("list_artifact_components", {
    title: "List published FairyGUI artifact components",
    description: "List immutable published artifacts and their native FairyGUI package/component IDs.",
    inputSchema: z.object({ artifactId: z.string().min(1).optional() }),
    annotations: { readOnlyHint: true },
  }, async ({ artifactId }) => {
    const artifacts = artifactId ? [getArtifact(artifactId)].filter((value): value is PlayerArtifact => value !== null) : listArtifacts()
    if (artifactId && artifacts.length === 0) return toolResult({ ok: false, code: "artifact_not_found", artifactId }, true)
    return toolResult({ ok: true, artifacts: artifacts.map(({ artifactId: id, playerUrl, digest, packages }) => ({ artifactId: id, playerUrl, digest, packages })) })
  })

  server.registerTool("open_artifact_player", {
    title: "Open published FairyGUI artifact Player",
    description: "Return the Player URL for an immutable published artifact and its current render session when the browser is open.",
    inputSchema: z.object({ artifactId: z.string().min(1) }),
    annotations: { readOnlyHint: true },
  }, async ({ artifactId }) => {
    const artifact = getArtifact(artifactId)
    if (!artifact) return toolResult({ ok: false, code: "artifact_not_found", artifactId }, true)
    const renderSession = broker.getSessionForArtifact(artifactId)
    return toolResult({ ok: true, artifactId, digest: artifact.digest, playerUrl: artifact.playerUrl, browserRequired: !renderSession, renderSession })
  })

  server.registerTool("render_artifact_component", {
    title: "Render published FairyGUI artifact component",
    description: "Render a component through native UIPackage in an open Maker Workbench Player.",
    inputSchema: z.object({
      artifactId: z.string().min(1),
      requestId: z.string().uuid(),
      packageId: z.string().min(1),
      componentId: z.string().min(1),
      capture: z.boolean().default(true),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ artifactId, requestId, packageId, componentId, capture }) => {
    const artifact = getArtifact(artifactId)
    if (!artifact) return toolResult({ ok: false, code: "artifact_not_found", artifactId }, true)
    const component = artifact.packages.find((pkg) => pkg.packageId === packageId)?.components.find((item) => item.id === componentId)
    if (!component) return toolResult({ ok: false, code: "artifact_component_not_found", artifactId, packageId, componentId }, true)
    try {
      const result = broker.executeForArtifact(artifactId, "render", { packageId, componentId, capture }, requestId)
      if (!result) return toolResult({ ok: false, code: "browser_required", artifactId, digest: artifact.digest, playerUrl: artifact.playerUrl })
      return commandToolResult(await result)
    } catch (error) {
      return toolResult({ ok: false, code: "render_failed", message: formatError(error) }, true)
    }
  })

  server.registerTool("get_render_observation", {
    title: "Get FairyGUI render observation",
    description: "Read the current Viewer or Player object tree, controllers, control values, and recent interaction state.",
    inputSchema: z.object({
      renderSessionId: z.string().min(1),
      requestId: z.string().uuid(),
      afterStateVersion: z.number().int().nonnegative(),
      afterViewStateVersion: versionSchema.default(0),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ renderSessionId, requestId, afterStateVersion, afterViewStateVersion }) => {
    try {
      const result = broker.executeReadForSession(renderSessionId, afterStateVersion, "observe", requestId, afterViewStateVersion)
      return result ? commandToolResult(await result) : sessionBrowserRequired(renderSessionId)
    } catch (error) {
      return toolResult({ ok: false, code: "render_session_error", message: formatError(error) }, true)
    }
  })

  server.registerTool("capture_render_screenshot", {
    title: "Capture FairyGUI render screenshot",
    description: "Capture the current Viewer or Player LayaAir canvas as a PNG image.",
    inputSchema: z.object({
      renderSessionId: z.string().min(1),
      requestId: z.string().uuid(),
      afterStateVersion: z.number().int().nonnegative(),
      afterViewStateVersion: versionSchema.default(0),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ renderSessionId, requestId, afterStateVersion, afterViewStateVersion }) => {
    try {
      const result = broker.executeReadForSession(renderSessionId, afterStateVersion, "capture", requestId, afterViewStateVersion)
      return result ? commandToolResult(await result) : sessionBrowserRequired(renderSessionId)
    } catch (error) {
      return toolResult({ ok: false, code: "render_session_error", message: formatError(error) }, true)
    }
  })
}

function compactAssetIssue(issue: ProjectAssetAnalysis["issues"][number]) {
  return {
    kind: issue.kind,
    severity: issue.severity,
    label: issue.label,
    detail: issue.detail,
    resourceCount: issue.resourceKeys.length,
    resourceKeys: issue.resourceKeys.slice(0, 20),
    truncated: issue.resourceKeys.length > 20,
  }
}

function commandToolResult(result: CommandResult) {
  const screenshotBase64 = typeof result.value.screenshotBase64 === "string" ? result.value.screenshotBase64 : null
  const { screenshotBase64: _screenshotBase64, ...commandValue } = result.value
  const value = {
    ok: true,
    ...result,
    value: commandValue,
    screenshot: screenshotBase64
      ? { attached: true, mimeType: "image/png" }
      : { attached: false },
  }
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value) },
      ...(screenshotBase64 ? [{ type: "image" as const, data: screenshotBase64, mimeType: "image/png" }] : []),
    ],
  }
}

function toolResult(value: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], isError }
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isViewerObservation(value: unknown): value is ViewerObservation {
  const observation = value as Partial<ViewerObservation> | null
  return !!observation && typeof observation.objectTree === "object" && Array.isArray(observation.controllers)
}
