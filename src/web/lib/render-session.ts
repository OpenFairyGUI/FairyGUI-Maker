import type { RenderSessionState, ViewerOperation, ViewerViewState } from "../../viewer-protocol"
import { getRenderSession, RendererRequestError, sendRenderCommand } from "./api"
type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never

/** Workbench commands use HTTP; only the renderer delivery loop owns the MessageChannel. */
export function createRenderSessionClient(initial: RenderSessionState, onState: (state: RenderSessionState) => void, signal: AbortSignal) {
  let state = initial
  let observing = false
  const accept = (next: RenderSessionState) => {
    if (signal.aborted || next.renderSessionId !== state.renderSessionId || next.stateSeq < state.stateSeq) return
    state = next
    onState(state)
    if (state.rendered && !state.observation && !observing) {
      observing = true
      void observe().catch(() => undefined).finally(() => { observing = false })
    }
  }
  const refresh = async () => { accept((await getRenderSession(state.renderSessionId, signal)).session) }
  const send = async (input: WithoutRequestId<Parameters<typeof sendRenderCommand>[1]>) => {
    try {
      const response = await sendRenderCommand(state.renderSessionId, { ...input, requestId: crypto.randomUUID() } as Parameters<typeof sendRenderCommand>[1], signal)
      accept(response.session)
      return response.result
    } catch (error) {
      const refreshed = await refresh().then(() => true, () => false)
      if (error instanceof RendererRequestError && error.status === 409) throw new Error(`状态冲突：${refreshed ? "界面已刷新，请确认后重新操作。" : "状态刷新失败，请重新连接。"}${error.message}`)
      throw error
    }
  }
  const observe = () => send({ kind: "observe", afterStateVersion: state.semanticStateVersion, afterViewStateVersion: state.viewStateVersion })
  accept(initial)
  return {
    accept,
    refresh,
    get state() { return state },
    render: (packageId: string, componentId: string) => send({ kind: "render", expectedStateVersion: state.semanticStateVersion, payload: { packageId, componentId } }),
    applyOperations: (operations: ViewerOperation[]) => send({ kind: "update", expectedStateVersion: state.semanticStateVersion, payload: { operations } }),
    setView: (view: Partial<ViewerViewState>) => send({ kind: "view", expectedViewStateVersion: state.viewStateVersion, payload: view }),
    observe,
    async capture() {
      const result = await send({ kind: "capture", afterStateVersion: state.semanticStateVersion, afterViewStateVersion: state.viewStateVersion })
      const bytes = Uint8Array.from(atob(String(result.value.screenshotBase64)), (char) => char.charCodeAt(0))
      return { blob: new Blob([bytes], { type: "image/png" }), result }
    },
  }
}

export type RenderSessionClient = ReturnType<typeof createRenderSessionClient>

export function watchRenderViewport(frame: HTMLIFrameElement, client: RenderSessionClient, onError: (error: Error) => void, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout>
  let pending = false
  let dirty = false
  const update = async () => {
    if (pending || signal.aborted) return
    const width = Math.max(1, Math.round(frame.clientWidth))
    const height = Math.max(1, Math.round(frame.clientHeight))
    dirty = false
    if (width === client.state.view.width && height === client.state.view.height) return
    pending = true
    try { await client.setView({ width, height }) }
    catch (error) { if (!signal.aborted) onError(error instanceof Error ? error : new Error(String(error))) }
    finally { pending = false; if (dirty) void update() }
  }
  // ponytail: coalesce panel drags to one in-flight viewport command; never retry a conflicting user operation.
  const observer = new ResizeObserver(() => { dirty = true; clearTimeout(timer); timer = setTimeout(() => void update(), 100) })
  observer.observe(frame)
  signal.addEventListener("abort", () => { clearTimeout(timer); observer.disconnect() }, { once: true })
}
