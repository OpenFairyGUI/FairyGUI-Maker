import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"
import { VIEWER_PROTOCOL_VERSION, type ViewerCommand, type ViewerConnectMessage, type ViewerRuntimeMessage, type ViewerScene } from "../src/viewer-protocol"
import { connectRendererChannel, executeRendererCommand, type RendererFrameSession } from "../src/web/lib/renderer-frame"

function runtime(t: TestContext, mode: "Viewer" | "Player", first: ViewerRuntimeMessage | null = { kind: "ready", sourceRevision: "revision" }) {
  const lifetime = new AbortController()
  const connection = { sourceRevision: "revision", nonce: crypto.randomUUID(), imageProbeWorker: "worker code" }
  let port!: MessagePort
  const target = {
    postMessage(message: ViewerConnectMessage, origin: string, transfer: MessagePort[]) {
      assert.deepEqual(message, { type: "fairygui.viewer.connect", protocolVersion: VIEWER_PROTOCOL_VERSION, ...connection })
      assert.equal(origin, "*")
      assert.equal(transfer.length, 1)
      port = structuredClone(transfer[0], { transfer })
      port.start()
      if (first) port.postMessage(first)
    },
  } as unknown as Window
  const connected = connectRendererChannel(target, mode, connection, lifetime.signal)
  t.after(() => { lifetime.abort(); port.close() })
  return {
    connected, lifetime,
    reply: (message: ViewerRuntimeMessage, transfer: Transferable[] = []) => port.postMessage(message, transfer),
    command: () => new Promise<ViewerCommand>((resolve) => port.addEventListener("message", (event) => resolve(event.data), { once: true })),
  }
}

for (const mode of ["Viewer", "Player"] as const) {
  test(`${mode} shared frame correlates responses, transfers bytes and preserves interaction watermarks`, async (t) => {
    const r = runtime(t, mode)
    const frame = await r.connected
    const interactions: number[] = []
    frame.setInteractionHandler((event) => interactions.push(event.runtimeEventSeq))
    let received = r.command()
    const observation = frame.observe()
    const command = await received
    assert.equal(command.kind, "observe")
    r.reply({ kind: "response", requestId: "unrelated", ok: true, runtimeEventSeq: 0 })
    r.reply({ kind: "interaction", value: { event: "click", targetId: "/button", runtimeEventSeq: 1 } })
    r.reply({ kind: "response", requestId: command.requestId, ok: true, value: { runtimeEventSeq: 999, objectTree: { id: "/button" } }, runtimeEventSeq: 1 })
    assert.deepEqual(await observation, { objectTree: { id: "/button" }, runtimeEventSeq: 1 })
    assert.deepEqual(interactions, [1])

    received = r.command()
    const updated = frame.applyOperations([{ op: "set-property", targetId: "/button", property: "visible", value: false }], 1)
    const update = await received
    assert.equal(update.kind, "apply-operations")
    assert.equal(update.expectedRuntimeEventSeq, 1)
    const rejected = assert.rejects(updated, /runtime_event_conflict/)
    r.reply({ kind: "response", requestId: update.requestId, ok: false, error: "runtime_event_conflict" })
    await rejected

    const data = new Uint8Array([1, 2, 3]).buffer
    const scene = { assets: [{ data }] } as ViewerScene
    received = r.command()
    const rendered = frame.send({ kind: "render", scene, expectedRuntimeEventSeq: 1 }, [data])
    assert.equal(data.byteLength, 0)
    const render = await received
    assert.equal(render.kind, "render")
    if (render.kind !== "render") assert.fail("wrong command")
    assert.deepEqual(new Uint8Array(render.scene.assets[0].data), new Uint8Array([1, 2, 3]))
    r.reply({ kind: "response", requestId: render.requestId, ok: true, runtimeEventSeq: 1 })
    await rendered

    received = r.command()
    const captured = frame.capture()
    const capture = await received
    const png = new Uint8Array([4, 5, 6]).buffer
    r.reply({ kind: "response", requestId: capture.requestId, ok: true, value: { data: png, type: "image/png", observation: { objectTree: { id: "/snapshot" } } }, runtimeEventSeq: 2 }, [png])
    const result = await captured
    assert.equal(result.blob.type, "image/png")
    assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()), new Uint8Array([4, 5, 6]))
    assert.equal(result.runtimeEventSeq, 2)
    assert.equal(result.observation?.objectTree.id, "/snapshot")

    frame.destroy()
    frame.destroy()
    await assert.rejects(frame.observe(), /session closed/)
  })

  test(`${mode} shared frame releases failed handshakes, timed-out requests and closed sessions`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] })
    await assert.rejects(runtime(t, mode, { kind: "ready", sourceRevision: "wrong" }).connected, /错误的/)
    await assert.rejects(runtime(t, mode, { kind: "fatal", error: "startup failed" }).connected, /startup failed/)
    const starting = runtime(t, mode, null)
    const timeout = assert.rejects(starting.connected, /启动超时/)
    t.mock.timers.tick(20_000)
    await timeout
    const aborted = runtime(t, mode, null)
    const abortReady = assert.rejects(aborted.connected, /cancel startup/)
    aborted.lifetime.abort(new Error("cancel startup"))
    await abortReady
    const target = { postMessage() { throw new Error("connect failed") } } as unknown as Window
    const connection = { sourceRevision: "revision", nonce: crypto.randomUUID(), imageProbeWorker: "worker" }
    await assert.rejects(connectRendererChannel(target, mode, connection, new AbortController().signal), /connect failed/)
    await assert.rejects(connectRendererChannel(target, mode, connection, AbortSignal.abort(new Error("already closed"))), /already closed/)

    const r = runtime(t, mode)
    const frame = await r.connected
    // Structured clone failure must remove its timer immediately, without killing the channel.
    const clear = t.mock.method(globalThis, "clearTimeout")
    await assert.rejects(frame.setView({ zoom: (() => 1) as unknown as number }), /clone/)
    assert.equal(clear.mock.callCount(), 1)
    let received = r.command()
    const timedOut = assert.rejects(frame.observe(), /command timed out: observe/)
    const old = await received
    t.mock.timers.tick(mode === "Viewer" ? 20_000 : 30_000)
    await timedOut
    received = r.command()
    const view = frame.setView({ zoom: 2 })
    const current = await received
    r.reply({ kind: "response", requestId: old.requestId, ok: true, runtimeEventSeq: 99 })
    r.reply({ kind: "response", requestId: current.requestId, ok: true, value: { zoom: 2 }, runtimeEventSeq: 3 })
    assert.deepEqual(await view, { zoom: 2, runtimeEventSeq: 3 })

    for (const reason of ["destroy", "abort", "fatal"] as const) {
      const r = runtime(t, mode)
      const frame = await r.connected
      const pending = [assert.rejects(frame.observe(), /closed/), assert.rejects(frame.setView({ zoom: 1 }), /closed/)]
      if (reason === "destroy") frame.destroy()
      if (reason === "abort") r.lifetime.abort(new Error("closed by abort"))
      if (reason === "fatal") r.reply({ kind: "fatal", error: "closed by runtime" })
      await Promise.all(pending)
      await assert.rejects(frame.observe(), /closed/)
    }
  })
}

