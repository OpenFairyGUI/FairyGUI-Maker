import { isViewerConnectMessage } from "./viewer-protocol"
import { readBoundedStream, withRuntimeLoad } from "./runtime/resource-budget"

// The URL nonce is a per-document channel binding, never a Host authorization token.
export function acceptRuntimeConnection(connect: (revision: string, port: MessagePort, imageProbeWorker: string) => Promise<void>) {
  const nonce = location.hash.slice(1)
  const parentOrigin = new URL(location.href).origin
  let connected = false
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (parent === window || event.source !== parent || event.origin !== parentOrigin || connected) return
    const message = event.data as { type?: string; nonce?: string } | null
    if (!/^[a-f0-9-]{36}$/.test(nonce) || message?.nonce !== nonce) return
    if (message.type === "fairygui.runtime.ping") {
      parent.postMessage({ type: "fairygui.runtime.pong", nonce }, parentOrigin)
    } else if (isViewerConnectMessage(message) && event.ports.length === 1) {
      // Bind synchronously, before asynchronous boot; replay cannot replace the port.
      connected = true
      void connect(message.sourceRevision, event.ports[0], message.imageProbeWorker)
    }
  })
}

export async function prepareRuntimeFrame(frame: HTMLIFrameElement, signal: AbortSignal) {
  signal.throwIfAborted()
  if (!("credentialless" in frame)) throw new Error("Runtime 隔离需要支持 credentialless iframe 的 Chrome/Edge。")
  frame.setAttribute("credentialless", "")
  const { default: imageProbeWorkerUrl } = await import("./runtime/image-probe.worker?worker&url")
  const imageProbeWorker = new TextDecoder().decode(await withRuntimeLoad(signal, async (workerSignal) => {
    const workerResponse = await fetch(imageProbeWorkerUrl, { signal: workerSignal, redirect: "error", credentials: "omit" })
    if (!workerResponse.ok || !workerResponse.body) throw new Error("Image probe worker is unavailable")
    return readBoundedStream(workerResponse.body, 256 * 1024, workerSignal)
  }))
  signal.throwIfAborted()
  const target = frame.contentWindow
  if (!target) throw new Error("Runtime iframe 尚未就绪。")
  const url = new URL(frame.dataset.runtime!, location.href)
  if (url.origin !== location.origin || !/^\/(viewer|player)-runtime\.html$/.test(url.pathname)) throw new Error("Invalid runtime entry")
  const nonce = crypto.randomUUID()
  // A query change forces a new Document on reconnect; a hash-only change would not.
  url.searchParams.set("instance", crypto.randomUUID())
  url.hash = nonce
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearInterval(interval)
      clearTimeout(timeout)
      window.removeEventListener("message", onMessage)
      signal.removeEventListener("abort", abort)
    }
    const abort = () => { cleanup(); reject(signal.reason) }
    const onMessage = (event: MessageEvent<unknown>) => {
      const message = event.data as { type?: string; nonce?: string } | null
      if (event.source !== target || event.origin !== "null" || message?.type !== "fairygui.runtime.pong" || message.nonce !== nonce) return
      cleanup()
      resolve()
    }
    // Opaque origins require '*'; the receiver pins parent Window + origin + nonce.
    const ping = () => target.postMessage({ type: "fairygui.runtime.ping", nonce }, "*")
    const interval = window.setInterval(ping, 100)
    const timeout = window.setTimeout(() => { cleanup(); reject(new Error("Runtime 页面加载超时。")) }, 20_000)
    window.addEventListener("message", onMessage)
    signal.addEventListener("abort", abort, { once: true })
    frame.src = url.href
  })
  signal.throwIfAborted()
  return { nonce, imageProbeWorker }
}
