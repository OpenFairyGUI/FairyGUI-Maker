import type { ArtifactManifest } from "../../artifact-protocol"

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
  const createResponse = await fetch("/api/artifact-imports", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: directory.name,
      source: { kind: "published-folder" },
      files: files.map(({ file, path }) => ({ path, size: file.size })),
    }),
  })
  if (!createResponse.ok) throw new Error(await responseError(createResponse, "创建 Artifact 导入失败"))
  const { importId } = await createResponse.json() as { importId: string }

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
}

async function collectFiles(directory: FileSystemDirectoryHandle) {
  const files: Array<{ file: File; path: string }> = []
  const scan = async (current: FileSystemDirectoryHandle, parentPath: string) => {
    for await (const [name, handle] of (current as IterableDirectoryHandle).entries()) {
      const path = parentPath ? `${parentPath}/${name}` : name
      if (handle.kind === "file") files.push({ file: await (handle as FileSystemFileHandle).getFile(), path })
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
