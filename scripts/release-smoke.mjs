import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createInterface } from "node:readline"
import { verifyReleaseInputs } from "./verify-release-inputs.mjs"

const root = path.resolve(import.meta.dirname, "..")
const tempRoot = await mkdtemp(path.join(tmpdir(), "fairygui-maker-release-"))
const consumer = path.join(tempRoot, "consumer")
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm"
const npmEnv = { ...process.env, npm_config_cache: path.join(tempRoot, "npm-cache") }
const packageMetadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
const expectedVersion = packageMetadata.version

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: process.env,
      shell: process.platform === "win32",
      ...options,
    })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => { stdout += chunk })
    child.stderr?.on("data", (chunk) => { stderr += chunk })
    child.once("error", reject)
    child.once("exit", (code) => code === 0
      ? resolve({ stdout, stderr })
      : reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`)))
  })
}

async function initializeMcp(origin, token, projectPath) {
  const headers = {
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }
  const initialized = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "release-smoke", version: "1.0.0" } },
    }),
  })
  if (!initialized.ok) throw new Error(await initialized.text())
  const initializeBody = await initialized.json()
  if (!initializeBody.result?.instructions?.includes("stable IDs")) throw new Error("MCP server instructions are missing")
  const sessionId = initialized.headers.get("mcp-session-id")
  if (!sessionId) throw new Error("MCP session id missing")
  const listed = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: { ...headers, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  })
  const body = await listed.json()
  if (!listed.ok || body.error) throw new Error(JSON.stringify(body))
  const call = async (name, args) => {
    const response = await fetch(`${origin}/mcp`, {
      method: "POST", headers: { ...headers, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: `openfairygui_backend_${name}`, arguments: args } }),
    })
    const payload = await response.json()
    const result = payload.result?.structuredContent?.backendResult
    if (!response.ok || !result) throw new Error(JSON.stringify(payload))
    return result
  }
  const opened = await call("open_session", { projectPath })
  if (!opened.ok) throw new Error(JSON.stringify(opened))
  const saved = await call("save_session", { sessionId: opened.data.sessionId, expectedRevision: opened.data.revision, force: true })
  if (saved.ok || saved.error?.code !== "save_approval_required") throw new Error("Installed Host did not require a Save Grant")
  const approved = await fetch(`${origin}/api/save-approvals/${saved.error.approval.approvalRequestId}/decision`, {
    method: "POST", headers, body: JSON.stringify({ decision: "approve" }),
  })
  if (approved.status !== 403) throw new Error("Installed Host allowed self-approval using only the MCP token")
  await call("close_session", { sessionId: opened.data.sessionId })
  await fetch(`${origin}/mcp`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25" },
  })
  return body.result.tools.map((tool) => tool.name)
}

async function verifyArtifactPersistence(installedRoot, origin, headers) {
  const resolveInstalled = createRequire(path.join(installedRoot, "package.json")).resolve
  const { Document } = await import(pathToFileURL(resolveInstalled("@openfairygui/core")).href)
  const { NodeIO } = await import(pathToFileURL(resolveInstalled("@openfairygui/core/node")).href)
  const document = new Document()
  document.createPackage("Smoke").setId("SMOKE001").addResource(document.createComponent("Main").setId("MAIN0001").setExported(true))
  const binaryPath = path.join(tempRoot, "Smoke.fui")
  await new NodeIO().writeBinary(document, binaryPath)
  const bytes = await readFile(binaryPath)
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const artifacts = []
  for (const name of ["First import", "Second import"]) {
    const response = await fetch(`${origin}/api/artifact-imports`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ name, files: [{ path: "Smoke.fui", size: bytes.length, sha256 }] }) })
    if (response.status !== 201) throw new Error("Installed Artifact import failed")
    const { importId } = await response.json()
    if (!(await fetch(`${origin}/api/artifact-imports/${importId}/files?path=Smoke.fui`, { method: "PUT", headers, body: bytes })).ok) throw new Error("Installed Artifact upload failed")
    const completed = await fetch(`${origin}/api/artifact-imports/${importId}/complete`, { method: "POST", headers })
    if (completed.status !== 201) throw new Error("Installed Artifact completion failed")
    artifacts.push((await completed.json()).artifact)
  }
  if (artifacts[0].artifactId !== artifacts[1].artifactId || artifacts[0].importId === artifacts[1].importId || artifacts[1].name !== "Second import") throw new Error("Installed Artifact provenance was overwritten")
  const summary = (await (await fetch(`${origin}/api/artifacts`, { headers })).json()).artifacts[0]
  if (summary.importCount !== 2 || summary.fileCount !== 1 || "files" in summary || "packages" in summary) throw new Error("Installed Artifact list is not a bounded summary")
  const fileUrl = `${origin}/api/artifacts/${artifacts[0].artifactId}/files/Smoke.fui`
  const file = await fetch(fileUrl, { headers })
  if (!file.ok || file.headers.get("etag") !== `"${sha256}"` || !Buffer.from(await file.arrayBuffer()).equals(bytes)) throw new Error("Installed Artifact bytes failed verification")
  await writeFile(path.join(tempRoot, "data", "artifacts", artifacts[0].artifactId, "Smoke.fui"), Buffer.alloc(bytes.length))
  const changed = await fetch(fileUrl, { headers })
  if (changed.status !== 409 || changed.headers.has("etag")) throw new Error("Installed Host served tampered Artifact bytes")
}

let host
try {
  await access(path.join(root, "LICENSE"))
  await verifyReleaseInputs(root)
  const notices = await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8")
  for (const marker of ["SIL OPEN FONT LICENSE Version 1.1", "pako 2.2.0", "Zlib License text"]) {
    if (!notices.includes(marker)) throw new Error(`Third-party notice is missing: ${marker}`)
  }

  console.log("Release smoke: packing candidate")
  await run(npmCommand, ["pack", "--silent", "--pack-destination", tempRoot], { env: npmEnv })
  const tarballs = (await readdir(tempRoot)).filter((file) => file.endsWith(".tgz"))
  if (tarballs.length !== 1) throw new Error(`Expected one package tarball, found ${tarballs.length}`)
  const tarball = path.join(tempRoot, tarballs[0])
  const tarballSha256 = createHash("sha256").update(await readFile(tarball)).digest("hex")
  console.log("Release smoke: installing tarball in a fresh consumer")
  await run(npmCommand, ["install", "--prefix", consumer, "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", tarball], { env: npmEnv })

  const installedRoot = path.join(consumer, "node_modules", packageMetadata.name)
  await Promise.all([
    access(path.join(installedRoot, "dist", "server", "index.js")),
    access(path.join(installedRoot, "dist", "web", "index.html")),
    access(path.join(installedRoot, "dist", "web", "THIRD_PARTY_LICENSES.md")),
    access(path.join(installedRoot, "README.md")),
    access(path.join(installedRoot, "LICENSE")),
    access(path.join(installedRoot, "THIRD_PARTY_NOTICES.md")),
    access(path.join(installedRoot, "vendor-runtime.lock.json")),
    access(path.join(installedRoot, ".agents", "skills", "use-fairygui-maker", "SKILL.md")),
    access(path.join(installedRoot, ".claude", "skills", "use-fairygui-maker", "SKILL.md")),
  ])
  const lockText = await readFile(path.join(installedRoot, "vendor-runtime.lock.json"), "utf8")
  if (lockText !== await readFile(path.join(root, "vendor-runtime.lock.json"), "utf8")) throw new Error("Installed runtime lock differs from the source lock")
  const installedLock = JSON.parse(lockText)
  for (const file of installedLock.files) {
    const bytes = await readFile(path.join(installedRoot, "dist/web/viewer-runtime", path.basename(file.path)))
    if (bytes.length !== file.byteLength || createHash("sha256").update(bytes).digest("hex") !== file.sha256) {
      throw new Error(`Installed runtime differs from the source lock: ${file.path}`)
    }
  }
  const bundledLicenses = await readFile(path.join(installedRoot, "dist", "web", "THIRD_PARTY_LICENSES.md"), "utf8")
  for (const marker of ["@openfairygui/core", "react -", "class-variance-authority", "lucide-react"]) {
    if (!bundledLicenses.includes(marker)) throw new Error(`Generated bundle licenses are missing: ${marker}`)
  }
  const bin = path.join(consumer, "node_modules", ".bin", process.platform === "win32" ? "fairygui-maker.cmd" : "fairygui-maker")
  console.log("Release smoke: verifying installed CLI and Host")
  const help = await run(bin, ["--help"], { cwd: consumer })
  if (!help.stdout.includes("fairygui-maker import") || !help.stdout.includes("fairygui-maker reimport") || !help.stdout.includes("view <project-path>") || !help.stdout.includes("--data-dir <path>") || !help.stdout.includes("FAIRYGUI_MAKER_APPROVAL_TOKEN")) throw new Error("Installed CLI help is incomplete")
  const version = await run(bin, ["--version"], { cwd: consumer })
  if (version.stdout.trim() !== expectedVersion) throw new Error(`Unexpected installed CLI version: ${version.stdout.trim()}`)
  const importedDirectory = path.join(consumer, "imported-fig")
  const imported = await run(bin, ["import", path.join(root, "test", "fixtures", "design-import", "basic-shapes.fig"), "--out", importedDirectory], { cwd: consumer })
  const importResult = JSON.parse(imported.stdout)
  if (importResult.source?.kind !== "fig" || importResult.report?.nodes < 1) throw new Error("Installed CLI did not return an import report")
  await Promise.all([access(importResult.fairyPath), access(path.join(importedDirectory, "maker-import-state.json"))])
  const freshDirectory = path.join(consumer, "imported-fig-fresh")
  const fresh = JSON.parse((await run(bin, ["import", path.join(root, "test", "fixtures", "design-import", "basic-shapes.fig"), "--out", freshDirectory], { cwd: consumer })).stdout)
  if (fresh.projectId !== importResult.projectId || JSON.stringify(fresh.ids) !== JSON.stringify(importResult.ids)) {
    throw new Error("Installed CLI fresh import IDs are not deterministic")
  }
  for (const file of await readdir(importedDirectory, { recursive: true, withFileTypes: true })) {
    if (!file.isFile()) continue
    const originalPath = path.join(file.parentPath, file.name)
    const freshPath = path.join(freshDirectory, path.relative(importedDirectory, originalPath))
    if (!(await readFile(originalPath)).equals(await readFile(freshPath))) throw new Error(`Installed CLI fresh import bytes differ: ${file.name}`)
  }
  const reimport = JSON.parse((await run(bin, ["reimport", importedDirectory, "--dry-run"], { cwd: consumer })).stdout)
  if (reimport.added?.length || reimport.changed?.length || reimport.removed?.length || reimport.conflict?.length || !reimport.preserved?.length) {
    throw new Error("Installed CLI returned an unstable no-change reimport plan")
  }
  let overwriteError = ""
  try {
    await run(bin, ["import", path.join(root, "test", "fixtures", "design-import", "basic-shapes.fig"), "--out", importedDirectory], { cwd: consumer })
  } catch (error) {
    overwriteError = String(error)
  }
  if (!overwriteError.includes("EEXIST")) throw new Error("Installed CLI did not refuse an existing output directory")
  let missingTokenError = ""
  try {
    await run(bin, ["--port", "0"], { cwd: consumer, env: { ...process.env, FAIRYGUI_MAKER_TOKEN: "" } })
  } catch (error) {
    missingTokenError = String(error)
  }
  if (!missingTokenError.includes("FAIRYGUI_MAKER_TOKEN is required when stdout is not an interactive terminal")) {
    throw new Error("Installed CLI did not enforce an explicit token outside an interactive terminal")
  }

  const token = "release-smoke-token-with-24-chars"
  const approvalToken = "release-owner-approval-token-with-24-chars"
  host = spawn(process.execPath, [path.join(installedRoot, "scripts", "fairygui-maker.mjs"), "--port", "0", "--data-dir", path.join(tempRoot, "data")], {
    cwd: consumer,
    env: { ...process.env, FAIRYGUI_MAKER_TOKEN: token, FAIRYGUI_MAKER_APPROVAL_TOKEN: approvalToken },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stdout = ""
  host.stdout.on("data", (chunk) => { stdout += chunk })
  let stderr = ""
  host.stderr.on("data", (chunk) => { stderr += chunk })
  const lines = createInterface({ input: host.stdout })
  const origin = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Installed Host did not start\n${stderr}`)), 20_000)
    lines.on("line", (line) => {
      const match = /^Maker Host: (http:\/\/\S+)$/.exec(line)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1])
    })
    host.once("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`Installed Host exited ${code}\n${stderr}`))
    })
  })

  const headers = { Authorization: `Bearer ${token}` }
  const status = await fetch(`${origin}/api/status`, { headers })
  if (!status.ok) throw new Error(await status.text())
  const home = await fetch(origin, { headers })
  if (!home.ok || !(await home.text()).includes("FairyGUI Workbench")) throw new Error("Installed Host did not serve the Workbench")
  for (const mode of ["viewer", "player"]) {
    const entry = await fetch(`${origin}/${mode}-runtime.html`)
    if (!entry.ok || !entry.headers.get("content-security-policy")?.includes("sandbox allow-scripts;")) throw new Error("Installed runtime entry is not sandboxed")
  }
  const workerFiles = (await readdir(path.join(installedRoot, "dist", "web", "assets"))).filter((name) => /^image-probe\.worker-.*\.js$/.test(name))
  if (!workerFiles.length) throw new Error("Installed image probe worker is missing")
  for (const name of workerFiles) {
    const response = await fetch(`${origin}/assets/${name}`, { headers: { Origin: "null" } })
    if (!response.ok || response.headers.get("access-control-allow-origin") !== "*") throw new Error("Installed runtime assets are not anonymously readable")
  }
  if ((await fetch(`${origin}/api/status`, { headers: { ...headers, Origin: "null" } })).status !== 403) throw new Error("Installed Host accepts opaque-origin API access")
  const toolNames = await initializeMcp(origin, token, importedDirectory)
  if (!toolNames.includes("list_viewer_components") || !toolNames.some((name) => name.startsWith("openfairygui_backend_"))) {
    throw new Error("Installed Host MCP tool surface is incomplete")
  }
  await verifyArtifactPersistence(installedRoot, origin, headers)
  if ([token, approvalToken].some((secret) => stdout.includes(secret) || stderr.includes(secret))) throw new Error("Installed Host exposed a configured token in process output")
  process.stdout.write(JSON.stringify({ tarball: path.basename(tarball), tarballSha256, runtimeFiles: installedLock.files.length, version: version.stdout.trim(), host: true, mcp: true, deterministicImport: true, saveGrants: true, runtimeIsolation: true, artifactPersistence: true }) + "\n")
} finally {
  if (host && host.exitCode === null) {
    const exited = new Promise((resolve) => host.once("exit", resolve))
    host.kill()
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))])
  }
  await rm(tempRoot, { recursive: true, force: true })
}
