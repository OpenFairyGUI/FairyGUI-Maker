import { execFileSync, spawn } from "node:child_process"
import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

import { connectMcp } from "./host"
import { finalSchema, type EvalTask, type FinalAnswer } from "./tasks"

export type RunnerName = "reference" | "codex" | "claude"
export type RunnerContext = { task: EvalTask; projectDir: string; agentCwd: string; caseDir: string; mcpOrigin: string; token: string; timeoutSeconds: number; model?: string; executable?: string }
export type RunnerResult = { ok: boolean; isolated: boolean; timedOut: boolean; final: FinalAnswer | null; version: string | null; notes: string[] }

const INSTRUCTIONS = "You are a FairyGUI Maker user's agent. Complete the user task using only the FairyGUI Maker MCP tools. Repository source, shell, file access, the internet, personal skills and other applications are not available. Ground every reported fact in tool results, follow the user's limits exactly, and when the product refuses an action, stop and report it honestly instead of working around it."
const MCP_NAME = "maker"

export async function runAgent(runner: RunnerName, context: RunnerContext): Promise<RunnerResult> {
  if (runner === "reference") return reference(context)
  return runner === "codex" ? codex(context) : claude(context)
}

async function reference(context: RunnerContext): Promise<RunnerResult> {
  const mcp = await connectMcp(context.mcpOrigin, context.token, "maker-eval-reference")
  try {
    const final = await context.task.reference(mcp.call, context.projectDir)
    writeFileSync(path.join(context.caseDir, "final.json"), `${JSON.stringify(final, null, 2)}\n`)
    return { ok: true, isolated: true, timedOut: false, final, version: null, notes: ["Deterministic harness self-check; not a model observation."] }
  } finally { await mcp.close() }
}

