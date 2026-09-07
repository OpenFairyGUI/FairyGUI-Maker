import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { createNodeBackendRuntime } from "@openfairygui/backend/node"
import { Resvg } from "@resvg/resvg-js"
import { chromium, type BrowserContext } from "playwright"
import { startMakerHost } from "../src/server/index"

/** A synthetic project: no user project is edited or saved. */
export async function sessionPreviewSmoke(context: BrowserContext, host: { origin: string; token: string }, root: string, evidence: string) {
  const projectRoot = path.join(root, "session-preview-project")
  await mkdir(path.join(projectRoot, "assets", "Main"), { recursive: true })
  await mkdir(path.join(projectRoot, "assets", "Shared"), { recursive: true })
  const png = (color: string) => new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="${color}" d="M0 0h32v32H0z"/></svg>`).render().asPng()
  const red = png("#ff0000"), blue = png("#0000ff")
  const files = {
    "Demo.fairy": '<projectDescription id="session-preview" type="Layabox" version="5.0" />',
    "assets/Main/package.xml": '<packageDescription id="MAIN0001"><resources><component id="ROOT0001" name="Main.xml" path="/" exported="true" /></resources></packageDescription>',
    "assets/Main/Main.xml": '<component size="260,120"><displayList><text id="TEXT0001" name="label" xy="10,10" size="220,40" fontSize="24" color="#eeeeee" text="Before"/><image id="IMAGE001" name="icon" src="ICON0001" pkg="SHARED01" xy="10,65" size="32,32"/></displayList></component>',
    "assets/Shared/package.xml": '<packageDescription id="SHARED01"><resources><image id="ICON0001" name="Icon.png" path="/"/><image id="UNUSED01" name="Unused.png" path="/"/></resources></packageDescription>',
  }
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(projectRoot, name), text)
  await writeFile(path.join(projectRoot, "assets", "Shared", "Icon.png"), red)
  await writeFile(path.join(projectRoot, "assets", "Shared", "Unused.png"), red)
  const client = new Client({ name: "session-preview-browser", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(`${host.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${host.token}` } } })
  const page = await context.newPage()
  const errors: string[] = [], assetRequests: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  page.on("request", (request) => { if (request.url().includes("/resource-bytes?")) assetRequests.push(new URL(request.url()).searchParams.get("resourceId")!) })
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult
    assert.equal(result.isError ?? false, false, JSON.stringify(result))
    const text = result.content.find((content) => content.type === "text")
    return { result, value: (result.structuredContent ?? (text?.type === "text" ? JSON.parse(text.text) : undefined)) as any }
  }
  const backend = async (name: string, args: Record<string, unknown>) => (await call(`openfairygui_backend_${name}`, args)).value.backendResult
  const register = () => page.waitForResponse((response) => response.url() === `${host.origin}/api/renderers` && response.status() === 201).then(async (response) => (await response.json()).session)
  let sessionId = ""
  const selector = { packageId: "MAIN0001", componentResourceId: "ROOT0001", displayNodeId: "TEXT0001" }
  try {
    await client.connect(transport)
    sessionId = (await backend("open_session", { projectPath: projectRoot })).data.sessionId
    assert.equal((await backend("query_entity", { sessionId, target: { kind: "displayNode", selector } })).data.entity.properties.text, "Before")
    await page.goto(`${host.origin}/?token=${host.token}`)
    const initialRegistration = register()
    await page.getByRole("button", { name: "预览会话", exact: true }).click()
    const first = await initialRegistration
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    await page.getByText("会话 revision 0 · 已保存", { exact: false }).waitFor()
    const projectId = new URL(page.url()).pathname.split("/")[2]
    const capture = async (renderer: typeof first, text: string, color: "red" | "blue") => {
      const rendered = await call("render_component_preview", { projectId, packageId: "MAIN0001", componentId: "ROOT0001", requestId: randomUUID() })
      const observed = await call("get_render_observation", { renderSessionId: renderer.renderSessionId, requestId: randomUUID(), afterStateVersion: rendered.value.semanticStateVersion })
      assert.match(JSON.stringify(observed.value.value.observation), new RegExp(text))
      const image = rendered.result.content.find((content) => content.type === "image")
      assert.ok(image?.type === "image")
      await writeFile(path.join(evidence, `session-preview-${color}.png`), Buffer.from(image.data, "base64"))
      const coloredPixels = await page.evaluate(async ({ base64, color }) => {
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
        const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext("2d")!
        ctx.drawImage(bitmap, 0, 0)
        bitmap.close()
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
        let count = 0
        for (let i = 0; i < pixels.length; i += 4) if (color === "red" ? pixels[i] > 240 && pixels[i + 1] < 15 && pixels[i + 2] < 15 : pixels[i] < 15 && pixels[i + 1] < 15 && pixels[i + 2] > 240) count++
        return count
      }, { base64: image.data, color })
      assert.ok(coloredPixels >= 900, `${color} image not rendered: ${coloredPixels} pixels`)
      assert.equal(rendered.value.sourceRevision, renderer.sourceRevision)
      return coloredPixels
    }
    const redPixels = await capture(first, "Before", "red")
    const edit = await backend("apply_transaction", { sessionId, expectedRevision: 0, operations: [
      { kind: "setDisplayNodeProps", selector, props: { text: "Unsaved after" } },
      { kind: "replaceResourceBytes", selector: { packageId: "SHARED01", resourceId: "ICON0001" }, sourceBytes: [...blue] },
    ] })
    assert.equal(edit.data.revision, 1)
    const readback = await backend("query_entity", { sessionId, target: { kind: "displayNode", selector } })
    assert.equal(readback.data.entity.properties.text, "Unsaved after")
    assert.equal(readback.data.revision, 1)
    await page.getByText("Viewer 已停止", { exact: true }).waitFor()
    assert.equal((await page.request.get(`${host.origin}/api/render-sessions/${first.renderSessionId}`)).status(), 404)
    const pending = register()
    await page.getByRole("button", { name: "刷新工程", exact: true }).click()
    const second = await pending
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    await page.getByText("会话 revision 1 · 未保存", { exact: false }).waitFor()
    assert.notEqual(second.sourceRevision, first.sourceRevision)
    const bluePixels = await capture(second, "Unsaved after", "blue")
    assert.equal(await readFile(path.join(projectRoot, "assets", "Main", "Main.xml"), "utf8"), files["assets/Main/Main.xml"])
    assert.deepEqual(await readFile(path.join(projectRoot, "assets", "Shared", "Icon.png")), red)
    assert.deepEqual([...new Set(assetRequests)], ["ICON0001"], "unused resource bytes must not be fetched")
    const pendingReload = register()
    await page.reload()
    const third = await pendingReload
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    await capture(third, "Unsaved after", "blue")
    assert.equal(third.sourceRevision, second.sourceRevision)
    await page.screenshot({ path: path.join(evidence, "session-preview-workbench.png"), fullPage: true })
    await backend("close_session", { sessionId })
    sessionId = ""
    assert.equal((await page.request.get(`${host.origin}/api/projects/${projectId}`)).status(), 404)
    assert.deepEqual(errors, [])
    return { revision0: first.sourceRevision, revision1: second.sourceRevision, redPixels, bluePixels, queryReadback: true, lazyCrossPackageImage: true, oldRendererExpired: true, diskUnchanged: true, reload: true, closeInvalidation: true }
  } finally {
    if (sessionId) await backend("close_session", { sessionId }).catch(() => undefined)
    await transport.terminateSession().catch(() => undefined)
    await client.close()
    await page.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = await mkdtemp(path.join(tmpdir(), "maker-session-preview-smoke-"))
  const evidence = path.resolve("test-results", "session-preview")
  await mkdir(evidence, { recursive: true })
  const host = await startMakerHost({ port: 0, dataDir: path.join(root, "host"), runtime: createNodeBackendRuntime({ allowedProjectRoots: [root] }) })
  const browser = await chromium.launch({ channel: process.env.FAIRYGUI_MAKER_BROWSER_CHANNEL ?? "chromium" })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const result = await sessionPreviewSmoke(context, host, root, evidence)
    await writeFile(path.join(evidence, "result.json"), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await browser.close()
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
}
