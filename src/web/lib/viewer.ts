import type { Document, UamAssetResource, UamComponentResource, UamProject, UamResource } from "@openfairygui/core"
import type { FileSystem } from "@openfairygui/core/project-io"
import { collectUamResourceReferences } from "../../asset-analysis"
import {
  VIEWER_PROTOCOL_VERSION,
  type ViewerBrokerCommand,
  type ViewerCommand,
  type ViewerConnectMessage,
  type ViewerDiagnostic,
  type ViewerInteractionEvent,
  type ViewerObservation,
  type ViewerOperation,
  type ViewerProjectCatalog,
  type ViewerRendered,
  type ViewerRuntimeMessage,
  type ViewerScene,
} from "../../viewer-protocol"
import { registerViewerRenderer } from "./api"
import { startRendererDelivery } from "./renderer-delivery"
import {
  getProjectBinding,
  queryProjectBindingPermission,
  refreshProjectSourceRevision,
} from "./project-source"

export type ViewerProjectRef = {
  projectId: string
  bindingId: string
  fairyguiProjectId: string
  fairyPath: string
  sourceOwner: "browser" | "host"
  sourceRevision: string
}

export type ViewerProjectBundle = {
  sourceRevision: string
  project: UamProject
  catalog: ViewerProjectCatalog
  diagnostics: ViewerDiagnostic[]
}

export async function readViewerProject(project: ViewerProjectRef): Promise<ViewerProjectBundle> {
  const [{ createFileSystemAccessFileSystem }, { ProjectReader }, core] = await Promise.all([
    import("@openfairygui/core/web"),
    import("@openfairygui/core/project-io"),
    import("@openfairygui/core"),
  ])
  let sourceRevision = project.sourceRevision
  let fileSystem: FileSystem
  let browserSource: Awaited<ReturnType<typeof getProjectBinding>> = null
  if (project.sourceOwner === "host") {
    fileSystem = await createHostProjectFileSystem(project.projectId)
  } else {
    browserSource = await getProjectBinding(project.bindingId)
    if (!browserSource) throw new Error("当前浏览器中找不到该工程的文件夹授权，请从 Dashboard 重新创建绑定。")
    const permission = await queryProjectBindingPermission(project.bindingId)
    if (permission !== "granted" && permission !== "unavailable") {
      throw new Error("需要重新授权读取 FairyGUI 工程文件夹。")
    }
    sourceRevision = await refreshProjectSourceRevision(browserSource)
    fileSystem = createFileSystemAccessFileSystem(browserSource.directory as unknown as Parameters<typeof createFileSystemAccessFileSystem>[0])
  }
  const document = await new ProjectReader(fileSystem).read(project.fairyPath, { hydrateResourceBytes: true })
  const root = document.getRoot()
  if (root.getProjectId() !== project.fairyguiProjectId) {
    throw new Error("文件夹中的 FairyGUI 工程 ID 与 Dashboard 绑定不一致，请重新创建项目绑定。")
  }

  const uam = core.normalizeUamProject(core.liftDocumentToUamProject(document))
  restoreImagePackageRefs(document, uam)
  const diagnostics = core.validateUamProject(uam).map<ViewerDiagnostic>((issue) => ({
    level: "warning",
    code: "uam_validation",
    path: issue.path,
    message: issue.message,
  }))
  if (browserSource && sourceRevision !== await refreshProjectSourceRevision(browserSource)) {
    throw new Error("FairyGUI 工程在 Viewer 读取过程中发生了变化，请刷新后重试。")
  }

  return {
    sourceRevision,
    project: uam,
    catalog: {
      schemaVersion: 1,
      source: { projectId: uam.projectId },
      packages: uam.packages.map((pkg) => ({
        packageId: pkg.id,
        packageName: pkg.name,
        components: pkg.resources
          .filter((resource): resource is UamComponentResource => resource.kind === "component")
          .map((resource) => ({ id: resource.id, name: resource.name })),
      })),
    },
    diagnostics,
  }
}

