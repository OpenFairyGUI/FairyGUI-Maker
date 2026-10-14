import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { createNodeBackendRuntime } from "@openfairygui/backend/node"
import { Resvg } from "@resvg/resvg-js"
import type { HeadlessBrowserChannel } from "../src/server/headless-browser"
import { startMakerHost } from "../src/server/index"

/** No test-owned page: the Host's own headless browser must serve Player and session-preview Viewer renders. */
export async function headlessSmoke(root: string, evidence: string, channel: HeadlessBrowserChannel) {
  const projectRoot = path.join(root, "headless-project")
  await mkdir(path.join(projectRoot, "assets", "Main"), { recursive: true })
  const blue = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path fill="#0000ff" d="M0 0h32v32H0z"/></svg>').render().asPng()
  const files = {
    "Demo.fairy": '<projectDescription id="headless-smoke" type="Layabox" version="5.0" />',
    "assets/Main/package.xml": '<packageDescription id="MAIN0001"><resources><component id="ROOT0001" name="Main.xml" path="/" exported="true" /><image id="ICON0001" name="Icon.png" path="/" exported="true"/></resources></packageDescription>',
    "assets/Main/Main.xml": '<component size="200,100"><displayList><text id="TEXT0001" name="label" xy="10,10" size="180,40" fontSize="24" color="#eeeeee" text="Headless"/><image id="IMAGE001" name="icon" src="ICON0001" xy="10,55" size="32,32"/></displayList></component>',
  }
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(projectRoot, name), text)
  await writeFile(path.join(projectRoot, "assets", "Main", "Icon.png"), blue)

  const host = await startMakerHost({ port: 0, dataDir: path.join(root, "headless-host"), runtime: createNodeBackendRuntime({ allowedProjectRoots: [root] }), headless: { channel } })
  const client = new Client({ name: "headless-smoke", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(`${host.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${host.token}` } } })
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }) as CallToolResult
    const text = result.content.find((content) => content.type === "text")
    return { result, value: (result.structuredContent ?? (text?.type === "text" ? JSON.parse(text.text) : undefined)) as any }
  }
  const image = async (result: CallToolResult, name: string) => {
    const content = result.content.find((item) => item.type === "image")
    assert.ok(content?.type === "image", "render must return a PNG")
    await writeFile(path.join(evidence, name), Buffer.from(content.data, "base64"))
  }
  let sessionId = ""
  try {
    await client.connect(transport)
    sessionId = (await call("openfairygui_backend_open_session", { projectPath: projectRoot })).value.backendResult.data.sessionId

    const published = (await call("publish_artifact", { sessionId, expectedRevision: 0 })).value
    assert.equal(published.ok, true, JSON.stringify(published))
    const { artifactId } = published.artifact
    const opened = (await call("open_artifact_player", { artifactId })).value
    assert.equal(opened.browserRequired, false, JSON.stringify(opened))
    const player = await call("render_artifact_component", { artifactId, packageId: "MAIN0001", componentId: "ROOT0001", requestId: randomUUID() })
    assert.equal(player.result.isError ?? false, false, JSON.stringify(player.value))
    const observed = await call("get_render_observation", { renderSessionId: opened.renderSession.renderSessionId, requestId: randomUUID(), afterStateVersion: player.value.semanticStateVersion })
    assert.match(JSON.stringify(observed.value.value.observation), /Headless/)
    await image(player.result, "headless-player.png")

    // Agent visual regression on the same headless Player: baseline, unchanged compare, a real change, then acceptance.
    const renderSessionId = opened.renderSession.renderSessionId
    const baselineInput = { renderSessionId, suite: "headless", key: "main/default" }
    const saved = await call("save_visual_baseline", { ...baselineInput, requestId: randomUUID(), afterStateVersion: player.value.semanticStateVersion, afterViewStateVersion: player.value.viewStateVersion })
    assert.equal(saved.value.ok, true, JSON.stringify(saved.value))
    assert.equal(saved.value.baseline.revision, 1)
    assert.match(saved.value.baseline.environment.userAgent, /HeadlessChrome|Chrome|Edg/)
    const unchanged = (await call("compare_visual_baseline", { ...baselineInput, requestId: randomUUID(), afterStateVersion: player.value.semanticStateVersion, afterViewStateVersion: player.value.viewStateVersion })).value
    assert.equal(unchanged.identical, true, JSON.stringify(unchanged))
    assert.equal(unchanged.environmentMatch, true)
    assert.equal(unchanged.metrics.differentPixels, 0)
    const label = findNode(observed.value.value.observation.objectTree, (node) => node.text === "Headless")
    assert.ok(label, "the label must be observable by text")
    const updated = (await call("update_render_session", { renderSessionId, requestId: randomUUID(), expectedStateVersion: player.value.semanticStateVersion, operations: [{ op: "set-property", targetId: label.id, property: "text", value: "Changed" }] })).value
    assert.equal(updated.ok, true, JSON.stringify(updated))
    const changed = await call("compare_visual_baseline", { ...baselineInput, requestId: randomUUID(), afterStateVersion: updated.semanticStateVersion, afterViewStateVersion: updated.viewStateVersion, includeCapture: true })
    assert.equal(changed.value.identical, false)
    assert.equal(changed.value.withinTolerance, false)
    assert.ok(changed.value.metrics.differentPixels > 0)
    assert.deepEqual(changed.value.images, ["diff", "capture"])
    assert.equal(changed.result.content.filter((content) => content.type === "image").length, 2)
    await image(changed.result, "headless-visual-diff.png")
    const tolerant = (await call("compare_visual_baseline", { ...baselineInput, requestId: randomUUID(), afterStateVersion: updated.semanticStateVersion, afterViewStateVersion: updated.viewStateVersion, tolerance: { maxDifferentPixels: changed.value.metrics.differentPixels } })).value
    assert.equal(tolerant.withinTolerance, true)
    const refused = await call("save_visual_baseline", { ...baselineInput, requestId: randomUUID(), afterStateVersion: updated.semanticStateVersion, afterViewStateVersion: updated.viewStateVersion })
    assert.equal(refused.value.code, "visual_baseline_exists")
    const accepted = (await call("save_visual_baseline", { ...baselineInput, requestId: randomUUID(), afterStateVersion: updated.semanticStateVersion, afterViewStateVersion: updated.viewStateVersion, replace: true, reason: "label text changed on purpose" })).value
    assert.equal(accepted.baseline.revision, 2)
    const listed = (await call("list_visual_baselines", { suite: "headless" })).value
    assert.deepEqual(listed.baselines.map(({ key, revision }: { key: string; revision: number }) => `${key}@${revision}`), ["main/default@2"])

    // Session previews read through Host APIs, so a Host browser can render them too.
    const preview = (await call("open_session_preview", { sessionId, expectedRevision: 0 })).value
    assert.equal(preview.ok, true, JSON.stringify(preview))
    const viewer = await call("render_component_preview", { projectId: preview.project.projectId, packageId: "MAIN0001", componentId: "ROOT0001", requestId: randomUUID() })
    assert.equal(viewer.result.isError ?? false, false, JSON.stringify(viewer.value))
    await image(viewer.result, "headless-viewer.png")

    // Browser-authorized projects need the person's own directory handle; the Host must not pretend to render them.
    const registered = await fetch(`${host.origin}/api/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ bindingId: randomUUID(), fairyguiProjectId: "browser-only", name: "Browser only", directoryName: "browser-only", fairyPath: "Demo.fairy", sourceRevision: "a".repeat(64) }),
    }).then((response) => response.json())
    const browserOnly = (await call("render_component_preview", { projectId: registered.project.projectId, packageId: "MAIN0001", componentId: "ROOT0001", requestId: randomUUID() })).value
    assert.equal(browserOnly.code, "browser_required")
    assert.equal(browserOnly.headlessError, undefined)
    return {
      channel, playerWithoutPage: true, sessionPreviewViewer: true, browserAuthorizedProjectsStayBrowserRequired: true,
      visualRegression: { unchangedIdentical: true, changedPixels: changed.value.metrics.differentPixels, toleranceHonoured: true, replaceNeedsFlag: true, acceptedRevision: 2 },
    }
  } finally {
    if (sessionId) await call("openfairygui_backend_close_session", { sessionId }).catch(() => undefined)
    await transport.terminateSession().catch(() => undefined)
    await client.close()
    await host.close()
  }
}

type ObjectNode = { id: string; text?: string; children?: ObjectNode[] }
function findNode(node: ObjectNode, match: (node: ObjectNode) => boolean): ObjectNode | undefined {
  if (match(node)) return node
  for (const child of node.children ?? []) {
    const found = findNode(child, match)
    if (found) return found
  }
  return undefined
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = await mkdtemp(path.join(tmpdir(), "maker-headless-smoke-"))
  const evidence = path.resolve("test-results", "headless")
  await mkdir(evidence, { recursive: true })
  try {
    const result = await headlessSmoke(root, evidence, (process.env.FAIRYGUI_MAKER_HEADLESS_BROWSER ?? "chrome") as HeadlessBrowserChannel)
    console.log(JSON.stringify(result, null, 2))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
