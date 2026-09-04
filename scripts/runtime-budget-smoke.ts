import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { deflateRawSync } from "node:zlib"
import { Document, liftDocumentToUamProject, normalizeUamProject, ProjectType } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"
import type { BrowserContext, Page } from "playwright"
import type { ArtifactManifest } from "../src/artifact-protocol"
import { VIEWER_PROTOCOL_VERSION, type ViewerCommand, type ViewerScene } from "../src/viewer-protocol"
import { compileViewerScene } from "../src/web/lib/viewer"

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
    for (let i = 0; i < 80; i++) child.addChild(document.createGGraph("leaf").setId(`leaf${i}`).setSize(1, 1))
    for (let i = 0; i < 70; i++) root.addChild(document.createGComponent("instance").setId(`instance${i}`).setSrc(child.getId()))
  } else root.addChild(document.createGTextField("title").setId("TITLE001").setText("Budget smoke").setSize(100, 30))
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

async function connect(page: Page, sourceRevision: string) {
  await page.evaluate(`new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const pending = new Map();
    const timer = setTimeout(() => reject(new Error("Runtime connect timeout")), 8000);
    channel.port1.onmessage = ({ data }) => {
      if (data.kind === "ready") { clearTimeout(timer); resolve(true); }
      if (data.kind === "fatal") { clearTimeout(timer); reject(new Error(data.error)); }
      if (data.kind === "response") { pending.get(data.requestId)?.(data); pending.delete(data.requestId); }
    };
    channel.port1.start();
    window.budgetRequest = (command) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Runtime command timeout: " + command.kind)), 8000);
      pending.set(command.requestId, (data) => { clearTimeout(timer); resolve(data); });
      channel.port1.postMessage(command);
    });
    window.postMessage({ type: "fairygui.viewer.connect", protocolVersion: ${VIEWER_PROTOCOL_VERSION}, sourceRevision: ${JSON.stringify(sourceRevision)} }, location.origin, [channel.port2]);
  })`)
}

let requestId = 0
async function request(page: Page, command: Omit<ViewerCommand, "requestId"> | Record<string, unknown>) {
  const json = JSON.stringify({ ...command, requestId: `budget-${++requestId}` }, (_, value) => value instanceof ArrayBuffer ? { runtimeBytes: Array.from(new Uint8Array(value)) } : value)
  return page.evaluate(`window.budgetRequest(JSON.parse(${JSON.stringify(json)}, (_, value) => value?.runtimeBytes ? Uint8Array.from(value.runtimeBytes).buffer : value))`) as Promise<{ ok: boolean; error?: string; value?: any }>
}

function accepted(result: { ok: boolean; error?: string }) { assert.equal(result.ok, true, result.error ?? "runtime command failed") }
function rejected(result: { ok: boolean; error?: string }, pattern: RegExp) {
  assert.equal(result.ok, false, "malicious runtime input was accepted")
  assert.match(result.error ?? "", pattern)
}

async function trackBlobs(page: Page) {
  await page.evaluate(`(() => {
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    window.budgetBlobs = new Set();
    window.budgetAllBlobs = [];
    URL.createObjectURL = (blob) => { const url = create(blob); window.budgetBlobs.add(url); window.budgetAllBlobs.push(url); return url; };
    URL.revokeObjectURL = (url) => { window.budgetBlobs.delete(url); revoke(url); };
  })()`)
}

async function assertClean(page: Page) {
  assert.equal(await page.evaluate("window.budgetBlobs.size"), 0, "failed/replaced render leaked Blob URLs")
  assert.equal(await page.evaluate("window.budgetAllBlobs.some(url => !!Laya.loader.getRes(url))"), false, "failed/replaced render leaked decoded cache entries")
}

