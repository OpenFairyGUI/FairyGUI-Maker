import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { registerViewerMcpTools, uiScenarioInputSchema, ViewerRenderBroker } from "../src/server/viewer"
import { VIEWER_PROTOCOL_VERSION, type ViewerBrokerCommand, type ViewerObservation, type ViewerOperation } from "../src/viewer-protocol"

async function fixture() {
  const project = { projectId: "demo", sourceRevision: "revision", viewerUrl: "http://localhost/viewer" }
  const broker = new ViewerRenderBroker(() => project)
  const id = broker.registerRenderer({ projectId: project.projectId, sourceRevision: project.sourceRevision, protocolVersion: VIEWER_PROTOCOL_VERSION })!.renderSessionId
  const observation: ViewerObservation = {
    objectTree: { id: "/root", name: "Main", type: "component", x: 0, y: 0, width: 200, height: 100, visible: true,
      children: [{ id: "/root/title", name: "Title", type: "text", text: "Before", x: 0, y: 0, width: 100, height: 20, visible: true }] },
    controllers: [{ targetId: "/root", name: "page", selectedIndex: 0, pageId: "first", pageName: "First", pages: [{ id: "first", name: "First" }] }],
    availableTransitions: [],
  }
  const title = observation.objectTree.children![0]
  const controller = new AbortController()
  const commands: ViewerBrokerCommand[] = []
  let holdUpdates = false
  let onObserve = () => {}
  let runtimeEventSeq = 0
  const interact = (targetId: string) => broker.recordInteraction(id, { runtimeEventSeq: ++runtimeEventSeq, targetId, event: "click" })
  const pump = (async () => {
    let after = 0
    while (!controller.signal.aborted) {
      const batch = await broker.readCommands(id, after, controller.signal)
      if (!batch) break
      for (const command of batch.commands) {
        after = command.commandSeq
        commands.push(command)
        if (holdUpdates && command.kind === "update") continue
        if (command.kind === "observe") onObserve()
        let error: string | undefined
        if (command.kind === "update") {
          for (const operation of command.payload.operations as ViewerOperation[]) {
            if (operation.op === "dispatch-event") interact(operation.targetId)
            else if (operation.op === "set-property" && operation.targetId === title.id && operation.property === "text") title.text = String(operation.value)
            else { error = "unsupported target after partial update"; break }
          }
        }
        broker.submitResult(id, { commandSeq: command.commandSeq, requestId: command.requestId, ok: !error, ...(error ? { error } : {}),
          value: { runtimeEventSeq, observation: structuredClone(observation),
            ...(command.kind === "render" ? { rendered: { packageId: "pkg", componentId: "main" } } : {}),
            ...(command.kind === "capture" ? { screenshotBase64: Buffer.from("test-png").toString("base64") } : {}) } })
      }
    }
  })()
  await broker.executeForSession(id, 0, "render", { packageId: "pkg", componentId: "main" })
  const input = (steps: unknown[]) => ({ renderSessionId: id, sourceRevision: project.sourceRevision, requestId: randomUUID(),
    expectedStateVersion: broker.getSession(id)!.stateVersion, expectedViewStateVersion: broker.getSession(id)!.viewStateVersion, steps })
  return { project, broker, id, title, commands, interact, input, hold: () => { holdUpdates = true }, observe: (callback: () => void) => { onObserve = callback },
    close: async () => { controller.abort(); broker.close(); await pump } }
}

