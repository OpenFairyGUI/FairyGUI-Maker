import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { deflateRawSync } from "node:zlib"
import { Document, liftDocumentToUamProject, normalizeUamProject, ProjectType } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"
import type { BrowserContext, Frame } from "playwright"
import type { ArtifactManifest, PlayerRenderSource } from "../src/artifact-protocol"
import { type ViewerCommand, type ViewerScene } from "../src/viewer-protocol"
import { compileViewerScene } from "../src/web/lib/viewer"
import { openTestRuntime } from "./runtime-isolation-smoke"
import { RUNTIME_LIMITS } from "../src/runtime/resource-budget"

const revision = "runtime-budget-smoke"

function makeDocument(shape: "normal" | "deep" | "wide") {
  const document = new Document()
  document.getRoot().setProjectId("budget-project").setProjectType(ProjectType.LayaBox)
  const pkg = document.createPackage("Smoke").setId("SMOKE001")
  const root = document.createComponent("Main").setId("MAIN0001").setExported(true).setSize(100, 100)
  pkg.addResource(root)
  if (shape === "deep") {
    let parent = root
    for (let i = 1; i < 67; i++) {
      const id = `DEEP${String(i).padStart(4, "0")}`
      const child = document.createComponent(`Deep${i}`).setId(id).setSize(100, 100)
      pkg.addResource(child)
      parent.addChild(document.createGComponent("child").setId(`child${i}`).setSrc(id))
      parent = child
    }
  } else if (shape === "wide") {
    const child = document.createComponent("Repeated").setId("REPEAT01").setSize(100, 100)
    pkg.addResource(child)
    for (let i = 0; i < 100; i++) child.addChild(document.createGGraph("leaf").setId(`leaf${i}`).setSize(1, 1))
    for (let i = 0; i < 100; i++) root.addChild(document.createGComponent("instance").setId(`instance${i}`).setSrc(child.getId()))
  } else {
    root.addChild(document.createGTextField("title").setId("TITLE001").setText("Budget smoke").setSize(100, 30))
    root.addChild(document.createGGraph("marker").setId("MARKER01").setXY(10, 60).setSize(20, 20).setGraphType(1).setFillColor("#e879f9"))
  }
  return document
}

function scene(document: Document) {
  return compileViewerScene({
    sourceRevision: revision,
    project: normalizeUamProject(liftDocumentToUamProject(document)),
    catalog: { schemaVersion: 1, source: { projectId: "budget" }, packages: [] },
    diagnostics: [],
  }, "SMOKE001", "MAIN0001")
}

function texturedDocument(count: number, png: Buffer) {
  const document = makeDocument("normal")
  const pkg = document.getRoot().listPackages()[0]!
  const root = pkg.listResources().find((resource) => resource.getId() === "MAIN0001") as ReturnType<Document["createComponent"]>
  const atlas = document.createAtlas().setIndex(0).setFile("atlas0.png").setWidth(png.readUInt32BE(16)).setHeight(png.readUInt32BE(20))
  pkg.addAtlas(atlas)
  for (let i = 0; i < count; i++) {
    const id = `IMG${String(i).padStart(5, "0")}`
    pkg.addResource(document.createImageResource(`image${i}`).setId(id).setFileName(`image${i}.png`).setWidth(1).setHeight(1))
    atlas.addSprite(document.createSprite().setItemId(id).setAtlas(atlas).setRectWidth(1).setRectHeight(1).setOriginalWidth(1).setOriginalHeight(1))
    root.addChild(document.createGImage(`texture${i}`).setId(`texture${i}`).setSrc(id).setSize(1, 1))
  }
  return document
}

let requestId = 0
async function request(page: Frame, command: Omit<ViewerCommand, "requestId"> | Record<string, unknown>) {
  const json = JSON.stringify({ ...command, requestId: `budget-${++requestId}` }, (_, value) => value instanceof ArrayBuffer ? { runtimeBytes: Array.from(new Uint8Array(value)) } : value)
  return page.page().evaluate(`window.budgetRequest(JSON.parse(${JSON.stringify(json)}, (_, value) => value?.runtimeBytes ? Uint8Array.from(value.runtimeBytes).buffer : value))`) as Promise<{ ok: boolean; error?: string; value?: any }>
}

