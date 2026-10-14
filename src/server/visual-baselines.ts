import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import sharp from "sharp"
import { z } from "zod"

import { PLAYER_RUNTIME_PROFILE } from "../artifact-protocol"
import { comparePixelData, type VisualMetrics } from "../visual-diff"
import type { ViewerRenderBroker } from "./viewer"

const NAME_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const MAX_KEY_SEGMENTS = 4
const MAX_PNG_BYTES = 32 * 1024 * 1024
const MAX_SIDE = 8_192
const MAX_PIXELS = 32_000_000
const HISTORY_LIMIT = 5

const suiteSchema = z.string().regex(NAME_SEGMENT, "suite: letters, digits, dot, dash or underscore; must start with a letter or digit")
const keySchema = z.string().max(260).refine((value) => {
  const segments = value.split("/")
  return segments.length <= MAX_KEY_SEGMENTS && segments.every((segment) => NAME_SEGMENT.test(segment))
}, `key: up to ${MAX_KEY_SEGMENTS} "/"-separated segments of letters, digits, dot, dash or underscore`)
const captureInput = {
  renderSessionId: z.string().min(1),
  requestId: z.string().uuid(),
  afterStateVersion: z.number().int().nonnegative(),
  afterViewStateVersion: z.number().int().nonnegative().default(0),
  suite: suiteSchema,
  key: keySchema,
}

export type VisualEnvironment = {
  runtimeProfile: string
  mode: "viewer" | "player"
  userAgent: string | null
  view: { zoom: number; background: string; width: number; height: number }
  image: { width: number; height: number }
}

export type VisualBaseline = {
  schemaVersion: 1
  suite: string
  key: string
  revision: number
  createdAt: string
  reason: string | null
  sha256: string
  environment: VisualEnvironment
  source: Record<string, unknown>
}

type ComparisonReport = {
  comparedAt: string
  baselineRevision: number
  identical: boolean
  withinTolerance: boolean
  metrics: VisualMetrics
  environmentDifferences: string[]
}

// Agent-managed reference captures under <data-dir>/visual-baselines/<suite>/<key>, kept across Host restarts.
export class VisualBaselineStore {
  private readonly root: string
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(dataDir: string) {
    this.root = path.join(dataDir, "visual-baselines")
  }

  async init() {
    await mkdir(this.root, { recursive: true })
  }

  async get(suite: string, key: string) {
    return readJson<VisualBaseline>(path.join(this.directory(suite, key), "baseline.json"))
  }

  async readImage(suite: string, key: string) {
    return readFile(path.join(this.directory(suite, key), "baseline.png"))
  }

