import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setTimeout as sleep } from "node:timers/promises"
import test, { type TestContext } from "node:test"
import { ViewerRenderBroker, rendererInteractionSchema, rendererResultSchema } from "../src/server/viewer"
import { VIEWER_PROTOCOL_VERSION, type ViewerBrokerCommand, type ViewerInteractionEvent } from "../src/viewer-protocol"
import { startRendererDelivery } from "../src/web/lib/renderer-delivery"

const project = { projectId: "delivery", sourceRevision: "revision", viewerUrl: "http://localhost/viewer" }
const registration = { projectId: project.projectId, sourceRevision: project.sourceRevision, protocolVersion: VIEWER_PROTOCOL_VERSION } as const
const event = (runtimeEventSeq: number): ViewerInteractionEvent => ({ runtimeEventSeq, targetId: "/button", event: "click", data: { selected: true } })
async function until(ready: () => boolean) {
  for (let i = 0; i < 500; i++) { if (ready()) return; await sleep(10) }
  assert.fail("Delivery did not reach the expected state")
}

async function renderer(t: TestContext, options: {
  execute?: (command: ViewerBrokerCommand) => Promise<Record<string, unknown>>
  post?: (path: string, body: string, signal: AbortSignal, accept: () => Response) => Promise<Response>
  duringRegistration?: (emit: (value: ViewerInteractionEvent) => void) => void
} = {}) {
  const broker = new ViewerRenderBroker(() => project)
  const registered = broker.registerRenderer(registration)!
  const lifetime = new AbortController()
  const errors: Error[] = []
  let handler: ((event: ViewerInteractionEvent) => void) | null = null
  const emit = (value: ViewerInteractionEvent) => handler?.(value)
  const windowBefore = Object.getOwnPropertyDescriptor(globalThis, "window")
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() })
  t.after(() => {
    lifetime.abort()
    broker.close()
    if (windowBefore) Object.defineProperty(globalThis, "window", windowBefore)
    else Reflect.deleteProperty(globalThis, "window")
  })
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    const target = new URL(url, "http://localhost")
    const signal = init.signal!
    if (init.method === "DELETE") { broker.disconnectRenderer(registered.renderSessionId); return new Response(null, { status: 204 }) }
    if (target.pathname.endsWith("/commands")) {
      const batch = await broker.readCommands(registered.renderSessionId, Number(target.searchParams.get("after")), signal)
      return batch ? Response.json(batch) : Response.json({ error: "session closed" }, { status: 404 })
    }
    const accept = () => {
      try {
        const body = JSON.parse(init.body as string)
        if (target.pathname.endsWith("/results")) {
          const accepted = broker.submitResult(registered.renderSessionId, rendererResultSchema.parse(body))
          return Response.json({ accepted, commandSeq: body.commandSeq, requestId: body.requestId })
        }
        const session = broker.recordInteraction(registered.renderSessionId, rendererInteractionSchema.parse(body))
        return Response.json({ accepted: !!session, runtimeEventSeq: body.runtimeEventSeq, session })
      } catch (error) { return Response.json({ error: String(error) }, { status: 409 }) }
    }
    return options.post ? options.post(target.pathname, init.body as string, signal, accept) : accept()
  })
  const delivery = await startRendererDelivery(
    async () => { options.duringRegistration?.(emit); return { session: registered } },
    { setInteractionHandler: (value) => { handler = value } },
    async (command) => ({ runtimeEventSeq: command.executionState?.runtimeEventSeq ?? 0, ...await (options.execute?.(command) ?? {}) }),
    (error) => errors.push(error),
    lifetime.signal,
  )
  return { broker, id: registered.renderSessionId, emit, errors, delivery, hasHandler: () => !!handler }
}

test("result retries preserve one execution and exact bytes before acceptance and after lost ACK", async (t) => {
  for (const failed of [false, true]) await t.test(failed ? "failed execution" : "successful mutation", async (t) => {
    let executions = 0
    const posts: string[] = []
    const r = await renderer(t, {
      execute: async () => { executions++; if (failed) throw new Error("partial update failed"); return { selected: true } },
      post: async (_path, body, _signal, accept) => {
        posts.push(body)
        if (posts.length === 1) throw new TypeError("offline before Host")
        const response = accept()
        if (posts.length === 2) throw new TypeError("lost Host ACK")
        return response
      },
    })
    const pending = r.broker.executeForProject(project.projectId, "update", {}, randomUUID())!
    if (failed) await assert.rejects(pending, /partial update failed/)
    else assert.equal((await pending).stateVersion, 1)
    await until(() => posts.length === 3)
    assert.equal(executions, 1)
    assert.equal(new Set(posts).size, 1)
    assert.equal(r.broker.getSession(r.id)?.stateVersion, 1)
    assert.deepEqual(r.errors, [])
  })
})

