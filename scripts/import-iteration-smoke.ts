import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { NodeIO } from "@openfairygui/core/node"
import { readProjectAsUam } from "@openfairygui/core/uam"
import type { BrowserContext } from "playwright"
import type { ImportDraftV1 } from "../src/design-import/draft-store"
import type { createBrowserEvidence } from "./browser-evidence"

export async function importIterationSmoke(context: BrowserContext, origin: string, evidence: Awaited<ReturnType<typeof createBrowserEvidence>>,
  callTool: (name: string, args: Record<string, unknown>) => Promise<any>) {
  const root = await mkdtemp(path.join(tmpdir(), "maker-import-iteration-browser-"))
  const page = await context.newPage()
  const created = await context.request.post(`${origin}/api/import-drafts`, { data: { sourcePath: path.resolve("test/fixtures/design-import/basic-shapes.fig") } })
  assert.equal(created.status(), 201)
  let draft: ImportDraftV1 = (await created.json()).draft
  const endpoint = `${origin}/api/import-drafts/${draft.draftId}`
  try {
    for (const step of ["parse", "plan", "compile"]) {
      const response = await context.request.post(`${endpoint}/${step}`, { data: { expectedRevision: draft.revision } })
      assert.equal(response.status(), 200, await response.text())
      draft = (await response.json()).draft
    }
    const detail = await (await context.request.get(endpoint)).json()
    const sourceNode = detail.outline.pages[0].roots[0].children[0]
    const projectId = detail.preview.projectId
    await page.goto(`${origin}/imports/${draft.draftId}`)
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    const catalog = (await callTool("list_viewer_components", { projectId })).value.projects[0]
    const pkg = catalog.packages[0]
    const component = pkg.components.find((component: { name: string }) => component.name === detail.buildPlan.packages[0].components.find((root: { exported: boolean }) => root.exported).name)
    assert.ok(component)
    const componentId = component.id
    const render = () => callTool("render_component_preview", { projectId, packageId: pkg.packageId, componentId, requestId: randomUUID(), capture: true })
    const before = await render()
    const objects = (node: any): any[] => [node, ...(node.children ?? []).flatMap(objects)]
    assert.ok(objects(before.value.value.observation.objectTree).some((node) => node.name === sourceNode.name))
    const beforePng = Buffer.from(before.body.result.content.find((item: any) => item.type === "image").data, "base64")
    await writeFile(path.join(evidence.directory, "iteration-before.png"), beforePng)
    await page.getByTestId("visual-reference-input").setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: beforePng })
    const saved = page.waitForResponse((response) => response.request().method() === "POST" && response.url().includes("/visual-evidence?"))
    await page.getByRole("button", { name: "捕获视觉证据", exact: true }).click()
    assert.equal((await saved).status(), 201)
    await page.getByTestId("visual-report").waitFor()
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    const mapping = page.waitForResponse((response) => response.request().method() === "PATCH" && response.url().endsWith("/semantic-overlay"))
    await page.getByLabel(`Mapping ${sourceNode.name}`, { exact: true }).selectOption("ignore")
    assert.equal((await mapping).status(), 200)
    await page.getByText("PLANNED", { exact: true }).waitFor()
    const changed = await (await context.request.get(endpoint)).json()
    assert.equal(changed.draft.generated, null)
    assert.equal(changed.draft.visualEvidence, null)
    assert.equal(changed.preview, null)
    assert.equal(await page.getByTestId("visual-report").count(), 0)
    await assert.rejects(callTool("get_render_observation", { renderSessionId: before.value.renderSessionId, requestId: randomUUID(), afterStateVersion: 0 }), /render_session_not_found/)
    await page.getByRole("button", { name: "编译 Viewer Preview", exact: true }).click()
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    const after = await render()
    assert.notEqual(after.value.renderSessionId, before.value.renderSessionId)
    assert.notEqual(after.value.sourceRevision, before.value.sourceRevision)
    assert.ok(!objects(after.value.value.observation.objectTree).some((node) => node.name === sourceNode.name))
    const afterPng = Buffer.from(after.body.result.content.find((item: any) => item.type === "image").data, "base64")
    assert.ok(!beforePng.equals(afterPng))
    await writeFile(path.join(evidence.directory, "iteration-after.png"), afterPng)
    await page.getByText("尚未选择 PNG 基线", { exact: true }).waitFor()
    await page.reload()
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    assert.equal(await page.getByLabel(`Mapping ${sourceNode.name}`, { exact: true }).inputValue(), "ignore")
    const reloaded = await render()
    assert.equal(reloaded.value.sourceRevision, after.value.sourceRevision)
    assert.ok(!objects(reloaded.value.value.observation.objectTree).some((node) => node.name === sourceNode.name))
    const output = path.join(root, "output")
    await page.getByLabel("Maker Host 本机绝对路径").fill(output)
    await page.getByRole("button", { name: "Materialize", exact: true }).click()
    await page.getByText("已写入", { exact: false }).waitFor()
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    const final = await (await context.request.get(endpoint)).json()
    const reopened = await readProjectAsUam(new NodeIO(), path.join(output, final.draft.generated.fairyFile))
    assert.ok(reopened.packages.every((pkg) => pkg.resources.every((resource) => resource.kind !== "component" || !resource.component.displayList.some((node) => node.name === sourceNode.name))))
    await page.screenshot({ path: path.join(evidence.directory, "iteration-materialized.png") })
    return { previewChanged: true, oldSessionInvalidated: true, oldEvidenceInvalidated: true, reloadAndMaterialize: true, removedNode: sourceNode.name }
  } catch (error) {
    await page.screenshot({ path: path.join(evidence.directory, "iteration-failed.png"), fullPage: true })
    throw error
  } finally {
    await page.close()
    const detail = await (await context.request.get(endpoint)).json()
    await context.request.delete(`${endpoint}?expectedRevision=${detail.draft.revision}`)
    await rm(root, { recursive: true, force: true })
  }
}
