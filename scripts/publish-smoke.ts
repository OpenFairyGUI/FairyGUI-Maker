import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
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

/** The main path on a synthetic project: Agent edit -> owner-approved save -> publish_artifact -> native Player render. */
export async function publishSmoke(context: BrowserContext, host: { origin: string; token: string; approvalToken: string }, root: string, evidence: string) {
  const projectRoot = path.join(root, "publish-project")
  await mkdir(path.join(projectRoot, "assets", "Main"), { recursive: true })
  await mkdir(path.join(projectRoot, "assets", "Shared"), { recursive: true })
  const red = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#ff0000" d="M0 0h32v32H0z"/></svg>').render().asPng()
  const files = {
    "Demo.fairy": '<projectDescription id="publish-smoke" type="Layabox" version="5.0" />',
    "assets/Main/package.xml": '<packageDescription id="MAIN0001"><resources><component id="ROOT0001" name="Main.xml" path="/" exported="true" /></resources></packageDescription>',
    "assets/Main/Main.xml": '<component size="260,120"><displayList><text id="TEXT0001" name="label" xy="10,10" size="220,40" fontSize="24" color="#eeeeee" text="Before"/><image id="IMAGE001" name="icon" src="ICON0001" pkg="SHARED01" xy="10,65" size="32,32"/></displayList></component>',
    "assets/Shared/package.xml": '<packageDescription id="SHARED01"><resources><image id="ICON0001" name="Icon.png" path="/" exported="true"/></resources></packageDescription>',
  }
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(projectRoot, name), text)
  await writeFile(path.join(projectRoot, "assets", "Shared", "Icon.png"), red)
  const client = new Client({ name: "publish-browser", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(`${host.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${host.token}` } } })
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const call = async (name: string, args: Record<string, unknown>, expectError = false) => {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult
    assert.equal(result.isError ?? false, expectError, JSON.stringify(result))
    const text = result.content.find((content) => content.type === "text")
    return { result, value: (result.structuredContent ?? (text?.type === "text" ? JSON.parse(text.text) : undefined)) as any }
  }
  const backend = async (name: string, args: Record<string, unknown>) => (await call(`openfairygui_backend_${name}`, args)).value.backendResult
  const selector = { packageId: "MAIN0001", componentResourceId: "ROOT0001", displayNodeId: "TEXT0001" }
  let sessionId = ""
  try {
    await client.connect(transport)
    sessionId = (await backend("open_session", { projectPath: projectRoot })).data.sessionId
    assert.equal((await backend("apply_transaction", { sessionId, expectedRevision: 0, operations: [{ kind: "setDisplayNodeProps", selector, props: { text: "Published after" } }] })).data.revision, 1)
    assert.equal((await call("publish_artifact", { sessionId, expectedRevision: 1 }, true)).value.error.code, "publish_requires_saved_session")

    const approval = (await call("openfairygui_backend_save_session", { sessionId, expectedRevision: 1 }, true)).value.backendResult.error.approval
    const decided = await page.request.post(`${host.origin}/api/save-approvals/${approval.approvalRequestId}/decision`, {
      headers: { Authorization: `Bearer ${host.token}`, "x-maker-approval-token": host.approvalToken }, data: { decision: "approve" },
    })
    assert.equal(decided.status(), 200)
    assert.equal((await backend("save_session", { sessionId, expectedRevision: 1 })).ok, true)
    const projectFiles = (await readdir(projectRoot, { recursive: true })).sort()

    const published = (await call("publish_artifact", { sessionId, expectedRevision: 1 })).value
    assert.equal(published.artifact.verification.source, "host-published")
    assert.equal(published.browserRequired, true)
    const { artifactId, playerUrl } = published.artifact
    assert.deepEqual((await readdir(projectRoot, { recursive: true })).sort(), projectFiles, "publish must not write into the project")

    await page.goto(`${playerUrl}?token=${host.token}`)
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    await page.getByText("由 Host 从已保存会话发布", { exact: false }).waitFor()
    const opened = (await call("open_artifact_player", { artifactId })).value
    assert.equal(opened.browserRequired, false)
    const rendered = await call("render_artifact_component", { artifactId, packageId: "MAIN0001", componentId: "ROOT0001", requestId: randomUUID() })
    const observed = await call("get_render_observation", { renderSessionId: opened.renderSession.renderSessionId, requestId: randomUUID(), afterStateVersion: rendered.value.semanticStateVersion })
    assert.match(JSON.stringify(observed.value.value.observation), /Published after/)
    const image = rendered.result.content.find((content) => content.type === "image")
    assert.ok(image?.type === "image")
    await writeFile(path.join(evidence, "publish-player.png"), Buffer.from(image.data, "base64"))
    const redPixels = await page.evaluate(async (base64) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height), ctx = canvas.getContext("2d")!
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data
      let count = 0
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 240 && pixels[i + 1] < 15 && pixels[i + 2] < 15) count++
      return count
    }, image.data)
    // The cross-package image only reaches the Player through the published atlas.
    assert.ok(redPixels >= 900, `published atlas image not rendered: ${redPixels} pixels`)
    assert.match(await readFile(path.join(projectRoot, "assets", "Main", "Main.xml"), "utf8"), /Published after/)
    await page.screenshot({ path: path.join(evidence, "publish-player-workbench.png"), fullPage: true })
    assert.deepEqual(errors, [])
    return { artifactId, savedRevision: 1, unsavedRefused: true, hostPublished: true, projectUnchangedByPublish: true, nativePlayerText: true, redPixels }
  } finally {
    if (sessionId) await backend("close_session", { sessionId }).catch(() => undefined)
    await transport.terminateSession().catch(() => undefined)
    await client.close()
    await page.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = await mkdtemp(path.join(tmpdir(), "maker-publish-smoke-"))
  const evidence = path.resolve("test-results", "publish")
  await mkdir(evidence, { recursive: true })
  const host = await startMakerHost({ port: 0, dataDir: path.join(root, "host"), runtime: createNodeBackendRuntime({ allowedProjectRoots: [root] }) })
  const browser = await chromium.launch({ channel: process.env.FAIRYGUI_MAKER_BROWSER_CHANNEL ?? "chromium" })
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } })
    const result = await publishSmoke(context, host, root, evidence)
    await writeFile(path.join(evidence, "result.json"), JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await browser.close()
    await host.close()
    await rm(root, { recursive: true, force: true })
  }
}