  async list(suite?: string) {
    const baselines: Array<VisualBaseline & { lastComparison: ComparisonReport | null }> = []
    const walk = async (directory: string, depth: number): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      if (entries.some((entry) => entry.isFile() && entry.name === "baseline.json")) {
        const baseline = await readJson<VisualBaseline>(path.join(directory, "baseline.json"))
        if (baseline) baselines.push({ ...baseline, lastComparison: await readJson<ComparisonReport>(path.join(directory, "last-comparison.json")) })
      }
      if (depth >= MAX_KEY_SEGMENTS + 1) return
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name !== "history" && NAME_SEGMENT.test(entry.name)) await walk(path.join(directory, entry.name), depth + 1)
      }
    }
    await walk(suite ? this.directory(suite) : this.root, suite ? 1 : 0)
    return baselines.sort((left, right) => left.suite.localeCompare(right.suite) || left.key.localeCompare(right.key))
  }

  async save(input: { suite: string; key: string; png: Buffer; environment: VisualEnvironment; source: Record<string, unknown>; replace: boolean; reason: string | null }) {
    return this.withLock(input.suite, input.key, async () => {
      const directory = this.directory(input.suite, input.key)
      const current = await this.get(input.suite, input.key)
      if (current && !input.replace) return { ok: false as const, code: "visual_baseline_exists", baseline: current }
      await mkdir(directory, { recursive: true })
      if (current) {
        // Keep superseded baselines for review; the newest HISTORY_LIMIT survive.
        const history = path.join(directory, "history")
        await mkdir(history, { recursive: true })
        await atomicWrite(path.join(history, `${current.revision}.png`), await readFile(path.join(directory, "baseline.png")))
        await atomicWrite(path.join(history, `${current.revision}.json`), JSON.stringify(current, null, 2))
        const revisions = (await readdir(history)).filter((name) => name.endsWith(".json")).map((name) => Number.parseInt(name, 10)).filter(Number.isSafeInteger).sort((a, b) => b - a)
        for (const old of revisions.slice(HISTORY_LIMIT)) {
          await rm(path.join(history, `${old}.png`), { force: true })
          await rm(path.join(history, `${old}.json`), { force: true })
        }
      }
      const baseline: VisualBaseline = {
        schemaVersion: 1,
        suite: input.suite,
        key: input.key,
        revision: (current?.revision ?? 0) + 1,
        createdAt: new Date().toISOString(),
        reason: input.reason,
        sha256: createHash("sha256").update(input.png).digest("hex"),
        environment: input.environment,
        source: input.source,
      }
      // The image lands first; baseline.json makes the new revision visible.
      await atomicWrite(path.join(directory, "baseline.png"), input.png)
      await atomicWrite(path.join(directory, "baseline.json"), JSON.stringify(baseline, null, 2))
      await rm(path.join(directory, "last-comparison.json"), { force: true })
      await rm(path.join(directory, "last-diff.png"), { force: true })
      return { ok: true as const, baseline, replaced: current?.revision ?? null }
    })
  }

  async recordComparison(suite: string, key: string, report: ComparisonReport, diff: Buffer | null) {
    return this.withLock(suite, key, async () => {
      const directory = this.directory(suite, key)
      if (diff) await atomicWrite(path.join(directory, "last-diff.png"), diff)
      else await rm(path.join(directory, "last-diff.png"), { force: true })
      await atomicWrite(path.join(directory, "last-comparison.json"), JSON.stringify(report, null, 2))
    })
  }

  private directory(suite: string, key?: string) {
    suiteSchema.parse(suite)
    if (key !== undefined) keySchema.parse(key)
    return path.join(this.root, suite, ...(key ? key.split("/") : []))
  }

  private async withLock<T>(suite: string, key: string, run: () => Promise<T>): Promise<T> {
    const id = `${suite}/${key}`
    const previous = this.locks.get(id) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(run)
    this.locks.set(id, next)
    try {
      return await next
    } finally {
      if (this.locks.get(id) === next) this.locks.delete(id)
    }
  }
}

