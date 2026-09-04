import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { Page, Route } from "playwright"

export async function brokerStateSmoke(page: Page, mode: "viewer" | "player", id: string, call: (name: string, args: Record<string, unknown>) => Promise<any>) {
  await page.getByText("AGENT READY", { exact: true }).waitFor()
  const endpoint = new URL(`/api/render-sessions/${id}`, page.url()).href
  const state = async () => (await (await page.request.get(endpoint)).json()).session
  const uiCommand = async (action: () => Promise<unknown>) => {
    const response = page.waitForResponse((response) => response.url() === `${endpoint}/commands` && response.request().method() === "POST")
    await action()
    const result = await response
    assert.equal(result.status(), 200, await result.text())
    return (await result.json()).result
  }
  const before = await state()
  const zoom = await uiCommand(() => page.getByRole("button", { name: "放大", exact: true }).click())
  assert.equal(zoom.semanticStateVersion, before.semanticStateVersion)
  assert.equal(zoom.viewStateVersion, before.viewStateVersion + 1)
  const background = await uiCommand(() => page.getByRole("button", { name: "背景", exact: true }).click())
  assert.equal(background.semanticStateVersion, before.semanticStateVersion)
  assert.equal(background.viewStateVersion, zoom.viewStateVersion + 1)
  const view = await call("set_render_view", { renderSessionId: id, requestId: randomUUID(), expectedViewStateVersion: background.viewStateVersion, view: { zoom: 1 } })
  await page.getByText("100%", { exact: true }).waitFor()
  const frame = page.frames().find((frame) => frame.url().endsWith(`/${mode}-runtime.html`))!
  assert.equal(await frame.evaluate("Laya.stage.bgColor"), "#f4f4f5")

  // Hold a real Workbench command while an Agent changes the view. No overwrite/retry after 409.
  let held = false
  const race = async (route: Route) => {
    if (route.request().method() !== "POST" || held) return route.continue()
    held = true
    await call("set_render_view", { renderSessionId: id, requestId: randomUUID(), expectedViewStateVersion: view.value.viewStateVersion, view: { zoom: 1.5 } })
    return route.continue()
  }
  await page.route(`${endpoint}/commands`, race)
  try {
    await page.getByRole("button", { name: "缩小", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "状态冲突" }).waitFor()
    await page.getByText("150%", { exact: true }).waitFor()
    await page.getByRole("button", { name: "知道了" }).click()
    assert.equal(await frame.evaluate("fgui.GRoot.inst.getChildAt(0).scaleX > 0"), true)
  } finally { await page.unroute(`${endpoint}/commands`, race) }
  assert.equal((await state()).view.zoom, 1.5)

  // Resizing the panel is a view command, not an unversioned runtime window.resize side effect.
  const old = await state()
  const viewport = page.viewportSize()!
  const resized = page.waitForResponse((response) => response.url() === `${endpoint}/commands` && response.request().method() === "POST" && response.request().postDataJSON()?.payload?.width !== undefined)
  await page.setViewportSize({ width: viewport.width + 100, height: viewport.height })
  assert.equal((await resized).status(), 200)
  const current = await state()
  assert.notEqual(current.view.width, old.view.width)
  assert.equal(current.semanticStateVersion, old.semanticStateVersion)
  assert.equal(current.viewStateVersion, old.viewStateVersion + 1)
  const captureResponse = await page.request.post(`${endpoint}/commands`, { data: { requestId: randomUUID(), kind: "capture", afterStateVersion: current.semanticStateVersion, afterViewStateVersion: current.viewStateVersion } })
  assert.equal(captureResponse.status(), 200)
  const capture = (await captureResponse.json()).result
  assert.equal(capture.semanticStateVersion, current.semanticStateVersion)
  assert.equal(capture.viewStateVersion, current.viewStateVersion)
  const png = Buffer.from(capture.value.screenshotBase64, "base64")
  assert.equal(png.readUInt32BE(16), current.view.width)
  assert.equal(png.readUInt32BE(20), current.view.height)

  let controller = false
  if (await page.getByRole("combobox", { name: "切换 Controller page Page", exact: true }).count()) {
    const before = await state()
    const changed = await uiCommand(() => page.getByRole("combobox", { name: "切换 Controller page Page", exact: true }).selectOption("second"))
    assert.equal(changed.semanticStateVersion, before.semanticStateVersion + 1)
    assert.equal(changed.viewStateVersion, before.viewStateVersion)
    const operations = [{ op: "set-controller-page", targetId: before.observation.objectTree.id, controllerName: "page", pageId: "first" }]
    await assert.rejects(call("update_render_session", { renderSessionId: id, requestId: randomUUID(), expectedStateVersion: before.semanticStateVersion, operations }), /state_version_conflict/)
    const updated = await call("update_render_session", { renderSessionId: id, requestId: randomUUID(), expectedStateVersion: changed.semanticStateVersion, operations })
    await page.waitForFunction(() => document.querySelector<HTMLSelectElement>('select[aria-label="切换 Controller page Page"]')?.value === "first")
    const played = await uiCommand(() => page.getByRole("button", { name: "播放", exact: true }).click())
    assert.equal(played.semanticStateVersion, updated.value.semanticStateVersion + 1)
    assert.equal(played.viewStateVersion, before.viewStateVersion)
    controller = true
  }
  if (mode === "player") {
    assert.equal(controller, true, "Player fixture must expose Controller and Transition controls")
    const before = await state()
    await call("render_artifact_component", { artifactId: before.artifactId, requestId: randomUUID(), packageId: "SMOKE001", componentId: "OTHER001", capture: false })
    await page.getByRole("treeitem", { selected: true }).filter({ hasText: "OTHER001" }).waitFor()
    const selectedCapture = await call("capture_render_screenshot", { renderSessionId: id, requestId: randomUUID(), afterStateVersion: before.semanticStateVersion + 1 })
    assert.equal(selectedCapture.value.value.component.componentId, "OTHER001")
    const restored = await uiCommand(() => page.getByRole("treeitem").filter({ hasText: "MAIN0001" }).click())
    assert.equal(restored.semanticStateVersion, before.semanticStateVersion + 2, "Broker state feedback must not cause another render")
  }
  return { sharedView: true, conflictUI: true, viewport: true, captureVersions: true, controller, componentSync: mode === "player" }
}
