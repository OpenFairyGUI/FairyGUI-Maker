import { MAX_ARTIFACT_FILES, MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_TOTAL_BYTES, type ArtifactImportFile, type ArtifactManifest } from "../../artifact-protocol"

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>
}

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

export async function importPublishedFolder(onProgress?: (value: { uploaded: number; total: number; path: string }) => void): Promise<ArtifactManifest | null> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker
  if (!picker) throw new Error("当前浏览器不支持文件夹授权，请使用最新版 Chrome 或 Edge。")
  let directory: FileSystemDirectoryHandle
  try {
    directory = await picker({ mode: "read" })
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null
    throw error
  }

  const files = await collectFiles(directory)
  if (!files.some(({ path }) => /(?:\.fui|_fui\.bytes)$/i.test(path))) throw new Error("所选目录不包含 FairyGUI 发布包（.fui 或 _fui.bytes）。")
  const manifest: ArtifactImportFile[] = []
  for (const { file, path } of files) {
    onProgress?.({ uploaded: 0, total: files.length, path: `校验 ${path}…` })
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
    manifest.push({ path, size: file.size, sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") })
  }
  const createResponse = await fetch("/api/artifact-imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: directory.name,
      source: { kind: "published-folder" },
      files: manifest,
    }),
  })
  if (!createResponse.ok) throw new Error(await responseError(createResponse, "创建 Artifact 导入失败"))
  const { importId } = await createResponse.json() as { importId: string }

  try {
    let uploaded = 0
    for (const { file, path } of files) {
      onProgress?.({ uploaded, total: files.length, path })
      const response = await fetch(`/api/artifact-imports/${encodeURIComponent(importId)}/files?path=${encodeURIComponent(path)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      })
      if (!response.ok) throw new Error(await responseError(response, `上传 ${path} 失败`))
      uploaded += 1
    }
    onProgress?.({ uploaded, total: files.length, path: "正在校验发布包…" })
    const completeResponse = await fetch(`/api/artifact-imports/${encodeURIComponent(importId)}/complete`, { method: "POST" })
    if (!completeResponse.ok) throw new Error(await responseError(completeResponse, "Artifact 校验失败"))
    return (await completeResponse.json() as { artifact: ArtifactManifest }).artifact
  } catch (error) {
    // A disconnected client may not reach DELETE; the Host also expires pending imports.
    await fetch(`/api/artifact-imports/${encodeURIComponent(importId)}`, { method: "DELETE" }).catch(() => undefined)
    throw error
  }
}

async function collectFiles(directory: FileSystemDirectoryHandle) {
  const files: Array<{ file: File; path: string }> = []
  let totalBytes = 0
  const scan = async (current: FileSystemDirectoryHandle, parentPath: string) => {
    for await (const [name, handle] of (current as IterableDirectoryHandle).entries()) {
      const path = parentPath ? `${parentPath}/${name}` : name
      if (handle.kind === "file") {
        const file = await (handle as FileSystemFileHandle).getFile()
        totalBytes += file.size
        if (files.length >= MAX_ARTIFACT_FILES || file.size > MAX_ARTIFACT_FILE_BYTES || totalBytes > MAX_ARTIFACT_TOTAL_BYTES) {
          throw new Error("发布目录超过 5,000 个文件、单文件 128 MiB 或总量 512 MiB 的限制。")
        }
        files.push({ file, path })
      }
      else await scan(handle as FileSystemDirectoryHandle, path)
    }
  }
  await scan(directory, "")
  files.sort((left, right) => left.path.localeCompare(right.path))
  return files
}

async function responseError(response: Response, fallback: string) {
  try {
    const value = await response.json() as { error?: string }
    return value.error ? `${fallback}：${value.error}` : `${fallback} (${response.status})`
  } catch {
    return `${fallback} (${response.status})`
  }
}