async function createHostProjectFileSystem(projectId: string): Promise<FileSystem> {
  const indexResponse = await fetch(`/api/projects/${encodeURIComponent(projectId)}/source-index`)
  if (!indexResponse.ok) throw new Error("Host 中找不到 CLI 授权的工程快照。")
  const { files } = await indexResponse.json() as { files: Array<{ path: string; size: number }> }
  const filePaths = new Set(files.map(({ path }) => path))
  const cache = new Map<string, Promise<Uint8Array>>()
  const readRaw = (filePath: string) => {
    const safePath = normalizeProjectPath(filePath)
    if (!filePaths.has(safePath)) return Promise.reject(new Error(`工程文件不存在：${safePath}`))
    const existing = cache.get(safePath)
    if (existing) return existing
    const pending = fetch(`/api/projects/${encodeURIComponent(projectId)}/source-file?path=${encodeURIComponent(safePath)}`).then(async (response) => {
      if (!response.ok) throw new Error(`工程文件读取失败：${safePath}`)
      return new Uint8Array(await response.arrayBuffer())
    })
    cache.set(safePath, pending)
    return pending
  }
  const readonly = async () => { throw new Error("CLI 工程快照为只读。") }
  return {
    async readFile(filePath) { return new TextDecoder().decode(await readRaw(filePath)) },
    readFileRaw: readRaw,
    writeFile: readonly,
    writeFileRaw: readonly,
    mkdir: readonly,
    async readdir(directory) {
      const safeDirectory = directory === "" || directory === "." ? "" : normalizeProjectPath(directory)
      const prefix = safeDirectory ? `${safeDirectory}/` : ""
      return [...new Set([...filePaths].flatMap((filePath) => {
        if (!filePath.startsWith(prefix)) return []
        const remainder = filePath.slice(prefix.length)
        const slash = remainder.indexOf("/")
        return slash === -1 ? [] : [remainder.slice(0, slash)]
      }))]
    },
    async exists(filePath) {
      const safePath = normalizeProjectPath(filePath)
      return filePaths.has(safePath) || [...filePaths].some((candidate) => candidate.startsWith(`${safePath}/`))
    },
    join: (...paths) => normalizeProjectPath(paths.filter(Boolean).join("/")),
    dirname(filePath) {
      const safePath = normalizeProjectPath(filePath)
      return safePath.includes("/") ? safePath.slice(0, safePath.lastIndexOf("/")) : "."
    },
  }
}

function normalizeProjectPath(value: string) {
  const segments: string[] = []
  for (const segment of value.replaceAll("\\", "/").split("/")) {
    if (!segment || segment === ".") continue
    if (segment === "..") {
      if (!segments.pop()) throw new Error("工程路径越界。")
    } else {
      segments.push(segment)
    }
  }
  if (segments.length === 0) throw new Error("工程路径为空。")
  return segments.join("/")
}

