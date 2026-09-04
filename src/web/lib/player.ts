import type { ArtifactManifest } from "../../artifact-protocol"
import {
  VIEWER_PROTOCOL_VERSION,
  type ViewerBrokerCommand,
  type ViewerCommand,
  type ViewerConnectMessage,
  type ViewerInteractionEvent,
  type ViewerObservation,
  type ViewerOperation,
  type ViewerRendered,
  type ViewerRuntimeMessage,
  type RenderSessionState,
  type ViewerViewState,
} from "../../viewer-protocol"
import { registerPlayerRenderer } from "./api"
import { startRendererDelivery } from "./renderer-delivery"
import { createRenderSessionClient, type RenderSessionClient } from "./render-session"
import { prepareRuntimeFrame } from "../../runtime-channel"
import { checkBudget, readBoundedStream, ResourceBudget, RUNTIME_LIMITS } from "../../runtime/resource-budget"

type PlayerFrameSession = {
  render(packageId: string, componentId: string, expectedRuntimeEventSeq?: number): Promise<ViewerRendered & { runtimeEventSeq: number }>
  capture(): Promise<{ blob: Blob; runtimeEventSeq: number; observation?: ViewerObservation }>
  observe(): Promise<ViewerObservation & { runtimeEventSeq: number }>
  setView(view: Partial<ViewerViewState>): Promise<Record<string, unknown>>
  applyOperations(operations: ViewerOperation[], expectedRuntimeEventSeq?: number): Promise<Record<string, unknown>>
  setInteractionHandler(handler: ((event: ViewerInteractionEvent) => void) | null): void
  destroy(): void
}

async function connectPlayerFrame(frame: HTMLIFrameElement, artifact: ArtifactManifest, signal: AbortSignal): Promise<PlayerFrameSession> {
  if (!frame.contentWindow) throw new Error("Player iframe 尚未就绪。")
  const connection = await prepareRuntimeFrame(frame, signal)
  const loading = new AbortController()
  const lifetime = AbortSignal.any([signal, loading.signal])
  let loaded = false
  const channel = new MessageChannel()
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timeout: number }>()
  let interactionHandler: ((event: ViewerInteractionEvent) => void) | null = null
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const readyTimeout = window.setTimeout(() => rejectReady(new Error("LayaAir Player runtime 启动超时。")), 20_000)

  channel.port1.onmessage = (event: MessageEvent<ViewerRuntimeMessage>) => {
    const message = event.data
    if (message.kind === "ready") {
      window.clearTimeout(readyTimeout)
      if (message.sourceRevision === artifact.digest) resolveReady()
      else rejectReady(new Error("Player runtime 连接到了错误的 Artifact 版本。"))
      return
    }
    if (message.kind === "fatal") { window.clearTimeout(readyTimeout); rejectReady(new Error(message.error)); return }
    if (message.kind === "interaction") { interactionHandler?.(message.value); return }
    if (message.kind !== "response") return
    const request = pending.get(message.requestId)
    if (!request) return
    window.clearTimeout(request.timeout)
    pending.delete(message.requestId)
    if (message.ok) request.resolve({ ...message.value as object, runtimeEventSeq: message.runtimeEventSeq })
    else request.reject(new Error(message.error))
  }
  channel.port1.start()
  const connectMessage: ViewerConnectMessage = { type: "fairygui.viewer.connect", protocolVersion: VIEWER_PROTOCOL_VERSION, sourceRevision: artifact.digest, ...connection }
  const abortReady = () => rejectReady(signal.reason)
  signal.addEventListener("abort", abortReady, { once: true })
  try {
    signal.throwIfAborted()
    frame.contentWindow.postMessage(connectMessage, "*", [channel.port2])
    await ready
  } catch (error) { channel.port1.close(); channel.port2.close(); throw error }
  finally { window.clearTimeout(readyTimeout); signal.removeEventListener("abort", abortReady) }

  const send = <T>(command: PlayerCommandInput, transfer: Transferable[] = []): Promise<T> => {
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => { pending.delete(requestId); reject(new Error(`Player runtime command timed out: ${command.kind}`)) }, 30_000)
      pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout })
      channel.port1.postMessage({ ...command, requestId } as ViewerCommand, transfer)
    })
  }

  return {
    async render(packageId, componentId, expectedRuntimeEventSeq) {
      try {
        const files = loaded ? undefined : await readArtifactFiles(artifact, lifetime)
        lifetime.throwIfAborted()
        const result = await send<ViewerRendered & { runtimeEventSeq: number }>({ kind: "render-artifact", source: { artifact, packageId, componentId, files }, expectedRuntimeEventSeq }, files?.map(({ data }) => data))
        loaded = true
        return result
      } catch (error) { loaded = false; throw error }
    },
    async capture() {
      const value = await send<{ data: ArrayBuffer; type: string; runtimeEventSeq: number; observation?: ViewerObservation }>({ kind: "capture" })
      return { blob: new Blob([value.data], { type: value.type }), runtimeEventSeq: value.runtimeEventSeq, observation: value.observation }
    },
    observe: () => send<ViewerObservation & { runtimeEventSeq: number }>({ kind: "observe" }),
    setView: (view) => send<Record<string, unknown>>({ kind: "set-view", view }),
    applyOperations: (operations, expectedRuntimeEventSeq) => send<Record<string, unknown>>({ kind: "apply-operations", operations, expectedRuntimeEventSeq }),
    setInteractionHandler(handler) { interactionHandler = handler },
    destroy() {
      loading.abort()
      window.clearTimeout(readyTimeout)
      for (const request of pending.values()) { window.clearTimeout(request.timeout); request.reject(new Error("Player runtime session closed.")) }
      pending.clear()
      channel.port1.close()
    },
  }
}

