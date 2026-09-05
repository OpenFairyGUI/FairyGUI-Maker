import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { UamProject } from "@openfairygui/core"
import { analyzeProjectAssets } from "../src/asset-analysis"
import { canonicalJson, parseMakerImportBundleV1, serializeMakerImportBundleV1 } from "../src/design-import/bundle"
import { convertDocument } from "../src/design-import/convert"
import { parseImportJson, stringifyImportJson } from "../src/design-import/json"
import type { ImportDocument, ImportFrame, ImportNode, ImportInstanceOverride } from "../src/design-import/model"

const MiB = 1024 * 1024
const common = (id: string) => ({ id, name: id, x: 0, y: 0, width: 100, height: 100, visible: true,
  opacity: 1, rotation: 0, scaleX: 1, scaleY: 1, mask: false, constraints: null, layoutChild: true })
const frame = (id: string, children: ImportNode[]): ImportFrame => ({ ...common(id), kind: "frame", sourceType: "component",
  variantProperties: {}, layout: null, clipContent: false, backgroundColor: null, children })
const document = (...roots: ImportFrame[]): ImportDocument => ({ name: "Stress", diagnostics: [], pages: [{ id: "page", name: "Page", roots }] })
const source = { kind: "raster" as const, name: "stress", sha256: "0".repeat(64) }

const cases = {
  async base64(sample: () => void) {
    const input = new Uint8Array(64 * MiB).fill(7)
    sample()
    const text = stringifyImportJson({ bytes: input })
    sample()
    const parsed = parseImportJson(text) as { bytes: Uint8Array }
    assert.deepEqual(parsed.bytes, input)
    sample()
    return { sourceBytes: input.byteLength, jsonCharacters: text.length }
  },
  async assets(sample: () => void) {
    const resources = Array.from({ length: 5000 }, (_, i) => ({ kind: "image", id: `i${i}`, name: `i${i}`,
      path: "/", branch: "", exported: false, sourceBytes: new Uint8Array(32 * 1024).fill(i % 251) }))
    const project = { projectId: "stress", settings: {}, packages: [{ id: "PACKAGE1", name: "Stress", resources }] } as unknown as UamProject
    sample()
    assert.equal((await analyzeProjectAssets(project, { projectId: "stress", sourceRevision: "stress" })).resources.length, 5000)
    await assert.rejects(analyzeProjectAssets({ ...project, packages: [{ ...project.packages[0], resources: [...project.packages[0].resources, project.packages[0].resources[0]] }] }, { projectId: "stress", sourceRevision: "stress" }), /5000/)
    sample()
    return { images: 5000, sourceBytes: 5000 * 32 * 1024 }
  },
  async bundle(sample: () => void) {
    const input = document(frame("root", Array.from({ length: 16 }, (_, i) => ({ ...common(`i${i}`), kind: "image" as const,
      format: "png" as const, bytes: new Uint8Array(8 * MiB).fill(i + 1) }))))
    sample()
    const files = await serializeMakerImportBundleV1({ source, document: input })
    sample()
    const parsed = await parseMakerImportBundleV1(files)
    assert.equal(parsed.document.pages[0].roots[0].children.length, 16)
    sample()
    const normal = await serializeMakerImportBundleV1({ source, document: document(frame("empty", [])) })
    const manifest = JSON.parse(new TextDecoder().decode(files["maker-import.json"]))
    manifest.assets[0].byteLength = 513 * MiB
    await assert.rejects(parseMakerImportBundleV1({ ...files, "maker-import.json": new TextEncoder().encode(`${JSON.stringify(canonicalJson(manifest), null, 2)}\n`) }), /512 MiB/)
    assert.equal((await parseMakerImportBundleV1(normal)).document.name, "Stress")
    return { images: 16, sourceBytes: 128 * MiB, rejectedDeclaredBytes: 513 * MiB, recovered: true }
  },
  async references(sample: () => void) {
    const displayList = Array.from({ length: 50_000 }, (_, i) => ({ kind: "image", id: `i${i}`, resource: { resourceId: "image" } }))
    const root = { kind: "component", id: "root", name: "root", path: "/", component: { displayList, properties: {} } }
    const image = { kind: "image", id: "image", name: "image", path: "/" }
    const project = { settings: {}, packages: [{ id: "PACKAGE1", name: "Stress", resources: [root, image] }] } as unknown as UamProject
    sample()
    const source = { projectId: "stress", sourceRevision: "stress" }
    assert.equal((await analyzeProjectAssets(project, source)).references.length, 50_000)
    sample()
    displayList.push(displayList[0])
    await assert.rejects(analyzeProjectAssets(project, source), /50000/)
    displayList.length = 1
    assert.equal((await analyzeProjectAssets(project, source)).references.length, 1)
    sample()
    return { references: 50_000, overflowRejected: true, recovered: true }
  },
  async overrides(sample: () => void) {
    const leaf = frame("leaf", [{ ...common("text"), kind: "text", text: "x".repeat(MiB), fontFamily: "Arial", fontSize: 16,
      color: "#ffffff", bold: false, italic: false, underline: false, strikethrough: false, align: "left", verticalAlign: "top",
      lineHeight: null, letterSpacing: 0, autoSize: "none", singleLine: false, runs: [], shadow: null }])
    const override: ImportInstanceOverride = { targetId: "text", targetPath: [], text: "changed", componentId: null, name: null,
      visible: null, opacity: null, width: null, height: null, fillColor: null, strokeColor: null, strokeWidth: null,
      cornerRadius: null, fontFamily: null, fontSize: null, bold: null, italic: null, underline: null, strikethrough: null }
    const instances = (count: number) => frame("root", Array.from({ length: count }, (_, i) => ({ ...common(`i${i}`), kind: "instance", componentId: "leaf", overrides: [override] })))
    sample()
    assert.throws(() => convertDocument(document(leaf, instances(33))), /INSTANCE_OVERRIDE_LIMIT.*32 MiB/)
    sample()
    assert.ok(convertDocument(document(leaf, instances(16))).project.packages.length)
    sample()
    return { rejectedClones: 33, recoveredClones: 16, cloneByteLimit: 32 * MiB }
  },
}

