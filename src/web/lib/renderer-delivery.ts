import { MAX_RENDERER_INTERACTION_BYTES, type ViewerBrokerCommand, type ViewerInteractionEvent } from "../../viewer-protocol"
import {
  closeRendererSession,
  readViewerCommands,
  RendererRequestError,
  submitViewerCommandResult,
  submitViewerInteraction,
} from "./api"

const MAX_OUTBOX_EVENTS = 256
const MAX_OUTBOX_BYTES = 1024 * 1024

// ponytail: one live iframe owns this in-memory outbox; reload starts a new session, not a replay of old side effects.
export async function startRendererDelivery(
  register: (signal: AbortSignal) => Promise<{ session: { renderSessionId: string } }>,
  frame: { setInteractionHandler(handler: ((event: ViewerInteractionEvent) => void) | null): void },
  execute: (command: ViewerBrokerCommand) => Promise<Record<string, unknown>>,
  onError: (error: Error) => void,
  lifetime: AbortSignal,
) {
  const controller = new AbortController()
  const { signal } = controller
  let renderSessionId = ""
  let failure: Error | undefined
  let receivedSeq = 0
  let outboxBytes = 0
  let draining = false
  const outbox: Array<{ runtimeEventSeq: number; body: string; bytes: number }> = []
  const close = () => {
    if (renderSessionId) void closeRendererSession(renderSessionId).catch((error) => console.warn("Renderer close failed; Host TTL will reclaim it.", error))
  }
  const pagehide = (event: PageTransitionEvent) => {
    // A bfcache restore must not display AGENT READY for the session we just closed.
    if (event.persisted) window.addEventListener("pageshow", () => window.location.reload(), { once: true })
    stop()
  }
  const stop = () => {
    if (signal.aborted) return
    controller.abort()
    lifetime.removeEventListener("abort", stop)
    window.removeEventListener("pagehide", pagehide)
    frame.setInteractionHandler(null)
    outbox.length = 0
    outboxBytes = 0
    close()
  }
  const fail = (error: unknown) => {
    if (signal.aborted) return
    failure = new Error(`Renderer 交付已停止：${error instanceof Error ? error.message : String(error)}。请刷新页面重新连接；旧会话不会自动重放。`)
    stop()
    onError(failure)
  }
  const drain = async () => {
    if (draining || !renderSessionId || signal.aborted) return
    draining = true
    try {
      while (outbox.length && !signal.aborted) {
        const event = outbox[0]
        const ack = await retry(() => submitViewerInteraction(renderSessionId, event.body, signal), signal)
        signal.throwIfAborted()
        if (ack.accepted !== true || ack.runtimeEventSeq !== event.runtimeEventSeq) throw new Error("interaction_ack_mismatch")
        outbox.shift()
        outboxBytes -= event.bytes
      }
    } finally {
      draining = false
    }
  }

  lifetime.throwIfAborted()
  lifetime.addEventListener("abort", stop, { once: true })
  window.addEventListener("pagehide", pagehide, { once: true })
  // Subscribe before registration so events emitted during its round trip cannot make a sequence gap.
  frame.setInteractionHandler((event) => {
    if (signal.aborted) return
    try {
      if (!Number.isSafeInteger(event.runtimeEventSeq) || event.runtimeEventSeq !== receivedSeq + 1) throw new Error("interaction_sequence_gap")
      const body = JSON.stringify(event)
      const bytes = new TextEncoder().encode(body).byteLength
      if (bytes > MAX_RENDERER_INTERACTION_BYTES || outbox.length >= MAX_OUTBOX_EVENTS || outboxBytes + bytes > MAX_OUTBOX_BYTES) throw new Error("interaction_outbox_limit_exceeded")
      outbox.push({ runtimeEventSeq: event.runtimeEventSeq, body, bytes })
      outboxBytes += bytes
      receivedSeq = event.runtimeEventSeq
      void drain().catch(fail)
    } catch (error) { fail(error) }
  })

  try {
    const { session } = await register(signal)
    renderSessionId = session.renderSessionId
    if (signal.aborted) { close(); signal.throwIfAborted() }
    void runCommands(renderSessionId, execute, signal).catch(fail)
    void drain().catch(fail)
    return { renderSessionId, stop }
  } catch (error) {
    stop()
    throw failure ?? error
  }
}

async function runCommands(renderSessionId: string, execute: (command: ViewerBrokerCommand) => Promise<Record<string, unknown>>, signal: AbortSignal) {
  let after = 0
  while (!signal.aborted) {
    const { commands } = await retry(() => readViewerCommands(renderSessionId, after, signal), signal)
    signal.throwIfAborted()
    // Fetch again after each ACK: a previously fetched batch may have expired while delivery was retrying.
    const command = commands[0]
    if (!command) continue
    if (!Number.isSafeInteger(command.commandSeq) || command.commandSeq <= after) throw new Error("command_sequence_conflict")
    const result = await execute(command)
      .then((value) => ({ ok: true, value }))
      .catch((error) => ({ ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 2_000) }))
    signal.throwIfAborted()
    // Only one command is in flight. Keep its exact wire result until ACK, including failed executions.
    const body = JSON.stringify({ commandSeq: command.commandSeq, requestId: command.requestId, ...result })
    const ack = await retry(() => submitViewerCommandResult(renderSessionId, body, signal), signal)
    signal.throwIfAborted()
    if (ack.accepted !== true || ack.commandSeq !== command.commandSeq || ack.requestId !== command.requestId) throw new Error("result_ack_mismatch")
    after = command.commandSeq
  }
}

async function retry<T>(send: () => Promise<T>, signal: AbortSignal): Promise<T> {
  const started = Date.now()
  let delay = 250
  for (;;) {
    signal.throwIfAborted()
    try { return await send() } catch (error) {
      signal.throwIfAborted()
      if (error instanceof RendererRequestError && error.status < 500 && ![408, 429].includes(error.status)) throw error
      if (Date.now() - started >= 60_000) throw new Error("renderer_delivery_timeout")
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(signal.reason) }
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve() }, delay)
        signal.addEventListener("abort", abort, { once: true })
      })
      delay = Math.min(delay * 2, 2_000)
    }
  }
}
