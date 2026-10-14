import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, getRouteApi } from "@tanstack/react-router"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { Camera, ChevronsDownUp, ChevronsUpDown, FolderPlus, PanelLeftClose, PanelLeftOpen, RefreshCw, Search, ServerCog, ZoomIn, ZoomOut } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { RenderCommandStatus, RenderStateControls, ViewerComponentList, brokerRendered } from "@/components/render-session"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ErrorState, ViewerLoading, projectSourceLabel } from "@/components/workbench"
import type { VisualCaptureInfo } from "@/design-import"
import { getProject, getProjects, type RegisteredProjectData } from "@/lib/api"
import { watchRenderViewport, type RenderSessionClient } from "@/lib/render-session"
import { readViewerProject, startViewerRenderer } from "@/lib/viewer"
import type { RenderSessionState } from "../viewer-protocol"

const projectViewerRoute = getRouteApi("/projects/$projectId/viewer")

export function ViewerPage() {
  const projects = useQuery({ queryKey: ["projects", "list"], queryFn: getProjects })
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Project projection</p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Viewer</h1>
        <p className="mt-2 text-sm text-muted-foreground">工程态资源的浏览器预览入口。</p>
      </div>
      <Card>
        <CardHeader className="border-b">
          <CardTitle>选择工程</CardTitle>
          <CardDescription>Viewer 从 Dashboard 中已经授权的只读 FairyGUI 工程启动。</CardDescription>
        </CardHeader>
        <CardContent>
          {projects.data?.projects.length ? (
            <div className="divide-y">
              {projects.data.projects.map((project) => (
                <div key={project.projectId} className="flex items-center gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{project.name}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{projectSourceLabel(project)}</p>
                  </div>
                  <Button asChild variant="outline"><Link to="/projects/$projectId/viewer" params={{ projectId: project.projectId }}>打开 Viewer</Link></Button>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid min-h-52 place-items-center p-8 text-center">
              <div className="max-w-md">
                <FolderPlus className="mx-auto mb-4 size-9 text-blue-400" />
                <h2 className="text-lg font-medium">尚无可预览工程</h2>
                <p className="mt-2 text-sm text-muted-foreground">先在 Dashboard 授权 FairyGUI 工程文件夹，再从这里进入 Viewer。</p>
                <Button asChild className="mt-4"><Link to="/">返回 Dashboard</Link></Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function ProjectViewerPage() {
  const { projectId } = projectViewerRoute.useParams()
  const project = useQuery({ queryKey: ["projects", projectId], queryFn: () => getProject(projectId) })
  if (project.isError) return <ErrorState retry={() => void project.refetch()} />

  return project.data
    ? <ProjectViewer project={project.data.project} />
    : <ViewerLoading message="正在读取项目绑定…" />
}

export function ProjectViewer({ project, compact = false, onCapture }: { project: RegisteredProjectData; compact?: boolean; onCapture?: (blob: Blob, info: VisualCaptureInfo) => Promise<void> }) {
  const queryClient = useQueryClient()
  const [scanProgress, setScanProgress] = useState("")
  const [scanCancelled, setScanCancelled] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const resourcePanelRef = useRef<PanelImperativeHandle>(null)
  const [session, setSession] = useState<RenderSessionClient | null>(null)
  const [brokerState, setBrokerState] = useState<RenderSessionState | null>(null)
  const rendered = brokerRendered(brokerState)
  const selected = rendered
  const [filter, setFilter] = useState("")
  const [runtimeError, setRuntimeError] = useState("")
  const [renderSessionId, setRenderSessionId] = useState("")
  const zoom = brokerState?.view.zoom ?? 1
  const background = brokerState?.view.background ?? "#202226"
  const [commandError, setCommandError] = useState("")
  const commandFailed = (error: unknown) => setCommandError(error instanceof Error ? error.message : String(error))
  const [busyAction, setBusyAction] = useState<"capture" | null>(null)
  const [resourcesCollapsed, setResourcesCollapsed] = useState(false)
  const [collapsedPackages, setCollapsedPackages] = useState(() => new Set<string>())
  const bundle = useQuery({
    queryKey: ["viewer-project", project.projectId, project.sourceRevision],
    queryFn: ({ signal }) => { setScanCancelled(false); return readViewerProject(project, { signal, onProgress: setScanProgress }) },
    retry: false,
    staleTime: Infinity,
  })

  useEffect(() => {
    const frame = iframeRef.current
    if (!frame || !bundle.data || bundle.isFetching || bundle.isError || scanCancelled) return
    let disposed = false
    let stopRenderer: (() => void) | null = null
    const lifetime = new AbortController()
    const connect = async () => {
      try {
        setRuntimeError("")
        const renderer = await startViewerRenderer(project.projectId, bundle.data, frame, setBrokerState, (error) => {
          if (disposed) return
          lifetime.abort()
          setSession(null)
          setRenderSessionId("")
          setRuntimeError(error.message)
        }, lifetime.signal)
        stopRenderer = renderer.stop
        if (disposed) { renderer.stop(); return }
        setSession(renderer.client)
        await renderer.client.setView({ width: Math.max(1, frame.clientWidth), height: Math.max(1, frame.clientHeight) })
        watchRenderViewport(frame, renderer.client, commandFailed, lifetime.signal)
        const pkg = bundle.data.catalog.packages.find((candidate) => candidate.components.length > 0)
        if (pkg) await renderer.client.render(pkg.packageId, pkg.components[0].id).catch(commandFailed)
        setRenderSessionId(renderer.renderSessionId)
      } catch (error) {
        if (!disposed) {
          lifetime.abort()
          setSession(null)
          setRenderSessionId("")
          setRuntimeError(error instanceof Error ? error.message : String(error))
        }
      }
    }
    void connect()
    return () => {
      disposed = true
      lifetime.abort()
      stopRenderer?.()
      setSession(null)
      setRenderSessionId("")
      setBrokerState(null)
    }
  }, [bundle.data, bundle.dataUpdatedAt, bundle.isFetching, bundle.isError, scanCancelled, project.projectId])

  const filteredPackages = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    if (!bundle.data || !query) return bundle.data?.catalog.packages ?? []
    return bundle.data.catalog.packages.flatMap((pkg) => {
      const components = pkg.components.filter((component) => `${pkg.packageName}/${component.name}`.toLocaleLowerCase().includes(query))
      return components.length ? [{ ...pkg, components }] : []
    })
  }, [bundle.data, filter])
  const allPackagesCollapsed = filteredPackages.length > 0 && filteredPackages.every(({ packageId }) => collapsedPackages.has(packageId))

  const capture = async () => {
    if (!session || !selected) return
    setBusyAction("capture")
    try {
      const { blob, result } = await session.capture()
      const component = result.value.component as Pick<VisualCaptureInfo, "packageId" | "componentId" | "packageName" | "componentName">
      if (onCapture) {
        await onCapture(blob, {
          ...component,
          renderState: { renderSessionId: result.renderSessionId, sourceRevision: result.sourceRevision, semanticStateVersion: result.semanticStateVersion, viewStateVersion: result.viewStateVersion },
        })
        return
      }
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `${component.packageName}-${component.componentName}.png`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      commandFailed(error)
    } finally {
      setBusyAction(null)
    }
  }

  const toggleResources = () => {
    const panel = resourcePanelRef.current
    if (!panel) return
    if (panel.isCollapsed()) panel.expand()
    else panel.collapse()
  }

  return (
    <div className="space-y-4">
      <section className="space-y-4">
        {!compact ? <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Project Viewer</p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{projectSourceLabel({ ...project, backendSession: bundle.data?.backendSession ?? project.backendSession })} · 尚未发布的工程 · 只读</p>
        </div> : null}
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3 shadow-sm">
          <RenderStateControls rendered={rendered} session={session} onError={setCommandError} />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => void bundle.refetch()} disabled={bundle.isFetching}>
              <RefreshCw className={bundle.isFetching ? "animate-spin" : ""} />刷新工程
            </Button>
            {bundle.isFetching ? <Button variant="outline" size="sm" onClick={() => { setScanCancelled(true); void queryClient.cancelQueries({ queryKey: ["viewer-project", project.projectId] }) }}>取消扫描</Button> : null}
            <Badge variant="outline">{renderSessionId ? "AGENT READY" : "AGENT WAITING"}</Badge>
            <Button variant="outline" size="sm" onClick={() => void session?.setView({ zoom: Math.max(0.25, zoom - 0.1) }).catch(commandFailed)} disabled={!session} aria-label="缩小"><ZoomOut /></Button>
            <span className="min-w-14 text-center text-xs text-muted-foreground">{Math.round(zoom * 100)}%</span>
            <Button variant="outline" size="sm" onClick={() => void session?.setView({ zoom: Math.min(4, zoom + 0.1) }).catch(commandFailed)} disabled={!session} aria-label="放大"><ZoomIn /></Button>
            <Button variant="outline" size="sm" onClick={() => void session?.setView({ background: background === "#202226" ? "#f4f4f5" : "#202226" }).catch(commandFailed)} disabled={!session}>背景</Button>
            <Button size="sm" onClick={() => void capture()} disabled={!session || !selected || busyAction !== null}><Camera />{onCapture ? "捕获视觉证据" : "截图"}</Button>
          </div>
        </div>
      </section>

      <Card className="overflow-hidden">
        <CardContent className="h-[62vh] min-h-[440px] max-h-[680px] p-0">
          <ResizablePanelGroup orientation="horizontal" className="h-full">
            <ResizablePanel id="viewer-resources" panelRef={resourcePanelRef} defaultSize={340} minSize={280} maxSize={520} collapsible collapsedSize={44} onResize={({ inPixels }) => setResourcesCollapsed(inPixels <= 44)} className="min-w-0 bg-card">
              <div className="flex h-full min-h-0 flex-col overflow-hidden">
                {resourcesCollapsed ? (
                  <Button variant="ghost" size="icon" onClick={toggleResources} aria-label="展开组件列表" title="展开组件列表" className="mx-auto mt-2 shrink-0"><PanelLeftOpen /></Button>
                ) : (
                  <>
                    <div className="flex shrink-0 items-center gap-2 border-b p-3">
                      <label className="relative min-w-0 flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                        <input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索 Package / Component" aria-label="搜索 Viewer 组件" className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" />
                      </label>
                      <Button variant="ghost" size="icon" onClick={() => setCollapsedPackages(allPackagesCollapsed ? new Set<string>() : new Set(filteredPackages.map(({ packageId }) => packageId)))} aria-label={allPackagesCollapsed ? "展开全部 Package" : "折叠全部 Package"} title={allPackagesCollapsed ? "展开全部 Package" : "折叠全部 Package"} disabled={filteredPackages.length === 0} className="shrink-0">{allPackagesCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}</Button>
                      <Button variant="ghost" size="icon" onClick={toggleResources} aria-label="折叠组件列表" title="折叠组件列表" className="shrink-0"><PanelLeftClose /></Button>
                    </div>
                    {bundle.data
                      ? <ViewerComponentList packages={filteredPackages} selected={selected} onSelect={({ packageId, componentId }) => void session?.render(packageId, componentId).catch(commandFailed)} collapsedPackages={collapsedPackages} onCollapsedPackagesChange={setCollapsedPackages} />
                      : bundle.isError
                        ? <div className="grid min-h-0 flex-1 place-items-center p-4 text-center text-sm text-muted-foreground">工程模型读取失败</div>
                        : <ViewerLoading message="正在读取当前工程模型…" compact />}
                  </>
                )}
              </div>
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="viewer-canvas" minSize={360} className="min-w-0">
              <div className="relative h-full min-h-0 bg-[#202226]">
                <iframe key={`${bundle.dataUpdatedAt}:${bundle.isFetching}`} ref={iframeRef} data-runtime="/viewer-runtime.html" title="FairyGUI LayaAir Viewer Runtime" sandbox="allow-scripts" className="absolute inset-0 size-full border-0" />
                {(bundle.isFetching || (bundle.data && !session && !runtimeError && !bundle.isError && !scanCancelled)) && (
                  <div className="absolute inset-0 grid place-items-center bg-background/80 backdrop-blur-sm">
                    <ViewerLoading message={bundle.isFetching ? scanProgress || "正在读取当前工程模型…" : "正在启动 LayaAir 3.3.10…"} />
                  </div>
                )}
                {(bundle.isError || runtimeError) && (
                  <div role="alert" className="absolute inset-0 grid place-items-center bg-background/90 p-8 text-center">
                    <div className="max-w-lg">
                      <ServerCog className="mx-auto mb-4 size-9 text-destructive" />
                      <p className="font-medium">Viewer 已停止</p>
                      <p className="mt-2 text-sm text-muted-foreground">{runtimeError || (bundle.error instanceof Error ? bundle.error.message : "未知错误")}</p>
                      <div className="mt-4 flex justify-center gap-2">
                        <Button variant="outline" onClick={() => runtimeError ? window.location.reload() : void bundle.refetch()}>{runtimeError ? "重新连接" : "重试"}</Button>
                        <Button asChild><Link to="/">返回 Dashboard</Link></Button>
                      </div>
                    </div>
                  </div>
                )}
                {scanCancelled && !bundle.isFetching && <div role="status" className="absolute inset-0 grid place-items-center bg-background/90 p-8 text-center">扫描已取消，请点击“刷新工程”重新读取。</div>}
                {rendered && session && !runtimeError && (
                  <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border bg-background/85 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur">{rendered.packageName}/{rendered.componentName} · {rendered.width}×{rendered.height}</div>
                )}
              </div>
            </ResizablePanel>
          </ResizablePanelGroup>
        </CardContent>
      </Card>
      <RenderCommandStatus state={brokerState} error={commandError} dismiss={() => setCommandError("")} />
      {bundle.data?.diagnostics.some(({ level }) => level === "warning") && (
        <p className="text-xs text-amber-500">{bundle.data.diagnostics.filter(({ level }) => level === "warning").map(({ message }) => message).join("；")}</p>
      )}
    </div>
  )
}
