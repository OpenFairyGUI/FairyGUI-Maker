import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { Browser } from "playwright"
import { createBrowserEvidence, saveVisualGolden } from "./browser-evidence"

/** Exercise the gate itself; a smoke suite that cannot fail must not certify a release. */
export async function browserEvidenceSmoke(browser: Browser) {
  const evidence = await createBrowserEvidence([])
  const context = await browser.newContext()
  try {
    await evidence.attach(context)
    const page = await context.newPage()
    await page.route("http://evidence.invalid/**", (route) => route.request().url().endsWith("/network-fault") ? route.abort("failed")
      : route.fulfill({ status: route.request().url().endsWith("/http-fault") ? 503 : 200,
        headers: { "Content-Type": "text/html", "Content-Security-Policy": "img-src data:; connect-src 'self'" },
        body: '<link rel="icon" href="data:,"><p>Intentional evidence gate self-test</p>' }))
    await page.goto("http://evidence.invalid/")
    const png = async (red: number) => Buffer.from(await page.evaluate((red) => {
      const canvas = document.createElement("canvas"); canvas.width = 1; canvas.height = 1
      canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray([red, 20, 30, 255]), 1, 1), 0, 0)
      return canvas.toDataURL("image/png").split(",")[1]
    }, red), "base64")
    const golden = path.join(evidence.directory, "one-pixel.png"), threshold = path.join(evidence.directory, "threshold.json")
    await writeFile(golden, await png(10))
    await writeFile(threshold, JSON.stringify({ schemaVersion: 1, fixture: "intentional pixel mutation", width: 1, height: 1, maxDifferentPixels: 0, maxMeanAbsoluteError: 0 }))
    await assert.rejects(saveVisualGolden(page, evidence.directory, "intentional-pixel-failure", await png(11), {
      renderSessionId: "render_00000000-0000-0000-0000-000000000000", sourceRevision: "gate-test", semanticStateVersion: 1, viewStateVersion: 1, stateVersion: 1,
      value: { component: { packageId: "pkg", componentId: "component" }, view: { width: 1, height: 1, zoom: 1, background: "#202226" } },
    }, { mode: "viewer", sourceId: "gate-test", sourceRevision: "gate-test", packageId: "pkg", componentId: "component" }, golden, threshold, false), /Visual baseline changed/)
    await page.evaluate(`(async () => {
      console.error("intentional-console-error"); console.warn("intentional-console-warning");
      setTimeout(() => { throw new Error("intentional-page-error") }, 0);
      const image = new Image(); image.src = "http://evidence.invalid/csp-fault.png";
      await fetch("/http-fault"); await fetch("/network-fault").catch(() => {});
      await new Promise(resolve => setTimeout(resolve, 0));
      await Promise.all(window.__makerEvidenceCspPending);
    })()`)
    for (const [kind, message] of [["pageerror", "intentional-page-error"], ["console.error", "intentional-console-error"], ["console.warning", "intentional-console-warning"], ["http", "503"], ["requestfailed", "ERR_FAILED"], ["csp", "img-src"]]) {
      assert.ok(evidence.diagnostics.some((d) => d.kind === kind && d.message.includes(message)), `Evidence listener missed ${kind}`)
    }
    assert.throws(() => evidence.verify(), /Unexpected browser diagnostics/)
    await evidence.finish("failed", { purpose: "intentional gate self-test", expectedFailure: true }, [page], new Error("intentional gate rejection"))
    const report = JSON.parse(await readFile(path.join(evidence.directory, "report.json"), "utf8"))
    assert.equal(report.status, "failed")
    assert.ok(report.screenshots.length > 0)
    for (const name of ["reference.png", "actual.png", "diff.png", "report.json", "threshold.json"]) {
      assert.ok((await readFile(path.join(evidence.directory, "intentional-pixel-failure", name))).length > 0)
    }
    return { pixelRejected: true, allDiagnosticListeners: true, failureFilesRetained: true }
  } finally { await context.close() }
}
