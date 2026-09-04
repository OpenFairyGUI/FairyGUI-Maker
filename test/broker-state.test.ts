import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { ViewerRenderBroker, renderSessionCommandSchema, rendererResultSchema } from "../src/server/viewer"
import { VIEWER_PROTOCOL_VERSION, type ViewerBrokerCommand } from "../src/viewer-protocol"

test("Broker separates semantic/view CAS, rejects queued stale work and stamps the captured state", async () => {
  const project = { projectId: "demo", sourceRevision: "revision", viewerUrl: "http://localhost/viewer" }
  const broker = new ViewerRenderBroker(() => project)
  const { renderSessionId: id } = broker.registerRenderer({ projectId: project.projectId, sourceRevision: project.sourceRevision, protocolVersion: VIEWER_PROTOCOL_VERSION })!
  let after = 0
  const next = async () => {
    const batch = await broker.readCommands(id, after, new AbortController().signal)
    assert.equal(batch?.commands.length, 1)
    return batch!.commands[0]
  }
  const finish = (command: ViewerBrokerCommand, runtimeEventSeq = 0) => {
    const result = { commandSeq: command.commandSeq, requestId: command.requestId, ok: true, value: { runtimeEventSeq } }
    broker.submitResult(id, result)
    broker.submitResult(id, result)
    after = command.commandSeq
  }
  try {
    const firstId = randomUUID()
    const first = broker.executeForSession(id, 0, "update", { operations: [] }, firstId)!
    const stale = broker.executeForSession(id, 0, "render", { packageId: "p", componentId: "c" })!
    const rejected = assert.rejects(stale, /state_version_conflict/)
    const view = broker.executeViewForSession(id, 0, { zoom: 2, background: "#ffffff", width: 800, height: 600 })!
    finish(await next())
    assert.equal((await first).semanticStateVersion, 1)
    assert.equal(broker.executeForSession(id, 0, "update", { operations: [] }, firstId), first)
    assert.throws(() => broker.executeForSession(id, 1, "update", { operations: [] }, firstId), /request_id_conflict/)
    const viewCommand = await next()
    assert.equal(viewCommand.kind, "view")
    assert.equal(viewCommand.commandSeq, 3)
    await rejected
    finish(viewCommand)
    const viewResult = await view
    assert.equal(viewResult.stateVersion, 1)
    assert.equal(viewResult.viewStateVersion, 1)
    assert.deepEqual(broker.getSession(id)?.view, { zoom: 2, background: "#ffffff", width: 800, height: 600 })
    assert.throws(() => broker.executeForSession(id, 0, "update", {}), /state_version_conflict/)
    assert.throws(() => broker.executeViewForSession(id, 0, { zoom: 1 }), /view_state_version_conflict/)

    const captureId = randomUUID()
    const capture = broker.executeReadForSession(id, 1, "capture", captureId, 1)!
    const command = await next()
    assert.deepEqual(command.executionState, { semanticStateVersion: 1, viewStateVersion: 1, runtimeEventSeq: 0 })
    const event = (runtimeEventSeq: number) => ({ runtimeEventSeq, targetId: "/button", event: "click" as const })
    // Event 1 happened before drawToCanvas, event 2 during PNG encoding / delivery.
    broker.recordInteraction(id, event(1))
    broker.recordInteraction(id, event(2))
    const wire = { commandSeq: command.commandSeq, requestId: captureId, ok: true, value: { runtimeEventSeq: 1, screenshotBase64: "snapshot" } }
    assert.equal(broker.submitResult(id, wire), true)
    const captured = await capture
    assert.equal(captured.semanticStateVersion, 2)
    assert.equal(captured.viewStateVersion, 1)
    assert.equal(captured.sourceRevision, project.sourceRevision)
    assert.equal(broker.getSession(id)?.semanticStateVersion, 3)
    assert.equal(broker.submitResult(id, wire), true)
    assert.deepEqual(await broker.executeReadForSession(id, 1, "capture", captureId, 1), captured)
    after = command.commandSeq

    // A click received after dispatch is rejected by the runtime before any operation.
    const update = broker.executeForSession(id, 3, "update", {})!
    const updateRejected = assert.rejects(update, /state_version_conflict/)
    const updateCommand = await next()
    broker.recordInteraction(id, event(3))
    broker.submitResult(id, { commandSeq: updateCommand.commandSeq, requestId: updateCommand.requestId, ok: false, error: "state_version_conflict: runtime event" })
    await updateRejected
    assert.equal(broker.getSession(id)?.stateVersion, 4)
    after = updateCommand.commandSeq

    const partial = broker.executeForSession(id, 4, "update", {})!
    const partialRejected = assert.rejects(partial, /partial update/)
    const partialCommand = await next()
    broker.submitResult(id, { commandSeq: partialCommand.commandSeq, requestId: partialCommand.requestId, ok: false, error: "partial update" })
    await partialRejected
    assert.equal(broker.getSession(id)?.semanticStateVersion, 5)
    assert.equal(broker.getSession(id)?.viewStateVersion, 1)
  } finally { broker.close() }
})

test("REST view/command and renderer snapshot trust boundaries stay bounded", () => {
  const command = { requestId: randomUUID(), kind: "view", expectedViewStateVersion: 0, payload: { width: 800, height: 600 } }
  assert.equal(renderSessionCommandSchema.safeParse(command).success, true)
  for (const payload of [{ zoom: 5 }, { width: 8193 }, { height: -1 }, { background: "url(https://example.com)" }, {}, { unknown: 1 }]) {
    assert.equal(renderSessionCommandSchema.safeParse({ ...command, payload }).success, false)
  }
  assert.equal(renderSessionCommandSchema.safeParse({ ...command, expectedViewStateVersion: undefined }).success, false)
  assert.equal(rendererResultSchema.safeParse({ commandSeq: 1, requestId: randomUUID(), ok: true, value: {} }).success, false)
})

test("uncertain view failures and iframe timeouts close the session and reject queued work", async () => {
  for (const kind of ["view", "update"] as const) {
    const broker = new ViewerRenderBroker(() => ({ projectId: "demo", sourceRevision: "revision", viewerUrl: "/viewer" }))
    const { renderSessionId: id } = broker.registerRenderer({ projectId: "demo", sourceRevision: "revision", protocolVersion: VIEWER_PROTOCOL_VERSION })!
    try {
      const failed = kind === "view" ? broker.executeViewForSession(id, 0, { zoom: 2 })! : broker.executeForSession(id, 0, "update", {})!
      const rejected = assert.rejects(failed, /view failed|runtime command timed out/)
      const queued = assert.rejects(broker.executeReadForSession(id, 0, "capture")!, /render_state_uncertain/)
      const { commands: [command] } = (await broker.readCommands(id, 0, new AbortController().signal))!
      assert.equal(broker.submitResult(id, { commandSeq: command.commandSeq, requestId: command.requestId, ok: false, error: kind === "view" ? "view failed" : "Viewer runtime command timed out." }), true)
      await Promise.all([rejected, queued])
      assert.equal(broker.getSession(id), null)
      assert.equal(broker.executeForSession(id, 0, "update", {}), null)
    } finally { broker.close() }
  }
})
