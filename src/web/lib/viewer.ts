import type { Document, UamAssetResource, UamComponentResource, UamProject, UamResource } from "@openfairygui/core"
import type { FileSystem } from "@openfairygui/core/project-io"
import { collectUamResourceReferences } from "../../asset-analysis"
import { snapshotFileSystem, type ProjectScanOptions } from "../../project-snapshot"
import {
  VIEWER_PROTOCOL_VERSION,
  type ViewerDiagnostic,
  type ViewerProjectCatalog,
  type ViewerRendered,
  type RenderSessionState,
  type ViewerScene,
} from "../../viewer-protocol"
import { getProject, refreshProject, registerViewerRenderer } from "./api"
import { startRendererDelivery } from "./renderer-delivery"
import { connectRendererChannel, executeRendererCommand, type RendererFrameSession } from "./renderer-frame"
import { createRenderSessionClient, type RenderSessionClient } from "./render-session"
import { prepareRuntimeFrame } from "../../runtime-channel"
import {
  getProjectBinding,
  queryProjectBindingPermission,
  readBrowserProjectSnapshot,
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

export async function readViewerProject(project: ViewerProjectRef, options: ProjectScanOptions = {}): Promise<ViewerProjectBundle> {
  const { project: current } = await getProject(project.projectId, options.signal)
  if (current.bindingId !== project.bindingId || current.fairyguiProjectId !== project.fairyguiProjectId || current.fairyPath !== project.fairyPath || current.sourceOwner !== project.sourceOwner) {
    throw new Error("工程绑定已改变，请从 Dashboard 重新打开。")
  }
  const [{ ProjectReader }, core] = await Promise.all([
    import("@openfairygui/core/project-io"),
    import("@openfairygui/core"),
  ])
  let sourceRevision = current.sourceRevision
  let document: Document
  if (project.sourceOwner === "host") {
    document = await new ProjectReader(await createHostProjectFileSystem(project.projectId, sourceRevision, options.signal)).read(project.fairyPath, { hydrateResourceBytes: true })
  } else {
    const browserSource = await getProjectBinding(project.bindingId)
    if (!browserSource) throw new Error("当前浏览器中找不到该工程的文件夹授权，请从 Dashboard 重新创建绑定。")
    const permission = await queryProjectBindingPermission(project.bindingId)
    if (permission !== "granted" && permission !== "unavailable") {
      throw new Error("需要重新授权读取 FairyGUI 工程文件夹。")
    }
    const snapshot = await readBrowserProjectSnapshot(browserSource.directory, options)
    if (snapshot.fairyPath !== current.fairyPath || snapshot.fairyguiProjectId !== current.fairyguiProjectId) throw new Error("目录中的工程身份已改变，请重新绑定。")
    sourceRevision = snapshot.sourceRevision
    document = snapshot.document
  }
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
  options.signal?.throwIfAborted()
  if (project.sourceOwner === "browser") {
    // Publish only after the frozen bytes and UAM are ready; a concurrent refresh must fail CAS, never overwrite it.
    await refreshProject(project.projectId, { bindingId: current.bindingId, fairyguiProjectId: current.fairyguiProjectId, expectedSourceRevision: current.sourceRevision, nextSourceRevision: sourceRevision }, options.signal)
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

async function createHostProjectFileSystem(projectId: string, sourceRevision: string, signal?: AbortSignal): Promise<FileSystem> {
  const base = `/api/projects/${encodeURIComponent(projectId)}`
  const indexResponse = await fetch(`${base}/source-index?sourceRevision=${sourceRevision}`, { signal })
  if (!indexResponse.ok) throw new Error("Host 中找不到 CLI 授权的工程快照。")
  const { files } = await indexResponse.json() as { files: Array<{ path: string; size: number }> }
  const filePaths = new Set(files.map(({ path }) => path))
  const cache = new Map<string, Promise<Uint8Array>>()
  const readRaw = (filePath: string) => {
    const safePath = filePath
    if (!filePaths.has(safePath)) return Promise.reject(new Error(`工程文件不存在：${safePath}`))
    const existing = cache.get(safePath)
    if (existing) return existing
    const pending = fetch(`${base}/source-file?path=${encodeURIComponent(safePath)}&sourceRevision=${sourceRevision}`, { signal }).then(async (response) => {
      if (!response.ok) throw new Error(`工程文件读取失败：${safePath}`)
      return new Uint8Array(await response.arrayBuffer())
    })
    cache.set(safePath, pending)
    return pending
  }
  return snapshotFileSystem(filePaths, readRaw)
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

async function connectViewerFrame(frame: HTMLIFrameElement, bundle: ViewerProjectBundle, signal: AbortSignal): Promise<RendererFrameSession> {
  if (!frame.contentWindow) throw new Error("Viewer iframe 尚未就绪。")
  const connection = await prepareRuntimeFrame(frame, signal)
  const runtime = await connectRendererChannel(frame.contentWindow, "Viewer", { ...connection, sourceRevision: bundle.sourceRevision }, signal)
  return {
    ...runtime,
    render(packageId, componentId, expectedRuntimeEventSeq) {
      const component = bundle.catalog.packages.find((pkg) => pkg.packageId === packageId)?.components.find((item) => item.id === componentId)
      if (!component) throw new Error(`Viewer resource not found: ${packageId}/${componentId}`)
      const scene = compileViewerScene(bundle, packageId, componentId)
      return runtime.send<ViewerRendered & { runtimeEventSeq: number }>({ kind: "render", scene, expectedRuntimeEventSeq }, scene.assets.map(({ data }) => data))
    },
  }
}

export async function startViewerRenderer(projectId: string, bundle: ViewerProjectBundle, iframe: HTMLIFrameElement, onState: (state: RenderSessionState) => void, onError: (error: Error) => void, signal: AbortSignal) {
  const frame = await connectViewerFrame(iframe, bundle, signal)
  if (signal.aborted) { frame.destroy(); signal.throwIfAborted() }
  let client: RenderSessionClient | undefined
  const delivery = await startRendererDelivery(
    (signal) => registerViewerRenderer({
      projectId,
      sourceRevision: bundle.sourceRevision,
      protocolVersion: VIEWER_PROTOCOL_VERSION,
      catalog: bundle.catalog,
    }, signal),
    frame,
    (command) => executeRendererCommand("Viewer", frame, command),
    onError,
    signal,
    (state) => client?.accept(state),
  )
  client = createRenderSessionClient(delivery.session, onState, signal)
  return { client, renderSessionId: delivery.renderSessionId, stop: () => { delivery.stop(); frame.destroy() } }
}

function resourceKey(packageId: string, resourceId: string) {
  return `${packageId}/${resourceId}`
}
