import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"
import { deflateRawSync } from "node:zlib"
import test from "node:test"
import { checkImageDimensions, checkPngDimensions, checkRuntimeMetadata, decompressFuiIfNeeded, ObservationBudget, probeWebpDimensions, readBoundedStream, ResourceBudget, RUNTIME_LIMITS, withRuntimeLoad } from "../src/runtime/resource-budget"

function fui(payload: Uint8Array, compressed = true) {
  const header = Buffer.alloc(33)
  header.writeUInt32BE(0x46475549)
  header.writeInt32BE(2, 4)
  header[8] = compressed ? 1 : 0
  return new Uint8Array(Buffer.concat([header, compressed ? deflateRawSync(payload) : payload]))
}

test("runtime FUI inflation bounds output, ratio, malformed headers and remaining package budget", async () => {
  const payload = randomBytes(2048)
  const source = fui(payload)
  const inflated = await decompressFuiIfNeeded(source)
  assert.deepEqual(inflated.subarray(33), new Uint8Array(payload))
  assert.equal(inflated[8], 0)
  assert.equal(source[8], 1, "does not modify the source")
  assert.equal(await decompressFuiIfNeeded(inflated), inflated)
  await assert.rejects(decompressFuiIfNeeded(fui(Buffer.alloc(1024 * 1024))), /resource_budget_exceeded: stream_bytes/)
  await assert.rejects(decompressFuiIfNeeded(source, undefined, 1024), /resource_budget_exceeded: stream_bytes/)
  await assert.rejects(decompressFuiIfNeeded(inflated, undefined, 1024), /fui_inflated_bytes/)
  await assert.rejects(decompressFuiIfNeeded(source.subarray(0, 13)), /数据缺失/)
  const invalid = source.slice()
  invalid[8] = 2
  await assert.rejects(decompressFuiIfNeeded(invalid), /包头/)
  await assert.rejects(decompressFuiIfNeeded(source.subarray(1)), /包头/)
  await assert.rejects(decompressFuiIfNeeded(source, AbortSignal.abort(new Error("cancelled"))), /cancelled/)
})

test("runtime stream collector cancels over-limit, chunk-flood, interrupted and stalled streams", async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(8)) },
    cancel() { cancelled = true },
  })
  await assert.rejects(readBoundedStream(stream, 10), /stream_bytes/)
  assert.equal(cancelled, true)
  await assert.rejects(readBoundedStream(new ReadableStream({ pull(c) { c.enqueue(new Uint8Array()) } }), 10, undefined, 2), /stream_chunks/)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("load deadline")), 10)
  try {
    await assert.rejects(readBoundedStream(new ReadableStream({ cancel() { cancelled = true } }), 10, controller.signal), /load deadline/)
  } finally { clearTimeout(timer) }
  await assert.rejects(readBoundedStream(new ReadableStream({ start(c) { c.error(new Error("broken stream")) } }), 10), /broken stream/)
  const result = await readBoundedStream(new Blob([new Uint8Array([1, 2, 3])]).stream(), 3)
  assert.deepEqual(Array.from(result), [1, 2, 3])
})

test("runtime load deadlines cancel active reads but detach from completed fetches", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] })
  const lifetime = new AbortController()
  let completed!: AbortSignal
  assert.equal(await withRuntimeLoad(lifetime.signal, async (signal) => { completed = signal; return 3 }), 3)
  t.mock.timers.tick(RUNTIME_LIMITS.loadMs)
  lifetime.abort()
  assert.equal(completed.aborted, false)
  await assert.rejects(withRuntimeLoad(lifetime.signal, async () => assert.fail("aborted load started")), { name: "AbortError" })
  for (const timeout of [false, true]) {
    const active = new AbortController()
    let cancelled = false
    const pending = withRuntimeLoad(active.signal, (signal) => readBoundedStream(new ReadableStream({ cancel() { cancelled = true } }), 10, signal))
    const rejected = assert.rejects(pending, timeout ? { name: "TimeoutError" } : /session closed/)
    if (timeout) t.mock.timers.tick(RUNTIME_LIMITS.loadMs)
    else active.abort(new Error("session closed"))
    await rejected
    assert.equal(cancelled, true)
  }
})