function accepted(result: { ok: boolean; error?: string }) { assert.equal(result.ok, true, result.error ?? "runtime command failed") }
function rejected(result: { ok: boolean; error?: string }, pattern: RegExp) {
  assert.equal(result.ok, false, "malicious runtime input was accepted")
  assert.match(result.error ?? "", pattern)
}

async function trackBlobs(page: Frame) {
  await page.evaluate(`(() => {
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    window.budgetBlobs = new Set();
    window.budgetAllBlobs = [];
    URL.createObjectURL = (blob) => { const url = create(blob); window.budgetBlobs.add(url); window.budgetAllBlobs.push(url); return url; };
    URL.revokeObjectURL = (url) => { window.budgetBlobs.delete(url); revoke(url); };
  })()`)
}

async function assertClean(page: Frame) {
  assert.equal(await page.evaluate("window.budgetBlobs.size"), 0, "failed/replaced render leaked Blob URLs")
  assert.equal(await page.evaluate("window.budgetAllBlobs.some(url => !!Laya.loader.getRes(url))"), false, "failed/replaced render leaked decoded cache entries")
  assert.equal(await page.evaluate("Promise.all(window.budgetAllBlobs.map(url => fetch(url).then(() => false, () => true))).then(results => results.every(Boolean))"), true, "Blob URL was not revoked")
}

async function assertOffscreenCapture(frame: Frame) {
  await frame.page().locator("#runtime-harness").evaluate((element) => { element.style.top = "5000px" })
  // No animation tick may rescue stale transform state in the explicit capture path.
  await frame.evaluate("Laya.Render.paused = true; Laya.stage.renderingEnabled = false")
  try {
    for (const width of [614, 482]) {
      accepted(await request(frame, { kind: "set-view", view: { width, height: 446 } }))
      const result = await frame.page().evaluate(async () => {
        const captured = await (window as any).budgetRequest({ kind: "capture", requestId: "offscreen-capture" })
        if (!captured.ok) throw new Error(captured.error)
        const bitmap = await createImageBitmap(new Blob([captured.value.data], { type: "image/png" }))
        try {
          const canvas = document.createElement("canvas"); canvas.width = bitmap.width; canvas.height = bitmap.height
          const ctx = canvas.getContext("2d")!; ctx.drawImage(bitmap, 0, 0)
          const root = captured.value.observation.objectTree
          return { width: bitmap.width, height: bitmap.height, x: root.x, y: root.y,
            pixel: Array.from(ctx.getImageData(root.x + 20, root.y + 70, 1, 1).data) }
        } finally { bitmap.close() }
      })
      assert.deepEqual(result, { width, height: 446, x: (width - 100) / 2, y: 173, pixel: [232, 121, 249, 255] }, "offscreen capture disagrees with the resized object position")
      assert.equal(await frame.evaluate("Laya.stage.renderingEnabled"), false, "capture resumed background rendering")
    }
  } finally {
    await frame.evaluate("Laya.Render.paused = false; Laya.stage.renderingEnabled = true")
    await frame.page().locator("#runtime-harness").evaluate((element) => { element.style.top = "0" })
  }
}

