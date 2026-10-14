import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, getRouteApi } from "@tanstack/react-router"
import type { PanelImperativeHandle } from "react-resizable-panels"
import { Archive, Camera, ChevronsDownUp, ChevronsUpDown, PanelLeftClose, PanelLeftOpen, Search, ServerCog, ZoomIn, ZoomOut } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { RenderCommandStatus, RenderStateControls, ViewerComponentList, brokerRendered } from "@/components/render-session"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { ArtifactTrust, ErrorState, ViewerLoading, formatTime } from "@/components/workbench"
import { getArtifact } from "@/lib/api"
import { importPublishedFolder } from "@/lib/artifacts"
import { startPlayerRenderer } from "@/lib/player"
import { artifactsQuery } from "@/lib/queries"
import { watchRenderViewport, type RenderSessionClient } from "@/lib/render-session"
import type { ViewerRendered, RenderSessionState } from "../viewer-protocol"
import type { ArtifactManifest } from "../artifact-protocol"

const artifactPlayerRoute = getRouteApi("/artifacts/$artifactId/player")

export function PlayerPage() {
  const queryClient = useQueryClient()
  const artifacts = useQuery(artifactsQuery)
  const [progress, setProgress] = useState("")
  const artifactImport = useMutation({
    mutationFn: () => importPublishedFolder(({ uploaded, total, path }) => setProgress(`${uploaded}/${total} · ${path}`)),
    onSuccess: async (artifact) => {
      setProgress("")
      if (artifact) await queryClient.invalidateQueries({ queryKey: artifactsQuery.queryKey })
    },
    onError: () => setProgress(""),
  })
  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Published runtime</p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">Player</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">读取已经发布的 FairyGUI 二进制包，以原生 UIPackage 控件呈现、交互、回放并接受 Agent 操作。</p>
        </div>
        <Button onClick={() => artifactImport.mutate()} disabled={artifactImport.isPending}><Archive className={artifactImport.isPending ? "animate-pulse" : ""} />{artifactImport.isPending ? "正在导入…" : "导入发布目录"}</Button>
      </section>
      {progress ? <p className="truncate text-xs text-muted-foreground">{progress}</p> : null}
      {artifactImport.error ? <p role="alert" className="text-sm text-destructive">{artifactImport.error.message}</p> : null}
      <Card>
        <CardHeader className="border-b"><CardTitle>选择 Artifact</CardTitle><CardDescription>相同内容共用快照，每次导入保留独立来源记录；下方显示最近一次导入。</CardDescription></CardHeader>
        <CardContent>
          {artifacts.data?.artifacts.length ? (
            <div className="divide-y">
              {artifacts.data.artifacts.map((artifact) => (
                <div key={artifact.artifactId} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-medium">{artifact.name}</p><Badge variant="secondary">{artifact.runtimeProfile}</Badge></div>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{artifact.componentCount} components · {artifact.fileCount} files · {artifact.importCount} imports · {formatTime(artifact.createdAt)}</p>
                    <p className="mt-1 text-xs text-muted-foreground"><ArtifactTrust artifact={artifact} /></p>
                  </div>
                  <Button asChild variant="outline"><Link to="/artifacts/$artifactId/player" params={{ artifactId: artifact.artifactId }}>打开 Player</Link></Button>
                </div>
              ))}
            </div>
          ) : artifacts.isPending ? <ViewerLoading message="正在读取 Artifacts…" /> : (
            <div className="grid min-h-52 place-items-center p-8 text-center"><div><Archive className="mx-auto mb-4 size-9 text-blue-400" /><h2 className="text-lg font-medium">尚无可播放 Artifact</h2><p className="mt-2 text-sm text-muted-foreground">导入包含 .fui 或 _fui.bytes 的 FairyGUI 发布目录。</p></div></div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function ArtifactPlayerPage() {
  const { artifactId } = artifactPlayerRoute.useParams()
  const artifact = useQuery({ queryKey: ["artifacts", artifactId], queryFn: () => getArtifact(artifactId) })
  if (artifact.isError) return <ErrorState retry={() => void artifact.refetch()} />
  return artifact.data ? <ArtifactPlayer artifact={artifact.data.artifact} /> : <ViewerLoading message="正在读取 Artifact…" />
}

function ArtifactPlayer({ artifact }: { artifact: ArtifactManifest }) {
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

  useEffect(() => {
    const frame = iframeRef.current
    if (!frame) return
    let disposed = false
    let stopRenderer: (() => void) | null = null
    const lifetime = new AbortController()
    const connect = async () => {
      try {
        setRuntimeError("")
        const renderer = await startPlayerRenderer(artifact, frame, setBrokerState, (error) => {
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
        const pkg = artifact.packages.find((candidate) => candidate.components.length > 0)
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
    }
  // Provenance can change without changing the immutable content or live Player state.
  }, [artifact.artifactId, artifact.digest])

  const packages = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    if (!query) return artifact.packages
    return artifact.packages.flatMap((pkg) => {
      const components = pkg.components.filter((component) => `${pkg.packageName}/${component.name}`.toLocaleLowerCase().includes(query))
      return components.length ? [{ ...pkg, components }] : []
    })
  }, [artifact.packages, filter])
  const allPackagesCollapsed = packages.length > 0 && packages.every(({ packageId }) => collapsedPackages.has(packageId))

  const capture = async () => {
    if (!session || !selected) return
    setBusyAction("capture")
    try {
      const { blob, result } = await session.capture()
      const component = result.value.component as Pick<ViewerRendered, "packageName" | "componentName">
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = `${component.packageName}-${component.componentName}.png`
      anchor.click()
      URL.revokeObjectURL(url)
    } catch (error) { commandFailed(error) } finally { setBusyAction(null) }
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
        <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Artifact Player</p><h1 className="font-heading text-3xl font-semibold tracking-tight">{artifact.name}</h1><p className="mt-2 text-sm text-muted-foreground">{artifact.runtimeProfile} · {artifact.digest.slice(0, 16)} · 不可变快照 · <ArtifactTrust artifact={artifact} /></p></div>
        <div className="flex flex-wrap items-end gap-3 rounded-lg border bg-card p-3 shadow-sm">
          <RenderStateControls rendered={rendered} session={session} onError={setCommandError} />
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            <Badge variant="outline">{renderSessionId ? "AGENT READY" : "AGENT WAITING"}</Badge>
            <Button variant="outline" size="sm" onClick={() => void session?.setView({ zoom: Math.max(0.25, zoom - 0.1) }).catch(commandFailed)} disabled={!session} aria-label="缩小"><ZoomOut /></Button>
            <span className="min-w-14 text-center text-xs text-muted-foreground">{Math.round(zoom * 100)}%</span>
            <Button variant="outline" size="sm" onClick={() => void session?.setView({ zoom: Math.min(4, zoom + 0.1) }).catch(commandFailed)} disabled={!session} aria-label="放大"><ZoomIn /></Button>
            <Button variant="outline" size="sm" onClick={() => void session?.setView({ background: background === "#202226" ? "#f4f4f5" : "#202226" }).catch(commandFailed)} disabled={!session}>背景</Button>
            <Button size="sm" onClick={() => void capture()} disabled={!session || !selected || busyAction !== null}><Camera />截图</Button>
          </div>
        </div>
      </section>
      <RenderCommandStatus state={brokerState} error={commandError} dismiss={() => setCommandError("")} />
      <Card className="overflow-hidden"><CardContent className="h-[62vh] min-h-[440px] max-h-[680px] p-0">
        <ResizablePanelGroup orientation="horizontal" className="h-full">
          <ResizablePanel id="player-resources" panelRef={resourcePanelRef} defaultSize={340} minSize={280} maxSize={520} collapsible collapsedSize={44} onResize={({ inPixels }) => setResourcesCollapsed(inPixels <= 44)} className="min-w-0 bg-card">
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {resourcesCollapsed ? <Button variant="ghost" size="icon" onClick={toggleResources} aria-label="展开组件列表" className="mx-auto mt-2 shrink-0"><PanelLeftOpen /></Button> : <>
                <div className="flex shrink-0 items-center gap-2 border-b p-3"><label className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索 Package / Component" aria-label="搜索 Player 组件" className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label><Button variant="ghost" size="icon" onClick={() => setCollapsedPackages(allPackagesCollapsed ? new Set<string>() : new Set(packages.map(({ packageId }) => packageId)))} aria-label={allPackagesCollapsed ? "展开全部 Package" : "折叠全部 Package"} title={allPackagesCollapsed ? "展开全部 Package" : "折叠全部 Package"} disabled={packages.length === 0} className="shrink-0">{allPackagesCollapsed ? <ChevronsUpDown /> : <ChevronsDownUp />}</Button><Button variant="ghost" size="icon" onClick={toggleResources} aria-label="折叠组件列表" className="shrink-0"><PanelLeftClose /></Button></div>
                <ViewerComponentList packages={packages} selected={selected} onSelect={({ packageId, componentId }) => void session?.render(packageId, componentId).catch(commandFailed)} collapsedPackages={collapsedPackages} onCollapsedPackagesChange={setCollapsedPackages} />
              </>}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="player-canvas" minSize={360} className="min-w-0"><div className="relative h-full min-h-0 bg-[#202226]">
            <iframe ref={iframeRef} data-runtime="/player-runtime.html" title="FairyGUI LayaAir Player Runtime" sandbox="allow-scripts" className="absolute inset-0 size-full border-0" />
            {!session && !runtimeError ? <div className="absolute inset-0 grid place-items-center bg-background/80 backdrop-blur-sm"><ViewerLoading message="正在启动原生 UIPackage runtime…" /></div> : null}
            {runtimeError ? <div role="alert" className="absolute inset-0 grid place-items-center bg-background/90 p-8 text-center"><div className="max-w-lg"><ServerCog className="mx-auto mb-4 size-9 text-destructive" /><p className="font-medium">Player 已停止</p><p className="mt-2 text-sm text-muted-foreground">{runtimeError}</p><div className="mt-4 flex justify-center gap-2"><Button variant="outline" onClick={() => window.location.reload()}>重新连接</Button><Button asChild><Link to="/player">返回 Player</Link></Button></div></div></div> : null}
            {rendered && session && !runtimeError ? <div className="pointer-events-none absolute bottom-3 right-3 rounded-md border bg-background/85 px-2.5 py-1.5 text-[11px] text-muted-foreground shadow-sm backdrop-blur">{rendered.packageName}/{rendered.componentName} · {rendered.width}×{rendered.height}</div> : null}
          </div></ResizablePanel>
        </ResizablePanelGroup>
      </CardContent></Card>
    </div>
  )
}
