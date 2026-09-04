// Runtime limits are deliberately lower than the upload/storage limits.
export const RUNTIME_LIMITS = {
  fileBytes: 128 * 1024 * 1024,
  encodedBytes: 256 * 1024 * 1024,
  inflatedBytes: 256 * 1024 * 1024,
  compressionRatio: 100,
  streamChunks: 16_384,
  loadMs: 15_000,
  imageDimension: 8_192,
  imagePixels: 8 * 1024 * 1024,
  decodedPixelBytes: 128 * 1024 * 1024,
  textures: 1_024,
  nodes: 5_000,
  depth: 64,
  stringLength: 16_384,
  observationEntries: 10_000,
  observationCharacters: 1024 * 1024,
} as const

export function checkBudget(value: number, limit: number, resource: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > limit) {
    throw new Error(`resource_budget_exceeded: ${resource} (${value} > ${limit})`)
  }
}

export function checkImageDimensions(width: number, height: number) {
  if (width < 1 || height < 1) throw new Error("Invalid image dimensions")
  checkBudget(width, RUNTIME_LIMITS.imageDimension, "image_width")
  checkBudget(height, RUNTIME_LIMITS.imageDimension, "image_height")
  checkBudget(width * height, RUNTIME_LIMITS.imagePixels, "image_pixels")
}

// Read IHDR before any decoder (including Core's strict PNG validation) runs.
export function checkPngDimensions(bytes: Uint8Array) {
  if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  checkImageDimensions(view.getUint32(16), view.getUint32(20))
  let chunks = 0
  for (let offset = 8; offset + 8 <= bytes.length; offset += 12 + view.getUint32(offset)) {
    checkBudget(++chunks, RUNTIME_LIMITS.streamChunks, "image_chunks")
    if (view.getUint32(offset + 4) === 0x6163544c) throw new Error("Animated PNG is outside the runtime image budget")
  }
}

// Core validates PNG/JPEG. For static WebP, check every RIFF dimension header before
// the browser decoder: https://developers.google.com/speed/webp/docs/riff_container
export function probeWebpDimensions(bytes: Uint8Array) {
  const fourCC = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4))
  if (fourCC(0) !== "RIFF" || fourCC(8) !== "WEBP") return null
  const invalid = () => { throw new Error("Invalid or animated WebP is outside the runtime image budget") }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 20 || view.getUint32(4, true) + 8 !== bytes.length) invalid()
  let dimensions: { width: number; height: number } | undefined
  let canvas: typeof dimensions
  let count = 0
  for (let offset = 12; offset < bytes.length;) {
    checkBudget(++count, RUNTIME_LIMITS.streamChunks, "image_chunks")
    if (offset + 8 > bytes.length) invalid()
    const kind = fourCC(offset)
    const size = view.getUint32(offset + 4, true)
    offset += 8
    const end = offset + size + (size % 2)
    if (end > bytes.length) invalid()
    if (kind === "ANIM" || kind === "ANMF") invalid()
    if (kind === "VP8X") {
      if (size !== 10 || canvas || (bytes[offset]! & 2)) invalid()
      const uint24 = (i: number) => bytes[i]! + bytes[i + 1]! * 256 + bytes[i + 2]! * 65536
      canvas = { width: uint24(offset + 4) + 1, height: uint24(offset + 7) + 1 }
      checkImageDimensions(canvas.width, canvas.height)
    } else if (kind === "VP8 " || kind === "VP8L") {
      if (dimensions) invalid()
      if (kind === "VP8 ") {
        if (size < 10 || (bytes[offset]! & 1) || bytes[offset + 3] !== 0x9d || bytes[offset + 4] !== 1 || bytes[offset + 5] !== 0x2a) invalid()
        dimensions = { width: view.getUint16(offset + 6, true) & 0x3fff, height: view.getUint16(offset + 8, true) & 0x3fff }
      } else {
        if (size < 5 || bytes[offset] !== 0x2f) invalid()
        const bits = view.getUint32(offset + 1, true)
        dimensions = { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
      }
      checkImageDimensions(dimensions.width, dimensions.height)
    }
    offset = end
  }
  if (!dimensions || (canvas && (canvas.width !== dimensions.width || canvas.height !== dimensions.height))) invalid()
  return dimensions!
}

export class ResourceBudget {
  encodedBytes = 0
  decodedPixelBytes = 0
  textures = 0
  nodes = 0

  encoded(bytes: number) {
    checkBudget(bytes, RUNTIME_LIMITS.fileBytes, "file_bytes")
    checkBudget(this.encodedBytes + bytes, RUNTIME_LIMITS.encodedBytes, "encoded_bytes")
    this.encodedBytes += bytes
  }

  texture(width = 0, height = 0) {
    if (width || height) checkImageDimensions(width, height)
    checkBudget(this.textures + 1, RUNTIME_LIMITS.textures, "textures")
    checkBudget(this.decodedPixelBytes + width * height * 4, RUNTIME_LIMITS.decodedPixelBytes, "decoded_pixel_bytes")
    this.textures += 1
    this.decodedPixelBytes += width * height * 4
  }

