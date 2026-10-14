import { pathToFileURL } from "node:url"

import { runCli } from "./cli"
import { logger } from "./host-config"

export type { AppType } from "./api"
export { readCliArguments, runCli } from "./cli"
export { startMakerHost } from "./host"
export { MCP_SESSION_IDLE_TTL_MS } from "./host-config"
export type { RegisteredProject, StartMakerHostOptions } from "./host-types"

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    logger.error({ err: error }, "FairyGUI Maker failed to start")
    process.exitCode = 1
  })
}