export async function readArtifactFiles(artifact: ArtifactManifest, lifetime: AbortSignal) {
  checkBudget(artifact.files.length, RUNTIME_LIMITS.nodes, "artifact_files")
  const budget = new ResourceBudget()
  for (const file of artifact.files) budget.encoded(file.size)
  const files: Array<{ path: string; data: ArrayBuffer }> = []
  for (const file of artifact.files) {
    lifetime.throwIfAborted()
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(RUNTIME_LIMITS.loadMs)])
    const path = file.path.split("/").map(encodeURIComponent).join("/")
    const response = await fetch(`/api/artifacts/${encodeURIComponent(artifact.artifactId)}/files/${path}`, { signal, redirect: "error" })
    if (!response.ok || !response.body) throw new Error(`读取 Artifact 失败：${file.path} (${response.status})`)
    const bytes = await readBoundedStream(response.body, file.size, signal)
    if (bytes.byteLength !== file.size) throw new Error(`Artifact file size mismatch: ${file.path}`)
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== file.sha256) throw new Error(`Artifact file digest mismatch: ${file.path}`)
    files.push({ path: file.path, data: bytes.buffer })
  }
  return files
}

export async function startPlayerRenderer(artifact: ArtifactManifest, iframe: HTMLIFrameElement, onState: (state: RenderSessionState) => void, onError: (error: Error) => void, signal: AbortSignal) {
  const frame = await connectPlayerFrame(iframe, artifact, signal)
  if (signal.aborted) { frame.destroy(); signal.throwIfAborted() }
  signal.addEventListener("abort", () => frame.destroy(), { once: true })
  let client: RenderSessionClient | undefined
  const delivery = await startRendererDelivery(
    (signal) => registerPlayerRenderer({ artifactId: artifact.artifactId, sourceRevision: artifact.digest, protocolVersion: VIEWER_PROTOCOL_VERSION }, signal),
    frame,
    (command) => executeBrokerCommand(artifact, frame, command),
    onError,
    signal,
    (state) => client?.accept(state),
  )
  client = createRenderSessionClient(delivery.session, onState, signal)
  return { client, renderSessionId: delivery.renderSessionId, stop: () => { delivery.stop(); frame.destroy() } }
}

async function executeBrokerCommand(artifact: ArtifactManifest, frame: PlayerFrameSession, command: ViewerBrokerCommand) {
  if (command.kind === "capture") return captureFrame(frame)
  if (command.kind === "observe") { const observation = await frame.observe(); return { observation, runtimeEventSeq: observation.runtimeEventSeq } }
  if (command.kind === "view") return frame.setView(command.payload)
  if (command.kind === "update") {
    if (!Array.isArray(command.payload.operations)) throw new Error("Player update command is missing operations.")
    return await frame.applyOperations(command.payload.operations as ViewerOperation[], command.executionState?.runtimeEventSeq)
  }
  const packageId = String(command.payload.packageId ?? "")
  const componentId = String(command.payload.componentId ?? "")
  const component = artifact.packages.find((pkg) => pkg.packageId === packageId)?.components.find((item) => item.id === componentId)
  if (!component) throw new Error(`Artifact component not found: ${packageId}/${componentId}`)
  const rendered = await frame.render(packageId, componentId, command.executionState?.runtimeEventSeq)
  return {
    rendered,
    observation: { objectTree: rendered.objectTree, controllers: rendered.controllers, availableTransitions: rendered.availableTransitions },
    runtimeEventSeq: rendered.runtimeEventSeq,
    ...(command.payload.capture === true ? await captureFrame(frame) : {}),
  }
}

async function captureFrame(frame: PlayerFrameSession) {
  const { blob, ...snapshot } = await frame.capture()
  return { ...snapshot, screenshotBase64: await blobToBase64(blob) }
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Player screenshot encoding failed."))
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "")
    reader.readAsDataURL(blob)
  })
}

type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never
type PlayerCommandInput = WithoutRequestId<ViewerCommand>