test("interaction outbox captures registration-time events and retries its head without gaps", async (t) => {
  const seqs: number[] = []
  const r = await renderer(t, {
    duringRegistration: (emit) => { emit(event(1)); emit(event(2)) },
    post: async (_path, body, _signal, accept) => {
      seqs.push(JSON.parse(body).runtimeEventSeq)
      if (seqs.length === 1) return Response.json({ error: "busy" }, { status: 503 })
      const response = accept()
      if (seqs.length === 2) throw new TypeError("ACK lost")
      return response
    },
  })
  r.emit(event(3))
  await until(() => r.broker.getSession(r.id)?.lastAcceptedRuntimeEventSeq === 3)
  assert.deepEqual(seqs, [1, 1, 1, 2, 3])
  assert.equal(r.broker.getSession(r.id)?.stateVersion, 3)
  assert.deepEqual(r.errors, [])
})

test("stop cancels in-flight delivery and never submits a late execution result", async (t) => {
  for (const duringPost of [false, true]) await t.test(duringPost ? "during POST" : "during execution", async (t) => {
    let finish!: (value: Record<string, unknown>) => void
    let started = false
    let posts = 0
    let aborted = false
    const r = await renderer(t, {
      execute: () => { started = true; return duringPost ? Promise.resolve({}) : new Promise((resolve) => { finish = resolve }) },
      post: async (_path, _body, signal) => {
        posts++
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => { aborted = true; reject(signal.reason) }, { once: true }))
      },
    })
    const pending = r.broker.executeForProject(project.projectId, "update", {})!
    const rejected = assert.rejects(pending, /disconnected/)
    await until(() => duringPost ? posts === 1 : started)
    r.delivery.stop()
    if (!duringPost) finish({})
    await rejected
    await sleep(300)
    assert.equal(posts, duringPost ? 1 : 0)
    assert.equal(aborted, duringPost)
    assert.equal(r.hasHandler(), false)
    assert.equal(r.broker.getSession(r.id), null)
    assert.deepEqual(r.errors, [])
  })
})

test("gap, outbox count/bytes overflow, invalid ACK and permanent HTTP failures stop visibly", async (t) => {
  for (const kind of ["gap", "count", "bytes", "event", "ack", "http"] as const) await t.test(kind, async (t) => {
    const r = await renderer(t, {
      post: async () => {
        if (kind === "ack") return Response.json({ accepted: true, runtimeEventSeq: 900 })
        if (kind === "http") return Response.json({ error: "session missing" }, { status: 404 })
        throw new TypeError("offline")
      },
    })
    if (kind === "gap") r.emit(event(2))
    else if (kind === "count") for (let seq = 1; seq <= 257; seq++) r.emit(event(seq))
    else if (kind === "bytes") for (let seq = 1; seq <= 40; seq++) r.emit({ ...event(seq), data: { text: "a".repeat(30_000) } })
    else if (kind === "event") r.emit({ ...event(1), data: { text: "a".repeat(65_536) } })
    else r.emit(event(1))
    await until(() => r.errors.length === 1)
    assert.match(r.errors[0].message, /刷新页面重新连接/)
    assert.equal(r.hasHandler(), false)
    assert.equal(r.broker.getSession(r.id), null)
  })
})

test("stop during registration closes a late session without starting a poll or an execution", async (t) => {
  const target = new EventTarget()
  Object.defineProperty(globalThis, "window", { configurable: true, value: target })
  t.after(() => { Reflect.deleteProperty(globalThis, "window") })
  const requests: string[] = []
  t.mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => { requests.push(init.method ?? "GET"); return new Response(null, { status: 204 }) })
  const lifetime = new AbortController()
  let finish!: (value: { session: { renderSessionId: string } }) => void
  const pending = startRendererDelivery(() => new Promise<{ session: { renderSessionId: string } }>((resolve) => { finish = resolve }), { setInteractionHandler() {} }, async () => assert.fail("late execution"), () => assert.fail("late error"), lifetime.signal)
  lifetime.abort()
  finish({ session: { renderSessionId: "late" } })
  await assert.rejects(pending, { name: "AbortError" })
  assert.deepEqual(requests, ["DELETE"])
})