  node(depth: number, count = 1) {
    checkBudget(depth, RUNTIME_LIMITS.depth, "scene_depth")
    checkBudget(this.nodes + count, RUNTIME_LIMITS.nodes, "scene_nodes")
    this.nodes += count
  }
}

export class ObservationBudget {
  private entries = 0
  private characters = 0
  private nodes = 0

  node(depth: number) {
    this.entry(depth)
    checkBudget(++this.nodes, RUNTIME_LIMITS.nodes, "observation_nodes")
  }

  entry(depth = 1) {
    checkBudget(depth, RUNTIME_LIMITS.depth, "observation_depth")
    checkBudget(++this.entries, RUNTIME_LIMITS.observationEntries, "observation_entries")
  }

  text(value: unknown): string {
    const text = String(value ?? "")
    checkBudget(text.length, RUNTIME_LIMITS.stringLength, "observation_string")
    this.characters += text.length
    checkBudget(this.characters, RUNTIME_LIMITS.observationCharacters, "observation_characters")
    return text
  }
}

// Covers strings/arrays in source metadata too, before text/layout or native constructors run.
export function checkRuntimeMetadata(value: unknown, depth = 0, budget = new ObservationBudget()) {
  checkBudget(depth, RUNTIME_LIMITS.depth * 2, "metadata_depth")
  if (typeof value === "string") { budget.text(value); return }
  if (!value || typeof value !== "object" || value instanceof ArrayBuffer) return
  if (Array.isArray(value)) checkBudget(value.length, RUNTIME_LIMITS.observationEntries, "metadata_items")
  budget.entry()
  for (const key in value) {
    budget.text(key)
    checkRuntimeMetadata((value as Record<string, unknown>)[key], depth + 1, budget)
  }
}

export async function withRuntimeLoad<T>(lifetime: AbortSignal, read: (signal: AbortSignal) => Promise<T>): Promise<T> {
  lifetime.throwIfAborted()
  const controller = new AbortController()
  const abort = () => controller.abort(lifetime.reason)
  const timer = setTimeout(() => controller.abort(new DOMException("Runtime load timed out", "TimeoutError")), RUNTIME_LIMITS.loadMs)
  lifetime.addEventListener("abort", abort, { once: true })
  try { return await read(controller.signal) }
  finally {
    // Completed fetches must not be cancelled by a later deadline or session teardown.
    clearTimeout(timer)
    lifetime.removeEventListener("abort", abort)
  }
}

export async function readBoundedStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  signal = AbortSignal.timeout(RUNTIME_LIMITS.loadMs),
  maxChunks: number = RUNTIME_LIMITS.streamChunks,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  let complete = false
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}) }
  signal.addEventListener("abort", abort, { once: true })
  try {
    signal.throwIfAborted()
    while (true) {
      const { value, done } = await reader.read()
      signal.throwIfAborted()
      if (done) { complete = true; break }
      checkBudget(chunks.length + 1, maxChunks, "stream_chunks")
      checkBudget(length + value.byteLength, maxBytes, "stream_bytes")
      chunks.push(value)
      length += value.byteLength
    }
    const result = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length }
    return result
  } catch (error) {
    void reader.cancel(error).catch(() => {})
    throw error
  } finally {
    signal.removeEventListener("abort", abort)
    // Like native Response body consumption, keep an EOF reader locked. Unlocking
    // it can abort Chromium's still-pending fetch completion even after all bytes arrived.
    if (!complete) reader.releaseLock()
  }
}

export async function decompressFuiIfNeeded(bytes: Uint8Array<ArrayBuffer>, signal?: AbortSignal, remainingBytes: number = RUNTIME_LIMITS.inflatedBytes) {
  checkBudget(bytes.byteLength, RUNTIME_LIMITS.fileBytes, "fui_encoded_bytes")
  if (bytes.byteLength < 13) throw new Error("FairyGUI 包头无效。")
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (view.getUint32(0) !== 0x46475549 || bytes[8]! > 1) throw new Error("FairyGUI 包头无效。")
  let offset = 9
  for (let index = 0; index < 2; index++) {
    if (offset + 2 > bytes.length) throw new Error("FairyGUI 包头无效。")
    offset += 2 + view.getUint16(offset)
  }
  offset += 20
  if (offset >= bytes.length) throw new Error("FairyGUI 数据缺失。")
  checkBudget(offset, remainingBytes, "fui_inflated_bytes")
  if (bytes[8] === 0) { checkBudget(bytes.length, remainingBytes, "fui_inflated_bytes"); return bytes }
  const maxBytes = Math.min(remainingBytes - offset, RUNTIME_LIMITS.inflatedBytes - offset, (bytes.length - offset) * RUNTIME_LIMITS.compressionRatio)
  const header = bytes.slice(0, offset)
  header[8] = 0
  const body = new Blob([bytes.subarray(offset)]).stream().pipeThrough(new DecompressionStream("deflate-raw"))
  // Include the header in the bounded collector: no third full-size inflated copy.
  const reader = body.getReader()
  let first = true
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (first) { first = false; controller.enqueue(header); return }
      const { value, done } = await reader.read()
      if (done) controller.close()
      else controller.enqueue(value)
    },
    cancel(reason) { return reader.cancel(reason) },
  })
  return readBoundedStream(stream, offset + maxBytes, signal)
}