export function compileViewerScene(bundle: ViewerProjectBundle, packageId: string, componentId: string): ViewerScene {
  const diagnostics: ViewerDiagnostic[] = []
  const packages = new Map(bundle.project.packages.map((pkg) => [pkg.id, pkg]))
  const components = new Map<string, ViewerScene["components"][number]>()
  const assets = new Map<string, ViewerScene["assets"][number]>()
  const visiting = new Set<string>()
  let byteLength = 0

  const diagnostic = (level: ViewerDiagnostic["level"], code: string, path: string, message: string) => {
    diagnostics.push({ level, code, path, message })
  }
  const resourceAt = (ownerPackageId: string, resourceId: string): { packageId: string; packageName: string; resource: UamResource } | null => {
    const pkg = packages.get(ownerPackageId)
    const resource = pkg?.resources.find((candidate) => candidate.id === resourceId)
    if (!pkg || !resource) return null
    return { packageId: pkg.id, packageName: pkg.name, resource }
  }
  const addResource = (ownerPackageId: string, resourceId: string, path: string) => {
    if (!resourceId) return
    if (components.size + assets.size >= 5_000) throw new Error("Viewer 组件依赖超过 5000 个资源，已停止读取。")
    const entry = resourceAt(ownerPackageId, resourceId)
    if (!entry) {
      diagnostic("error", "resource_missing", path, `找不到 FairyGUI 资源 ${ownerPackageId}/${resourceId}。`)
      return
    }
    const key = resourceKey(entry.packageId, entry.resource.id)
    if (entry.resource.kind === "component") {
      if (visiting.has(key)) {
        diagnostic("warning", "component_cycle", path, `检测到循环组件引用 ${entry.packageName}/${entry.resource.name}。`)
        return
      }
      if (components.has(key)) return
      visiting.add(key)
      components.set(key, { packageId: entry.packageId, packageName: entry.packageName, resource: structuredClone(entry.resource) })
      for (const reference of collectUamResourceReferences(entry.packageId, entry.resource, (invalidPath, value) => {
        diagnostic("warning", "url_invalid", invalidPath, `无法解析 FairyGUI URL：${value}`)
      })) addResource(reference.packageId, reference.resourceId, reference.path)
      for (const transition of entry.resource.component.transitions) {
        for (const item of transition.items) {
          if (item.actionType < 0 || item.actionType > 15) {
            diagnostic("warning", "transition_action_unsupported", `component:${entry.packageId}/${entry.resource.id}/transition:${transition.name}`, `Transition ${transition.name} 包含未知 actionType ${item.actionType}。`)
          }
        }
      }
      visiting.delete(key)
      return
    }
    if (assets.has(key)) return
    const sourceBytes = entry.resource.sourceBytes
    if (!sourceBytes?.byteLength) {
      diagnostic("error", "asset_bytes_missing", path, `资源 ${entry.packageName}/${entry.resource.name} 没有可读取的源文件字节。`)
      return
    }
    byteLength += sourceBytes.byteLength
    if (byteLength > 256 * 1024 * 1024) throw new Error("Viewer 组件依赖超过 256 MiB，已停止读取。")
    const { sourceBytes: _sourceBytes, ...resource } = entry.resource
    assets.set(key, {
      packageId: entry.packageId,
      packageName: entry.packageName,
      resource: structuredClone(resource) as Omit<UamAssetResource, "sourceBytes">,
      data: sourceBytes.slice().buffer,
    })
    for (const reference of collectUamResourceReferences(entry.packageId, entry.resource)) {
      addResource(reference.packageId, reference.resourceId, reference.path)
    }
  }

  addResource(packageId, componentId, `component:${packageId}/${componentId}`)
  const root = resourceAt(packageId, componentId)
  if (!root || root.resource.kind !== "component") throw new Error(`找不到 Viewer 组件 ${packageId}/${componentId}。`)

  return {
    schemaVersion: 1,
    sourceRevision: bundle.sourceRevision,
    projectId: bundle.project.projectId,
    root: { packageId, resourceId: componentId },
    components: [...components.values()],
    assets: [...assets.values()],
    diagnostics,
  }
}

function restoreImagePackageRefs(document: Document, project: UamProject) {
  for (const sourcePackage of document.getRoot().listPackages()) {
    const targetPackage = project.packages.find((pkg) => pkg.id === sourcePackage.getId())
    if (!targetPackage) continue
    for (const sourceComponent of sourcePackage.listComponents()) {
      const targetComponent = targetPackage.resources.find((resource): resource is UamComponentResource => (
        resource.kind === "component" && resource.id === sourceComponent.getId()
      ))
      if (!targetComponent) continue
      const sourceNodes = new Map(sourceComponent.listChildren().map((node) => [node.getId(), node]))
      for (const node of targetComponent.component.displayList) {
        if (node.kind !== "image") continue
        const sourceNode = sourceNodes.get(node.id) as { getPackageId?(): string } | undefined
        const referencedPackageId = sourceNode?.getPackageId?.()
        if (referencedPackageId) node.resource.packageId = referencedPackageId
      }
    }
  }
}

export type ViewerFrameSession = {
  render(packageId: string, componentId: string): Promise<ViewerRendered>
  capture(): Promise<Blob>
  observe(): Promise<ViewerObservation>
  setView(zoom: number, background: string): Promise<void>
  playTransition(transitionName?: string): Promise<void>
  applyOperations(operations: ViewerOperation[]): Promise<Record<string, unknown>>
  setInteractionHandler(handler: ((event: ViewerInteractionEvent) => void) | null): void
  destroy(): void
}