test("real MCP scenarios sequence operations, assertions, waits and PNGs with replay and fail-fast receipts", async () => {
  const state = await fixture()
  const server = new McpServer({ name: "scenario-test", version: "1.0.0" })
  registerViewerMcpTools(server, state.broker, () => state.project)
  const client = new Client({ name: "scenario-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (input: Record<string, unknown>) => {
    const result = await client.callTool({ name: "run_ui_scenario", arguments: input })
    return { result, data: JSON.parse((result.content as { text: string }[])[0].text) }
  }
  try {
    state.interact("old-event")
    const oldEvent = await call(state.input([{ action: "assert", condition: { kind: "interaction", targetId: "old-event", event: "click" } }]))
    assert.equal(oldEvent.result.isError, true, "pre-scenario events cannot satisfy a condition")
    const input = state.input([
      { action: "update", operations: [{ op: "set-property", targetId: state.title.id, property: "text", value: "After" }, { op: "dispatch-event", targetId: state.title.id, event: "click" }] },
      { action: "assert", condition: { kind: "property", targetId: state.title.id, property: "text", equals: "After" } },
      { action: "assert", condition: { kind: "controller", targetId: "/root", controllerName: "page", pageId: "first" } },
      { action: "wait-for", condition: { kind: "interaction", targetId: state.title.id, event: "click" }, timeoutMs: 1000 },
      { action: "wait-for", condition: { kind: "property", targetId: state.title.id, property: "text", equals: "Ready" }, timeoutMs: 1000 },
      { action: "capture" },
    ])
    let observations = 0
    let ready: ReturnType<typeof setTimeout> | undefined
    state.observe(() => {
      if (++observations === 3) ready = setTimeout(() => { state.title.text = "Ready" }, 25)
    })
    let completed: Awaited<ReturnType<typeof call>>
    try { completed = await call(input) } finally { clearTimeout(ready) }
    assert.equal(completed.data.value.passed, true, JSON.stringify(completed.data))
    assert.equal(completed.data.value.steps.length, 6)
    assert.equal(completed.data.value.capture.stepIndex, 5)
    assert.equal(completed.data.value.capture.sourceRevision, state.project.sourceRevision)
    assert.equal((completed.result.content as { type: string }[]).filter((item) => item.type === "image").length, 1)
    assert.equal(JSON.stringify(completed.data).includes("screenshotBase64"), false)
    const count = state.commands.length
    assert.deepEqual(await call(input), completed, "whole-run retry returns the same receipt without re-executing operations")
    assert.equal(state.commands.length, count)
    assert.match((await call({ ...input, steps: [{ action: "capture" }] })).data.message, /request_id_conflict/)
    assert.match((await call({ ...input, requestId: randomUUID() })).data.message, /state_version_conflict/)

    const failed = await call(state.input([
      { action: "assert", condition: { kind: "exists", targetId: "missing", exists: true } },
      { action: "update", operations: [{ op: "set-property", targetId: state.title.id, property: "text", value: "Never" }] },
    ]))
    assert.equal(failed.result.isError, true)
    assert.equal(failed.data.value.failedStep, 0)
    assert.equal(failed.data.value.steps.length, 1)
    assert.equal(state.title.text, "Ready")
    const partial = await call(state.input([{ action: "update", operations: [
      { op: "set-property", targetId: state.title.id, property: "text", value: "Applied prefix" },
      { op: "set-property", targetId: "missing", property: "text", value: "Never" },
    ] }, { action: "capture" }]))
    assert.equal(partial.data.value.passed, false)
    assert.equal(partial.data.value.rollback, false)
    assert.equal(partial.data.value.sessionAvailable, true)
    assert.equal(state.title.text, "Applied prefix")
    assert.equal(partial.data.value.steps.length, 1)
    state.title.children = [{ ...state.title }]
    const ambiguous = await call(state.input([{ action: "assert", condition: { kind: "exists", targetId: state.title.id, exists: true } }]))
    assert.match(ambiguous.data.value.error, /target_ambiguous/)
    state.title.children = [{ id: "" } as any]
    const malformed = await call(state.input([{ action: "assert", condition: { kind: "exists", targetId: "missing", exists: false } }]))
    assert.match(malformed.data.value.error, /observation_invalid/, "malformed observations cannot prove absence")
    delete state.title.children
  } finally { await client.close(); await server.close(); await state.close() }
})

test("scenario bounds, concurrency, lost events, source changes and in-flight deadlines fail explicitly", async () => {
  const state = await fixture()
  const condition = { kind: "property", targetId: state.title.id, property: "text", equals: "Never" }
  try {
    const waiting = { ...state.input([{ action: "wait-for", condition, timeoutMs: 150 }]), timeoutMs: 2000 }
    const parsed = uiScenarioInputSchema.parse(waiting)
    const pending = state.broker.runScenario(parsed)!
    assert.equal(state.broker.runScenario(parsed), pending)
    assert.throws(() => state.broker.runScenario({ ...parsed, requestId: randomUUID() }), /scenario_busy/)
    const expired = await pending
    assert.equal(expired.value.passed, false)
    assert.match(String(expired.value.error), /condition_timeout/)
    assert.notEqual(state.broker.getSession(state.id), null, "an unmet condition with acknowledged reads keeps the renderer usable")
    assert.equal(state.commands.length < 10, true, "waits must not busy-poll the renderer")

    const events = uiScenarioInputSchema.parse(state.input([{ action: "wait-for", condition: { kind: "interaction", targetId: "missing", event: "click" }, timeoutMs: 1000 }]))
    const lost = state.broker.runScenario(events)!
    for (let index = 0; index < 101; index++) state.interact(`event-${index}`)
    assert.match(String((await lost).value.error), /interaction_history_lost/)

    state.hold()
    const hanging = uiScenarioInputSchema.parse({ ...state.input([{ action: "update", operations: [{ op: "set-property", targetId: state.title.id, property: "text", value: "Unknown" }] }]), timeoutMs: 100 })
    const uncertain = await state.broker.runScenario(hanging)!
    assert.equal(uncertain.value.passed, false)
    assert.equal(uncertain.value.executionUncertain, true)
    assert.equal(uncertain.value.sessionAvailable, false)
    assert.equal(state.broker.getSession(state.id), null)
  } finally { await state.close() }

  const changed = await fixture()
  try {
    const input = uiScenarioInputSchema.parse(changed.input([{ action: "wait-for", condition, timeoutMs: 1000 }]))
    const running = changed.broker.runScenario(input)!
    changed.project.sourceRevision = "new-revision"
    const result = await running
    assert.equal(result.value.passed, false)
    assert.equal(result.value.sessionAvailable, false)
    assert.equal(result.sourceRevision, "revision")
  } finally { await changed.close() }

  const valid = { renderSessionId: "id", requestId: randomUUID(), sourceRevision: "revision", expectedStateVersion: 0, expectedViewStateVersion: 0, steps: [{ action: "capture" }] }
  for (const input of [
    { ...valid, steps: Array.from({ length: 21 }, () => ({ action: "capture" })) },
    { ...valid, steps: [{ action: "capture" }, { action: "capture" }] },
    { ...valid, timeoutMs: 30_001 },
    { ...valid, steps: [{ action: "assert", condition: { kind: "property", targetId: "id", property: "__proto__", equals: "bad" } }] },
    { ...valid, steps: [{ action: "evaluate", script: "arbitrary JavaScript" }] },
    { ...valid, steps: [{ action: "update", operations: Array.from({ length: 101 }, () => ({ op: "set-property", targetId: "id", property: "visible", value: true })) }] },
    { ...valid, steps: [51, 50].map((count) => ({ action: "update", operations: Array.from({ length: count }, () => ({ op: "set-property", targetId: "id", property: "visible", value: true })) })) },
    { ...valid, steps: [{ action: "update", operations: [{ op: "set-property", targetId: "id", property: "text", value: "x".repeat(256 * 1024) }] }] },
  ]) assert.equal(uiScenarioInputSchema.safeParse(input).success, false)
})
