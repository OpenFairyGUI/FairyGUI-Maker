import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import pino from "pino"

const require = createRequire(import.meta.url)
export const { version: PACKAGE_VERSION } = require("../../package.json") as { version: string }
export const WEB_DIST = fileURLToPath(new URL("../../dist/web", import.meta.url))
export const MAX_MCP_SESSIONS = 32
export const MCP_SESSION_IDLE_TTL_MS = 30 * 60_000
export const HOST_INSTRUCTIONS = "FairyGUI authoring, Viewer, and Player service. Use backend sessions for revision-checked project edits. Every save requires expectedRevision. The owner can allow ordinary saves for one project session in Workbench, or pre-authorize them for specific projects when starting the Host; force-save, explicit target paths and materialization still require a one-time Host Save Grant. On save_approval_required, ask the owner to verify once in Workbench and choose the save permission, then retry unchanged arguments; never obtain owner credentials or approve yourself. Session permission ends on revoke, project close/reopen or Host restart. Use stable IDs returned by list/inspect tools; Viewer and Player operations affect render-session memory only."
export const VIEW_ONLY_INSTRUCTIONS = "Read-only FairyGUI Viewer and Player service. Use stable IDs returned by list tools. Viewer operations never write project files; backend authoring and save tools are unavailable in this mode."
export const logger = pino({ level: process.env.FAIRYGUI_MAKER_LOG_LEVEL ?? "info" })
