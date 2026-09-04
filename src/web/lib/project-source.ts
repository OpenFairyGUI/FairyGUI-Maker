export type ProjectBindingPermission = PermissionState | "missing" | "unavailable" | "host"

export type AuthorizedProjectSource = {
  bindingId: string
  directory: FileSystemDirectoryHandle
  directoryName: string
  fairyguiProjectId: string
  fairyPath: string
  name: string
  sourceRevision: string
}

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>
}

type IterableDirectoryHandle = FileSystemDirectoryHandle & {
  entries(): AsyncIterableIterator<[string, FileSystemHandle]>
}

type PermissionDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (descriptor: { mode: "read" }) => Promise<PermissionState>
}

type PersistedProjectBinding = Omit<AuthorizedProjectSource, "directory"> & {
  directory: FileSystemDirectoryHandle
}

const DATABASE_NAME = "fairygui-maker"
const DATABASE_VERSION = 1
const BINDING_STORE = "project-bindings"

export async function authorizeProjectDirectory(): Promise<AuthorizedProjectSource | null> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker
  if (!picker) throw new Error("当前浏览器不支持文件夹授权，请使用最新版 Chrome 或 Edge。")

  let directory: FileSystemDirectoryHandle
  try {
    directory = await picker({ mode: "read" })
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null
    throw error
  }

  const files = await collectProjectFiles(directory)
  const fairyFiles = files.filter(({ path }) => path.toLowerCase().endsWith(".fairy"))
  if (fairyFiles.length === 0) throw new Error("所选文件夹中没有 .fairy 工程文件。")
  if (fairyFiles.length > 1) {
    throw new Error(`所选文件夹包含多个 .fairy 工程：${fairyFiles.slice(0, 3).map(({ path }) => path).join("、")}`)
  }

  const [{ file, path: fairyPath }] = fairyFiles
  const document = new DOMParser().parseFromString(await file.text(), "application/xml")
  if (document.querySelector("parsererror") || document.documentElement.localName !== "projectDescription") {
    throw new Error(`${fairyPath} 不是有效的 FairyGUI 工程文件。`)
  }
  const fairyguiProjectId = document.documentElement.getAttribute("id")?.trim()
  if (!fairyguiProjectId) throw new Error(`${fairyPath} 缺少 projectDescription id。`)

  return {
    bindingId: crypto.randomUUID(),
    directory,
    directoryName: directory.name,
    fairyguiProjectId,
    fairyPath,
    name: fairyPath.split("/").at(-1)!.replace(/\.fairy$/i, ""),
    sourceRevision: await fingerprintProjectFiles(files),
  }
}

export async function getProjectBinding(bindingId: string): Promise<AuthorizedProjectSource | null> {
  const database = await openDatabase()
  try {
    return await new Promise<AuthorizedProjectSource | null>((resolve, reject) => {
      const request = database.transaction(BINDING_STORE, "readonly").objectStore(BINDING_STORE).get(bindingId)
      request.onsuccess = () => resolve((request.result as PersistedProjectBinding | undefined) ?? null)
      request.onerror = () => reject(request.error ?? new Error("工程绑定读取失败。"))
    })
  } finally {
    database.close()
  }
}

export async function refreshProjectSourceRevision(source: AuthorizedProjectSource) {
  return await fingerprintProjectFiles(await collectProjectFiles(source.directory))
}

export async function saveProjectBinding(source: AuthorizedProjectSource) {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(BINDING_STORE, "readwrite")
      transaction.objectStore(BINDING_STORE).put(source satisfies PersistedProjectBinding)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("工程绑定保存失败。"))
      transaction.onabort = () => reject(transaction.error ?? new Error("工程绑定保存已中止。"))
    })
  } finally {
    database.close()
  }
}

export async function deleteProjectBinding(bindingId: string) {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(BINDING_STORE, "readwrite")
      transaction.objectStore(BINDING_STORE).delete(bindingId)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error("工程绑定清理失败。"))
    })
  } finally {
    database.close()
  }
}

export async function queryProjectBindingPermission(bindingId: string): Promise<ProjectBindingPermission> {
  const database = await openDatabase()
  try {
    const binding = await new Promise<PersistedProjectBinding | undefined>((resolve, reject) => {
      const request = database.transaction(BINDING_STORE, "readonly").objectStore(BINDING_STORE).get(bindingId)
      request.onsuccess = () => resolve(request.result as PersistedProjectBinding | undefined)
      request.onerror = () => reject(request.error ?? new Error("工程绑定读取失败。"))
    })
    if (!binding) return "missing"
    const handle = binding.directory as PermissionDirectoryHandle
    if (!handle.queryPermission) return "unavailable"
    try {
      return await handle.queryPermission({ mode: "read" })
    } catch {
      return "unavailable"
    }
  } finally {
    database.close()
  }
}

async function scanDirectory(
  directory: FileSystemDirectoryHandle,
  parentPath: string,
  files: Array<{ file: File; path: string }>,
) {
  for await (const [name, handle] of (directory as IterableDirectoryHandle).entries()) {
    const path = parentPath ? `${parentPath}/${name}` : name
    if (handle.kind === "file") {
      files.push({ file: await (handle as FileSystemFileHandle).getFile(), path })
    } else {
      await scanDirectory(handle as FileSystemDirectoryHandle, path, files)
    }
  }
}

async function collectProjectFiles(directory: FileSystemDirectoryHandle) {
  const files: Array<{ file: File; path: string }> = []
  await scanDirectory(directory, "", files)
  return files
}

async function fingerprintProjectFiles(files: Array<{ file: File; path: string }>) {
  // ponytail: metadata fingerprint avoids reading every asset; use content digests if same-size timestamp spoofing matters.
  const fingerprint = files
    .map(({ file, path }) => `${path}\0${file.size}\0${file.lastModified}`)
    .sort()
    .join("\n")
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fingerprint)))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

function openDatabase(): Promise<IDBDatabase> {
  if (!globalThis.indexedDB) return Promise.reject(new Error("当前浏览器不支持 IndexedDB，无法保存工程授权。"))
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(BINDING_STORE)) {
        request.result.createObjectStore(BINDING_STORE, { keyPath: "bindingId" })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error("工程绑定数据库打开失败。"))
  })
}
