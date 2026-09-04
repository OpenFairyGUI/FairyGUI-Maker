import { createHash } from "node:crypto"
import { readFile, readdir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { ProjectReader, type FileSystem } from "@openfairygui/core/project-io"

const MAX_FILES = 5_000
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

export type HostProjectSnapshot = {
  rootName: string
  fairyguiProjectId: string
  fairyPath: string
  name: string
  sourceRevision: string
  listFiles(): Array<{ path: string; size: number }>
  readFile(filePath: string): Uint8Array | null
}

export async function createHostProjectSnapshot(inputPath: string): Promise<HostProjectSnapshot> {
  const root = await realpath(path.resolve(inputPath))
  if (!(await stat(root)).isDirectory()) throw new Error("view_project_path_must_be_a_directory")

  const files = new Map<string, Uint8Array>()
  let totalBytes = 0
  const scan = async (directory: string, parent = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = parent ? `${parent}/${entry.name}` : entry.name
      const absolutePath = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`view_project_symlink_not_allowed:${relativePath}`)
      if (entry.isDirectory()) {
        await scan(absolutePath, relativePath)
        continue
      }
      if (!entry.isFile()) throw new Error(`view_project_special_file_not_allowed:${relativePath}`)
      if (files.size >= MAX_FILES) throw new Error("view_project_too_many_files")

      const canonicalPath = await realpath(absolutePath)
      assertWithinRoot(root, canonicalPath)
      const data = await readFile(canonicalPath)
      totalBytes += data.byteLength
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("view_project_too_large")
      files.set(normalizeRelativePath(relativePath), new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    }
  }
  await scan(root)

  const fairyFiles = [...files.keys()].filter((filePath) => filePath.toLowerCase().endsWith(".fairy"))
  if (fairyFiles.length !== 1) throw new Error(`view_project_requires_one_fairy_file:${fairyFiles.length}`)
  const fairyPath = fairyFiles[0]
  const document = await new ProjectReader(createReadOnlyFileSystem(files)).read(fairyPath)
  const fairyguiProjectId = document.getRoot().getProjectId().trim()
  if (!fairyguiProjectId) throw new Error(`view_project_missing_id:${fairyPath}`)

  const digest = createHash("sha256")
  for (const [filePath, data] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    digest.update(filePath).update("\0").update(data).update("\0")
  }

  return {
    rootName: path.basename(root),
    fairyguiProjectId,
    fairyPath,
    name: path.posix.basename(fairyPath).replace(/\.fairy$/i, ""),
    sourceRevision: digest.digest("hex"),
    listFiles: () => [...files].map(([filePath, data]) => ({ path: filePath, size: data.byteLength })),
    readFile(filePath) {
      return files.get(normalizeRelativePath(filePath)) ?? null
    },
  }
}

function createReadOnlyFileSystem(files: Map<string, Uint8Array>): FileSystem {
  const textDecoder = new TextDecoder()
  const readonly = async () => { throw new Error("view_project_is_read_only") }
  return {
    async readFile(filePath) {
      const data = files.get(normalizeRelativePath(filePath))
      if (!data) throw new Error(`view_project_file_not_found:${filePath}`)
      return textDecoder.decode(data)
    },
    async readFileRaw(filePath) {
      const data = files.get(normalizeRelativePath(filePath))
      if (!data) throw new Error(`view_project_file_not_found:${filePath}`)
      return data
    },
    writeFile: readonly,
    writeFileRaw: readonly,
    mkdir: readonly,
    async readdir(directory) {
      const safeDirectory = normalizeDirectoryPath(directory)
      const prefix = safeDirectory ? `${safeDirectory}/` : ""
      return [...new Set([...files.keys()].flatMap((filePath) => {
        if (!filePath.startsWith(prefix)) return []
        const remainder = filePath.slice(prefix.length)
        const slash = remainder.indexOf("/")
        return slash === -1 ? [] : [remainder.slice(0, slash)]
      }))]
    },
    async exists(filePath) {
      const safePath = normalizeRelativePath(filePath)
      return files.has(safePath) || [...files.keys()].some((candidate) => candidate.startsWith(`${safePath}/`))
    },
    join: (...paths) => path.posix.join(...paths),
    dirname: (filePath) => path.posix.dirname(filePath),
  }
}

function normalizeDirectoryPath(value: string) {
  return value === "" || value === "." ? "" : normalizeRelativePath(value)
}

function normalizeRelativePath(value: string) {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error("view_project_path_outside_root")
  }
  const normalized = path.posix.normalize(value)
  if (normalized !== value || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("view_project_path_outside_root")
  }
  return normalized
}

function assertWithinRoot(root: string, candidate: string) {
  const relative = path.relative(root, candidate)
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return
  throw new Error("view_project_path_outside_root")
}
