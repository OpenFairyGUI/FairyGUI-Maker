import { captureProjectSnapshot, projectPath, type ProjectScanOptions } from "../../project-snapshot"

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
  savedAt?: number
}

const DATABASE_NAME = "fairygui-maker"
const DATABASE_VERSION = 1
const BINDING_STORE = "project-bindings"

export async function authorizeProjectDirectory(options: ProjectScanOptions = {}): Promise<AuthorizedProjectSource | null> {
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker
  if (!picker) throw new Error("当前浏览器不支持文件夹授权，请使用最新版 Chrome 或 Edge。")

  let directory: FileSystemDirectoryHandle
  try {
    directory = await picker({ mode: "read" })
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null
    throw error
  }

  const { fairyPath, fairyguiProjectId, sourceRevision } = await readBrowserProjectSnapshot(directory, options)

  return {
    bindingId: crypto.randomUUID(),
    directory,
    directoryName: directory.name,
    fairyguiProjectId,
    fairyPath,
    name: fairyPath.split("/").at(-1)!.replace(/\.fairy$/i, ""),
    sourceRevision,
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

export function readBrowserProjectSnapshot(root: FileSystemDirectoryHandle, options: ProjectScanOptions = {}) {
  const directoryAt = async (path: string) => {
    let directory = root
    for (const part of projectPath(path).split("/").filter(Boolean)) directory = await directory.getDirectoryHandle(part)
    return directory
  }
  return captureProjectSnapshot({
    async *entries(path) {
      for await (const [name, handle] of (await directoryAt(path) as IterableDirectoryHandle).entries()) yield { name, kind: handle.kind }
    },
    async readFile(path, maxBytes, signal) {
      signal.throwIfAborted()
      const parts = path.split("/")
      const name = parts.pop()!
      const handle = await (await directoryAt(parts.join("/"))).getFileHandle(name)
      const file = await handle.getFile()
      signal.throwIfAborted()
      if (file.size > maxBytes) throw new Error("project_snapshot_byte_budget_exceeded")
      const data = new Uint8Array(await file.arrayBuffer())
      signal.throwIfAborted()
      if (data.byteLength !== file.size || data.byteLength > maxBytes) throw new Error("project_source_changed_during_read")
      return data
    },
  }, options)
}

export async function saveProjectBinding(source: AuthorizedProjectSource) {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(BINDING_STORE, "readwrite")
      transaction.objectStore(BINDING_STORE).put({ ...source, savedAt: Date.now() } satisfies PersistedProjectBinding)
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
      transaction.onabort = () => reject(transaction.error ?? new Error("工程绑定清理已中止。"))
    })
  } finally {
    database.close()
  }
}

/** Explicit cleanup only; retain fresh saves so another tab can finish Host registration. Legacy v1 records have no savedAt. */
export async function cleanupProjectBindings(registeredBindingIds: Set<string>) {
  const database = await openDatabase()
  try {
    return await new Promise<number>((resolve, reject) => {
      let removed = 0
      const transaction = database.transaction(BINDING_STORE, "readwrite")
      const request = transaction.objectStore(BINDING_STORE).openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) return
        const binding = cursor.value as PersistedProjectBinding
        if (!registeredBindingIds.has(binding.bindingId) && (binding.savedAt ?? 0) < Date.now() - 86_400_000) { cursor.delete(); removed++ }
        cursor.continue()
      }
      transaction.oncomplete = () => resolve(removed)
      transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("失效授权清理失败。"))
    })
  } finally { database.close() }
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
