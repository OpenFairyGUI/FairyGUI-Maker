import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { writeFile } from "node:fs/promises"
import path from "node:path"
import type { Page } from "playwright"

export async function uiScenarioSmoke(page: Page, mode: "viewer" | "player", id: string, directory: string,
  call: (name: string, args: Record<string, unknown>) => Promise<any>) {
  await page.getByText("AGENT READY", { exact: true }).waitFor()
  const endpoint = new URL(`/api/render-sessions/${id}`, page.url()).href
  const state = async () => (await (await page.request.get(endpoint)).json()).session
  const original = await state()
  await call("set_render_view", { renderSessionId: id, requestId: randomUUID(), expectedViewStateVersion: original.viewStateVersion, view: { zoom: 1 } })
  const current = await state()
  const observed = await call("get_render_observation", { renderSessionId: id, requestId: randomUUID(), afterStateVersion: current.stateVersion, afterViewStateVersion: current.viewStateVersion })
  const root = observed.value.value.observation.objectTree
  const title = mode === "player" ? root.children.find((node: any) => node.id.endsWith("/TITLE001")) : null
  const controller = observed.value.value.observation.controllers.find((item: any) => item.targetId === root.id)
  const otherPage = controller?.pages.find((item: any) => item.id !== controller.pageId)
  const steps: Record<string, unknown>[] = [
    { action: "update", operations: [{ op: "set-property", targetId: root.id, property: "visible", value: false }] },
    { action: "assert", condition: { kind: "property", targetId: root.id, property: "visible", equals: false } },
    { action: "update", operations: [{ op: "set-property", targetId: root.id, property: "visible", value: true }] },
    { action: "wait-for", condition: { kind: "property", targetId: root.id, property: "visible", equals: true }, timeoutMs: 3000 },
  ]
  if (title) steps.push(
    { action: "update", operations: [{ op: "set-property", targetId: title.id, property: "text", value: "Scenario checked" }] },
    { action: "assert", condition: { kind: "property", targetId: title.id, property: "text", equals: "Scenario checked" } },
  )
  if (otherPage) steps.push(
    { action: "update", operations: [{ op: "set-controller-page", targetId: root.id, controllerName: controller.name, pageId: otherPage.id }] },
    { action: "assert", condition: { kind: "controller", targetId: root.id, controllerName: controller.name, pageId: otherPage.id } },
  )
  steps.push({ action: "capture" })
  const input = { renderSessionId: id, requestId: randomUUID(), sourceRevision: current.sourceRevision,
    expectedStateVersion: observed.value.semanticStateVersion, expectedViewStateVersion: observed.value.viewStateVersion, timeoutMs: 30_000, steps }
  const completed = await call("run_ui_scenario", input)
  assert.equal(completed.value.value.passed, true)
  assert.equal(completed.value.value.steps.length, steps.length)
  const image = completed.body.result.content.find((item: any) => item.type === "image")
  const png = Buffer.from(image.data, "base64")
  assert.equal(png.readUInt32BE(0), 0x89504e47)
  assert.equal(completed.value.value.capture.sourceRevision, current.sourceRevision)
  await writeFile(path.join(directory, `${mode}-ui-scenario.png`), png)
  const beforeReplay = await state()
  assert.deepEqual((await call("run_ui_scenario", input)).value, completed.value)
  assert.equal((await state()).commandSeq, beforeReplay.commandSeq)

  const failedInput = { ...input, requestId: randomUUID(), expectedStateVersion: beforeReplay.stateVersion, expectedViewStateVersion: beforeReplay.viewStateVersion,
    steps: [{ action: "assert", condition: { kind: "exists", targetId: "scenario-missing-target", exists: true } },
      { action: "update", operations: [{ op: "set-property", targetId: root.id, property: "visible", value: false }] }] }
  await assert.rejects(call("run_ui_scenario", failedInput), /assertion_failed/)
  const failed = await state()
  assert.equal(failed.stateVersion, beforeReplay.stateVersion)
  assert.equal(failed.observation.objectTree.visible, true, "failed assertion must stop the following update")

  let humanInteraction = false
  if (mode === "player") {
    assert.ok(title && otherPage, "Player fixture must exercise text and Controller assertions")
    const background = root.children.find((node: any) => node.id.endsWith("/BACK0001"))
    assert.ok(background)
    const firstAck = page.waitForResponse((response) => response.url() === `${endpoint}/results`
      && response.request().postDataJSON()?.commandSeq === failed.commandSeq + 1)
    const interaction = call("run_ui_scenario", { ...input, requestId: randomUUID(), expectedStateVersion: failed.stateVersion, expectedViewStateVersion: failed.viewStateVersion,
      steps: [{ action: "update", operations: [{ op: "set-property", targetId: root.id, property: "visible", value: true }] },
        { action: "wait-for", condition: { kind: "interaction", targetId: background.id, event: "click" }, timeoutMs: 5000 }] })
    // Wait for this run's first actual command ACK before sending a human-style canvas click.
    await firstAck
    const frame = page.frames().find((frame) => new URL(frame.url()).pathname === "/player-runtime.html")!
    const canvas = await frame.locator("canvas").first().boundingBox()
    assert.ok(canvas)
    await page.mouse.click(canvas.x + root.x + background.x + background.width / 2, canvas.y + root.y + background.y + background.height - 20)
    assert.equal((await interaction).value.value.passed, true)
    humanInteraction = true
  }
  const after = await state()
  const restore = [{ op: "set-property", targetId: root.id, property: "visible", value: root.visible },
    ...(title ? [{ op: "set-property", targetId: title.id, property: "text", value: title.text }] : []),
    ...(otherPage ? [{ op: "set-controller-page", targetId: root.id, controllerName: controller.name, pageId: controller.pageId }] : [])]
  await call("update_render_session", { renderSessionId: id, requestId: randomUUID(), expectedStateVersion: after.stateVersion, operations: restore })
  await call("set_render_view", { renderSessionId: id, requestId: randomUUID(), expectedViewStateVersion: after.viewStateVersion, view: { zoom: original.view.zoom } })
  return { operationsAndAssertions: true, capture: true, replay: true, failFast: true, controller: !!otherPage, humanInteraction }
}
