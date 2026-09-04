import { constants } from "node:fs"
import { lstat, open, opendir, realpath, stat } from "node:fs/promises"
import path from "node:path"
import { captureProjectSnapshot, projectPath } from "../project-snapshot"

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

  const checkedPath = async (relative: string) => {
    let candidate = root
    for (const part of projectPath(relative).split("/").filter(Boolean)) {
      candidate = path.join(candidate, part)
      if ((await lstat(candidate)).isSymbolicLink()) throw new Error("project_symlink_or_special_file_not_allowed")
    }
    const canonical = await realpath(candidate)
    const outside = path.relative(root, canonical)
    if (outside === ".." || outside.startsWith(`..${path.sep}`) || path.isAbsolute(outside)) throw new Error("project_path_outside_root")
    return canonical
  }
  const { files, fairyPath, fairyguiProjectId, sourceRevision } = await captureProjectSnapshot({
    async *entries(directory) {
      const opened = await opendir(await checkedPath(directory))
      for await (const entry of opened) yield { name: entry.name, kind: entry.isSymbolicLink() ? "unsafe" : entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "unsafe" }
    },
    async readFile(relative, maxBytes, signal) {
      signal.throwIfAborted()
      const filePath = await checkedPath(relative)
      const expected = await lstat(filePath)
      if (!expected.isFile() || expected.isSymbolicLink()) throw new Error("project_symlink_or_special_file_not_allowed")
      const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      try {
        const before = await file.stat()
        if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino) throw new Error("project_source_changed_during_read")
        const confirmed = await lstat(await checkedPath(relative))
        if (before.dev !== confirmed.dev || before.ino !== confirmed.ino) throw new Error("project_source_changed_during_read")
        if (before.size > maxBytes) throw new Error("project_snapshot_byte_budget_exceeded")
        const data = new Uint8Array(before.size)
        let offset = 0
        while (offset < data.byteLength) {
          signal.throwIfAborted()
          const { bytesRead } = await file.read(data, offset, Math.min(1024 * 1024, data.length - offset), offset)
          if (!bytesRead) throw new Error("project_source_changed_during_read")
          offset += bytesRead
        }
        const after = await file.stat()
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("project_source_changed_during_read")
        return data
      } finally { await file.close() }
    },
  })

  return {
    rootName: path.basename(root),
    fairyguiProjectId,
    fairyPath,
    name: path.posix.basename(fairyPath).replace(/\.fairy$/i, ""),
    sourceRevision,
    listFiles: () => [...files].map(([path, data]) => ({ path, size: data.byteLength })),
    readFile(filePath) { return files.get(projectPath(filePath)) ?? null },
  }
}
