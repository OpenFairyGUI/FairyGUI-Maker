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
  const frame = page.frames().find((frame) => frame.url().endsWith(`/${mode}-runtime.html`))!
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
  assert.equal((await page.request.delete(endpoint)).status(), 204)
  await page.getByRole("alert").filter({ hasText: "Renderer 交付已停止" }).waitFor({ timeout: 5_000 }).catch(async (error) => {
    throw new Error(`${String(error)}\nWorkbench: ${await page.locator("body").innerText()}`)
  })
  await page.getByText("AGENT WAITING", { exact: true }).waitFor()
  await page.getByRole("button", { name: "重新连接", exact: true }).click()
  await page.getByText("AGENT READY", { exact: true }).waitFor()
  assert.equal((await page.request.get(endpoint)).status(), 404)
  return { resultAttempts: 3, executions: 1, interactionAttempts: 4, interactions: 2, reconnect: true }
}
