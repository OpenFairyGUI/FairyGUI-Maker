// Real-task Agent evaluation of Maker's main path. See docs/agent-evals.md.
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseArgs } from "node:util"

import { FIXTURE, readFixtureNodes, snapshotFiles, writeFixtureProject } from "./evals/fixture"
import { connectMcp, installMaker, ROOT, startHost, startMcpRecorder, toolCalls } from "./evals/host"
import { runAgent, type RunnerName } from "./evals/runners"
import { observedTexts, seedBaseline, TASKS, type Check, type EvalTask, type Evidence, type FinalAnswer } from "./evals/tasks"

const { values } = parseArgs({
  options: Object.fromEntries(["runner", "case", "model", "codex", "claude", "headless-browser", "timeout-seconds", "evidence"].map((name) => [name, { type: "string" as const }])),
})
const runner = values.runner as RunnerName
if (!["reference", "codex", "claude"].includes(runner)) throw new Error("Choose --runner reference (harness self-check), codex or claude (real models).")
const tasks = TASKS.filter((task) => !values.case || task.id === values.case)
if (!tasks.length) throw new Error(`Unknown --case; choose one of: ${TASKS.map(({ id }) => id).join(", ")}`)
const timeoutSeconds = Number(values["timeout-seconds"] ?? 600)
if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) throw new Error("--timeout-seconds must be an integer in 1..3600")
if (runner === "reference" && (values.model || values.codex || values.claude)) throw new Error("--model, --codex and --claude apply only to real model runners")

const evidenceRoot = values.evidence ? path.resolve(values.evidence) : await mkdtemp(path.join(tmpdir(), "fairygui-maker-evals-"))
await mkdir(evidenceRoot, { recursive: true })
console.log(`[agent-eval] Evidence: ${evidenceRoot}`)
console.log("[agent-eval] Packing and installing the candidate")
const installed = await installMaker(evidenceRoot)
const results = []
for (const task of tasks) results.push(await runTask(task))

