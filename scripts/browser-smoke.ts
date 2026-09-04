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
import { rendererDeliverySmoke } from "./renderer-delivery-smoke"
import { brokerStateSmoke } from "./broker-state-smoke"
import { projectRevisionSmoke } from "./project-revision-smoke"
import { saveGrantSmoke } from "./save-grant-smoke"

const token = "browser-smoke-token-with-24-chars"
const browserChannel = process.env.FAIRYGUI_MAKER_BROWSER_CHANNEL ?? "chromium"
const dataDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-browser-data-"))
const publishDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-browser-publish-"))
let host: Awaited<ReturnType<typeof startMakerHost>> | undefined
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined

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
  pkg.addResource(document.createComponent("Other").setId("OTHER001").setExported(true).setSize(100, 100))

  const io = new NodeIO()
  const binaryPath = path.join(publishDir, "Smoke.fui")
  await io.writeBinary(document, binaryPath, { compressed: true })
  host = await startMakerHost({ port: 0, token, dataDir, runtime: createNodeBackendRuntime({ allowedProjectRoots: [publishDir] }) })

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

  browser = await chromium.launch({ headless: true, channel: browserChannel })
  const context = await browser.newContext()
  const page = await context.newPage()
  const pageErrors: string[] = []
  page.on("pageerror", (error) => pageErrors.push(error.message))
  await page.goto(`${host.origin}/design-import?token=${token}`, { waitUntil: "domcontentloaded" })
  await page.locator('input[type="file"][accept=".fig,.psd"]').setInputFiles(importFixture)
  await page.waitForURL(/\/imports\/draft_/)
  const mappingResponse = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().includes("/semantic-overlay"))
  await page.locator('select[aria-label^="Mapping "]').nth(1).selectOption("ignore")
  if (!(await mappingResponse).ok()) throw new Error("Workbench semantic mapping failed")
  await page.getByRole("button", { name: "生成 Build Plan" }).click()
  await page.getByText("PLANNED", { exact: true }).waitFor()
  await page.getByRole("button", { name: "编译 Viewer Preview" }).click()
  await page.getByText("Viewer Preview", { exact: true }).waitFor()
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
  if (!viewerRender.value?.value?.observation?.objectTree?.children?.length) {
    throw new Error("Viewer observation did not include imported FIG children")
  }
  if (process.env.UPDATE_VISUAL_GOLDENS === "1") await writeFile(visualGolden, viewerPng)
  await page.getByTestId("visual-reference-input").setInputFiles(visualGolden)
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
  const viewerState = await brokerStateSmoke(page, "viewer", viewerRender.value.renderSessionId,
    (name, args) => callTool(host!.origin, sessionId, 80, name, args))
  const viewerDelivery = await rendererDeliverySmoke(page, "viewer", viewerRender.value.renderSessionId, viewerRender.value.value.observation.objectTree.id,
    (name, args) => callTool(host!.origin, sessionId, 60, name, args))
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
  if (!imported.ok() || (await imported.json()).artifact?.artifactId !== artifact.artifactId) {
    throw new Error("Browser Artifact SHA-256 upload did not reproduce the immutable artifact")
  }
  await page.getByRole("button", { name: "导入发布目录", exact: true }).waitFor()

  await page.goto(`${host.origin}/artifacts/${artifact.artifactId}/player`, { waitUntil: "domcontentloaded" })
  await waitFor(
    () => callTool(host!.origin, sessionId, 4, "open_artifact_player", { artifactId: artifact.artifactId }).catch(() => ({ value: null } as any)),
    (result) => result.value?.browserRequired === false,
  )
  const playerRender = await callTool(host.origin, sessionId, 5, "render_artifact_component", {
    artifactId: artifact.artifactId,
    requestId: randomUUID(),
    packageId: "SMOKE001",
    componentId: "MAIN0001",
    capture: true,
  })
  assertPng(playerRender.body)
  if (!JSON.stringify(playerRender.value).includes("TITLE001")) throw new Error("Player observation did not include the rendered title")
  const playerState = await brokerStateSmoke(page, "player", playerRender.value.renderSessionId,
    (name, args) => callTool(host!.origin, sessionId, 90, name, args))
  const playerDelivery = await rendererDeliverySmoke(page, "player", playerRender.value.renderSessionId, playerRender.value.value.observation.objectTree.id,
    (name, args) => callTool(host!.origin, sessionId, 70, name, args))
  const runtimeBudgets = await runtimeBudgetSmoke(page.context(), host.origin, artifact, publishDir)
  const projectRevision = await projectRevisionSmoke(context, host.origin)
  const saveGrants = await saveGrantSmoke(context, host, publishDir)
  if (pageErrors.length) throw new Error(`Browser page errors: ${pageErrors.join("; ")}`)

  await fetch(`${host.origin}/mcp`, {
    method: "DELETE",
    headers: { ...headers, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25" },
  })
  process.stdout.write(JSON.stringify({ browser: browserChannel, importSource: "fig", workbench: true, artifactUpload: true, mapping: true, visualEvidence: true, viewer: true, player: true, viewerState, playerState, viewerDelivery, playerDelivery, runtimeBudgets, projectRevision, saveGrants, screenshots: 3, artifactId: artifact.artifactId }) + "\n")
} catch (error) {
  for (const page of browser?.contexts().flatMap((context) => context.pages()) ?? []) {
    process.stderr.write(`${page.url()}\n${await page.locator("body").innerText().catch(() => "Page unavailable")}\n`)
  }
  throw error
} finally {
  await browser?.close()
  await host?.close()
  await rm(dataDir, { recursive: true, force: true })
  await rm(publishDir, { recursive: true, force: true })
}
