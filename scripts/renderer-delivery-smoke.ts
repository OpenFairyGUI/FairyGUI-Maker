import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import type { Page, Route } from "playwright"

async function until(ready: () => boolean) {
  for (let i = 0; i < 100; i++) { if (ready()) return; await sleep(50) }
  assert.fail("Renderer delivery retry did not complete")
}

export async function rendererDeliverySmoke(
  page: Page,
  mode: "viewer" | "player",
  renderSessionId: string,
  rootId: string,
  call: (name: string, args: Record<string, unknown>) => Promise<unknown>,
) {
  const endpoint = new URL(`/api/render-sessions/${renderSessionId}`, page.url()).href
  const state = async () => (await (await page.request.get(endpoint)).json()).session
  const frame = page.frames().find((frame) => new URL(frame.url()).pathname === `/${mode}-runtime.html`)!
  assert.ok(frame)
  // Count the real Workbench -> iframe commands, without replacing either renderer.
  await page.evaluate(`(() => {
    window.deliveryExecutions = 0;
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message, ...rest) {
      if (message?.kind === "apply-operations") window.deliveryExecutions++;
      return post.call(this, message, ...rest);
    };
  })()`)
  await frame.evaluate(`(() => {
    const post = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function(message, ...rest) {
      if (message?.kind === "response") window.deliveryPort = this;
      return post.call(this, message, ...rest);
    };
  })()`)
  const results: string[] = []
  const resultFault = async (route: Route) => {
    results.push(route.request().postData()!)
    if (results.length === 1) return route.abort("failed") // Not received by Host.
    if (results.length === 2) {
      assert.equal((await route.fetch()).status(), 200)
      return route.abort("failed") // Host committed; ACK did not reach Workbench.
    }
    return route.continue()
  }
  await page.route(`${endpoint}/results`, resultFault)
  try {
    const before = await state()
    await call("update_render_session", {
      renderSessionId, requestId: randomUUID(), expectedStateVersion: before.stateVersion,
      operations: [{ op: "set-property", targetId: rootId, property: "visible", value: false }],
    })
    await until(() => results.length === 3)
    assert.equal(new Set(results).size, 1, "retry changed the executed result")
    assert.equal(await page.evaluate("window.deliveryExecutions"), 1, "the iframe executed the same mutation twice")
    assert.equal(await frame.evaluate("fgui.GRoot.inst.getChildAt(0).visible"), false)
    assert.equal((await state()).stateVersion, before.stateVersion + 1)
  } finally { await page.unroute(`${endpoint}/results`, resultFault) }
  const result = JSON.parse(results[0])
  assert.equal((await page.request.post(`${endpoint}/results`, { data: result })).status(), 200)
  assert.equal((await page.request.post(`${endpoint}/results`, { data: { ...result, value: { ...result.value, changed: true } } })).status(), 409)

  const interactions: string[] = []
  const interactionFault = async (route: Route) => {
    interactions.push(route.request().postData()!)
    if (interactions.length === 1) return route.fulfill({ status: 503, json: { error: "offline test" } })
    if (interactions.length === 2) {
      assert.equal((await route.fetch()).status(), 200)
      return route.abort("failed")
    }
    return route.continue()
  }
  await page.route(`${endpoint}/interactions`, interactionFault)
  const before = await state()
  const firstSeq = before.lastAcceptedRuntimeEventSeq + 1
  try {
    // Fault-injected events must also advance response watermarks; production increments both inside the runtime.
    await frame.evaluate(`(() => {
      const post = MessagePort.prototype.postMessage;
      MessagePort.prototype.postMessage = function(message, ...rest) {
        if (message?.kind === "response" && message.ok) message.runtimeEventSeq += 2;
        return post.call(this, message, ...rest);
      };
      for (let seq = ${firstSeq}; seq < ${firstSeq + 2}; seq++) {
        window.deliveryPort.postMessage({ kind: "interaction", value: { runtimeEventSeq: seq, targetId: ${JSON.stringify(rootId)}, event: "click", data: { selected: true } } });
      }
    })()`)
    await until(() => interactions.length === 4)
    await call("get_render_observation", { renderSessionId, requestId: randomUUID(), afterStateVersion: before.stateVersion })
    const after = await state()
    assert.deepEqual(interactions.map((body) => JSON.parse(body).runtimeEventSeq), [firstSeq, firstSeq, firstSeq, firstSeq + 1])
    assert.equal(new Set(interactions.slice(0, 3)).size, 1)
    assert.equal(after.lastAcceptedRuntimeEventSeq, firstSeq + 1)
    assert.equal(after.stateVersion, before.stateVersion + 2)
  } finally { await page.unroute(`${endpoint}/interactions`, interactionFault) }
  const interaction = JSON.parse(interactions[0])
  assert.equal((await page.request.post(`${endpoint}/interactions`, { data: interaction })).status(), 200)
  assert.equal((await page.request.post(`${endpoint}/interactions`, { data: { ...interaction, data: { selected: false } } })).status(), 409)

  // A closed/uncertain session must not look AGENT READY. Reconnection creates fresh state.
  // Separate the 35s long-poll transport deadline from the UI's response to a terminal error.
  const closedPoll = page.waitForResponse((response) => response.url().startsWith(`${endpoint}/commands?`) && response.status() === 404, { timeout: 40_000 })
  assert.equal((await page.request.delete(endpoint)).status(), 204)
  await closedPoll
  await page.getByRole("alert").filter({ hasText: "Renderer 交付已停止" }).waitFor({ timeout: 5_000 }).catch(async (error) => {
    throw new Error(`${String(error)}\nWorkbench: ${await page.locator("body").innerText()}`)
  })
  await page.getByText("AGENT WAITING", { exact: true }).waitFor()
  const registration = page.waitForResponse((response) => response.url().endsWith("/api/renderers") && response.request().method() === "POST" && response.status() === 201)
  await page.getByRole("button", { name: "重新连接", exact: true }).click()
  const reconnectedSessionId = (await (await registration).json()).session.renderSessionId as string
  await page.getByText("AGENT READY", { exact: true }).waitFor()
  assert.equal((await page.request.get(endpoint)).status(), 404)
  return { resultAttempts: 3, executions: 1, interactionAttempts: 4, interactions: 2, reconnect: true, reconnectedSessionId }
}

