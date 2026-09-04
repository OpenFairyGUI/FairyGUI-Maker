import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { readFile, rm } from "node:fs/promises"
import path from "node:path"
import test from "node:test"
import { assertDiagnostics, assertVisualBaseline, createBrowserEvidence, expectedDiagnostic, goldenUpdateEnabled, redactEvidence, type BrowserDiagnostic } from "../scripts/browser-evidence"
import { comparePixelData } from "../src/web/lib/visual-evidence"

test("evidence gates reject a changed pixel, dimensions, unexpected browser failures and CI baseline updates", () => {
  const reference = { width: 1, height: 1, data: new Uint8ClampedArray([10, 20, 30, 255]) }
  const actual = { ...reference, data: new Uint8ClampedArray([11, 20, 30, 255]) }
  const baseline = { schemaVersion: 1 as const, fixture: "one-pixel", width: 1, height: 1, maxDifferentPixels: 0, maxMeanAbsoluteError: 0 }
  assert.throws(() => assertVisualBaseline(comparePixelData(reference, actual).metrics, baseline, { width: 1, height: 1 }, { width: 1, height: 1 }), /Visual baseline changed/)
  assert.throws(() => assertVisualBaseline(comparePixelData(reference, reference).metrics, baseline, { width: 1, height: 1 }, { width: 2, height: 1 }), /Capture dimensions changed/)
  for (const kind of ["pageerror", "console.error", "console.warning", "requestfailed", "http", "csp"]) {
    assert.throws(() => assertDiagnostics([{ phase: "workbench-import", kind, message: "unexpected", status: 500, url: "/assets/runtime.js" }]), /Unexpected browser diagnostics/)
  }
  const intentional: BrowserDiagnostic = { phase: "delivery-viewer", kind: "http", status: 503, message: "POST 503", url: "http://localhost/api/render-sessions/render-id/results" }
  assertDiagnostics([intentional])
  assert.equal(expectedDiagnostic({ ...intentional, status: 500 }), undefined)
  assert.equal(expectedDiagnostic({ ...intentional, phase: "viewer-golden" }), undefined)
  assert.equal(expectedDiagnostic({ ...intentional, url: "http://localhost/assets/runtime.js" }), undefined)
  const teardown: BrowserDiagnostic = { phase: "lifecycle-viewer", kind: "requestfailed", method: "DELETE", message: "net::ERR_ABORTED", url: "http://localhost/api/render-sessions/render-id" }
  assert.ok(expectedDiagnostic(teardown))
  assert.equal(expectedDiagnostic({ ...teardown, message: "net::ERR_FAILED" }), undefined)
  assert.equal(expectedDiagnostic({ ...teardown, url: "http://localhost/api/projects/project-id" }), undefined)
  assert.throws(() => goldenUpdateEnabled({ CI: "true", UPDATE_VISUAL_GOLDENS: "1" }), /CI must not update/)
  assert.equal(goldenUpdateEnabled({ UPDATE_VISUAL_GOLDENS: "1" }), true)
  assert.equal(goldenUpdateEnabled({ CI: "true" }), false)
})

test("failure reports survive caller cleanup and redact tokens and local fixture paths", async () => {
  const secret = "host-owner-test-token"
  const evidence = await createBrowserEvidence([secret, "C:\\private\\fixture"])
  try {
    await assert.rejects(evidence.step("injected-failure", async () => { throw new Error("deliberate smoke failure") }))
    await evidence.finish("failed", { environment: { browserVersion: "test" } }, [], new Error(`${secret} C:\\private\\fixture ?token=other-secret`))
    const text = await readFile(path.join(evidence.directory, "report.json"), "utf8")
    const report = JSON.parse(text)
    assert.equal(report.status, "failed")
    assert.equal(report.checks["injected-failure"].status, "failed")
    assert.doesNotMatch(text, /host-owner-test-token|private|other-secret/)
    assert.doesNotMatch(redactEvidence(JSON.stringify({ path: "C:\\private\\fixture" }), ["C:\\private\\fixture"]), /private/)
    assert.match(redactEvidence("/test?token=hidden#nonce=also-hidden", []), /token=\[redacted\]#nonce=\[redacted\]/)
  } finally { await rm(evidence.directory, { recursive: true, force: true }) }
})

test("buffered browser messages retain their original fault phase", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000 })
  const evidence = await createBrowserEvidence([])
  try {
    const context = Object.assign(new EventEmitter(), { async exposeBinding() {}, async addInitScript() {} })
    await evidence.attach(context as unknown as Parameters<typeof evidence.attach>[0])
    const page = new EventEmitter()
    context.emit("page", page)
    evidence.phase("delivery-viewer")
    t.mock.timers.tick(100)
    evidence.phase("viewer-golden")
    const message = { type: () => "error", location: () => ({ url: "http://localhost/api/render-sessions/id/results" }), text: () => "net::ERR_FAILED" }
    page.emit("console", { ...message, timestamp: () => 1050 })
    assert.equal(evidence.diagnostics[0].phase, "delivery-viewer")
    evidence.verify()
    page.emit("console", { ...message, timestamp: () => 1150 })
    assert.throws(() => evidence.verify(), /Unexpected browser diagnostics/)
  } finally { await rm(evidence.directory, { recursive: true, force: true }) }
})