const name = process.argv[2] as keyof typeof cases
if (Object.hasOwn(cases, name)) {
  assert.ok(globalThis.gc, "Run with --expose-gc")
  const collect = () => { for (let i = 0; i < 3; i++) globalThis.gc!() }
  collect()
  const before = process.memoryUsage()
  const peak = { ...before }
  const sample = () => { const now = process.memoryUsage(); for (const key of Object.keys(peak) as Array<keyof typeof peak>) peak[key] = Math.max(peak[key], now[key]) }
  const digest = crypto.subtle.digest.bind(crypto.subtle)
  let active = 0, maxActiveHashes = 0
  crypto.subtle.digest = async (...args) => {
    maxActiveHashes = Math.max(maxActiveHashes, ++active)
    sample()
    try { return await digest(...args) } finally { active--; sample() }
  }
  const start = performance.now()
  const details = await cases[name](sample)
  sample()
  await new Promise(resolve => setImmediate(resolve))
  collect()
  const after = process.memoryUsage()
  const checks = {
    retainedHeapBelow32MiB: after.heapUsed - before.heapUsed < 32 * MiB,
    retainedArrayBuffersBelow4MiB: after.arrayBuffers - before.arrayBuffers < 4 * MiB,
    processPeakBelow1GiB: process.resourceUsage().maxRSS * 1024 < 1024 * MiB,
    singleHashInFlight: maxActiveHashes <= 1,
  }
  console.log(JSON.stringify({ name, details, elapsedMs: performance.now() - start, before, peak, after,
    maxRssBytes: process.resourceUsage().maxRSS * 1024, maxActiveHashes, checks, node: process.version, platform: process.platform }))
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks))
} else {
  const results = []
  let failed = false
  for (const name of Object.keys(cases)) {
    const child = spawnSync(process.execPath, ["--expose-gc", "--import", "tsx", fileURLToPath(import.meta.url), name], { encoding: "utf8", timeout: 180_000, maxBuffer: MiB })
    failed ||= child.status !== 0
    const result = { name, status: child.status, error: child.status === 0 ? undefined : String(child.stderr || child.error).slice(0, 8000),
      ...(child.stdout.trim().startsWith("{") ? JSON.parse(child.stdout.trim()) : {}) }
    results.push(result)
    console.log(`${name}: ${child.status === 0 ? "passed" : "FAILED"}; peak RSS ${(result.maxRssBytes / MiB).toFixed(1)} MiB; post-GC ${(result.after?.rss / MiB).toFixed(1)} MiB; hashes ${result.maxActiveHashes}`)
  }
  const output = path.resolve("test-results/memory", `node-${Date.now()}.json`)
  await mkdir(path.dirname(output), { recursive: true })
  await writeFile(output, JSON.stringify({ status: failed ? "failed" : "passed", results, gpu: "unverified", sampling: "RSS high-water mark plus phase/hash-boundary samples; post-GC is retained memory, not guaranteed OS reclamation" }, null, 2))
  console.log(`Memory evidence: ${output}`)
  assert.equal(failed, false, "Memory gate failed; see retained evidence")
}