test("shared Broker adapter forwards execution watermarks and keeps renderer-specific validation", async () => {
  const frame = {
    render: async (packageId: string, componentId: string, seq: number) => {
      assert.deepEqual([packageId, componentId, seq], ["pkg", "component", 7])
      throw new Error("renderer-specific catalog rejection")
    },
    applyOperations: async (operations: unknown, seq: number) => ({ operations, runtimeEventSeq: seq }),
    observe: async () => ({ objectTree: { id: "/observed" }, runtimeEventSeq: 8 }),
    setView: async (view: unknown) => ({ view }),
  } as unknown as RendererFrameSession
  const base = { requestId: crypto.randomUUID(), commandSeq: 1, executionState: { semanticStateVersion: 2, viewStateVersion: 3, runtimeEventSeq: 7 } }
  for (const mode of ["Viewer", "Player"] as const) {
    await assert.rejects(executeRendererCommand(mode, frame, { ...base, kind: "render", payload: { packageId: "pkg", componentId: "component" } }), /renderer-specific/)
    await assert.rejects(executeRendererCommand(mode, frame, { ...base, kind: "update", payload: {} }), /missing operations/)
    assert.deepEqual(await executeRendererCommand(mode, frame, { ...base, kind: "update", payload: { operations: [] } }), { operations: [], runtimeEventSeq: 7 })
    assert.deepEqual(await executeRendererCommand(mode, frame, { ...base, kind: "view", payload: { zoom: 2 } }), { view: { zoom: 2 } })
    assert.deepEqual(await executeRendererCommand(mode, frame, { ...base, kind: "observe", payload: {} }), { observation: { objectTree: { id: "/observed" }, runtimeEventSeq: 8 }, runtimeEventSeq: 8 })
  }
})
