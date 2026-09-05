import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import test from "node:test"
import type { UamProject } from "@openfairygui/core"
import { analyzeProjectAssets } from "../src/asset-analysis"
import { makerImportSha256 } from "../src/design-import/bundle"
import { artifactPackageClosure } from "../src/runtime/artifact-resources"
import { ResourceBudget, RUNTIME_LIMITS } from "../src/runtime/resource-budget"
import { readArtifactFiles } from "../src/web/lib/player"
import type { ArtifactManifest, ArtifactPackage } from "../src/artifact-protocol"
import { parseImportJson, stringifyImportJson } from "../src/design-import/json"
import { playRuntimeAudio } from "../src/runtime/audio-budget"

test("snapshot Base64 retains its format, subarray boundaries and repeat round trips", () => {
  const bytes = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4)
  const serialized = stringifyImportJson({ bytes })
  assert.deepEqual(JSON.parse(serialized), { bytes: { $uint8: "AQID" } })
  const parsed = parseImportJson(serialized) as { bytes: Uint8Array }
  assert.deepEqual(parsed.bytes, bytes)
  assert.equal(Buffer.isBuffer(parsed.bytes), false)
  assert.equal(stringifyImportJson(parsed), serialized)
})

test("hashing preserves subarray boundaries and keeps one native hash in flight", async t => {
  const bytes = new Uint8Array([9, 1, 2, 3, 9]).subarray(1, 4)
  const hash = createHash("sha256").update(bytes).digest("hex")
  assert.equal(await makerImportSha256(bytes), hash)
  const shared = new Uint8Array(new SharedArrayBuffer(5)); shared.set([9, 1, 2, 3, 9])
  assert.equal(await makerImportSha256(shared.subarray(1, 4)), hash)
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  let active = 0, peak = 0
  t.mock.method(crypto.subtle, "digest", async (...args: Parameters<typeof digest>) => {
    peak = Math.max(peak, ++active)
    try { return await digest(...args) } finally { active-- }
  })
  const resources = Array.from({ length: 50 }, (_, i) => ({ kind: "image", id: `i${i}`, name: `i${i}`, path: "/", branch: "", sourceBytes: bytes }))
  const result = await analyzeProjectAssets({ settings: {}, packages: [{ id: "PACKAGE1", name: "Main", resources }] } as unknown as UamProject,
    { projectId: "stress", sourceRevision: "stress" })
  assert.equal(peak, 1)
  assert.ok(result.resources.every(resource => resource.sha256 === hash))
})

test("Player resolves transitive package closure and rejects missing, cyclic and duplicate identities", () => {
  const pkg = (packageId: string, dependencies: string[] = []): ArtifactPackage => ({ packageId, dependencies, packageName: packageId, binaryPath: `${packageId}.fui`, components: [] })
  const packages = [pkg("a", ["b", "c"]), pkg("b", ["c"]), pkg("c"), pkg("unrelated", ["missing"])]
  assert.deepEqual(artifactPackageClosure(packages, "a").map(pkg => pkg.packageId), ["c", "b", "a"])
  assert.throws(() => artifactPackageClosure(packages, "unrelated"), /missing/)
  assert.throws(() => artifactPackageClosure([pkg("a", ["b"]), pkg("b", ["a"])], "a"), /cycle/)
  assert.throws(() => artifactPackageClosure([pkg("a"), pkg("a")], "a"), /Duplicate/)
})

test("Player only fetches requested manifest bytes; unrelated 500 MiB is not loaded", async t => {
  const bytes = new Uint8Array([1, 2, 3])
  const file = { path: "a.fui", size: 3, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "application/octet-stream" }
  const artifact = { artifactId: "test", files: [file, ...Array.from({ length: 4 }, (_, i) => ({ ...file, path: `unused${i}.png`, size: 125 * 1024 * 1024 }))] } as ArtifactManifest
  const calls: string[] = []
  t.mock.method(globalThis, "fetch", async (url: string) => { calls.push(url); return new Response(bytes) })
  const signal = new AbortController().signal
  assert.equal((await readArtifactFiles(artifact, signal, ["a.fui"])).length, 1)
  assert.equal(calls.length, 1)
  await assert.rejects(readArtifactFiles(artifact, signal, ["../secret"]), /not found/)
  await assert.rejects(readArtifactFiles(artifact, signal, ["a.fui", "a.fui"]), /Duplicate/)
  assert.equal(calls.length, 1)
})

test("audio file, aggregate bytes and clip counts reserve before media allocation", () => {
  const budget = new ResourceBudget()
  assert.throws(() => budget.audio(RUNTIME_LIMITS.audioFileBytes + 1), /audio_file_bytes/)
  for (let i = 0; i < 4; i++) budget.audio(RUNTIME_LIMITS.audioFileBytes)
  assert.throws(() => budget.audio(1), /audio_encoded_bytes/)
  const clips = new ResourceBudget()
  for (let i = 0; i < RUNTIME_LIMITS.audioClips; i++) clips.audio(1)
  assert.throws(() => clips.audio(1), /audio_clips/)
  assert.doesNotThrow(() => new ResourceBudget().audio(46))
})

test("streaming audio only plays registered clips within the eight-voice limit", () => {
  const audios = new Map(Array.from({ length: 10 }, (_, i) => [`blob:${i}`, {
    paused: true, ended: false, currentTime: 10, volume: 1,
    play(this: { paused: boolean }) { this.paused = false; return Promise.resolve() },
  } as unknown as HTMLAudioElement]))
  for (let i = 0; i < 8; i++) assert.equal(playRuntimeAudio(audios, `blob:${i}`, 0.5), true)
  assert.equal(audios.get("blob:0")!.volume, 0.5)
  assert.equal(audios.get("blob:0")!.currentTime, 0)
  assert.equal(playRuntimeAudio(audios, "blob:8", 1), false)
  assert.equal(playRuntimeAudio(audios, "https://invalid.example/audio.wav", 1), false)
  assert.equal(audios.get("blob:8")!.paused, true)
})
