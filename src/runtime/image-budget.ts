import { checkBudget, checkImageDimensions, checkPngDimensions, RUNTIME_LIMITS, type ResourceBudget } from "./resource-budget"

declare const Laya: any
declare const fgui: any

let imageProbeWorkerSource = ""
export function setImageProbeWorker(source: string) { imageProbeWorkerSource = source }

export function installResourceLoadBudget(urls: Set<string>, images: Set<string>) {
  const load = Laya.loader.load
  Laya.loader.load = function (input: any, ...args: any[]) {
    for (const entry of Array.isArray(input) ? input : [input]) {
      const url = typeof entry === "string" ? entry : entry?.url
      // Inline rich-text images and native widget templates must not bypass image preflight.
      // Native asynchronous consumers already handle a missing resource (null).
      if (typeof url !== "string") return Promise.resolve(null)
      let key = url
      if (!urls.has(key)) {
        let parsed: URL
        try { parsed = new URL(url, location.href) } catch { return Promise.resolve(null) }
        if (parsed.origin !== location.origin) return Promise.resolve(null)
        key = parsed.pathname + parsed.search
      }
      if (!urls.has(key)) return Promise.resolve(null)
      const type = entry?.type ?? (typeof args[0] === "string" ? args[0] : args[0]?.type)
      if ((type == null || type === Laya.Loader.IMAGE) && !images.has(key)) return Promise.resolve(null)
    }
    return load.call(this, input, ...args)
  }
}

export async function loadRuntimeTexture(url: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const clear = () => { Laya.loader.cancelLoadByUrl?.(url); Laya.loader.clearRes(url) }
  let abort = () => {}
  try {
    return await Promise.race([
      Promise.resolve(fgui.AssetProxy.inst.load(url, Laya.Loader.IMAGE)).then((texture: any) => {
        if (signal.aborted) { texture?.destroy?.(); clear(); signal.throwIfAborted() }
        if (!texture) throw new Error("Unable to decode runtime image")
        return texture
      }),
      new Promise<never>((_, reject) => {
        abort = () => { clear(); reject(signal.reason) }
        signal.addEventListener("abort", abort, { once: true })
        if (signal.aborted) abort()
      }),
    ])
  } finally { signal.removeEventListener("abort", abort) }
}

export async function reserveImage(data: ArrayBuffer, type: string, budget: ResourceBudget, signal: AbortSignal) {
  checkBudget(data.byteLength, RUNTIME_LIMITS.fileBytes, "image_encoded_bytes")
  checkBudget(budget.textures + 1, RUNTIME_LIMITS.textures, "textures")
  checkPngDimensions(new Uint8Array(data))
  signal.throwIfAborted()
  if (!imageProbeWorkerSource) throw new Error("Image probe worker is unavailable")
  // Keep URL ownership here: an opaque worker cannot reliably revoke its creator's URL.
  const workerUrl = URL.createObjectURL(new Blob([imageProbeWorkerSource], { type: "text/javascript" }))
  let worker: Worker | undefined
  let abort: () => void = () => {}
  try {
    worker = new Worker(workerUrl)
    const probe = worker
    const result = await new Promise<{ width?: number; height?: number; svg?: string }>((resolve, reject) => {
      abort = () => reject(signal.reason)
      signal.addEventListener("abort", abort, { once: true })
      probe.onerror = () => reject(new Error("Image validation worker failed"))
      probe.onmessage = ({ data }) => data.error ? reject(new Error(data.error)) : resolve(data.result)
      // Keep the source buffer owned by the scene; validation is terminated on timeout/cancel.
      probe.postMessage({ bytes: data, svg: type === "image/svg+xml" })
    })
    let { width, height } = result
    if (result.svg) {
      const root = new DOMParser().parseFromString(result.svg, "image/svg+xml").documentElement
      const dimension = (name: string) => {
        const value = root.getAttribute(name)
        if (value == null) return undefined
        if (!/^\d+(?:\.\d+)?(?:px)?$/.test(value)) throw new Error("SVG requires explicit pixel dimensions")
        return Math.ceil(Number(value.replace(/px$/, "")))
      }
      width = dimension("width")
      height = dimension("height")
      if (width == null || height == null) {
        const box = root.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number)
        if (!box || box.length !== 4) throw new Error("SVG requires dimensions or viewBox")
        width ??= Math.ceil(box[2]!)
        height ??= Math.ceil(box[3]!)
      }
      checkImageDimensions(width, height)
      root.setAttribute("width", String(width))
      root.setAttribute("height", String(height))
      data = new TextEncoder().encode(new XMLSerializer().serializeToString(root)).buffer
    }
    checkImageDimensions(width!, height!)
    budget.texture(width!, height!)
    return { width: width!, height: height!, data }
  } finally {
    signal.removeEventListener("abort", abort)
    worker?.terminate()
    URL.revokeObjectURL(workerUrl)
  }
}