test("a bfcache restore reloads instead of resuming a stopped renderer", async (t) => {
  const r = await renderer(t)
  let reloads = 0
  Reflect.set(window, "location", { reload: () => { reloads++ } })
  const pagehide = new Event("pagehide")
  Object.defineProperty(pagehide, "persisted", { value: true })
  window.dispatchEvent(pagehide)
  assert.equal(r.broker.getSession(r.id), null)
  assert.equal(r.hasHandler(), false)
  window.dispatchEvent(new Event("pageshow"))
  window.dispatchEvent(new Event("pageshow"))
  assert.equal(reloads, 1)
})

test("a prolonged delivery failure stops instead of keeping an outbox alive forever", async (t) => {
  t.mock.timers.enable({ apis: ["Date"] })
  const r = await renderer(t, { post: async () => {
    t.mock.timers.setTime(Date.now() + 60_001)
    throw new TypeError("offline")
  } })
  r.emit(event(1))
  await until(() => r.errors.length === 1)
  assert.match(r.errors[0].message, /renderer_delivery_timeout/)
  assert.equal(r.broker.getSession(r.id), null)
})

test("Broker replay receipts are canonical, bounded, conflict-safe and do not advance state twice", async () => {
  const broker = new ViewerRenderBroker(() => project)
  try {
    const { renderSessionId: id } = broker.registerRenderer(registration)!
    const requestId = randomUUID()
    const pending = broker.executeForProject(project.projectId, "update", { a: 1, b: 2 }, requestId)!
    assert.equal(broker.executeForProject(project.projectId, "update", { b: 2, a: 1 }, requestId), pending)
    await broker.readCommands(id, 0, new AbortController().signal)
    const result = { commandSeq: 1, requestId, ok: true, value: { runtimeEventSeq: 0, a: 1, b: { c: 2, d: [1, 2] } } }
    assert.equal(broker.submitResult(id, result), true)
    await pending
    assert.equal(broker.submitResult(id, { ...result, value: { b: { d: [1, 2], c: 2 }, a: 1, runtimeEventSeq: 0 } }), true)
    assert.throws(() => broker.submitResult(id, { ...result, value: { a: 2, runtimeEventSeq: 0 } }), /result_conflict/)
    assert.throws(() => broker.submitResult(id, { ...result, requestId: randomUUID() }), /result_conflict/)
    assert.equal(broker.getSession(id)?.stateVersion, 1)
    const interaction = { ...event(1), data: { selected: true, index: 2 } }
    broker.recordInteraction(id, interaction)
    broker.recordInteraction(id, { ...interaction, data: { index: 2, selected: true } })
    assert.throws(() => broker.recordInteraction(id, { ...event(1), data: { selected: false } }), /interaction_conflict/)
    assert.throws(() => broker.recordInteraction(id, event(3)), /interaction_sequence_gap/)
    assert.equal(broker.getSession(id)?.stateVersion, 2)
    for (let seq = 2; seq <= 257; seq++) {
      broker.recordInteraction(id, event(seq))
      const requestId = randomUUID()
      const pending = broker.executeForProject(project.projectId, "capture", {}, requestId)!
      await broker.readCommands(id, seq - 1, new AbortController().signal)
      broker.submitResult(id, { commandSeq: seq, requestId, ok: true, value: { runtimeEventSeq: seq } })
      await pending
    }
    assert.throws(() => broker.recordInteraction(id, interaction), /interaction_conflict/)
    assert.throws(() => broker.submitResult(id, result), /result_conflict/)
    assert.equal(broker.getSession(id)?.lastAcceptedRuntimeEventSeq, 257)
    assert.equal(rendererInteractionSchema.safeParse({ ...event(1), data: { text: "a".repeat(16_385) } }).success, false)
  } finally { broker.close() }
})

test("unacknowledged command timeout invalidates the whole uncertain session; TTL reclaims idle sessions", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] })
  const broker = new ViewerRenderBroker(() => project)
  try {
    const { renderSessionId: id } = broker.registerRenderer(registration)!
    const requestId = randomUUID()
    const first = broker.executeForProject(project.projectId, "update", {}, requestId)!
    const second = broker.executeForProject(project.projectId, "capture", {})!
    const rejected = Promise.all([assert.rejects(first, /execution status is unknown/), assert.rejects(second, /execution status is unknown/)])
    t.mock.timers.tick(30_000)
    await rejected
    assert.equal(broker.getSession(id), null)
    assert.equal(broker.submitResult(id, { commandSeq: 1, requestId, ok: true }), false)
    const fresh = broker.registerRenderer(registration)!
    assert.notEqual(fresh.renderSessionId, id)
    t.mock.timers.tick(5 * 60_000 + 1)
    broker.pruneExpiredSessions()
    assert.equal(broker.getSession(fresh.renderSessionId), null)
  } finally { broker.close() }
})