test("runtime image and scene accounting reject oversized inputs before allocating textures/nodes", () => {
  const png = Buffer.alloc(24)
  Buffer.from("89504e470d0a1a0a", "hex").copy(png)
  png.writeUInt32BE(100_000, 16)
  png.writeUInt32BE(1, 20)
  assert.throws(() => checkPngDimensions(png), /image_width/)
  assert.throws(() => checkImageDimensions(4096, 4096), /image_pixels/)
  assert.throws(() => checkImageDimensions(NaN, 1), /image_width/)
  const budget = new ResourceBudget()
  budget.encoded(RUNTIME_LIMITS.fileBytes)
  budget.encoded(RUNTIME_LIMITS.fileBytes)
  assert.throws(() => budget.encoded(1), /encoded_bytes/)
  for (let i = 0; i < 4; i++) budget.texture(4096, 2048)
  assert.throws(() => budget.texture(1, 1), /decoded_pixel_bytes/)
  const textures = new ResourceBudget()
  for (let i = 0; i < RUNTIME_LIMITS.textures; i++) textures.texture()
  assert.throws(() => textures.texture(), /textures/)
  const nodes = new ResourceBudget()
  nodes.node(64, RUNTIME_LIMITS.nodes)
  assert.throws(() => nodes.node(1), /scene_nodes/)
  assert.throws(() => new ResourceBudget().node(65), /scene_depth/)
})

test("runtime static WebP checks actual frame dimensions and rejects animated/mismatched containers", () => {
  const webp = Buffer.alloc(26)
  webp.write("RIFF")
  webp.writeUInt32LE(webp.length - 8, 4)
  webp.write("WEBPVP8L", 8)
  webp.writeUInt32LE(5, 16)
  webp[20] = 0x2f
  webp.writeUInt32LE(31 | (15 << 14), 21)
  assert.deepEqual(probeWebpDimensions(webp), { width: 32, height: 16 })
  webp.writeUInt32LE(0x3fff, 21)
  assert.throws(() => probeWebpDimensions(webp), /image_width/)
  webp.write("ANMF", 12)
  assert.throws(() => probeWebpDimensions(webp), /animated WebP/)
  webp.write("VP8L", 12)
  webp.writeUInt32LE(31 | (15 << 14), 21)
  const extended = Buffer.alloc(webp.length + 18)
  webp.copy(extended, 0, 0, 12)
  extended.writeUInt32LE(extended.length - 8, 4)
  extended.write("VP8X", 12)
  extended.writeUInt32LE(10, 16)
  extended[24] = 31; extended[27] = 15
  webp.copy(extended, 30, 12)
  assert.deepEqual(probeWebpDimensions(extended), { width: 32, height: 16 })
  extended[24] = 32
  assert.throws(() => probeWebpDimensions(extended), /Invalid.*WebP/)
  assert.equal(probeWebpDimensions(new Uint8Array([1])), null)
})

test("observation budgets bound strings, aggregate characters, entries and nesting", () => {
  const strings = new ObservationBudget()
  assert.throws(() => strings.text("x".repeat(RUNTIME_LIMITS.stringLength + 1)), /observation_string/)
  const total = new ObservationBudget()
  for (let i = 0; i < 64; i++) total.text("x".repeat(16_384))
  assert.throws(() => total.text("x"), /observation_characters/)
  const entries = new ObservationBudget()
  for (let i = 0; i < RUNTIME_LIMITS.observationEntries; i++) entries.entry()
  assert.throws(() => entries.entry(), /observation_entries/)
  assert.throws(() => new ObservationBudget().entry(65), /observation_depth/)
  const nodes = new ObservationBudget()
  for (let i = 0; i < RUNTIME_LIMITS.nodes; i++) nodes.node(1)
  assert.throws(() => nodes.node(1), /observation_nodes/)
  const cycle: any = {}; cycle.self = cycle
  assert.throws(() => checkRuntimeMetadata(cycle), /metadata_depth/)
  assert.throws(() => checkRuntimeMetadata({ text: "x".repeat(16_385) }), /observation_string/)
  assert.throws(() => checkRuntimeMetadata(new Array(100_000_000)), /metadata_items/)
  assert.doesNotThrow(() => checkRuntimeMetadata({ data: new ArrayBuffer(100), text: "valid" }))
})
