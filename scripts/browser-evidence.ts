import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { BrowserContext, Page } from "playwright"
import { z } from "zod"
import { comparePixelData } from "../src/web/lib/visual-evidence"
import type { RenderCommandResult } from "../src/viewer-protocol"

export type BrowserDiagnostic = { phase: string; kind: string; message: string; url: string; status?: number; method?: string; resourceType?: string; navigation?: boolean; frameUrl?: string }

// Exceptions describe the deliberate fault, not an entire page/phase. Everything is still saved.
export function expectedDiagnostic(d: BrowserDiagnostic): string | undefined {
  const url = d.url
  if (d.kind === "requestfailed" && d.method === "GET" && d.message === "net::ERR_ABORTED") {
    if (/\/api\/render-sessions\/[^/]+(?:\/commands)?$/.test(url)) return "cancelled session read/poll"
    if (/\/assets\/image-probe.worker-[\w-]+\.js$/.test(url)) return "cancelled runtime bootstrap"
    if (d.phase === "runtime-navigation" && /\/api\/artifacts\/[^/]+\/files\/active\.(svg|html|js)$/.test(url)) return "active content downloaded instead of navigated"
  }
  if (d.kind === "requestfailed" && d.method === "DELETE" && d.message === "net::ERR_ABORTED"
    && /\/api\/render-sessions\/[^/]+$/.test(url)) return "best-effort renderer teardown (Host timeout/TTL remains authoritative)"
  if (/^(delivery-|lifecycle-|project-revision$)/.test(d.phase)
    && (d.kind === "http" && d.status === 404 || d.kind === "console.error" && /404/.test(d.message))
    && /\/api\/render-sessions\/[^/]+\/commands$/.test(url)) return "closed or invalidated session poll"
  if (d.phase.startsWith("broker-state-") && /\/commands$/.test(url)
    && (d.kind === "http" && d.status === 409 || d.kind === "console.error" && /409/.test(d.message))) return "injected view CAS conflict"
  if (d.phase.startsWith("delivery-") && /\/api\/render-sessions\/[^/]+\/(results|interactions)$/.test(url)
    && (d.kind === "requestfailed" && d.message === "net::ERR_FAILED"
      || d.kind === "http" && d.status === 503 || d.kind === "console.error" && /ERR_FAILED|503/.test(d.message))) return "injected delivery/ACK loss"
  if (d.phase === "save-grants" && /\/api\/save-approvals\/[^/]+\/decision$/.test(url)
    && (d.kind === "http" && d.status === 403 || d.kind === "console.error" && /403/.test(d.message))) return "ordinary token cannot approve saves"
  const probeTarget = /http:\/\/127\.0\.0\.1:\d+\/(?:mcp|api\/(?:status|projects(?:\/[^/]+\/source-index)?|save-approvals(?:\/forged\/decision)?|artifacts\/[^/]+\/files\/Smoke\.fui))(?:[.'"\s]|$)/
  if (d.phase.startsWith("isolation-") && (d.kind === "console.error" || d.kind === "csp")
    && (/Unsafe attempt to initiate navigation|Blocked opening/.test(d.message)
      || probeTarget.test(d.message) && /connect-src|Refused to connect because it violates the document's Content Security Policy/.test(d.message))) return "intentional iframe escape probe"
  if (d.phase === "runtime-budgets" && d.kind === "console.error"
    && /^Fetch API cannot load blob:null\/[\da-f-]+\. URL scheme "blob" is not supported\.$/.test(d.message)) return "revoked Blob URL cannot be fetched"
  return undefined
}

export function redactEvidence(value: string, secrets: string[]) {
  const forms = secrets.filter(Boolean).flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)])
  for (const secret of forms.sort((a, b) => b.length - a.length)) value = value.replaceAll(secret, "[redacted]")
  return value.replace(/([?&#](?:token|approvalToken|nonce)=)[^\s&#'"<>]+/gi, "$1[redacted]")
}

export function assertDiagnostics(diagnostics: BrowserDiagnostic[]) {
  const unexpected = diagnostics.filter((d) => !expectedDiagnostic(d))
  assert.equal(unexpected.length, 0, `Unexpected browser diagnostics (${unexpected.length}; first five): ${JSON.stringify(unexpected.slice(0, 5))}`)
}

export async function createBrowserEvidence(secrets: string[]) {
  const root = path.resolve("test-results/browser")
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(path.join(root, "run-"))
  const diagnostics: BrowserDiagnostic[] = []
  const checks: Record<string, { status: "passed" | "failed"; result?: unknown }> = {}
  const phases = [{ name: "setup", at: 0 }]
  const phase = (name: string) => { phases.push({ name, at: Date.now() }) }
  let overflow = false
  const clean = (value: string) => redactEvidence(value, secrets).slice(0, 4_000)
  const record = (d: Omit<BrowserDiagnostic, "phase">, at = Date.now()) => {
    if (diagnostics.length >= 2_000) { overflow = true; return }
    // No query strings, cookies, authorization, request bodies, DOM dumps or storage exports.
    diagnostics.push({ ...d, phase: phases.findLast((phase) => phase.at <= at)!.name, message: clean(d.message), url: clean(d.url.split(/[?#]/)[0]) })
  }
  return {
    directory,
    diagnostics,
    phase,
    async attach(context: BrowserContext) {
      await context.exposeBinding("__makerEvidenceCsp", ({ frame }, value: { directive: string; blocked: string; at: number }) => {
        record({ kind: "csp", url: frame.url(), message: `${value.directive}: ${value.blocked}` }, value.at)
      })
      await context.addInitScript(`window.__makerEvidenceCspPending = []; document.addEventListener("securitypolicyviolation", event => {
        window.__makerEvidenceCspPending.push(window.__makerEvidenceCsp({ directive: event.effectiveDirective, blocked: event.blockedURI, at: performance.timeOrigin + event.timeStamp }));
      });`)
      context.on("page", (page) => {
        page.on("pageerror", (error) => record({ kind: "pageerror", url: page.url(), message: error.message }))
        page.on("console", (message) => {
          // Chromium may replay buffered messages after a route/debugger change.
          if (["error", "warning"].includes(message.type())) record({ kind: `console.${message.type()}`, url: message.location().url || page.url(), message: message.text() }, message.timestamp())
        })
      })
      context.on("requestfailed", (request) => record({ kind: "requestfailed", method: request.method(), url: request.url(), message: request.failure()?.errorText ?? "unknown failure",
        resourceType: request.resourceType(), navigation: request.isNavigationRequest(), frameUrl: clean(request.frame().url().split(/[?#]/)[0]) }))
      context.on("response", (response) => {
        if (response.status() >= 400) record({ kind: "http", url: response.url(), status: response.status(), message: `${response.request().method()} ${response.status()}` })
      })
    },
    async step<T>(name: string, run: () => Promise<T>): Promise<T> {
      phase(name)
      try {
        const result = await run()
        checks[name] = { status: "passed", result }
        process.stdout.write(`Browser check passed: ${name}\n`)
        return result
      } catch (error) { checks[name] = { status: "failed" }; throw error }
    },
    verify() {
      assert.equal(overflow, false, "Browser diagnostics exceeded the evidence budget")
      assertDiagnostics(diagnostics)
    },
    async finish(status: "passed" | "failed", metadata: Record<string, unknown>, pages: Page[], error?: unknown) {
      const screenshots: string[] = []
      if (status === "failed") for (const [index, page] of pages.entries()) {
        if (page.isClosed()) continue
        const name = `failure-page-${index + 1}.png`
        try {
          await page.screenshot({ path: path.join(directory, name), mask: [page.locator('input[type="password"]')], timeout: 5_000 })
          screenshots.push(name)
        } catch { /* A closed/crashed page can have no screenshot; diagnostics and the failure still persist. */ }
      }
      const report = { schemaVersion: 1, status, ...metadata, checks, screenshots, overflow,
        error: error ? clean(error instanceof Error ? error.message : String(error)) : undefined,
        diagnostics: diagnostics.map((d) => ({ ...d, expected: expectedDiagnostic(d) ?? null })) }
      await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n")
      process.stdout.write(`Browser evidence: ${directory}\n`)
    },
  }
}

const baselineSchema = z.object({
  schemaVersion: z.literal(1), fixture: z.string().min(1),
  width: z.number().int().positive().max(2048), height: z.number().int().positive().max(2048),
  maxDifferentPixels: z.number().int().nonnegative(), maxMeanAbsoluteError: z.number().finite().nonnegative().max(255),
}).strict()

export function goldenUpdateEnabled(env: NodeJS.ProcessEnv = process.env) {
  const update = env.UPDATE_VISUAL_GOLDENS === "1"
  if (update && env.CI && env.CI !== "false") throw new Error("CI must not update visual goldens")
  return update
}

export function assertVisualBaseline(metrics: ReturnType<typeof comparePixelData>["metrics"], baseline: z.infer<typeof baselineSchema>, reference: { width: number; height: number }, capture: { width: number; height: number }) {
  assert.deepEqual(reference, { width: baseline.width, height: baseline.height }, "Golden dimensions changed")
  assert.deepEqual(capture, reference, "Capture dimensions changed")
  assert.ok(metrics.differentPixels <= baseline.maxDifferentPixels && metrics.meanAbsoluteError <= baseline.maxMeanAbsoluteError,
    `Visual baseline changed: ${JSON.stringify(metrics)}`)
}

/** Decode/encode with Chromium; compare with the same pure pixel algorithm as Workbench. */
export async function saveVisualGolden(page: Page, directory: string, name: string, actual: Buffer, result: RenderCommandResult, identity: { mode: "viewer" | "player"; sourceId: string; sourceRevision: string; packageId: string; componentId: string }, golden: string, thresholdFile: string, update = goldenUpdateEnabled()) {
  assert.match(name, /^[a-z0-9-]+$/)
  const target = path.join(directory, name)
  await mkdir(target)
  await writeFile(path.join(target, "actual.png"), actual)
  const baseline = baselineSchema.parse(JSON.parse(await readFile(thresholdFile, "utf8")))
  await writeFile(path.join(target, "threshold.json"), JSON.stringify(baseline, null, 2) + "\n")
  assert.equal(actual.readUInt32BE(16), baseline.width)
  assert.equal(actual.readUInt32BE(20), baseline.height)
  const captured = z.object({ component: z.object({ packageId: z.string(), componentId: z.string() }),
    view: z.object({ width: z.number(), height: z.number(), zoom: z.number(), background: z.string() }) }).parse(result.value)
  assert.equal(captured.component.packageId, identity.packageId)
  assert.equal(captured.component.componentId, identity.componentId)
  assert.equal(captured.view.width, baseline.width)
  assert.equal(captured.view.height, baseline.height)
  assert.equal(result.sourceRevision, identity.sourceRevision)
  assert.match(result.renderSessionId, /^render_[\da-f-]{36}$/)
  assert.ok(Number.isSafeInteger(result.semanticStateVersion) && result.semanticStateVersion >= 0)
  assert.ok(Number.isSafeInteger(result.viewStateVersion) && result.viewStateVersion >= 0)
  let reference: Buffer
  let baselineMissing = false
  try { reference = await readFile(golden) } catch (error) {
    if (!update || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    baselineMissing = true
    reference = actual
  }
  await writeFile(path.join(target, "reference.png"), reference)
  const decode = async (png: Buffer) => {
    const pixels = await page.evaluate(async (base64) => {
      const image = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: "image/png" }))
      try {
        if (image.width > 2048 || image.height > 2048) throw new Error("Golden exceeds test pixel budget")
        const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height
        const ctx = canvas.getContext("2d", { willReadFrequently: true })!
        ctx.drawImage(image, 0, 0)
        return { width: image.width, height: image.height, data: Array.from(ctx.getImageData(0, 0, image.width, image.height).data) }
      } finally { image.close() }
    }, png.toString("base64"))
    return { ...pixels, data: new Uint8ClampedArray(pixels.data) }
  }
  const [left, right] = await Promise.all([decode(reference), decode(actual)])
  const { diff, metrics } = comparePixelData(left, right)
  const diffBase64 = await page.evaluate(({ width, height, data }) => {
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height
    canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0)
    return canvas.toDataURL("image/png").split(",")[1]
  }, { width: metrics.width, height: metrics.height, data: Array.from(diff) })
  await writeFile(path.join(target, "diff.png"), Buffer.from(diffBase64, "base64"))
  const size = ({ width, height }: { width: number; height: number }) => ({ width, height })
  let mismatch: unknown
  try { assertVisualBaseline(metrics, baseline, size(left), size(right)) } catch (error) { mismatch = error }
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")
  await writeFile(path.join(target, "report.json"), JSON.stringify({ schemaVersion: 1, status: baselineMissing ? "candidate" : mismatch ? "failed" : "passed", baselineMissing, ...identity,
    sourceRevision: result.sourceRevision, renderSessionId: result.renderSessionId, semanticStateVersion: result.semanticStateVersion, viewStateVersion: result.viewStateVersion,
    view: result.value.view, observation: result.value.observation, referenceSha256: sha256(reference), actualSha256: sha256(actual), metrics,
  }, null, 2) + "\n")
  if (mismatch && !update) throw mismatch
  return { metrics, golden, actual }
}