export async function runtimeBudgetSmoke(context: BrowserContext, origin: string, artifact: ArtifactManifest, publishDir: string) {
  const normal = makeDocument("normal")
  const deep = makeDocument("deep")
  const wide = makeDocument("wide")
  const sound = makeDocument("normal")
  sound.getRoot().listPackages()[0].addResource(sound.createSoundResource("tone").setId("SOUND001").setFile("tone.wav"))
  const wav = Buffer.alloc(46)
  wav.write("RIFF"); wav.writeUInt32LE(38, 4); wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28)
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(2, 40)
  const base = await scene(normal)
  const giant = Buffer.alloc(24)
  Buffer.from("89504e470d0a1a0a", "hex").copy(giant)
  giant.writeUInt32BE(100_000, 16)
  giant.writeUInt32BE(100_000, 20)
  const png = await readFile(path.join(process.cwd(), "test/fixtures/design-import/basic-shapes.viewer.png"))
  const withAsset = (data: Uint8Array, kind = "image", fileName = "test.png"): ViewerScene => ({
    ...base,
    assets: [{ packageId: "SMOKE001", packageName: "Smoke", resource: { id: "IMAGE001", kind, name: "image", fileName } as any, data: new Uint8Array(data).buffer }],
  })
  const errors: string[] = []
  const viewerPage = await context.newPage()
  const playerPage = await context.newPage()
  for (const page of [viewerPage, playerPage]) page.on("pageerror", (error) => errors.push(error.message))
  try {
    await viewerPage.goto(origin)
    let viewer = await openTestRuntime(viewerPage, "viewer", revision)
    await trackBlobs(viewer)
    assert.equal(await viewer.evaluate('Laya.loader.load("https://invalid.example/unbudgeted.png")'), null, "unvalidated native image bypassed the resource gate")
    accepted(await request(viewer, { kind: "render", scene: withAsset(png) }))
    assert.equal(await viewer.evaluate("window.budgetBlobs.size"), 1)
    rejected(await request(viewer, { kind: "render", scene: withAsset(giant) }), /resource_budget_exceeded: image_width/)
    await assertClean(viewer)
    rejected(await request(viewer, { kind: "render", scene: await scene(deep) }), /scene_depth/)
    rejected(await request(viewer, { kind: "render", scene: await scene(wide) }), /scene_nodes/)
    const jta = Buffer.alloc(22 + 1025 * 12)
    jta.writeUInt16BE(5); jta.write("yytou", 2); jta.writeInt32BE(100, 7); jta[11] = 24; jta.writeInt16BE(1025, 18)
    for (let i = 0; i < 1025; i++) jta.writeInt16BE(-1, 20 + i * 12 + 10)
    rejected(await request(viewer, { kind: "render", scene: withAsset(jta, "movieClip", "clip.jta") }), /textures/)
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="100000" height="100000"/>')
    rejected(await request(viewer, { kind: "render", scene: withAsset(svg, "image", "huge.svg") }), /image_width/)
    for (const type of ["image/jpeg", "image/webp"]) {
      const encoded = await viewer.evaluate<string>(`(() => { const canvas = document.createElement("canvas"); canvas.width = 32; canvas.height = 16; return canvas.toDataURL(${JSON.stringify(type)}).split(",")[1]; })()`)
      accepted(await request(viewer, { kind: "render", scene: withAsset(Buffer.from(encoded, "base64"), "image", type === "image/jpeg" ? "test.jpg" : "test.webp") }))
    }
    const safeSvg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 16"><rect width="32" height="16" fill="red"/></svg>')
    accepted(await request(viewer, { kind: "render", scene: withAsset(safeSvg, "image", "test.svg") }))
    accepted(await request(viewer, { kind: "render", scene: base }))
    await assertClean(viewer)
    await viewerPage.locator("#runtime-harness").evaluate((frame) => { frame.style.top = "5000px" })
    accepted(await request(viewer, { kind: "render", scene: base }))
    accepted(await request(viewer, { kind: "capture" }))
    await assertOffscreenCapture(viewer)
    const repeatedOperations = Array.from({ length: 2500 }, () => ({ op: "set-property", targetId: "/SMOKE001/MAIN0001", property: "visible", value: true }))
    rejected(await request(viewer, { kind: "apply-operations", operations: repeatedOperations }), /observation_nodes/)
    await viewer.evaluate('fgui.GRoot.inst.getChildAt(0).name = "x".repeat(16385)')
    rejected(await request(viewer, { kind: "observe" }), /observation_string/)
    accepted(await request(viewer, { kind: "render", scene: base }))
    accepted(await request(viewer, { kind: "observe" }))

    // Hold a decoded result across pagehide cancellation. It must not revive a cache entry.
    await viewer.evaluate(`(() => {
      window.budgetOriginalLoad = fgui.AssetProxy.inst.load.bind(fgui.AssetProxy.inst);
      fgui.AssetProxy.inst.load = (...args) => new Promise(resolve => {
        window.budgetOriginalLoad(...args).then(texture => { window.budgetLateTexture = texture; window.budgetLateResolve = resolve; });
      });
    })()`)
    const delayed = JSON.stringify({ kind: "render", requestId: "delayed-image", scene: withAsset(png) }, (_, value) => value instanceof ArrayBuffer ? { runtimeBytes: Array.from(new Uint8Array(value)) } : value)
    await viewerPage.evaluate(`void window.budgetRequest(JSON.parse(${JSON.stringify(delayed)}, (_, value) => value?.runtimeBytes ? Uint8Array.from(value.runtimeBytes).buffer : value)).catch(() => {})`)
    await viewer.waitForFunction(() => Boolean((window as any).budgetLateResolve))
    await viewer.evaluate('dispatchEvent(new PageTransitionEvent("pagehide"))')
    await viewer.evaluate("fgui.AssetProxy.inst.load = window.budgetOriginalLoad; window.budgetLateResolve(window.budgetLateTexture)")
    accepted(await request(viewer, { kind: "render", scene: base }))
    await assertClean(viewer)
    await viewerPage.evaluate("window.replayRuntimeConnect()")
    accepted(await request(viewer, { kind: "observe" }))
    assert.equal(await viewerPage.evaluate("window.rejectedConnections"), 0, "replayed port replaced the live channel")
    viewer = await openTestRuntime(viewerPage, "viewer", revision)
    accepted(await request(viewer, { kind: "render", scene: base }))

    const io = new NodeIO()
    const files = new Map<string, Buffer>()
    const other = makeDocument("normal")
    const otherPackage = other.getRoot().listPackages()[0].setId("OTHER001").setName("Other")
    const dependent = makeDocument("normal")
    const dependentPackage = dependent.getRoot().listPackages()[0]
    dependentPackage.addDependency(dependent.createPackage(otherPackage.getName()).setId(otherPackage.getId()))
    dependentPackage.listComponents()[0].addChild(dependent.createGComponent("external").setId("external").setSrc("MAIN0001").setPackageId("OTHER001"))
    for (const [id, document] of [["normal", normal], ["dependent", dependent], ["other", other], ["deep", deep], ["wide", wide], ["audio", sound], ["image-a", texturedDocument(256, png)], ["textures", texturedDocument(1024, png)]] as const) {
      const target = path.join(publishDir, `budget-${id}.fui`)
      await io.writeBinary(document, target, { compressed: true })
      files.set(id, await readFile(target))
    }
    files.set("image-b", files.get("image-a")!)
    files.set("giant", files.get("image-a")!)
    const header = Buffer.alloc(33)
    header.writeUInt32BE(0x46475549); header.writeInt32BE(2, 4); header[8] = 1
    files.set("bomb", Buffer.concat([header, deflateRawSync(Buffer.alloc(1024 * 1024))]))
    await playerPage.goto(origin)
    const player = await openTestRuntime(playerPage, "player", artifact.digest)
    await trackBlobs(player)
    assert.equal(await player.evaluate('Laya.loader.load("https://invalid.example/unbudgeted.png")'), null, "unvalidated Player image bypassed the resource gate")
    const renderSource = (id: string, image?: Buffer, audio = wav): PlayerRenderSource => ({
      packageId: "SMOKE001", componentId: "MAIN0001", artifact: {
        ...artifact, artifactId: `budget-${id}`,
        files: [{ path: "Smoke.fui", size: (files.get(id) ?? files.get("normal")!).length, sha256: "0".repeat(64), mimeType: "application/octet-stream" },
          ...(id === "audio" ? [{ path: "Smoke_SOUND001.wav", size: audio.length, sha256: "0".repeat(64), mimeType: "audio/wav" }] : []),
          ...(image ? [{ path: "Smoke_atlas0.png", size: image.length, sha256: "0".repeat(64), mimeType: "image/png" }] : [])],
      },
      files: [{ path: "Smoke.fui", data: new Uint8Array(files.get(id) ?? files.get("normal")!).buffer },
        ...(id === "audio" ? [{ path: "Smoke_SOUND001.wav", data: new Uint8Array(audio).buffer }] : []),
        ...(image ? [{ path: "Smoke_atlas0.png", data: new Uint8Array(image).buffer }] : [])],
    })
    const render = (id: string, image?: Buffer, audio = wav) => request(player, { kind: "render-artifact", source: renderSource(id, image, audio) })
    await playerPage.locator("#runtime-harness").evaluate((frame) => { frame.style.top = "5000px" })
    accepted(await render("normal"))
    accepted(await request(player, { kind: "capture" }))
    await assertOffscreenCapture(player)
    rejected(await render("bomb"), /resource_budget_exceeded: stream_bytes/)
    rejected(await render("deep"), /scene_depth/)
    rejected(await render("wide"), /scene_nodes/)
    rejected(await render("giant", giant), /image_width/)
    rejected(await render("textures", png), /textures/)
    await assertClean(player)
    accepted(await render("image-a", png))
    assert.equal(await player.evaluate('Laya.loader.load("https://invalid.example/runtime-artifact/budget-image-a/Smoke_atlas0.png")'), null, "foreign-origin resource reused a trusted path")
    assert.equal(await player.evaluate('fgui.GRoot.inst.getChildAt(0).getChild("texture0").image.texture.width'), 1, "native Player did not use the validated atlas")
    assert.equal(await player.evaluate("window.budgetBlobs.size"), 1)
    accepted(await render("image-b", png))
    assert.equal(await player.evaluate("window.budgetBlobs.size"), 1)
    assert.equal(await player.evaluate('!!Laya.loader.getRes("/runtime-artifact/budget-image-a/Smoke_atlas0.png")'), false)
    accepted(await render("normal"))
    await assertClean(player)
    accepted(await render("audio"))
    assert.match(await player.evaluate('fgui.UIPackage.getById("SMOKE001").getItemById("SOUND001").file'), /^blob:/)
    assert.equal(await player.evaluate('fetch(fgui.UIPackage.getById("SMOKE001").getItemById("SOUND001").file).then(response => response.arrayBuffer()).then(bytes => bytes.byteLength)'), wav.length)
    assert.equal(await player.evaluate('fgui.GRoot.inst.playOneShotSound("https://invalid.example/outside.wav")'), false)
    // Observe real HTML media creation/cleanup; it must not use native Web Audio PCM loading.
    await player.evaluate(`(() => {
      const load = Laya.loader.load.bind(Laya.loader);
      window.audioPcmLoads = 0;
      Laya.loader.load = (...args) => { if (args[1] === Laya.Loader.SOUND) window.audioPcmLoads++; return load(...args); };
      window.playedAudio = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () { window.playedAudio.push(this); return play.call(this); };
      fgui.GRoot.inst.playOneShotSound(fgui.UIPackage.getById("SMOKE001").getItemById("SOUND001").file);
    })()`)
    accepted(await render("normal"))
    assert.equal(await player.evaluate("window.audioPcmLoads"), 0)
    assert.equal(await player.evaluate("window.playedAudio.length > 0 && window.playedAudio.every(audio => audio.paused && !audio.getAttribute('src'))"), true)
    const longWav = Buffer.alloc(44 + 31 * 8000 * 2)
    wav.copy(longWav)
    longWav.writeUInt32LE(longWav.length - 8, 4); longWav.writeUInt32LE(longWav.length - 44, 40)
    rejected(await render("audio", undefined, longWav), /audio_duration_ms/)
    await assertClean(player)
    accepted(await render("normal"))
    await assertClean(player)
    rejected(await request(player, { kind: "apply-operations", operations: repeatedOperations }), /observation_nodes/)
    await player.evaluate('fgui.GRoot.inst.getChildAt(0).name = "x".repeat(16385)')
    rejected(await request(player, { kind: "observe" }), /observation_string/)
    accepted(await render("normal"))
    accepted(await request(player, { kind: "observe" }))
    const dependencySource: PlayerRenderSource = {
      ...renderSource("dependent"),
      artifact: { ...artifact, artifactId: "dependency-closure", packages: [
        { ...artifact.packages[0], dependencies: ["OTHER001"] },
        { ...artifact.packages[0], packageId: "OTHER001", packageName: "Other", binaryPath: "Other.fui", dependencies: [] },
        { ...artifact.packages[0], packageId: "UNUSED00", packageName: "Unused", binaryPath: "Unused.fui", dependencies: [] },
      ], files: [
        { path: "Smoke.fui", size: files.get("dependent")!.length, sha256: "0".repeat(64), mimeType: "application/octet-stream" },
        { path: "Other.fui", size: files.get("other")!.length, sha256: "0".repeat(64), mimeType: "application/octet-stream" },
        { path: "Unused.fui", size: 128 * 1024 * 1024, sha256: "0".repeat(64), mimeType: "application/octet-stream" },
      ] },
      files: [
        { path: "Smoke.fui", data: new Uint8Array(files.get("dependent")!).buffer },
        { path: "Other.fui", data: new Uint8Array(files.get("other")!).buffer },
      ],
    }
    accepted(await request(player, { kind: "render-artifact", source: dependencySource }))
    assert.equal(await player.evaluate('fgui.GRoot.inst.getChildAt(0).getChild("external").getChild("title").text'), "Budget smoke")
    assert.equal(await player.evaluate('!!fgui.UIPackage.getById("UNUSED00")'), false)
    accepted(await request(player, { kind: "render-artifact", source: { ...dependencySource, packageId: "OTHER001", files: dependencySource.files!.filter(file => file.path === "Other.fui") } }))
    assert.equal(await player.evaluate('!!fgui.UIPackage.getById("SMOKE001")'), false, "switching root package retained the previous closure")
    // Measure the actual isolated renderer, not the Workbench parent V8 heap.
    const cdp = await context.newCDPSession(player)
    const heap = async (gc = false) => {
      if (gc) await cdp.send("HeapProfiler.collectGarbage")
      const usage = await cdp.send("Runtime.getHeapUsage")
      const native = await player.evaluate<{ resources: number; cacheEntries: number; cpuBytes: number; gpuEstimatedBytes: number; blobs: number; packages: number }>(`({ resources: Object.keys(Laya.Resource._idResourcesMap).length,
        cacheEntries: Object.keys(Laya.Loader.loadedMap).length, cpuBytes: Laya.Resource.cpuMemory,
        gpuEstimatedBytes: Laya.Resource.gpuMemory, blobs: window.budgetBlobs.size,
        packages: Object.keys(fgui.UIPackage._instById).length })`)
      return { jsHeapBytes: usage.usedSize, backingStorageBytes: usage.backingStorageSize, ...native }
    }
    const peak = await heap()
    const samples = []
    for (let cycle = 1; cycle <= 100; cycle++) {
      const source = renderSource(cycle % 2 ? "image-a" : "image-b", png)
      const prepared = await request(player, { kind: "prepare-artifact", source: { ...source, files: source.files!.filter(file => file.path.endsWith(".fui")) } })
      accepted(prepared)
      assert.deepEqual(prepared.value.files, ["Smoke_atlas0.png"])
      accepted(await request(player, { kind: "render-artifact", source: { ...source, files: source.files!.filter(file => !file.path.endsWith(".fui")) } }))
      const current = await heap()
      for (const key of Object.keys(current) as Array<keyof typeof current>) peak[key] = Math.max(peak[key], current[key])
      assert.equal(current.blobs, 1)
      if (cycle % 10 === 0) {
        accepted(await request(player, { kind: "unload-artifact" }))
        const retained = await heap(true)
        assert.equal(retained.blobs, 0)
        assert.equal(retained.packages, 0)
        samples.push({ cycle, ...retained })
        console.log(`Player memory cycle ${cycle}/100: ${(retained.jsHeapBytes / 1024 / 1024).toFixed(2)} MiB JS heap`)
      }
    }
    const first = samples[0], last = samples.at(-1)!
    assert.ok(last.jsHeapBytes - first.jsHeapBytes < 4 * 1024 * 1024, "Player retained JS heap grew by more than 4 MiB")
    assert.ok(last.backingStorageBytes - first.backingStorageBytes < 1024 * 1024, "Player retained backing stores grew by more than 1 MiB")
    assert.ok(last.jsHeapBytes - samples[4].jsHeapBytes < 1024 * 1024, "Player did not plateau in the final 50 cycles")
    for (const sample of samples) {
      assert.equal(sample.resources, first.resources, "native resources did not return to the warmed baseline")
      assert.equal(sample.cacheEntries, first.cacheEntries, "loader cache entries grew across A/B loads")
      assert.equal(sample.gpuEstimatedBytes, first.gpuEstimatedBytes, "engine texture estimate did not return to baseline")
    }
    await cdp.detach()
    await assertClean(player)
    accepted(await render("normal"))

    // Decode 128 MiB of RGBA, reject the next image before decoding, then recover.
    const largePng = await viewer.evaluate<string>(`(() => { const canvas = document.createElement("canvas"); canvas.width = 4096; canvas.height = 2048; return canvas.toDataURL("image/png").split(",")[1]; })()`)
    const largeImages = (count: number) => ({ ...base, assets: Array.from({ length: count }, (_, i) => {
      const asset = withAsset(Buffer.from(largePng, "base64")).assets[0];
      return { ...asset, resource: { ...asset.resource, id: `large${i}` } };
    }) })
    await viewer.evaluate(`(() => {
      window.stressTextures = [];
      const load = fgui.AssetProxy.inst.load.bind(fgui.AssetProxy.inst);
      fgui.AssetProxy.inst.load = async (...args) => { const texture = await load(...args); window.stressTextures.push(texture); return texture; };
    })()`)
    accepted(await request(viewer, { kind: "render", scene: largeImages(4) }))
    const decodedEstimate = await viewer.evaluate<number>("window.stressTextures.reduce((bytes, texture) => bytes + texture.width * texture.height * 4, 0)")
    assert.equal(decodedEstimate, RUNTIME_LIMITS.decodedPixelBytes)
    rejected(await request(viewer, { kind: "render", scene: largeImages(5) }), /decoded_pixel_bytes/)
    accepted(await request(viewer, { kind: "render", scene: base }))
    const recoveredEstimate = await viewer.evaluate<number>("window.stressTextures.filter(texture => !texture.destroyed).reduce((bytes, texture) => bytes + texture.width * texture.height * 4, 0)")
    assert.equal(await viewer.evaluate("window.stressTextures.length === 8 && window.stressTextures.every(texture => texture.destroyed === true)"), true, "replacement/failure did not destroy all decoded textures")
    assert.equal(recoveredEstimate, 0, "decoded texture handles survived replacement/failure")
    assert.deepEqual(errors, [], "budget failures escaped the command error boundary")
    return { fuiBomb: true, giantImages: true, textures: true, sceneNodes: true, sceneDepth: true, observation: true, recoveryAndCleanup: true, offscreenCapture: true, offscreenResizedPixels: true, nonceHandshake: true, audioBlob: true,
      memory: { cycles: 100, subtexturesPerLoad: 256, dependencyClosure: true, peak, samples, decodedRgbaBudget: RUNTIME_LIMITS.decodedPixelBytes, decodedEstimate, recoveredEstimate, actualGpuMemory: "unverified; the engine GPU counter can stay zero and is not driver/VRAM measurement" } }
  } finally { await viewerPage.close(); await playerPage.close() }
}
