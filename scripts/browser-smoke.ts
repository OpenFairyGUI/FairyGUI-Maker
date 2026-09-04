import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { Document, ProjectType } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"
import { createNodeBackendRuntime } from "@openfairygui/backend/node"
import { chromium } from "playwright"

import { startMakerHost } from "../src/server/index"
import type { ArtifactManifest } from "../src/artifact-protocol"
import { runtimeBudgetSmoke } from "./runtime-budget-smoke"
import { rendererDeliverySmoke, rendererLifecycleSmoke } from "./renderer-delivery-smoke"
import { brokerStateSmoke } from "./broker-state-smoke"
import { projectRevisionSmoke } from "./project-revision-smoke"
import { saveGrantSmoke } from "./save-grant-smoke"
import { assertRuntimeIsolated, runtimeNavigationSmoke } from "./runtime-isolation-smoke"
import { createBrowserEvidence, goldenUpdateEnabled, saveVisualGolden } from "./browser-evidence"
import { browserEvidenceSmoke } from "./browser-evidence-smoke"

const token = "browser-smoke-token-with-24-chars"
const browserChannel = process.env.FAIRYGUI_MAKER_BROWSER_CHANNEL ?? "chromium"
const dataDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-browser-data-"))
const publishDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-browser-publish-"))
let host: Awaited<ReturnType<typeof startMakerHost>> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
const secrets = [token, dataDir, publishDir, process.cwd()]
const evidence = await createBrowserEvidence(secrets)
const goldens: Awaited<ReturnType<typeof saveVisualGolden>>[] = []
const environment: Record<string, unknown> = { browserChannel, node: process.version, platform: process.platform, viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC" }

type McpCall = { result: { content: Array<{ type: string; text?: string; data?: string }>; isError?: boolean } }

async function callTool(origin: string, sessionId: string, id: number, name: string, args: Record<string, unknown>) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Mcp-Session-Id": sessionId,
      "MCP-Protocol-Version": "2025-11-25",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  })
  const body = await response.json() as McpCall & { error?: unknown }
  if (!response.ok || body.error || body.result?.isError) throw new Error(`${name}: ${JSON.stringify(body)}`)
  const text = body.result.content.find((content) => content.type === "text")?.text
  return { body, value: text ? JSON.parse(text) as any : undefined }
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  let last: T | undefined
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await read()
    if (ready(last)) return last
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Browser renderer was not ready: ${JSON.stringify(last)}`)
}

function assertPng(body: McpCall) {
  const image = body.result.content.find((content) => content.type === "image")
  const png = image?.data ? Buffer.from(image.data, "base64") : null
  if (!png || png.length < 100 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || png.readUInt32BE(16) === 0 || png.readUInt32BE(20) === 0) {
    throw new Error("MCP response did not contain a PNG screenshot")
  }
  return png
}

try {
  const updateGoldens = goldenUpdateEnabled()
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8"))
  Object.assign(environment, { makerVersion: packageJson.version, playwrightVersion: packageJson.devDependencies.playwright,
    coreVersion: packageJson.dependencies["@openfairygui/core"], commit: process.env.GITHUB_SHA })
  const importFixture = path.join(process.cwd(), "test", "fixtures", "design-import", "basic-shapes.fig")
  const visualGolden = path.join(process.cwd(), "test", "fixtures", "design-import", "basic-shapes.viewer.png")
  const visualBaseline = JSON.parse(await readFile(path.join(process.cwd(), "test", "fixtures", "design-import", "basic-shapes.visual-baseline.json"), "utf8")) as {
    maxDifferentPixels: number
    maxMeanAbsoluteError: number
  }
  const document = new Document()
  document.getRoot().setProjectId("smoke-project").setProjectType(ProjectType.LayaBox)
  const pkg = document.createPackage("Smoke").setId("SMOKE001")
  const component = document.createComponent("Main").setId("MAIN0001").setExported(true).setSize(520, 300)
  component
    .addChild(document.createGGraph("background").setId("BACK0001").setXY(0, 0).setSize(520, 300).setGraphType(1).setFillColor("#172554"))
    .addChild(document.createGTextField("title").setId("TITLE001").setXY(42, 58).setSize(440, 64).setFontSize(32).setColor("#dbeafe").setText("FairyGUI Maker"))
  pkg.addResource(component)
  component.addController(document.createController("page").setSelectedIndex(0)
    .addPage(document.createControllerPage("First").setId("first"))
    .addPage(document.createControllerPage("Second").setId("second")))
  component.addTransition(document.createTransition("show").addItem(document.createTransitionItem("title")
    .setTime(0).setTargetId("TITLE001").setActionType(14).setStartValue(["Played"]).setEndValue(["Played"])))
  pkg.addResource(document.createComponent("Other").setId("OTHER001").setExported(true).setSize(100, 100)
    .addChild(document.createGGraph("square").setId("SQUARE01").setXY(10, 15).setSize(65, 30).setGraphType(1).setFillColor("#e879f9"))
    .addChild(document.createGGraph("circle").setId("CIRCLE01").setXY(45, 55).setSize(35, 35).setGraphType(2).setFillColor("#38bdf8")))

  const io = new NodeIO()
  const binaryPath = path.join(publishDir, "Smoke.fui")
  await io.writeBinary(document, binaryPath, { compressed: true })
  host = await startMakerHost({ port: 0, token, dataDir, runtime: createNodeBackendRuntime({ allowedProjectRoots: [publishDir] }) })
  secrets.push(host.approvalToken)

  const binary = await readFile(binaryPath)
  const headers = { Authorization: `Bearer ${token}` }
  const created = await fetch(`${host.origin}/api/artifact-imports`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Browser smoke", source: { kind: "published-folder" }, files: [{ path: "Smoke.fui", size: binary.byteLength, sha256: createHash("sha256").update(binary).digest("hex") }] }),
  })
  if (!created.ok) throw new Error(await created.text())
  const { importId } = await created.json() as { importId: string }
  const uploaded = await fetch(`${host.origin}/api/artifact-imports/${importId}/files?path=Smoke.fui`, { method: "PUT", headers, body: binary })
  if (!uploaded.ok) throw new Error(await uploaded.text())
  const completed = await fetch(`${host.origin}/api/artifact-imports/${importId}/complete`, { method: "POST", headers })
  if (!completed.ok) throw new Error(await completed.text())
  const { artifact } = await completed.json() as { artifact: ArtifactManifest }
  environment.runtimeProfile = artifact.runtimeProfile

  const initialized = await fetch(`${host.origin}/mcp`, {
    method: "POST",
    headers: { ...headers, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "browser-smoke", version: "1.0.0" } },
    }),
  })
  if (!initialized.ok) throw new Error(await initialized.text())
  const sessionId = initialized.headers.get("mcp-session-id")
  if (!sessionId) throw new Error("MCP session id missing")

  // Pin the rasterizer for synthetic CI fixtures, not the user's normal browser.
  browser = await chromium.launch({ headless: true, channel: browserChannel, args: ["--use-gl=angle", "--use-angle=swiftshader"] })
  environment.rasterizer = "angle-swiftshader"
  environment.browserVersion = browser.version()
  await evidence.step("evidence-gate-self-test", () => browserEvidenceSmoke(browser!))
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1, locale: "en-US", timezoneId: "UTC", colorScheme: "light", reducedMotion: "reduce" })
  await evidence.attach(context)
  const iframeCredentials: Array<Promise<boolean>> = []
  context.on("request", (request) => {
    if (request.frame().parentFrame()) iframeCredentials.push(request.allHeaders().then((headers) => !headers.cookie && !headers.authorization, () => false))
  })
  const page = await context.newPage()
  evidence.phase("workbench-import")
  await page.goto(`${host.origin}/design-import?token=${token}`, { waitUntil: "domcontentloaded" })
  await page.locator('input[type="file"][accept=".fig,.psd"]').setInputFiles(importFixture)
  await page.waitForURL(/\/imports\/draft_/)
  const mappingResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/semantic-overlay"))
  await page.locator('select[aria-label^="Mapping "]').nth(1).selectOption("ignore")
  if (!(await mappingResponse).ok()) throw new Error("Workbench semantic mapping failed")
  await page.getByRole("button", { name: "生成 Build Plan" }).click()
  await page.getByText("PLANNED", { exact: true }).waitFor()
  const firstPlan = await fetch(`${host.origin}/api/import-drafts/${new URL(page.url()).pathname.split("/").pop()}`, { headers }).then((response) => response.json()) as any
  await page.reload({ waitUntil: "domcontentloaded" })
  const replannedResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().endsWith("/plan"))
  await page.getByRole("button", { name: "重新生成 Build Plan" }).click()
  const replannedResult = await replannedResponse
  if (!replannedResult.ok()) throw new Error("Workbench replan failed")
  const replanned = await replannedResult.json()
  const requestedRootIds = firstPlan.buildPlan.packages.flatMap((pkg: any) => pkg.components.filter((root: any) => root.exported).map((root: any) => root.sourceNodeId))
  if (JSON.stringify(replannedResult.request().postDataJSON().rootIds) !== JSON.stringify(requestedRootIds)) throw new Error("Workbench replan lost the selected root scope")
  if (replanned.draft.revision !== firstPlan.draft.revision + 1 || replanned.buildPlan.schemaVersion !== 2
    || JSON.stringify(replanned.buildPlan) !== JSON.stringify(firstPlan.buildPlan)) throw new Error("Workbench replan is not deterministic or revision-checked")
  await page.getByRole("button", { name: "编译 Viewer Preview" }).click()
  await page.getByText("Viewer Preview", { exact: true }).waitFor()
  // Catalog registration precedes Workbench's initial view/render commands.
  await page.getByText("AGENT READY", { exact: true }).waitFor()
  const draftId = new URL(page.url()).pathname.split("/").pop()!
  const draftDetail = await fetch(`${host.origin}/api/import-drafts/${draftId}`, { headers }).then((response) => response.json()) as { preview: { projectId: string } }
  const projectId = draftDetail.preview.projectId
  const viewerCatalog = await waitFor(
    () => callTool(host!.origin, sessionId, 2, "list_viewer_components", { projectId }).catch(() => ({ value: null } as any)),
    (result) => result.value?.projects?.[0]?.packages?.some((pkg: any) => pkg.components?.length > 0),
  )
  const viewerPackage = viewerCatalog.value.projects[0].packages.find((pkg: any) => pkg.components?.length > 0)
  const viewerComponent = viewerPackage.components[0]
  const viewerRender = await callTool(host.origin, sessionId, 3, "render_component_preview", {
    projectId,
    requestId: randomUUID(),
    packageId: viewerPackage.packageId,
    componentId: viewerComponent.id,
    capture: true,
  })
  const viewerPng = assertPng(viewerRender.body)
  await evidence.step("viewer-golden", async () => {
    goldens.push(await saveVisualGolden(page, evidence.directory, "viewer", viewerPng, viewerRender.value,
      { mode: "viewer", sourceId: projectId, sourceRevision: viewerCatalog.value.projects[0].sourceRevision, packageId: viewerPackage.packageId, componentId: viewerComponent.id }, visualGolden,
      path.join(process.cwd(), "test/fixtures/design-import/basic-shapes.visual-baseline.json")))
    return goldens.at(-1)!.metrics
  })
  const viewerIsolation = await evidence.step("isolation-viewer", () => assertRuntimeIsolated(page, "viewer", `/api/projects/${projectId}/source-index`))
  if (!viewerRender.value?.value?.observation?.objectTree?.children?.length) {
    throw new Error("Viewer observation did not include imported FIG children")
  }
  evidence.phase("workbench-evidence")
  await page.getByTestId("visual-reference-input").setInputFiles(updateGoldens ? { name: "reference.png", mimeType: "image/png", buffer: viewerPng } : visualGolden)
  const evidenceResponse = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/visual-evidence?"))
  await page.getByRole("button", { name: "捕获视觉证据" }).click()
  const savedEvidence = await evidenceResponse
  if (!savedEvidence.ok()) throw new Error(`Workbench visual evidence failed: ${await savedEvidence.text()}`)
  const { visualEvidence } = await savedEvidence.json() as { visualEvidence: { renderState: { renderSessionId: string; semanticStateVersion: number; viewStateVersion: number }; comparison: { differentPixels: number; meanAbsoluteError: number } } }
  if (visualEvidence.renderState?.renderSessionId !== viewerRender.value.renderSessionId || visualEvidence.renderState.semanticStateVersion < viewerRender.value.semanticStateVersion || visualEvidence.renderState.viewStateVersion < 1) throw new Error("Visual evidence lost its Broker state stamp")
  if (visualEvidence.comparison.differentPixels > visualBaseline.maxDifferentPixels
    || visualEvidence.comparison.meanAbsoluteError > visualBaseline.maxMeanAbsoluteError) {
    throw new Error(`basic-shapes visual baseline changed: ${JSON.stringify(visualEvidence.comparison)}`)
  }
  await page.getByTestId("visual-report").waitFor()
  await page.getByRole("button", { name: "Side-by-side" }).click()
  await page.getByAltText("Viewer Capture").waitFor()
  await page.getByRole("button", { name: "Pixel Diff" }).click()
  await page.getByAltText("Pixel Diff").waitFor()
  const viewerState = await evidence.step("broker-state-viewer", () => brokerStateSmoke(page, "viewer", viewerRender.value.renderSessionId,
    (name, args) => callTool(host!.origin, sessionId, 80, name, args)))
  const viewerDelivery = await evidence.step("delivery-viewer", () => rendererDeliverySmoke(page, "viewer", viewerRender.value.renderSessionId, viewerRender.value.value.observation.objectTree.id,
    (name, args) => callTool(host!.origin, sessionId, 60, name, args)))
  const viewerLifecycle = await evidence.step("lifecycle-viewer", () => rendererLifecycleSmoke(page, viewerDelivery.reconnectedSessionId,
    (name, args) => callTool(host!.origin, sessionId, 61, name, args)))
  evidence.phase("artifact-upload")
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByTestId("visual-report").waitFor()
  if (!(await page.getByTestId("visual-report").innerText()).includes(`Semantic ${visualEvidence.renderState.semanticStateVersion} · View ${visualEvidence.renderState.viewStateVersion}`)) throw new Error("Visual evidence state stamp did not survive reload")

  await page.goto(`${host.origin}/player`, { waitUntil: "domcontentloaded" })
  // Inject only the picker result; hashing, upload, finalization and UI run unchanged.
  // Browser JS avoids tsx name helpers in serialized async-generator functions.
  await page.evaluate(`(() => {
    const bytes = ${JSON.stringify(Array.from(binary))};
    Object.defineProperty(window, "showDirectoryPicker", { configurable: true, value: async () => ({
      kind: "directory",
      name: "Smoke",
      async *entries() {
        yield ["Smoke.fui", { kind: "file", getFile: async () => new File([Uint8Array.from(bytes)], "Smoke.fui") }]
      },
    }) })
  })()`)
  const importedResponse = page.waitForResponse((response) => response.request().method() === "POST" && /\/api\/artifact-imports\/[^/]+\/complete$/.test(response.url()))
  await page.getByRole("button", { name: "导入发布目录", exact: true }).click()
  const imported = await importedResponse
  const importedArtifact = (await imported.json()).artifact as ArtifactManifest
  if (!imported.ok() || importedArtifact?.artifactId !== artifact.artifactId || importedArtifact.importId === artifact.importId || importedArtifact.name !== "Smoke") {
    throw new Error("Browser Artifact SHA-256 upload did not reproduce the immutable artifact")
  }
  await page.getByRole("button", { name: "导入发布目录", exact: true }).waitFor()
  // The same content gets a new provenance record, visible after cache invalidation and reload.
  await page.getByText("2 components · 1 files · 2 imports", { exact: false }).waitFor()
  await page.getByText("Smoke", { exact: true }).waitFor()
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.getByText("2 components · 1 files · 2 imports", { exact: false }).waitFor()
  await page.goto(host.origin, { waitUntil: "domcontentloaded" })
  await page.getByText("1 packages · 1 files · 2 imports", { exact: false }).waitFor()

  await evidence.step("lifecycle-player-fetch", async () => {
    const probe = await context.newPage()
    // Exercise the same network interception used by the delivery fault checks.
    await probe.route("**/api/render-sessions/*/results", (route) => route.continue())
    try {
      for (let i = 0; i < 20; i++) {
        const fetched = probe.waitForResponse((response) => response.url().endsWith(`/api/artifacts/${artifact.artifactId}/files/Smoke.fui`))
        await probe.goto(`${host!.origin}/artifacts/${artifact.artifactId}/player`, { waitUntil: "domcontentloaded" })
        // JS can receive every byte while Chromium still reports the request as cancelled.
        if (!(await (await fetched).body()).equals(binary)) throw new Error("Player fetch did not complete with the published bytes")
        await probe.getByText("AGENT READY", { exact: true }).waitFor()
      }
      return { freshLoads: 20, completedFileRequests: 20 }
    } finally { await probe.close() }
  })

  await page.goto(`${host.origin}/artifacts/${artifact.artifactId}/player`, { waitUntil: "domcontentloaded" })
  await page.getByText("AGENT READY", { exact: true }).waitFor()
  await waitFor(
    () => callTool(host!.origin, sessionId, 4, "open_artifact_player", { artifactId: artifact.artifactId }).catch(() => ({ value: null } as any)),
    (result) => result.value?.browserRequired === false,
  )
  await evidence.step("player-golden", async () => {
    const rendered = await callTool(host!.origin, sessionId, 50, "render_artifact_component", {
      artifactId: artifact.artifactId, requestId: randomUUID(), packageId: "SMOKE001", componentId: "OTHER001", capture: false,
    })
    const view = await callTool(host!.origin, sessionId, 51, "set_render_view", { renderSessionId: rendered.value.renderSessionId,
      requestId: randomUUID(), expectedViewStateVersion: rendered.value.viewStateVersion,
      view: { width: 482, height: 446, zoom: 1, background: "#202226" } })
    const captured = await callTool(host!.origin, sessionId, 52, "capture_render_screenshot", { renderSessionId: rendered.value.renderSessionId,
      requestId: randomUUID(), afterStateVersion: rendered.value.semanticStateVersion, afterViewStateVersion: view.value.viewStateVersion })
    goldens.push(await saveVisualGolden(page, evidence.directory, "player", assertPng(captured.body), captured.value,
      { mode: "player", sourceId: artifact.artifactId, sourceRevision: artifact.digest, packageId: "SMOKE001", componentId: "OTHER001" },
      path.join(process.cwd(), "test/fixtures/design-import/smoke.player.png"), path.join(process.cwd(), "test/fixtures/design-import/smoke.player-baseline.json")))
    return goldens.at(-1)!.metrics
  })
  const playerRender = await callTool(host.origin, sessionId, 5, "render_artifact_component", {
    artifactId: artifact.artifactId,
    requestId: randomUUID(),
    packageId: "SMOKE001",
    componentId: "MAIN0001",
    capture: true,
  })
  assertPng(playerRender.body)
  const playerIsolation = await evidence.step("isolation-player", () => assertRuntimeIsolated(page, "player", `/api/artifacts/${artifact.artifactId}/files/Smoke.fui`))
  if (!JSON.stringify(playerRender.value).includes("TITLE001")) throw new Error("Player observation did not include the rendered title")
  const playerState = await evidence.step("broker-state-player", () => brokerStateSmoke(page, "player", playerRender.value.renderSessionId,
    (name, args) => callTool(host!.origin, sessionId, 90, name, args)))
  evidence.phase("artifact-persistence")
  const stablePlayer = (await callTool(host.origin, sessionId, 91, "open_artifact_player", { artifactId: artifact.artifactId })).value.renderSession
  const relabel = await context.request.post(`${host.origin}/api/artifact-imports`, { data: { name: "Relabeled Smoke", files: [{ path: "Smoke.fui", size: binary.length, sha256: createHash("sha256").update(binary).digest("hex") }] } })
  if (relabel.status() !== 201) throw new Error("Artifact relabel import failed")
  const relabelId = (await relabel.json()).importId
  if (!(await context.request.put(`${host.origin}/api/artifact-imports/${relabelId}/files?path=Smoke.fui`, { data: binary })).ok()
    || (await context.request.post(`${host.origin}/api/artifact-imports/${relabelId}/complete`)).status() !== 201) throw new Error("Artifact relabel completion failed")
  // Workbench queries stay fresh for 2s; a normal focus refetch starts only after that window.
  await new Promise((resolve) => setTimeout(resolve, 2_100))
  const metadataRefresh = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === `/api/artifacts/${artifact.artifactId}`)
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")))
  await metadataRefresh
  await page.getByRole("heading", { name: "Relabeled Smoke", exact: true }).waitFor()
  await page.evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
  const relabeledPlayer = (await callTool(host.origin, sessionId, 92, "open_artifact_player", { artifactId: artifact.artifactId })).value.renderSession
  if (relabeledPlayer?.renderSessionId !== stablePlayer.renderSessionId || relabeledPlayer?.semanticStateVersion !== stablePlayer.semanticStateVersion) throw new Error("Artifact provenance refresh reset the Player session")
  const playerDelivery = await evidence.step("delivery-player", () => rendererDeliverySmoke(page, "player", playerRender.value.renderSessionId, playerRender.value.value.observation.objectTree.id,
    (name, args) => callTool(host!.origin, sessionId, 70, name, args)))
  const playerLifecycle = await evidence.step("lifecycle-player", () => rendererLifecycleSmoke(page, playerDelivery.reconnectedSessionId,
    (name, args) => callTool(host!.origin, sessionId, 71, name, args)))
  const runtimeBudgets = await evidence.step("runtime-budgets", () => runtimeBudgetSmoke(page.context(), host!.origin, artifact, publishDir))
  const projectRevision = await evidence.step("project-revision", () => projectRevisionSmoke(context, host!.origin))
  const saveGrants = await evidence.step("save-grants", () => saveGrantSmoke(context, host!, publishDir))
  const runtimeNavigation = await evidence.step("runtime-navigation", () => runtimeNavigationSmoke(context, host!.origin, artifact))
  if (!(await Promise.all(iframeCredentials)).every(Boolean)) throw new Error("Runtime iframe request carried Host credentials")
  evidence.verify()
  await context.close()
  evidence.verify()

  await fetch(`${host.origin}/mcp`, {
    method: "DELETE",
    headers: { ...headers, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25" },
  })
  // Golden changes are explicit and happen only after all functional/diagnostic checks pass.
  if (updateGoldens) for (const golden of goldens) await writeFile(golden.golden, golden.actual)
  await evidence.finish("passed", { environment, goldenUpdate: updateGoldens }, [])
  process.stdout.write(JSON.stringify({ browser: browserChannel, importSource: "fig", workbench: true, deterministicPlan: true, artifactUpload: true, artifactPersistence: true, mapping: true, visualEvidence: true, viewer: true, player: true, viewerState, playerState, viewerDelivery, playerDelivery, viewerLifecycle, playerLifecycle, runtimeBudgets, projectRevision, saveGrants, viewerIsolation, playerIsolation, runtimeNavigation, screenshots: 4, artifactId: artifact.artifactId }) + "\n")
} catch (error) {
  await evidence.finish("failed", { environment }, browser?.contexts().flatMap((context) => context.pages()) ?? [], error)
  throw error
} finally {
  await browser?.close()
  await host?.close()
  await rm(dataDir, { recursive: true, force: true })
  await rm(publishDir, { recursive: true, force: true })
}