export async function runtimeBudgetSmoke(context: BrowserContext, origin: string, artifact: ArtifactManifest, publishDir: string) {
  const normal = makeDocument("normal")
  const deep = makeDocument("deep")
  const wide = makeDocument("wide")
  const base = scene(normal)
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
  const viewer = await context.newPage()
  const player = await context.newPage()
  for (const page of [viewer, player]) page.on("pageerror", (error) => errors.push(error.message))
  try {
    await viewer.goto(`${origin}/viewer-runtime.html`)
    await connect(viewer, revision)
    await trackBlobs(viewer)
    assert.equal(await viewer.evaluate('Laya.loader.load("https://invalid.example/unbudgeted.png")'), null, "unvalidated native image bypassed the resource gate")
    accepted(await request(viewer, { kind: "render", scene: withAsset(png) }))
    assert.equal(await viewer.evaluate("window.budgetBlobs.size"), 1)
    rejected(await request(viewer, { kind: "render", scene: withAsset(giant) }), /resource_budget_exceeded: image_width/)
    await assertClean(viewer)
    rejected(await request(viewer, { kind: "render", scene: scene(deep) }), /scene_depth/)
    rejected(await request(viewer, { kind: "render", scene: scene(wide) }), /scene_nodes/)
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
    const repeatedOperations = Array.from({ length: 2500 }, () => ({ op: "set-property", targetId: "/SMOKE001/MAIN0001", property: "visible", value: true }))
    rejected(await request(viewer, { kind: "apply-operations", operations: repeatedOperations }), /observation_nodes/)
    await viewer.evaluate('fgui.GRoot.inst.getChildAt(0).name = "x".repeat(16385)')
    rejected(await request(viewer, { kind: "observe" }), /observation_string/)
    accepted(await request(viewer, { kind: "render", scene: base }))
    accepted(await request(viewer, { kind: "observe" }))

    // Hold a decoded result across reconnect, then deliver it late. It must not revive a cache entry.
    await viewer.evaluate(`(() => {
      window.budgetOriginalLoad = fgui.AssetProxy.inst.load.bind(fgui.AssetProxy.inst);
      fgui.AssetProxy.inst.load = (...args) => new Promise(resolve => {
        window.budgetOriginalLoad(...args).then(texture => { window.budgetLateTexture = texture; window.budgetLateResolve = resolve; });
      });
    })()`)
    const delayed = JSON.stringify({ kind: "render", requestId: "delayed-image", scene: withAsset(png) }, (_, value) => value instanceof ArrayBuffer ? { runtimeBytes: Array.from(new Uint8Array(value)) } : value)
    await viewer.evaluate(`void window.budgetRequest(JSON.parse(${JSON.stringify(delayed)}, (_, value) => value?.runtimeBytes ? Uint8Array.from(value.runtimeBytes).buffer : value)).catch(() => {})`)
    await viewer.waitForFunction(() => Boolean((window as any).budgetLateResolve))
    await connect(viewer, revision)
    await viewer.evaluate("fgui.AssetProxy.inst.load = window.budgetOriginalLoad; window.budgetLateResolve(window.budgetLateTexture)")
    accepted(await request(viewer, { kind: "render", scene: base }))
    await assertClean(viewer)

    const io = new NodeIO()
    const files = new Map<string, Buffer>()
    for (const [id, document] of [["normal", normal], ["deep", deep], ["wide", wide], ["image-a", texturedDocument(1, png)], ["textures", texturedDocument(1024, png)]] as const) {
      const target = path.join(publishDir, `budget-${id}.fui`)
      await io.writeBinary(document, target, { compressed: true })
      files.set(id, await readFile(target))
    }
    files.set("image-b", files.get("image-a")!)
    const header = Buffer.alloc(33)
    header.writeUInt32BE(0x46475549); header.writeInt32BE(2, 4); header[8] = 1
    files.set("bomb", Buffer.concat([header, deflateRawSync(Buffer.alloc(1024 * 1024))]))
    await player.route("**/api/artifacts/*/files/**", (route) => {
      const url = new URL(route.request().url())
      const id = url.pathname.split("/")[3]!.replace("budget-", "")
      return route.fulfill({ status: 200, contentType: url.pathname.endsWith(".png") ? "image/png" : "application/octet-stream", body: url.pathname.endsWith(".png") ? id === "giant" ? giant : png : files.get(id) ?? files.get("normal")! })
    })
    await player.goto(`${origin}/player-runtime.html`)
    await connect(player, artifact.digest)
    await trackBlobs(player)
    assert.equal(await player.evaluate('Laya.loader.load("https://invalid.example/unbudgeted.png")'), null, "unvalidated Player image bypassed the resource gate")
    const render = (id: string, image?: Buffer) => request(player, { kind: "render-artifact", source: {
      packageId: "SMOKE001", componentId: "MAIN0001", artifact: {
        ...artifact, artifactId: `budget-${id}`,
        files: [{ path: "Smoke.fui", size: (files.get(id) ?? files.get("normal")!).length, sha256: "0".repeat(64), mimeType: "application/octet-stream" },
          ...(image ? [{ path: "Smoke_atlas0.png", size: image.length, sha256: "0".repeat(64), mimeType: "image/png" }] : [])],
      },
    } })
    accepted(await render("normal"))
    rejected(await render("bomb"), /resource_budget_exceeded: stream_bytes/)
    rejected(await render("deep"), /scene_depth/)
    rejected(await render("wide"), /scene_nodes/)
    rejected(await render("giant", giant), /image_width/)
    rejected(await render("textures", png), /textures/)
    await assertClean(player)
    accepted(await render("image-a", png))
    assert.equal(await player.evaluate('Laya.loader.load("https://invalid.example/api/artifacts/budget-image-a/files/Smoke_atlas0.png")'), null, "foreign-origin resource reused a trusted path")
    assert.equal(await player.evaluate('fgui.GRoot.inst.getChildAt(0).getChild("texture0").image.texture.width'), 1, "native Player did not use the validated atlas")
    assert.equal(await player.evaluate("window.budgetBlobs.size"), 1)
    accepted(await render("image-b", png))
    assert.equal(await player.evaluate("window.budgetBlobs.size"), 1)
    assert.equal(await player.evaluate('!!Laya.loader.getRes("/api/artifacts/budget-image-a/files/Smoke_atlas0.png")'), false)
    accepted(await render("normal"))
    await assertClean(player)
    rejected(await request(player, { kind: "apply-operations", operations: repeatedOperations }), /observation_nodes/)
    await player.evaluate('fgui.GRoot.inst.getChildAt(0).name = "x".repeat(16385)')
    rejected(await request(player, { kind: "observe" }), /observation_string/)
    accepted(await render("normal"))
    accepted(await request(player, { kind: "observe" }))
    assert.deepEqual(errors, [], "budget failures escaped the command error boundary")
    return { fuiBomb: true, giantImages: true, textures: true, sceneNodes: true, sceneDepth: true, observation: true, recoveryAndCleanup: true }
  } finally { await viewer.close(); await player.close() }
}