export function registerVisualBaselineTools(server: McpServer, broker: ViewerRenderBroker, store: VisualBaselineStore) {
  const capture = async (input: { renderSessionId: string; requestId: string; afterStateVersion: number; afterViewStateVersion: number }) => {
    const pending = broker.executeReadForSession(input.renderSessionId, input.afterStateVersion, "capture", input.requestId, input.afterViewStateVersion)
    if (!pending) {
      const target = broker.getBrowserTarget(input.renderSessionId)
      return { ok: false as const, value: target ? { ok: false, code: "browser_required", renderSessionId: input.renderSessionId, ...target } : { ok: false, code: "render_session_not_found", renderSessionId: input.renderSessionId } }
    }
    const result = await pending
    const base64 = typeof result.value.screenshotBase64 === "string" ? result.value.screenshotBase64 : ""
    const png = Buffer.from(base64, "base64")
    const pixels = await decodePng(png)
    const environment = broker.rendererEnvironment(input.renderSessionId)
    if (!environment) return { ok: false as const, value: { ok: false, code: "render_session_not_found", renderSessionId: input.renderSessionId } }
    const { screenshotBase64: _image, ...captured } = result.value
    return {
      ok: true as const,
      png,
      pixels,
      environment: {
        runtimeProfile: PLAYER_RUNTIME_PROFILE,
        mode: environment.mode,
        userAgent: environment.userAgent,
        view: environment.view,
        image: { width: pixels.width, height: pixels.height },
      } satisfies VisualEnvironment,
      source: {
        renderSessionId: result.renderSessionId,
        ...("projectId" in environment ? { projectId: environment.projectId } : { artifactId: environment.artifactId }),
        sourceRevision: result.sourceRevision,
        semanticStateVersion: result.semanticStateVersion,
        viewStateVersion: result.viewStateVersion,
        ...("component" in captured ? { component: captured.component } : {}),
      },
    }
  }

  server.registerTool("save_visual_baseline", {
    title: "Save a visual baseline from a render session",
    description: "Capture the current Viewer or Player canvas and store it as the reference image for suite/key. An existing baseline is replaced only with replace: true and a reason (accepting a visual change); superseded revisions are kept for review. Records the renderer environment so later comparisons can tell environment changes from regressions.",
    inputSchema: z.object({ ...captureInput, replace: z.boolean().default(false), reason: z.string().trim().min(1).max(500).optional() }),
  }, async ({ replace, reason, suite, key, ...input }) => {
    try {
      if (replace && !reason) return toolResult({ ok: false, code: "visual_baseline_reason_required", message: "Replacing a baseline accepts a visual change; give the reason." }, true)
      const captured = await capture(input)
      if (!captured.ok) return toolResult(captured.value, true)
      const saved = await store.save({ suite, key, png: captured.png, environment: captured.environment, source: captured.source, replace, reason: reason ?? null })
      if (!saved.ok) return toolResult({ ok: false, code: saved.code, message: "A baseline already exists. Compare against it, or pass replace: true with a reason to accept a new one.", baseline: saved.baseline }, true)
      return imageResult({ ok: true, baseline: saved.baseline, replacedRevision: saved.replaced }, [captured.png])
    } catch (error) {
      return toolResult({ ok: false, code: "visual_baseline_failed", message: errorMessage(error) }, true)
    }
  })

  server.registerTool("compare_visual_baseline", {
    title: "Compare a render session with its visual baseline",
    description: "Capture the current Viewer or Player canvas and compare it pixel by pixel with suite/key. Returns metrics, identical, withinTolerance (exact match unless tolerance is given) and the environment fields that differ from the baseline's; the diff PNG is attached when pixels differ. A different browser, zoom, background or viewport can change pixels without a UI regression.",
    inputSchema: z.object({
      ...captureInput,
      tolerance: z.object({
        maxDifferentPixels: z.number().int().nonnegative().optional(),
        maxMeanAbsoluteError: z.number().nonnegative().max(255).optional(),
      }).strict().optional(),
      includeCapture: z.boolean().default(false),
      includeBaseline: z.boolean().default(false),
    }),
    annotations: { readOnlyHint: true },
  }, async ({ suite, key, tolerance, includeCapture, includeBaseline, ...input }) => {
    try {
      const baseline = await store.get(suite, key)
      if (!baseline) return toolResult({ ok: false, code: "visual_baseline_not_found", suite, key, message: "Save a baseline with save_visual_baseline first." }, true)
      const captured = await capture(input)
      if (!captured.ok) return toolResult(captured.value, true)
      const baselinePng = await store.readImage(suite, key)
      const reference = await decodePng(baselinePng)
      const { diff, metrics } = comparePixelData(reference, captured.pixels)
      const sameSize = reference.width === captured.pixels.width && reference.height === captured.pixels.height
      const identical = sameSize && metrics.differentPixels === 0
      const limits = tolerance ?? { maxDifferentPixels: 0 }
      const withinTolerance = sameSize
        && (limits.maxDifferentPixels === undefined || metrics.differentPixels <= limits.maxDifferentPixels)
        && (limits.maxMeanAbsoluteError === undefined || metrics.meanAbsoluteError <= limits.maxMeanAbsoluteError)
      const environmentDifferences = differences(baseline.environment, captured.environment)
      const diffPng = identical ? null : await sharp(Buffer.from(diff.buffer, diff.byteOffset, diff.byteLength), { raw: { width: metrics.width, height: metrics.height, channels: 4 } }).png().toBuffer()
      await store.recordComparison(suite, key, { comparedAt: new Date().toISOString(), baselineRevision: baseline.revision, identical, withinTolerance, metrics, environmentDifferences }, diffPng)
      return imageResult({
        ok: true,
        suite,
        key,
        baselineRevision: baseline.revision,
        identical,
        withinTolerance,
        tolerance: limits,
        metrics,
        dimensions: { baseline: { width: reference.width, height: reference.height }, capture: { width: captured.pixels.width, height: captured.pixels.height } },
        environmentMatch: environmentDifferences.length === 0,
        environmentDifferences,
        capture: captured.source,
        images: [...(diffPng ? ["diff"] : []), ...(includeCapture ? ["capture"] : []), ...(includeBaseline ? ["baseline"] : [])],
      }, [...(diffPng ? [diffPng] : []), ...(includeCapture ? [captured.png] : []), ...(includeBaseline ? [baselinePng] : [])])
    } catch (error) {
      return toolResult({ ok: false, code: "visual_compare_failed", message: errorMessage(error) }, true)
    }
  })

  server.registerTool("list_visual_baselines", {
    title: "List visual baselines",
    description: "List stored visual baselines with their revision, reason, environment, source and last comparison. Images are not included; use compare_visual_baseline with includeBaseline to see one.",
    inputSchema: z.object({ suite: suiteSchema.optional(), limit: z.number().int().min(1).max(500).default(100) }),
    annotations: { readOnlyHint: true },
  }, async ({ suite, limit }) => {
    const baselines = await store.list(suite)
    return toolResult({ ok: true, total: baselines.length, baselines: baselines.slice(0, limit) })
  })
}