const passed = results.filter((result) => result.passed).length
const report = {
  schemaVersion: 1,
  runner,
  modelRequested: values.model ?? null,
  cliVersion: results.find((result) => result.cliVersion)?.cliVersion ?? null,
  provenance: { commit: git(["rev-parse", "HEAD"]), dirty: git(["status", "--porcelain"]) !== "", node: process.version, platform: process.platform, arch: process.arch, tarball: installed.tarball, tarballSha256: installed.tarballSha256, headlessBrowser: values["headless-browser"] ?? "chrome, then msedge" },
  summary: { passed, total: results.length, modelSuccessRate: runner === "reference" ? null : passed / results.length },
  tasks: results,
}
await writeFile(path.join(evidenceRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`)
for (const result of results) console.log(`${result.passed ? "PASS" : "FAIL"}  ${result.id}  (${Math.round(result.durationMs / 1000)}s, ${result.toolCalls} tool calls)${result.passed ? "" : `  ${result.failedChecks.join("; ")}`}`)
console.log(`[agent-eval] ${passed}/${results.length} passed. Report: ${path.join(evidenceRoot, "report.json")}`)
// The reference runner gates the harness and judges; model runs are observations and never fail the command.
if (runner === "reference" && passed !== results.length) process.exitCode = 1

async function runTask(task: EvalTask) {
  const caseDir = path.join(evidenceRoot, "cases", task.id)
  const workspace = path.join(caseDir, "workspace")
  const projectDir = path.join(workspace, "project")
  const agentCwd = path.join(caseDir, "agent")
  await mkdir(agentCwd, { recursive: true })
  await writeFixtureProject(projectDir)
  await writeFile(path.join(caseDir, "prompt.txt"), `${task.prompt(projectDir)}\n`)
  const host = await startHost({ installedRoot: installed.installedRoot, cwd: workspace, dataDir: path.join(caseDir, "data"), allowSave: projectDir, browser: values["headless-browser"], logFile: path.join(caseDir, "host.log") })
  const recorder = await startMcpRecorder(host.origin, path.join(caseDir, "mcp.jsonl"))
  const harness = await connectMcp(host.origin, host.token, "maker-eval-harness")
  const started = Date.now()
  let checks: Check[] = []
  let runnerResult: Awaited<ReturnType<typeof runAgent>> | null = null
  let error: string | null = null
  try {
    if (task.seedBaseline) await seedBaseline(harness.call, projectDir)
    const before = await snapshotFiles(projectDir)
    console.log(`[agent-eval] ${task.id}: running ${runner}`)
    runnerResult = await runAgent(runner, { task, projectDir, agentCwd, caseDir, mcpOrigin: recorder.origin, token: host.token, timeoutSeconds, model: values.model, executable: runner === "codex" ? values.codex : runner === "claude" ? values.claude : undefined })
    const evidence = await collectEvidence(task, projectDir, runnerResult.final, before, recorder.trace, harness.call, host)
    await writeFile(path.join(caseDir, "evidence.json"), `${JSON.stringify({ ...evidence, calls: evidence.calls.map(({ name, ok, arguments: args }) => ({ name, ok, arguments: args })) }, null, 2)}\n`)
    checks = [
      { name: "runner finished without timing out", ok: runnerResult.ok && !runnerResult.timedOut },
      { name: "the Agent used only Maker MCP tools", ok: runnerResult.isolated },
      { name: "a final answer with every required fact was returned", ok: validFinal(task, runnerResult.final) },
      ...task.judge(evidence),
    ]
  } catch (caught) {
    error = caught instanceof Error ? caught.stack ?? caught.message : String(caught)
    checks.push({ name: "harness completed the case", ok: false, detail: error })
  } finally {
    await harness.close().catch(() => undefined)
    await recorder.stop()
    await host.stop()
  }
  const calls = toolCalls(recorder.trace)
  const result = {
    id: task.id,
    goal: task.goal,
    passed: checks.length > 0 && checks.every((check) => check.ok),
    failedChecks: checks.filter((check) => !check.ok).map((check) => check.name),
    checks,
    durationMs: Date.now() - started,
    toolCalls: calls.length,
    failedToolCalls: calls.filter((call) => !call.ok).length,
    tools: [...new Set(calls.map((call) => call.name))],
    cliVersion: runnerResult?.version ?? null,
    error,
  }
  await writeFile(path.join(caseDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

async function collectEvidence(task: EvalTask, projectDir: string, final: FinalAnswer | null, before: Record<string, string>, trace: Parameters<typeof toolCalls>[0], call: Awaited<ReturnType<typeof connectMcp>>["call"], host: { origin: string; token: string }): Promise<Evidence> {
  const headers = { Authorization: `Bearer ${host.token}` }
  const artifacts = (await (await fetch(`${host.origin}/api/artifacts?limit=100`, { headers })).json()).artifacts
  const approvals = (await (await fetch(`${host.origin}/api/save-approvals`, { headers })).json()).approvals
  const baselines = (await call("list_visual_baselines", {})).value.baselines
  let playerTexts: string[] | null = null
  if (task.verifyPlayer) {
    const published = artifacts.filter((artifact: any) => artifact.source.kind === "host-publish")
    const target = published.find((artifact: any) => artifact.artifactId === final?.facts.artifactId) ?? published[0]
    if (target) {
      // The judge looks for itself instead of trusting the Agent's report.
      const player = await call("open_artifact_player", { artifactId: target.artifactId })
      if (player.value?.browserRequired === false) {
        const rendered = await call("render_artifact_component", { artifactId: target.artifactId, packageId: FIXTURE.packageId, componentId: FIXTURE.componentId, requestId: randomUUID(), capture: false })
        playerTexts = observedTexts(rendered.value?.value?.rendered?.objectTree)
      }
    }
  }
  return {
    final,
    calls: toolCalls(trace),
    before,
    after: await snapshotFiles(projectDir),
    nodes: await readFixtureNodes(projectDir),
    artifacts,
    baselines,
    approvals,
    playerTexts,
  }
}

function validFinal(task: EvalTask, final: FinalAnswer | null) {
  return Boolean(final) && ["completed", "blocked"].includes(final!.outcome) && typeof final!.summary === "string"
    && (final!.blocker === null || typeof final!.blocker === "string") && Object.keys(task.facts).every((name) => name in (final!.facts ?? {}))
}

function git(args: string[]) {
  try { return execFileSync("git", ["-c", `safe.directory=${ROOT.replaceAll("\\", "/")}`, ...args], { cwd: ROOT, encoding: "utf8" }).trim() } catch { return null }
}
