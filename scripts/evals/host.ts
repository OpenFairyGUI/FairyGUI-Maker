import { spawn, type ChildProcess } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { appendFileSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import http from "node:http"
import path from "node:path"
import { createInterface } from "node:readline"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

export const ROOT = path.resolve(import.meta.dirname, "..", "..")
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"

export function run(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd ?? ROOT, env: options.env ?? process.env, shell: process.platform === "win32" && command.endsWith(".cmd") })
    let stdout = "", stderr = ""
    child.stdout?.on("data", (chunk) => { stdout += chunk })
    child.stderr?.on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("exit", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`)))
  })
}

/** The packed candidate installed with production dependencies only, as a user would install it. */
export async function installMaker(evidenceRoot: string) {
  const env = { ...process.env, npm_config_cache: path.join(evidenceRoot, "npm-cache") }
  await run(npmCommand, ["pack", "--silent", "--pack-destination", evidenceRoot], { env })
  const tarballs = (await readdir(evidenceRoot)).filter((file) => file.endsWith(".tgz"))
  if (tarballs.length !== 1) throw new Error(`Expected one package tarball, found ${tarballs.length}`)
  const tarball = path.join(evidenceRoot, tarballs[0])
  const consumer = path.join(evidenceRoot, "consumer")
  await run(npmCommand, ["install", "--prefix", consumer, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { env })
  const name = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")).name as string
  return {
    installedRoot: path.join(consumer, "node_modules", ...name.split("/")),
    tarball: path.basename(tarball),
    tarballSha256: createHash("sha256").update(await readFile(tarball)).digest("hex"),
  }
}

export type RunningHost = { origin: string; token: string; approvalToken: string; logFile: string; stop(): Promise<void> }

/** The installed CLI, rooted at the case workspace, rendering headlessly and with the case project pre-authorized. */
export async function startHost({ installedRoot, cwd, dataDir, allowSave, browser, logFile }: {
  installedRoot: string; cwd: string; dataDir: string; allowSave: string; browser?: string; logFile: string
}): Promise<RunningHost> {
  const token = randomBytes(24).toString("base64url")
  const approvalToken = randomBytes(24).toString("base64url")
  const args = [path.join(installedRoot, "scripts", "fairygui-maker.mjs"), "--port", "0", "--data-dir", dataDir, "--allow-save", allowSave, ...(browser ? ["--headless-browser", browser] : [])]
  const child = spawn(process.execPath, args, { cwd, env: { ...process.env, FAIRYGUI_MAKER_TOKEN: token, FAIRYGUI_MAKER_APPROVAL_TOKEN: approvalToken, FAIRYGUI_MAKER_LOG_LEVEL: "warn" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
  child.stdout!.on("data", (chunk) => appendFileSync(logFile, chunk))
  child.stderr!.on("data", (chunk) => appendFileSync(logFile, chunk))
  const origin = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Installed Host did not start; see ${logFile}`)), 30_000)
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const match = /^Maker Host: (http:\/\/\S+)$/.exec(line)
      if (match) { clearTimeout(timer); resolve(match[1]) }
    })
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Installed Host exited ${code}; see ${logFile}`)) })
  })
  return { origin, token, approvalToken, logFile, stop: () => stopProcess(child) }
}

async function stopProcess(child: ChildProcess) {
  if (child.exitCode !== null) return
  const exited = new Promise((resolve) => child.once("exit", resolve))
  child.kill(process.platform === "win32" ? undefined : "SIGINT")
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))])
  if (child.exitCode === null) child.kill("SIGKILL")
}

export type McpTraceEntry = { at: string; request: unknown; status: number; response: unknown }

/** A local pass-through in front of the Host that records every JSON-RPC exchange; the Agent connects here. */
export async function startMcpRecorder(target: string, traceFile: string) {
  const targetUrl = new URL(target)
  const trace: McpTraceEntry[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk) => chunks.push(chunk))
    request.on("end", () => {
      const body = Buffer.concat(chunks)
      const upstream = http.request({
        hostname: targetUrl.hostname, port: targetUrl.port, path: request.url, method: request.method,
        // The Host only accepts its own Host header.
        headers: { ...request.headers, host: targetUrl.host },
      }, (reply) => {
        response.writeHead(reply.statusCode ?? 502, reply.headers)
        const json = String(reply.headers["content-type"] ?? "").includes("application/json")
        const replyChunks: Buffer[] = []
        reply.on("data", (chunk) => { if (json) replyChunks.push(chunk); response.write(chunk) })
        reply.on("end", () => {
          response.end()
          if (request.method !== "POST" || !request.url?.startsWith("/mcp")) return
          const entry = { at: new Date().toISOString(), request: parse(body), status: reply.statusCode ?? 0, response: json ? parse(Buffer.concat(replyChunks)) : null }
          trace.push(entry)
          appendFileSync(traceFile, `${JSON.stringify(entry, shrinkImages)}\n`)
        })
      })
      // A Host shutdown cuts long-lived SSE streams after their headers were already relayed.
      upstream.on("error", (error) => { if (response.headersSent) response.destroy(); else { response.writeHead(502); response.end(String(error)) } })
      response.on("close", () => { if (!response.writableFinished) upstream.destroy() })
      upstream.end(body)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as { port: number }
  return {
    origin: `http://127.0.0.1:${port}`,
    trace,
    stop: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) }),
  }
}

function parse(body: Buffer) {
  try { return JSON.parse(body.toString("utf8")) } catch { return body.length ? { unparsed: body.byteLength } : null }
}

function shrinkImages(key: string, value: unknown) {
  return key === "data" && typeof value === "string" && value.length > 256 ? `<${value.length} base64 chars>` : value
}

/** Completed tools/call exchanges with their parsed result, in call order. */
export function toolCalls(trace: McpTraceEntry[]) {
  return trace.flatMap((entry) => {
    const request = entry.request as { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } } | null
    if (request?.method !== "tools/call" || !request.params?.name) return []
    const result = (entry.response as { result?: CallToolResult } | null)?.result
    const text = result?.content?.find((item) => item.type === "text")
    let value: any = result?.structuredContent
    if (value === undefined && text?.type === "text") { try { value = JSON.parse(text.text) } catch { value = undefined } }
    const backend = value?.backendResult
    const ok = Boolean(result) && !result!.isError && (backend ? backend.ok === true : value?.ok !== false)
    return [{ name: request.params.name, arguments: request.params.arguments ?? {}, ok, value: backend ?? value }]
  })
}

export async function connectMcp(origin: string, token: string, name: string) {
  const client = new Client({ name, version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } })
  await client.connect(transport)
  const call = async (tool: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 120_000 }) as CallToolResult
    const text = result.content.find((item) => item.type === "text")
    let value: any = result.structuredContent
    // Input-validation failures come back as plain MCP error text, not JSON.
    if (value === undefined && text?.type === "text") { try { value = JSON.parse(text.text) } catch { value = { ok: false, error: { code: "mcp_error", message: text.text } } } }
    return { result, value: value?.backendResult ?? value, isError: Boolean(result.isError) }
  }
  return { call, close: async () => { await transport.terminateSession().catch(() => undefined); await client.close() } }
}