export async function rendererLifecycleSmoke(page: Page, renderSessionId: string, call: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const replacement = await page.context().newPage()
  try {
    const registered = replacement.waitForResponse((r) => r.url().endsWith("/api/renderers") && r.request().method() === "POST" && r.status() === 201)
    await replacement.goto(page.url(), { waitUntil: "domcontentloaded" })
    const id = (await (await registered).json()).session.renderSessionId as string
    assert.notEqual(id, renderSessionId)
    await replacement.getByText("AGENT READY", { exact: true }).waitFor()
    await page.getByRole("alert").filter({ hasText: "renderer_replaced" }).waitFor()
    await page.getByText("AGENT WAITING", { exact: true }).waitFor()
    const endpoint = new URL(`/api/render-sessions/${id}`, page.url()).href
    const requestId = randomUUID()
    let received!: () => void
    const held = new Promise<void>((resolve) => { received = resolve })
    let release!: () => void
    const closed = new Promise<void>((resolve) => { release = resolve })
    await replacement.route(`${endpoint}/results`, async (route) => {
      if (route.request().postDataJSON().requestId !== requestId) return route.continue()
      received()
      await closed
      await route.abort().catch(() => {}) // The page may already have closed its connection.
    })
    const pending = call("get_render_observation", { renderSessionId: id, requestId, afterStateVersion: 0 })
    const rejected = assert.rejects(pending, /disconnected|render_command_timeout/)
    try {
      await Promise.race([held, sleep(5_000).then(() => assert.fail("Pending renderer command was not executed"))])
      await replacement.close()
    } finally { release() }
    await rejected
    assert.equal((await page.request.get(endpoint)).status(), 404)
    // Explicitly reconnect the original tab; neither its old session nor the in-flight request is replayed.
    const reconnected = page.waitForResponse((r) => r.url().endsWith("/api/renderers") && r.request().method() === "POST" && r.status() === 201)
    await page.getByRole("button", { name: "重新连接", exact: true }).click()
    const freshId = (await (await reconnected).json()).session.renderSessionId
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    assert.notEqual(freshId, id)
    assert.notEqual(freshId, renderSessionId)
    await call("get_render_observation", { renderSessionId: freshId, requestId: randomUUID(), afterStateVersion: 0 })
    return { replacement: true, oldTabExplicitError: true, pendingCloseRejected: true, freshSessionRecovery: true }
  } finally { await replacement.close() }
}