async function decodePng(png: Buffer) {
  if (png.byteLength === 0 || png.byteLength > MAX_PNG_BYTES) throw new Error("visual_capture_size_invalid")
  const { data, info } = await sharp(png, { limitInputPixels: MAX_PIXELS }).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (info.width > MAX_SIDE || info.height > MAX_SIDE || info.channels !== 4) throw new Error("visual_capture_dimensions_invalid")
  return { width: info.width, height: info.height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength) }
}

function differences(baseline: VisualEnvironment, current: VisualEnvironment) {
  const fields: Array<[string, unknown, unknown]> = [
    ["runtimeProfile", baseline.runtimeProfile, current.runtimeProfile],
    ["mode", baseline.mode, current.mode],
    ["userAgent", baseline.userAgent, current.userAgent],
    ["view.zoom", baseline.view.zoom, current.view.zoom],
    ["view.background", baseline.view.background, current.view.background],
    ["view.width", baseline.view.width, current.view.width],
    ["view.height", baseline.view.height, current.view.height],
    ["image.width", baseline.image.width, current.image.width],
    ["image.height", baseline.image.height, current.image.height],
  ]
  return fields.filter(([, left, right]) => left !== right).map(([name]) => name)
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

async function atomicWrite(file: string, data: string | Buffer) {
  const temporary = `${file}.${randomUUID()}.tmp`
  await writeFile(temporary, data, { flush: true })
  await rename(temporary, file)
}

function toolResult(value: Record<string, unknown>, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }], structuredContent: value, ...(isError ? { isError: true } : {}) }
}

function imageResult(value: Record<string, unknown>, images: Buffer[]) {
  return {
    content: [
      { type: "text" as const, text: JSON.stringify(value) },
      ...images.map((image) => ({ type: "image" as const, data: image.toString("base64"), mimeType: "image/png" })),
    ],
    structuredContent: value,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
