import type { Document } from "@openfairygui/core"
import type { FileSystem } from "@openfairygui/core/project-io"

export const PROJECT_SCAN_LIMITS = { entries: 10_000, files: 5_000, directories: 1_000, depth: 32, textBytes: 8 * 1024 * 1024, fileBytes: 128 * 1024 * 1024, totalBytes: 512 * 1024 * 1024, timeoutMs: 60_000 } as const
const ignoredNames = new Set(["node_modules", "dist", "build", "out", "coverage", "library", "temp", "obj", "bin"])
const decoder = new TextDecoder()

/** Both adapters enumerate metadata only; readFile must enforce maxBytes before allocating. */
export type ProjectSnapshotSource = {
  entries(directory: string): AsyncIterable<{ name: string; kind: "file" | "directory" | "unsafe" }>
  readFile(path: string, maxBytes: number, signal: AbortSignal): Promise<Uint8Array>
}
export type ProjectScanOptions = { signal?: AbortSignal; onProgress?: (message: string) => void }

export function ignoredProjectPath(path: string) {
  return path.split("/").some((part) => part.startsWith(".") || ignoredNames.has(part.toLowerCase()) || /\.(pem|key|p12|pfx)$/i.test(part))
}

export function projectPath(value: string) {
  if (value.startsWith("/") || value.startsWith("\\") || /[\x00-\x1f<>:"|?*]/.test(value)) throw new Error("project_path_outside_root")
  const parts: string[] = []
  for (const part of value.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") { if (!parts.pop()) throw new Error("project_path_outside_root") }
    else {
      if (/[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) throw new Error("project_path_invalid")
      parts.push(part)
    }
  }
  return parts.join("/")
}

export function snapshotFileSystem(paths: Iterable<string>, read: (path: string) => Promise<Uint8Array>): FileSystem {
  const files = new Set(paths)
  const directories = new Map<string, Set<string>>([["", new Set()]])
  for (const path of files) {
    const parts = path.split("/")
    for (let i = 0; i < parts.length - 1; i++) {
      const parent = parts.slice(0, i).join("/")
      const directory = parts.slice(0, i + 1).join("/")
      if (!directories.has(directory)) directories.set(directory, new Set())
      directories.get(parent)!.add(parts[i])
    }
  }
  const readonly = async () => { throw new Error("project_snapshot_is_read_only") }
  return {
    readFile: async (path) => decoder.decode(await read(projectPath(path))),
    readFileRaw: (path) => read(projectPath(path)),
    writeFile: readonly, writeFileRaw: readonly, mkdir: readonly,
    readdir: async (path) => { const entries = directories.get(projectPath(path)); if (!entries) throw new Error("project_directory_not_found"); return [...entries].sort() },
    exists: async (path) => files.has(projectPath(path)) || directories.has(projectPath(path)),
    join: (...paths) => projectPath(paths.filter(Boolean).join("/")),
    dirname: (path) => projectPath(path).split("/").slice(0, -1).join("/"),
  }
}

export async function captureProjectSnapshot(source: ProjectSnapshotSource, options: ProjectScanOptions = {}) {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(PROJECT_SCAN_LIMITS.timeoutMs)])
  const scan = async () => {
    const files = new Set<string>()
    let entries = 0, directories = 0
    const visit = async (directory: string, depth: number) => {
      signal.throwIfAborted()
      if (depth > PROJECT_SCAN_LIMITS.depth || ++directories > PROJECT_SCAN_LIMITS.directories) throw new Error("project_scan_directory_budget_exceeded")
      for await (const entry of source.entries(directory)) {
        signal.throwIfAborted()
        if (++entries > PROJECT_SCAN_LIMITS.entries) throw new Error("project_scan_entry_budget_exceeded")
        if (!entry.name || /[/\\]/.test(entry.name)) throw new Error("project_entry_invalid")
        const path = directory ? `${directory}/${entry.name}` : entry.name
        if (ignoredProjectPath(path)) continue
        if (projectPath(path) !== path) throw new Error("project_entry_invalid")
        if (entry.kind === "unsafe") throw new Error(`project_symlink_or_special_file_not_allowed:${path}`)
        if (entry.kind === "directory") await visit(path, depth + 1)
        else {
          if (files.size >= PROJECT_SCAN_LIMITS.files) throw new Error("project_scan_file_budget_exceeded")
          files.add(path)
        }
      }
    }
    await visit("", 0)
    return files
  }
  options.onProgress?.("扫描工程目录…")
  const index = await scan()
  const fairyFiles = [...index].filter((path) => /\.fairy$/i.test(path))
  if (fairyFiles.length !== 1) throw new Error(`view_project_requires_one_fairy_file:${fairyFiles.length}`)
  const fairyPath = fairyFiles[0]
  const base = fairyPath.split("/").slice(0, -1).join("/")
  const files = new Map<string, Uint8Array>()
  let totalBytes = 0
  let failure: unknown
  const allowed = (path: string) => {
    const relative = base ? (path.startsWith(`${base}/`) ? path.slice(base.length + 1) : "") : path
    return path === fairyPath || /^(assets(?:_[^/]+)?\/|settings\/(Publish|Common|Adaptation|CustomProperties|i18n)\.json$)/.test(relative)
  }
  const read = async (path: string) => {
    try {
      signal.throwIfAborted()
      if (!allowed(path) || ignoredProjectPath(path)) throw new Error(`project_dependency_path_not_allowed:${path}`)
      const cached = files.get(path)
      if (cached) return cached
      if (!index.has(path)) throw new Error(`project_dependency_missing:${path}`)
      const limit = Math.min(/\.(fairy|xml|json|atlas|fnt)$/i.test(path) ? PROJECT_SCAN_LIMITS.textBytes : PROJECT_SCAN_LIMITS.fileBytes, PROJECT_SCAN_LIMITS.totalBytes - totalBytes)
      const data = await source.readFile(path, limit, signal)
      if (data.byteLength > limit) throw new Error("project_snapshot_byte_budget_exceeded")
      totalBytes += data.byteLength
      files.set(path, data)
      options.onProgress?.(`读取工程依赖 ${files.size} 个 · ${Math.ceil(totalBytes / 1024)} KiB`)
      return data
    } catch (error) { failure ??= error; throw error }
  }
  const { ProjectReader } = await import("@openfairygui/core/project-io")
  const result = await new ProjectReader(snapshotFileSystem(index, read)).readDetailed(fairyPath, { hydrateResourceBytes: true })
  if (failure) throw failure // ProjectReader tolerates some failed resource reads; privacy/budget failures must not be swallowed.
  if (!result.document || !result.complete) throw new Error(`project_snapshot_invalid:${result.diagnostics.filter(({ severity }) => severity === "error").map(({ message }) => message).join("; ")}`)
  const document = result.document
  const fairyguiProjectId = document.getRoot().getProjectId().trim()
  if (!fairyguiProjectId) throw new Error(`view_project_missing_id:${fairyPath}`)
  await readSidecars(document, base, index, files, read)
  if (failure) throw failure

  options.onProgress?.("复核工程内容…")
  const manifest: Array<[string, string]> = []
  for (const [path, data] of [...files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    signal.throwIfAborted()
    const digest = await sha256(data)
    if (digest !== await sha256(await source.readFile(path, data.byteLength, signal))) throw new Error("project_source_changed_during_read")
    manifest.push([path, digest])
  }
  const finalIndex = await scan()
  if (index.size !== finalIndex.size || [...index].some((path) => !finalIndex.has(path))) throw new Error("project_source_changed_during_read")
  signal.throwIfAborted()
  // ponytail: a sorted content-hash manifest, not a Merkle tree; add incremental hashing only if real scan timings need it.
  const sourceRevision = await sha256(new TextEncoder().encode(JSON.stringify(manifest)))
  // The UAM and the Host file API must project the same frozen dependency set, not unreferenced directory entries.
  const frozenDocument = await new ProjectReader(snapshotFileSystem(files.keys(), async (path) => {
    const data = files.get(path)
    if (!data) throw new Error(`project_dependency_missing:${path}`)
    return data
  })).read(fairyPath, { hydrateResourceBytes: true })
  signal.throwIfAborted()
  return { fairyPath, fairyguiProjectId, sourceRevision, files, document: frozenDocument }
}

async function sha256(data: Uint8Array) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", data as Uint8Array<ArrayBuffer>))].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

async function readSidecars(document: Document, base: string, index: Set<string>, files: Map<string, Uint8Array>, read: (path: string) => Promise<Uint8Array>) {
  const include = async (parent: string, name: string, required = true) => {
    if (!name || /^[\/\\]/.test(name) || name.includes(":")) throw new Error("project_dependency_path_not_allowed")
    const path = projectPath([parent, name].filter(Boolean).join("/"))
    if (ignoredProjectPath(path)) throw new Error(`project_dependency_path_not_allowed:${path}`)
    if (required || index.has(path)) await read(path)
    return path
  }
  for (const pkg of document.getRoot().listPackages()) {
    for (const resource of pkg.listResources()) {
      if (resource.propertyType !== "SpineResource" && resource.propertyType !== "DragonBonesResource") continue
      const skeleton = resource as ReturnType<Document["createSpineResource"]>
      const folder = projectPath([base, skeleton.getBranch() ? `assets_${skeleton.getBranch()}` : "assets", pkg.getName(), skeleton.getPath().replace(/^\//, "")].filter(Boolean).join("/"))
      const file = skeleton.getFile()
      const conventional = resource.propertyType === "SpineResource" ? file.replace(/\.[^.]+$/, ".atlas") : file.replace(/(?:_ske)?\.[^.]+$/, "_tex.json")
      await include(folder, conventional, false)
      for (const name of skeleton.getAtlasNames()) await include(folder, name)
    }
  }
  for (const [path, data] of files) {
    const parent = path.split("/").slice(0, -1).join("/")
    if (/\.fnt$/i.test(path)) {
      if (decoder.decode(data.subarray(0, 3)) === "BMF") {
        if (data[3] !== 3) throw new Error("project_binary_font_version_unsupported")
        const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
        for (let offset = 4; offset < data.length;) {
          if (offset + 5 > data.length) throw new Error("project_binary_font_invalid")
          const kind = data[offset], size = view.getUint32(offset + 1, true)
          offset += 5
          if (offset + size > data.length) throw new Error("project_binary_font_invalid")
          if (kind === 3) {
            if (size === 0 || data[offset + size - 1] !== 0) throw new Error("project_binary_font_invalid")
            for (const page of decoder.decode(data.subarray(offset, offset + size)).split("\0").filter(Boolean)) await include(parent, page)
          }
          offset += size
        }
      } else for (const match of decoder.decode(data).matchAll(/(?:^|\n|<)\s*page\b[^\n>]*?\bfile\s*=\s*["']([^"']+)["']/g)) await include(parent, match[1])
    } else if (/\.atlas$/i.test(path)) {
      for (const block of decoder.decode(data).trim().split(/\r?\n\s*\r?\n/)) {
        const name = block.split(/\r?\n/, 1)[0].trim()
        if (name && !name.includes(":")) await include(parent, name)
      }
    } else if (/_tex\.json$/i.test(path)) {
      const atlas = JSON.parse(decoder.decode(data)) as { imagePath?: string }
      if (atlas.imagePath) await include(parent, atlas.imagePath)
    }
  }
}
