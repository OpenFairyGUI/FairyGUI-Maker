#!/usr/bin/env node

try {
  const { runCli } = await import("../dist/server/index.js")
  await runCli()
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