async function codex(context: RunnerContext): Promise<RunnerResult> {
  const schemaFile = path.join(context.caseDir, "answer-schema.json")
  const instructionsFile = path.join(context.caseDir, "instructions.txt")
  const finalFile = path.join(context.caseDir, "final.json")
  writeFileSync(schemaFile, JSON.stringify(finalSchema(context.task), null, 2))
  writeFileSync(instructionsFile, `${INSTRUCTIONS}\n`)
  const args = ["exec", "--ignore-user-config", "--ignore-rules", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only", "--json", "-C", context.agentCwd, "--output-schema", schemaFile, "-o", finalFile]
  if (context.model) args.push("--model", context.model)
  // Same isolation as the OpenFairyGUI evaluation host: no shell, browser, plugins, memories or other agents.
  for (const feature of ["shell_tool", "unified_exec", "shell_snapshot", "plugins", "apps", "memories", "multi_agent", "multi_agent_v2", "browser_use", "browser_use_external", "browser_use_full_cdp_access", "computer_use", "in_app_browser", "image_generation", "hooks", "skill_search", "skill_mcp_dependency_install", "workspace_dependencies", "goals", "sleep_tool"]) args.push("--disable", feature)
  args.push("--enable", "skip_host_skill_discovery")
  for (const config of [
    'approval_policy="never"', 'web_search="disabled"', "project_doc_max_bytes=0", 'history.persistence="none"', "suppress_unstable_features_warning=true",
    `model_instructions_file=${JSON.stringify(instructionsFile)}`,
    // The token reaches Codex only through the environment, never through arguments or files.
    `mcp_servers.${MCP_NAME}={url=${JSON.stringify(`${context.mcpOrigin}/mcp`)},bearer_token_env_var="MAKER_EVAL_TOKEN",required=true,default_tools_approval_mode="approve",tool_timeout_sec=180}`,
  ]) args.push("-c", config)
  args.push("-")
  const executable = context.executable ?? "codex"
  const outcome = await spawnAgent(executable, args, context, { MAKER_EVAL_TOKEN: context.token })
  const events = jsonLines(outcome.stdout)
  // Fail closed if any item is not a Maker MCP call, model text or planning.
  const allowed = new Set(["agent_message", "reasoning", "mcp_tool_call", "plan_update", "error", "todo_list"])
  const isolated = events.every(({ item }) => !item || (allowed.has(item.type) && (item.type !== "mcp_tool_call" || item.server === MCP_NAME || (item.server === "codex" && /^list_mcp_resource/.test(item.tool)))))
  const final = readFinal(finalFile)
  return { ok: outcome.code === 0 && !outcome.timedOut && !events.some((event) => ["turn.failed", "error"].includes(event.type)), isolated, timedOut: outcome.timedOut, final, version: cliVersion(executable), notes: [] }
}

async function claude(context: RunnerContext): Promise<RunnerResult> {
  const configFile = path.join(context.caseDir, "mcp-config.json")
  // Claude Code expands ${VAR} in MCP headers, so the token stays out of the retained evidence.
  writeFileSync(configFile, JSON.stringify({ mcpServers: { [MCP_NAME]: { type: "http", url: `${context.mcpOrigin}/mcp`, headers: { Authorization: "Bearer ${MAKER_EVAL_TOKEN}" } } } }, null, 2))
  const args = [
    "-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    "--strict-mcp-config", "--mcp-config", configFile, "--allowedTools", `mcp__${MCP_NAME}`,
    "--tools", "", "--setting-sources", "", "--disable-slash-commands",
    "--append-system-prompt", INSTRUCTIONS, "--json-schema", JSON.stringify(finalSchema(context.task)),
  ]
  if (context.model) args.push("--model", context.model)
  const executable = context.executable ?? "claude"
  const outcome = await spawnAgent(executable, args, context, { MAKER_EVAL_TOKEN: context.token })
  const events = jsonLines(outcome.stdout)
  const toolUses = events.flatMap((event) => event.type === "assistant" ? (event.message?.content ?? []).filter((block: any) => block.type === "tool_use") : [])
  // StructuredOutput carries the --json-schema answer and ToolSearch only loads deferred Maker schemas; every other
  // offered or used tool would be a non-Maker capability.
  const permitted = (name: string) => name.startsWith(`mcp__${MCP_NAME}__`) || name === "StructuredOutput" || name === "ToolSearch"
  const offered = events.find((event) => event.type === "system" && event.subtype === "init")?.tools as string[] | undefined
  const isolated = Boolean(offered) && offered!.every(permitted) && toolUses.every((block: any) => permitted(String(block.name)))
  const result = [...events].reverse().find((event) => event.type === "result")
  const final = (result?.structured_output as FinalAnswer | undefined) ?? parseFinal(result?.result)
  if (final) writeFileSync(path.join(context.caseDir, "final.json"), `${JSON.stringify(final, null, 2)}\n`)
  return { ok: outcome.code === 0 && !outcome.timedOut && result?.subtype === "success" && !result?.is_error, isolated, timedOut: outcome.timedOut, final, version: cliVersion(executable), notes: [] }
}

function spawnAgent(executable: string, args: string[], context: RunnerContext, env: Record<string, string>) {
  writeFileSync(path.join(context.caseDir, "runner.json"), JSON.stringify({ executable, args, modelRequested: context.model ?? null }, null, 2))
  return new Promise<{ code: number | null; timedOut: boolean; stdout: string }>((resolve, reject) => {
    const child = spawn(executable, args, { cwd: context.agentCwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
    let stdout = ""
    let timedOut = false
    child.stdout.on("data", (chunk) => { stdout += chunk; appendFileSync(path.join(context.caseDir, "agent.jsonl"), chunk) })
    child.stderr.on("data", (chunk) => appendFileSync(path.join(context.caseDir, "agent.stderr.txt"), chunk))
    child.stdin.on("error", () => undefined)
    const timer = setTimeout(() => { timedOut = true; child.kill() }, context.timeoutSeconds * 1000)
    child.once("error", (error) => { clearTimeout(timer); reject(error) })
    child.once("exit", (code) => { clearTimeout(timer); resolve({ code, timedOut, stdout }) })
    child.stdin.end(context.task.prompt(context.projectDir))
  })
}

function jsonLines(text: string): any[] {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)] } catch { return [] } })
}

function readFinal(file: string) {
  try { return parseFinal(readFileSync(file, "utf8")) } catch { return null }
}

function parseFinal(text: unknown): FinalAnswer | null {
  if (typeof text !== "string") return null
  try {
    const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ""))
    return value && typeof value === "object" ? value as FinalAnswer : null
  } catch { return null }
}

function cliVersion(executable: string) {
  try { return execFileSync(executable, ["--version"], { encoding: "utf8", timeout: 15_000, windowsHide: true }).trim() } catch { return null }
}