export async function connectViewerFrame(
  frame: HTMLIFrameElement,
  bundle: ViewerProjectBundle,
  onRendered: (value: ViewerRendered) => void,
): Promise<ViewerFrameSession> {
  if (!frame.contentWindow) throw new Error("Viewer iframe 尚未就绪。")
  const channel = new MessageChannel()
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timeout: number }>()
  let interactionHandler: ((event: ViewerInteractionEvent) => void) | null = null
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  const readyTimeout = window.setTimeout(() => rejectReady(new Error("LayaAir Viewer runtime 启动超时。")), 20_000)

  channel.port1.onmessage = (event: MessageEvent<ViewerRuntimeMessage>) => {
    const message = event.data
    if (message.kind === "ready") {
      window.clearTimeout(readyTimeout)
      resolveReady()
      return
    }
    if (message.kind === "fatal") {
      window.clearTimeout(readyTimeout)
      rejectReady(new Error(message.error))
      return
    }
    if (message.kind === "rendered") {
      onRendered(message.value)
      return
    }
    if (message.kind === "interaction") {
      interactionHandler?.(message.value)
      return
    }
    if (message.kind !== "response") return
    const request = pending.get(message.requestId)
    if (!request) return
    window.clearTimeout(request.timeout)
    pending.delete(message.requestId)
    if (message.ok) request.resolve(message.value)
    else request.reject(new Error(message.error))
  }
  channel.port1.start()

  const connectMessage: ViewerConnectMessage = {
    type: "fairygui.viewer.connect",
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    sourceRevision: bundle.sourceRevision,
  }
  frame.contentWindow.postMessage(connectMessage, location.origin, [channel.port2])
  await ready

  const send = <T>(command: ViewerCommandInput, transfer: Transferable[] = []): Promise<T> => {
    const requestId = crypto.randomUUID()
    return new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        pending.delete(requestId)
        reject(new Error(`Viewer runtime command timed out: ${command.kind}`))
      }, 20_000)
      pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject, timeout })
      channel.port1.postMessage({ ...command, requestId } as ViewerCommand, transfer)
    })
  }

  return {
    render(packageId, componentId) {
      const scene = compileViewerScene(bundle, packageId, componentId)
      return send<ViewerRendered>({ kind: "render", scene }, scene.assets.map(({ data }) => data))
    },
    async capture() {
      const value = await send<{ data: ArrayBuffer; type: string }>({ kind: "capture" })
      return new Blob([value.data], { type: value.type })
    },
    observe: () => send<ViewerObservation>({ kind: "observe" }),
    setView: (zoom, background) => send<void>({ kind: "set-view", zoom, background }),
    playTransition: (transitionName) => send<void>({ kind: "play-transition", transitionName }),
    applyOperations: (operations) => send<Record<string, unknown>>({ kind: "apply-operations", operations }),
    setInteractionHandler(handler) {
      interactionHandler = handler
    },
    destroy() {
      window.clearTimeout(readyTimeout)
      for (const request of pending.values()) {
        window.clearTimeout(request.timeout)
        request.reject(new Error("Viewer runtime session closed."))
      }
      pending.clear()
      channel.port1.close()
    },
  }
}

export async function startViewerRenderer(projectId: string, bundle: ViewerProjectBundle, frame: ViewerFrameSession, onError: (error: Error) => void, signal: AbortSignal) {
  return startRendererDelivery(
    (signal) => registerViewerRenderer({
      projectId,
      sourceRevision: bundle.sourceRevision,
      protocolVersion: VIEWER_PROTOCOL_VERSION,
      catalog: bundle.catalog,
    }, signal),
    frame,
    (command) => executeBrokerCommand(bundle, frame, command),
    onError,
    signal,
  )
}

async function executeBrokerCommand(bundle: ViewerProjectBundle, frame: ViewerFrameSession, command: ViewerBrokerCommand) {
  if (command.kind === "capture") return { screenshotBase64: await blobToBase64(await frame.capture()) }
  if (command.kind === "observe") return { observation: await frame.observe() }
  if (command.kind === "update") {
    const operations = command.payload.operations
    if (!Array.isArray(operations)) throw new Error("Viewer update command is missing operations.")
    return await frame.applyOperations(operations as ViewerOperation[])
  }

  const packageId = String(command.payload.packageId ?? "")
  const componentId = String(command.payload.componentId ?? "")
  const pkg = bundle.catalog.packages.find((candidate) => candidate.packageId === packageId)
  const component = pkg?.components.find((candidate) => candidate.id === componentId)
  if (!pkg || !component) throw new Error(`Viewer resource not found: ${packageId}/${componentId}`)
  const rendered = await frame.render(packageId, componentId)
  return {
    rendered,
    observation: { objectTree: rendered.objectTree, controllers: rendered.controllers },
    ...(command.payload.capture === true ? { screenshotBase64: await blobToBase64(await frame.capture()) } : {}),
  }
}

function blobToBase64(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("Viewer screenshot encoding failed."))
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "")
    reader.readAsDataURL(blob)
  })
}

function resourceKey(packageId: string, resourceId: string) {
  return `${packageId}/${resourceId}`
}

type WithoutRequestId<T> = T extends unknown ? Omit<T, "requestId"> : never
type ViewerCommandInput = WithoutRequestId<ViewerCommand>
