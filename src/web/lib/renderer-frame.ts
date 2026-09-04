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
  type ViewerViewState,
} from "../../viewer-protocol"

type RendererMode = "Viewer" | "Player"
type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never

export type RendererFrameSession = {
  render(packageId: string, componentId: string, expectedRuntimeEventSeq?: number): Promise<ViewerRendered & { runtimeEventSeq: number }>
  capture(): Promise<{ blob: Blob; runtimeEventSeq: number; observation?: ViewerObservation }>
  observe(): Promise<ViewerObservation & { runtimeEventSeq: number }>
  setView(view: Partial<ViewerViewState>): Promise<Record<string, unknown>>
  applyOperations(operations: ViewerOperation[], expectedRuntimeEventSeq?: number): Promise<Record<string, unknown>>
  setInteractionHandler(handler: ((event: ViewerInteractionEvent) => void) | null): void
  destroy(): void
}

// The parent has already authenticated this opaque frame via prepareRuntimeFrame's nonce/pong handshake.
export async function connectRendererChannel(target: Window, mode: RendererMode, connection: Omit<ViewerConnectMessage, "type" | "protocolVersion">, signal: AbortSignal) {
  signal.throwIfAborted()
  const channel = new MessageChannel()
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; timeout: ReturnType<typeof setTimeout> }>()
  let interactionHandler: ((event: ViewerInteractionEvent) => void) | null = null
  let closed = false
  let closeReason: unknown
  let resolveReady!: () => void
  let rejectReady!: (error: unknown) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  const close = (error: unknown) => {
    if (closed) return
    closed = true
    closeReason = error
    clearTimeout(readyTimeout)
    signal.removeEventListener("abort", abort)
    rejectReady(error)
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(error) }
    pending.clear()
    interactionHandler = null
    channel.port1.onmessage = null
    channel.port1.close()
    channel.port2.close()
  }
  const abort = () => close(signal.reason)
  const readyTimeout = setTimeout(() => close(new Error(`LayaAir ${mode} runtime 启动超时。`)), 20_000)
  signal.addEventListener("abort", abort, { once: true })
  channel.port1.onmessage = (event: MessageEvent<ViewerRuntimeMessage>) => {
    const message = event.data
    if (closed) return
    if (message.kind === "ready") {
      clearTimeout(readyTimeout)
      if (message.sourceRevision === connection.sourceRevision) resolveReady()
      else close(new Error(`${mode} runtime 连接到了错误的${mode === "Viewer" ? "工程" : " Artifact "}版本。`))
      return
    }
    if (message.kind === "fatal") { close(new Error(message.error)); return }
    if (message.kind === "interaction") { interactionHandler?.(message.value); return }
    if (message.kind !== "response") return
    const request = pending.get(message.requestId)
    if (!request) return
    clearTimeout(request.timeout)
    pending.delete(message.requestId)
    if (message.ok) request.resolve({ ...message.value as object, runtimeEventSeq: message.runtimeEventSeq })
    else request.reject(new Error(message.error))
  }
  channel.port1.start()
  try {
    const message: ViewerConnectMessage = { type: "fairygui.viewer.connect", protocolVersion: VIEWER_PROTOCOL_VERSION, ...connection }
    target.postMessage(message, "*", [channel.port2])
  } catch (error) { close(error) }
  await ready

  const send = <T>(command: WithoutRequestId<ViewerCommand>, transfer: Transferable[] = []): Promise<T> => {
    if (closed) return Promise.reject(closeReason)
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`${mode} runtime command timed out: ${command.kind}`))
      }, mode === "Viewer" ? 20_000 : 30_000)
      pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout })
      try { channel.port1.postMessage({ ...command, requestId } as ViewerCommand, transfer) }
      catch (error) { clearTimeout(timeout); pending.delete(requestId); reject(error) }
    })
  }
  return {
    send,
    async capture() {
      const value = await send<{ data: ArrayBuffer; type: string; runtimeEventSeq: number; observation?: ViewerObservation }>({ kind: "capture" })
      return { blob: new Blob([value.data], { type: value.type }), runtimeEventSeq: value.runtimeEventSeq, observation: value.observation }
    },
    observe: () => send<ViewerObservation & { runtimeEventSeq: number }>({ kind: "observe" }),
    setView: (view: Partial<ViewerViewState>) => send<Record<string, unknown>>({ kind: "set-view", view }),
    applyOperations: (operations: ViewerOperation[], expectedRuntimeEventSeq?: number) => send<Record<string, unknown>>({ kind: "apply-operations", operations, expectedRuntimeEventSeq }),
    setInteractionHandler(handler: ((event: ViewerInteractionEvent) => void) | null) { if (!closed) interactionHandler = handler },
    destroy: () => close(new Error(`${mode} runtime session closed.`)),
  }
}

export async function executeRendererCommand(mode: RendererMode, frame: RendererFrameSession, command: ViewerBrokerCommand) {
  if (command.kind === "capture") return captureFrame(mode, frame)
  if (command.kind === "observe") { const observation = await frame.observe(); return { observation, runtimeEventSeq: observation.runtimeEventSeq } }
  if (command.kind === "view") return frame.setView(command.payload)
  if (command.kind === "update") {
    if (!Array.isArray(command.payload.operations)) throw new Error(`${mode} update command is missing operations.`)
    return frame.applyOperations(command.payload.operations as ViewerOperation[], command.executionState?.runtimeEventSeq)
  }
  // Each renderer validates its own catalog and prepares its own bytes in render().
  const rendered = await frame.render(String(command.payload.packageId ?? ""), String(command.payload.componentId ?? ""), command.executionState?.runtimeEventSeq)
  return {
    rendered,
    observation: { objectTree: rendered.objectTree, controllers: rendered.controllers, availableTransitions: rendered.availableTransitions },
    runtimeEventSeq: rendered.runtimeEventSeq,
    ...(command.payload.capture === true ? await captureFrame(mode, frame) : {}),
  }
}

async function captureFrame(mode: RendererMode, frame: RendererFrameSession) {
  const { blob, ...snapshot } = await frame.capture()
  const screenshotBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error(`${mode} screenshot encoding failed.`))
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "")
    reader.readAsDataURL(blob)
  })
  return { ...snapshot, screenshotBase64 }
}
