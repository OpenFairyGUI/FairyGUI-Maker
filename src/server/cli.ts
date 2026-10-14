import { writeFile } from "node:fs/promises"
import { resolve } from "node:path"

import { ImportDraftStore } from "../design-import/draft-store"
import { applyProjectReimport, planProjectReimport } from "../design-import/node"
import { createHostBackendFileSystem } from "./backend-files"
import { HEADLESS_BROWSER_CHANNELS, type HeadlessBrowserChannel } from "./headless-browser"
import { startMakerHost } from "./host"
import { PACKAGE_VERSION, logger } from "./host-config"

export function readCliArguments(argv: string[]) {
  let port: number | undefined
  let dataDir: string | undefined
  let outputPath: string | undefined
  let dryRun = false
  let applyDigest: string | undefined
  let headlessDisabled = false
  let headlessChannel: HeadlessBrowserChannel | undefined
  const allowSave: string[] = []
  const positional: string[] = []
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === "--") continue
    if (argument === "--help" || argument === "-h") return { help: true as const }
    if (argument === "--version" || argument === "-v") return { version: true as const }
    if (argument === "--port") {
      port = Number(argv[++index])
      continue
    }
    if (argument === "--data-dir") {
      dataDir = argv[++index]
      if (!dataDir) throw new Error("--data-dir requires a path")
      continue
    }
    if (argument === "--out") {
      outputPath = argv[++index]
      if (!outputPath) throw new Error("--out requires a path")
      continue
    }
    if (argument === "--dry-run") {
      dryRun = true
      continue
    }
    if (argument === "--apply") {
      if (applyDigest !== undefined) throw new Error("--apply may only be specified once")
      applyDigest = argv[++index]
      if (!applyDigest || !/^[a-f0-9]{64}$/.test(applyDigest)) throw new Error("--apply requires the planDigest from a fresh --dry-run")
      continue
    }
    if (argument === "--no-headless") {
      headlessDisabled = true
      continue
    }
    if (argument === "--headless-browser") {
      const channel = argv[++index]
      if (!HEADLESS_BROWSER_CHANNELS.includes(channel as HeadlessBrowserChannel)) throw new Error(`--headless-browser requires one of: ${HEADLESS_BROWSER_CHANNELS.join(", ")}`)
      headlessChannel = channel as HeadlessBrowserChannel
      continue
    }
    if (argument === "--allow-save") {
      const project = argv[++index]
      if (!project) throw new Error("--allow-save requires a project directory or .fairy path")
      allowSave.push(project)
      continue
    }
    if (argument.startsWith("-")) throw new Error(`Unknown option: ${argument}`)
    positional.push(argument)
  }
  if (headlessDisabled && headlessChannel) throw new Error("--no-headless and --headless-browser cannot be combined")
  if ((positional[0] === "import" || positional[0] === "reimport") && (headlessDisabled || headlessChannel)) {
    throw new Error("--no-headless and --headless-browser apply only when starting the Host")
  }
  if (allowSave.length && positional.length) throw new Error("--allow-save applies only to the full Host; view, import and reimport never use Host saves")
  // The Host renders headlessly by default from the CLI; the startMakerHost API stays opt-in.
  const headless = headlessDisabled ? false : headlessChannel ? { channel: headlessChannel } : true
  if (positional[0] === "import") {
    if (applyDigest !== undefined) throw new Error("--apply requires a reimport command")
    if (port !== undefined) {
      throw new Error("Usage: fairygui-maker import <source.fig|source.psd|bundle-directory> --out <new-directory>")
    }
    if (positional[1] === "inspect") {
      if (positional.length !== 3 || outputPath !== undefined || dryRun) {
        throw new Error("Usage: fairygui-maker import inspect <source.fig|source.psd|bundle-directory> [--data-dir <path>]")
      }
      return { help: false as const, importAction: "inspect" as const, importSource: positional[2]!, ...(dataDir ? { dataDir } : {}) }
    }
    if (positional[1] === "plan") {
      if (positional.length !== 3 || !outputPath || dryRun) {
        throw new Error("Usage: fairygui-maker import plan <source.fig|source.psd|bundle-directory> --out <plan.json> [--data-dir <path>]")
      }
      return { help: false as const, importAction: "plan" as const, importSource: positional[2]!, outputPath, ...(dataDir ? { dataDir } : {}) }
    }
    const importSource = positional[1]
    if (positional.length !== 2 || !importSource || dryRun === (outputPath !== undefined)) {
      throw new Error("Usage: fairygui-maker import <source.fig|source.psd|bundle-directory> (--out <new-directory> | --dry-run) [--data-dir <path>]")
    }
    return {
      help: false as const,
      importSource,
      ...(outputPath ? { outputPath } : {}),
      ...(dataDir ? { dataDir } : {}),
      ...(dryRun ? { dryRun: true as const } : {}),
    }
  }
  if (positional[0] === "reimport") {
    if (positional.length !== 2 || dryRun === (applyDigest !== undefined) || outputPath !== undefined || port !== undefined) {
      throw new Error("Usage: fairygui-maker reimport <project-directory> (--dry-run | --apply <planDigest>) [--data-dir <path>]")
    }
    return { help: false as const, reimportPath: positional[1]!, ...(dryRun ? { dryRun: true as const } : { applyDigest: applyDigest! }), ...(dataDir ? { dataDir } : {}) }
  }
  if (applyDigest !== undefined) throw new Error("--apply requires a reimport command")
  if (outputPath !== undefined || dryRun) throw new Error("--out and --dry-run require an import or reimport command")
  if (positional.length === 0) return { help: false as const, port, dataDir, projectPath: undefined, headless, ...(allowSave.length ? { allowSave } : {}) }
  if (positional[0] !== "view" || positional.length !== 2) throw new Error("Usage: fairygui-maker view <project-path> [--port <port>] [--data-dir <path>]")
  return { help: false as const, port, dataDir, projectPath: positional[1], headless }
}

