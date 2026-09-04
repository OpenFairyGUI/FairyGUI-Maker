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

type PlayerFrameSession = {
  render(packageId: string, componentId: string, expectedRuntimeEventSeq?: number): Promise<ViewerRendered & { runtimeEventSeq: number }>
  capture(): Promise<{ blob: Blob; runtimeEventSeq: number; observation?: ViewerObservation }>
  observe(): Promise<ViewerObservation & { runtimeEventSeq: number }>
  setView(view: Partial<ViewerViewState>): Promise<Record<string, unknown>>
  applyOperations(operations: ViewerOperation[], expectedRuntimeEventSeq?: number): Promise<Record<string, unknown>>
  setInteractionHandler(handler: ((event: ViewerInteractionEvent) => void) | null): void
  destroy(): void
}

async function connectPlayerFrame(frame: HTMLIFrameElement, artifact: ArtifactManifest): Promise<PlayerFrameSession> {
  if (!frame.contentWindow) throw new Error("Player iframe 尚未就绪。")
  await waitForPlayerRuntime(frame)
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
  const connectMessage: ViewerConnectMessage = { type: "fairygui.viewer.connect", protocolVersion: VIEWER_PROTOCOL_VERSION, sourceRevision: artifact.digest }
  frame.contentWindow.postMessage(connectMessage, location.origin, [channel.port2])
  await ready

  const send = <T>(command: PlayerCommandInput): Promise<T> => {
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => { pending.delete(requestId); reject(new Error(`Player runtime command timed out: ${command.kind}`)) }, 30_000)
      pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout })
      channel.port1.postMessage({ ...command, requestId } as ViewerCommand)
    })
  }

  return {
    render: (packageId, componentId, expectedRuntimeEventSeq) => send<ViewerRendered & { runtimeEventSeq: number }>({ kind: "render-artifact", source: { artifact, packageId, componentId }, expectedRuntimeEventSeq }),
    async capture() {
      const value = await send<{ data: ArrayBuffer; type: string; runtimeEventSeq: number; observation?: ViewerObservation }>({ kind: "capture" })
      return { blob: new Blob([value.data], { type: value.type }), runtimeEventSeq: value.runtimeEventSeq, observation: value.observation }
    },
    observe: () => send<ViewerObservation & { runtimeEventSeq: number }>({ kind: "observe" }),
    setView: (view) => send<Record<string, unknown>>({ kind: "set-view", view }),
    applyOperations: (operations, expectedRuntimeEventSeq) => send<Record<string, unknown>>({ kind: "apply-operations", operations, expectedRuntimeEventSeq }),
    setInteractionHandler(handler) { interactionHandler = handler },
    destroy() {
      window.clearTimeout(readyTimeout)
      for (const request of pending.values()) { window.clearTimeout(request.timeout); request.reject(new Error("Player runtime session closed.")) }
      pending.clear()
      channel.port1.close()
    },
  }
}

async function waitForPlayerRuntime(frame: HTMLIFrameElement) {
  const target = frame.contentWindow
  if (!target) throw new Error("Player iframe 尚未就绪。")
  const nonce = crypto.randomUUID()
  await new Promise<void>((resolve, reject) => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = event.data as { type?: string; nonce?: string } | null
      if (event.origin !== location.origin || event.source !== target || message?.type !== "fairygui.player.pong" || message.nonce !== nonce) return
      cleanup()
      resolve()
    }
    const ping = () => target.postMessage({ type: "fairygui.player.ping", nonce }, location.origin)
    const interval = window.setInterval(ping, 100)
    const timeout = window.setTimeout(() => { cleanup(); reject(new Error("Player runtime 页面加载超时。")) }, 20_000)
    const cleanup = () => { window.clearInterval(interval); window.clearTimeout(timeout); window.removeEventListener("message", onMessage) }
    window.addEventListener("message", onMessage)
    ping()
  })
}

export async function startPlayerRenderer(artifact: ArtifactManifest, iframe: HTMLIFrameElement, onState: (state: RenderSessionState) => void, onError: (error: Error) => void, signal: AbortSignal) {
  const frame = await connectPlayerFrame(iframe, artifact)
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