export async function runCli(argv = process.argv.slice(2)) {
  const options = readCliArguments(argv)
  if ("version" in options) {
    process.stdout.write(`${PACKAGE_VERSION}\n`)
    return null
  }
  if (options.help) {
    process.stdout.write(`Usage:
  fairygui-maker [--allow-save <project>]... [--port <port>] [--data-dir <path>] [--no-headless | --headless-browser <chrome|msedge|chromium>]
  fairygui-maker view <project-path> [--port <port>] [--data-dir <path>] [--no-headless | --headless-browser <chrome|msedge|chromium>]
  fairygui-maker import <source.fig|source.psd|bundle-directory> --out <new-directory> [--data-dir <path>]
  fairygui-maker import <source.fig|source.psd|bundle-directory> --dry-run [--data-dir <path>]
  fairygui-maker import inspect <source.fig|source.psd|bundle-directory> [--data-dir <path>]
  fairygui-maker import plan <source.fig|source.psd|bundle-directory> --out <plan.json> [--data-dir <path>]
  fairygui-maker reimport <project-directory> --dry-run [--data-dir <path>]
  fairygui-maker reimport <project-directory> --apply <planDigest> [--data-dir <path>]

Options:
  --out <path>       New project directory, or plan JSON for import plan
  --dry-run          Compile a draft or plan reimport changes without writing the target project
  --apply <digest>   Explicitly approve the exact reimport planDigest from --dry-run; conflicts and stale inputs are refused
  --port <port>      Localhost port (default: 3847)
  --data-dir <path>  Private artifact, draft, and runtime data directory (default: .fairygui-maker)
  --allow-save <project>
                     Pre-authorize ordinary saves to this project directory (or .fairy file) for this Host process.
                     Repeatable. Force-save, explicit target paths and materialization still need one-time approval
  --no-headless      Never open a Host-owned headless browser; render tools then need an open Workbench page
  --headless-browser <name>
                     Browser for headless rendering: chrome, msedge, or chromium (Playwright's, installed separately).
                     Default: installed Chrome, then Edge
  --version          Print the installed Maker version

Environment: FAIRYGUI_MAKER_TOKEN, FAIRYGUI_MAKER_APPROVAL_TOKEN, FAIRYGUI_MAKER_PORT, FAIRYGUI_MAKER_DATA_DIR, FAIRYGUI_MAKER_LOG_LEVEL
Host save approval: verify ownership once in Workbench using the separate approval token, then allow ordinary saves for a project session or approve once. Force-save, explicit target paths and materialization still require one-time approval. Every save remains revision-checked.
CLI reimport approval: close the project in Host/editor, review --dry-run, then explicitly run --apply <planDigest>. This is a local owner command, not an MCP save approval bypass.
`)
    return null
  }
  if ("reimportPath" in options) {
    const fileSystem = await createHostBackendFileSystem(resolve(options.dataDir ?? process.env.FAIRYGUI_MAKER_DATA_DIR ?? ".fairygui-maker"))
    const result = "applyDigest" in options
      ? { ...await applyProjectReimport(options.reimportPath!, options.applyDigest!, fileSystem), applied: true }
      : await planProjectReimport(options.reimportPath!, fileSystem)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  if ("importSource" in options) {
    const dataDir = resolve(("dataDir" in options ? options.dataDir : undefined) ?? process.env.FAIRYGUI_MAKER_DATA_DIR ?? ".fairygui-maker")
    const drafts = new ImportDraftStore(dataDir)
    await drafts.init()
    let draft = await drafts.create(options.importSource!)
    draft = await drafts.parse(draft.draftId, draft.revision)
    if ("importAction" in options && options.importAction === "inspect") {
      process.stdout.write(`${JSON.stringify({ draft }, null, 2)}\n`)
      return draft
    }
    const planned = await drafts.plan(draft.draftId, draft.revision)
    draft = planned.draft
    if ("importAction" in options && options.importAction === "plan") {
      const planPath = resolve(options.outputPath!)
      await writeFile(planPath, `${JSON.stringify(planned.buildPlan, null, 2)}\n`, { flag: "wx" })
      const result = { draft, planPath }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
      return result
    }
    draft = await drafts.compile(draft.draftId, draft.revision)
    if ("dryRun" in options && options.dryRun) {
      process.stdout.write(`${JSON.stringify({ draft }, null, 2)}\n`)
      return draft
    }
    const materialized = await drafts.materialize(draft.draftId, draft.revision, options.outputPath!)
    const result = { ...materialized.result, draftId: draft.draftId, draftRevision: materialized.draft.revision }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    return result
  }
  const configuredToken = process.env.FAIRYGUI_MAKER_TOKEN
  if (!configuredToken && !process.stdout.isTTY) {
    throw new Error("FAIRYGUI_MAKER_TOKEN is required when stdout is not an interactive terminal.")
  }
  const host = await startMakerHost(options)
  logger.info({ origin: host.origin, mcpEndpoint: `${host.origin}/mcp` }, "FairyGUI Maker started")
  process.stdout.write(`Maker Host: ${host.origin}\nMaker MCP: ${host.origin}/mcp\n`)
  if (!configuredToken) {
    process.stdout.write(`Open Maker Workbench: ${host.origin}/?token=${host.token}\n`)
    if (host.project) process.stdout.write(`Open Viewer: ${host.project.viewerUrl}?token=${host.token}\n`)
  } else {
    process.stdout.write(`Open Maker Workbench: ${host.origin}/\n`)
    if (host.project) process.stdout.write(`Open Viewer: ${host.project.viewerUrl}\n`)
  }
  if (!host.project) {
    if (host.preauthorizedProjects.length) {
      process.stdout.write(`Ordinary saves pre-authorized (--allow-save): ${host.preauthorizedProjects.join(", ")}\n`)
    }
    if (!process.env.FAIRYGUI_MAKER_APPROVAL_TOKEN && process.stdout.isTTY) {
      process.stdout.write(`Host save approval token (owner only; do not give to MCP clients): ${host.approvalToken}\n`)
    } else {
      process.stdout.write(process.env.FAIRYGUI_MAKER_APPROVAL_TOKEN
        ? "Verify ownership once in Workbench with FAIRYGUI_MAKER_APPROVAL_TOKEN, then choose session or one-time save permission.\n"
        : host.preauthorizedProjects.length
          ? "Other saves are blocked: restart interactively or set a separate FAIRYGUI_MAKER_APPROVAL_TOKEN for owner confirmation.\n"
          : "Host saves are blocked: restart interactively or set a separate FAIRYGUI_MAKER_APPROVAL_TOKEN for owner confirmation.\n")
    }
  }
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    await host.close()
  }
  process.once("SIGINT", () => void stop())
  process.once("SIGTERM", () => void stop())
  return host
}
