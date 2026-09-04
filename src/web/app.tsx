import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router"
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { PanelImperativeHandle } from "react-resizable-panels"
import {
  Archive,
  Boxes,
  Camera,
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  CircleGauge,
  Eye,
  FileInput,
  FolderKanban,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  RefreshCw,
  Search,
  ServerCog,
  ZoomIn,
  ZoomOut,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { DesignImportPage, ImportDraftPage, type VisualCaptureInfo } from "@/design-import"
import { SaveApprovalsCard } from "@/save-approvals"
import { createProject, deleteProject, getArtifact, getArtifacts, getProject, getProjects, getSessions, getStatus, registerProjectAssetAnalysis, type RegisteredProjectData } from "@/lib/api"
import { importPublishedFolder } from "@/lib/artifacts"
import { startPlayerRenderer } from "@/lib/player"
import { watchRenderViewport, type RenderSessionClient } from "@/lib/render-session"
import {
  authorizeProjectDirectory,
  cleanupProjectBindings,
  deleteProjectBinding,
  queryProjectBindingPermission,
  saveProjectBinding,
  type ProjectBindingPermission,
} from "@/lib/project-source"
import {
  readViewerProject,
  startViewerRenderer,
} from "@/lib/viewer"
import { analyzeProjectAssets, displayAssetPath, summarizeAssetAnalysis, type AssetIssue, type AssetReference, type AssetResource } from "../asset-analysis"
import type { ViewerCatalogPackage, ViewerComponent, ViewerOperation, ViewerRendered, RenderSessionState } from "../viewer-protocol"
import type { ArtifactManifest } from "../artifact-protocol"

const statusQuery = { queryKey: ["host-status"], queryFn: getStatus, refetchInterval: 5_000 }
const sessionsQuery = { queryKey: ["sessions"], queryFn: getSessions, refetchInterval: 5_000 }
const projectsQuery = {
  queryKey: ["projects", "with-permissions"],
  queryFn: async () => {
    const result = await getProjects()
    return {
      projects: await Promise.all(result.projects.map(async (project) => ({
        ...project,
        permission: project.sourceOwner === "host" ? "host" as const : await queryProjectBindingPermission(project.bindingId),
      }))),
    }
  },
}
const artifactsQuery = { queryKey: ["artifacts"], queryFn: getArtifacts }

type SessionRow = {
  id: string
  kind: "MCP" | "Project"
  name: string
  state: string
  activity: string
}

const tableFeatureSet = tableFeatures({})
const columnHelper = createColumnHelper<typeof tableFeatureSet, SessionRow>()
const sessionColumns = columnHelper.columns([
  columnHelper.accessor("kind", { header: "类型" }),
  columnHelper.accessor("name", { header: "会话" }),
  columnHelper.accessor("state", { header: "状态" }),
  columnHelper.accessor("activity", { header: "最近活动" }),
])
const columnWidths = ["14%", "36%", "18%", "32%"]

function formatTime(value?: string) {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "—"
}

function WorkbenchLayout() {
  const status = useQuery(statusQuery)
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-screen bg-background text-foreground">
      <ResizablePanel id="navigation" defaultSize="18" minSize={220} maxSize={360} className="min-w-0 bg-sidebar">
        <aside className="flex h-full min-h-screen flex-col border-r border-sidebar-border p-4">
          <div className="mb-7 flex items-center gap-3 px-2">
            <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Boxes className="size-5" />
            </div>
            <div>
              <div className="font-heading font-semibold">FairyGUI Maker</div>
              <div className="text-xs text-muted-foreground">Workbench</div>
            </div>
          </div>
          <nav aria-label="Maker Workbench 模块" className="space-y-1">
            <NavLink to="/" icon={<CircleGauge />} label="Dashboard" exact />
            <NavLink to="/viewer" icon={<Eye />} label="Viewer" />
            <NavLink to="/player" icon={<Play />} label="Player" />
            <NavLink to="/asset-manager" icon={<FolderKanban />} label="Asset Manager" />
            <NavLink to="/design-import" icon={<FileInput />} label="Design Import" />
          </nav>
          <div className="mt-auto rounded-xl border bg-background/60 p-3 text-xs text-muted-foreground">
            <div className="mb-2 flex items-center justify-between">
              <span>Maker Host</span>
              <Badge variant={status.data ? "secondary" : "outline"}>{status.data ? "RUNNING" : "CONNECTING"}</Badge>
            </div>
            <code className="block truncate text-[11px]">{status.data?.host.origin ?? "127.0.0.1"}</code>
          </div>
        </aside>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="content" defaultSize="82" minSize={480} className="min-w-0">
        <div className="min-h-screen bg-[radial-gradient(circle_at_top_right,oklch(0.28_0.05_260/0.32),transparent_35rem)]">
          <header className="flex h-16 items-center justify-between border-b bg-background/80 px-6 backdrop-blur">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Local control plane</p>
              <p className="text-sm font-medium">工程、MCP 与浏览器工具链</p>
            </div>
            <Badge variant="outline" className="gap-1.5"><span className="size-1.5 rounded-full bg-emerald-500" />Local only</Badge>
          </header>
          <main className="mx-auto w-full max-w-[1500px] p-6 lg:p-8"><Outlet /></main>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function NavLink({ to, icon, label, exact = false }: { to: "/" | "/viewer" | "/player" | "/asset-manager" | "/design-import"; icon: React.ReactNode; label: string; exact?: boolean }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground font-medium" }}
    >
      <span className="[&_svg]:size-4">{icon}</span>{label}
    </Link>
  )
}

function DashboardPage() {
  const queryClient = useQueryClient()
  const status = useQuery(statusQuery)
  const sessions = useQuery(sessionsQuery)
  const projects = useQuery(projectsQuery)
  const artifacts = useQuery(artifactsQuery)
  const scanAbort = useRef<AbortController | null>(null)
  const [projectProgress, setProjectProgress] = useState("")
  useEffect(() => () => scanAbort.current?.abort(), [])
  const projectCreation = useMutation({
    mutationFn: async () => {
      const controller = new AbortController()
      scanAbort.current = controller
      const source = await authorizeProjectDirectory({ signal: controller.signal, onProgress: setProjectProgress })
      if (!source) return null
      controller.signal.throwIfAborted()
      await saveProjectBinding(source)
      // Keep the local handle on an uncertain POST outcome; explicit cleanup can remove an orphan later.
      const { directory: _directory, ...input } = source
      return await createProject(input)
    },
    onSuccess: async (result) => {
      if (result) await queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey })
    },
    onSettled: () => { scanAbort.current = null; setProjectProgress("") },
  })
  const projectRemoval = useMutation({
    mutationFn: async (project: ProjectListItem) => {
      await deleteProject(project)
      if (project.sourceOwner === "browser") await deleteProjectBinding(project.bindingId)
      for (const key of ["projects", "viewer-project", "asset-analysis"]) queryClient.removeQueries({ queryKey: [key, project.projectId] })
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey }),
  })
  const bindingCleanup = useMutation({
    mutationFn: async () => {
      const current = await getProjects()
      return cleanupProjectBindings(new Set(current.projects.map(({ bindingId }) => bindingId)))
    },
  })
  const [artifactProgress, setArtifactProgress] = useState("")
  const artifactImport = useMutation({
    mutationFn: () => importPublishedFolder(({ uploaded, total, path }) => setArtifactProgress(`${uploaded}/${total} · ${path}`)),
    onSuccess: async (artifact) => {
      setArtifactProgress("")
      if (artifact) await queryClient.invalidateQueries({ queryKey: artifactsQuery.queryKey })
    },
    onError: () => setArtifactProgress(""),
  })
  const refreshing = status.isFetching || sessions.isFetching || projects.isFetching || artifacts.isFetching

  if (status.isError || sessions.isError || projects.isError || artifacts.isError) {
    return <ErrorState retry={() => void queryClient.invalidateQueries()} />
  }

  const data = status.data
  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Overview</p>
          <h1 className="font-heading text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Maker Host 已统一承载 WebUI、Streamable HTTP MCP 和 Viewer 服务入口。</p>
        </div>
        <Button variant="outline" onClick={() => void Promise.all([
          queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
          queryClient.invalidateQueries({ queryKey: sessionsQuery.queryKey }),
          queryClient.invalidateQueries({ queryKey: projectsQuery.queryKey }),
        ])} disabled={refreshing}>
          <RefreshCw className={refreshing ? "animate-spin" : ""} />刷新
        </Button>
      </section>

      <section aria-label="Host 指标" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Host" value={data?.host.status ?? "loading"} detail={data ? `v${data.host.version}` : "正在连接"} />
        <MetricCard label="MCP sessions" value={String(data?.mcp.sessions ?? 0)} detail="Streamable HTTP" />
        <MetricCard label="Projects" value={String(projects.data?.projects.length ?? 0)} detail="Read-only bindings" />
        <MetricCard label="Artifacts" value={String(data?.player?.artifacts ?? artifacts.data?.artifacts.length ?? 0)} detail="Immutable published snapshots" />
      </section>

      <SaveApprovalsCard />

      <ProjectBindingsCard
        projects={projects.data?.projects ?? []}
        creating={projectCreation.isPending}
        error={projectCreation.error ?? projectRemoval.error ?? bindingCleanup.error}
        create={() => projectCreation.mutate()}
        progress={projectProgress}
        cancel={() => scanAbort.current?.abort()}
        removing={projectRemoval.isPending}
        remove={(project) => { if (window.confirm(`移除「${project.name}」的注册、快照与本浏览器授权？不会删除源工程文件。`)) projectRemoval.mutate(project) }}
        cleanup={() => { if (window.confirm("清理本浏览器中超过 24 小时且未在当前 Host 注册的授权？不会删除源文件，也不会撤销浏览器的系统权限。")) bindingCleanup.mutate() }}
        cleaning={bindingCleanup.isPending}
        cleanupCount={bindingCleanup.data}
      />

      <ArtifactImportsCard
        artifacts={artifacts.data?.artifacts ?? []}
        importing={artifactImport.isPending}
        progress={artifactProgress}
        error={artifactImport.error}
        create={() => artifactImport.mutate()}
      />

      <section className="grid gap-4 xl:grid-cols-[minmax(0,1.55fr)_minmax(280px,.65fr)]">
        <Card>
          <CardHeader className="border-b">
            <CardTitle>活跃会话</CardTitle>
            <CardDescription>TanStack Table 负责结构，Virtual 只渲染可见行。</CardDescription>
            <CardAction><Badge variant="secondary">{(sessions.data?.mcp.length ?? 0) + (sessions.data?.projects.length ?? 0)} active</Badge></CardAction>
          </CardHeader>
          <CardContent><SessionTable data={sessions.data} /></CardContent>
        </Card>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Viewer</CardTitle>
            <CardDescription>浏览器渲染入口已建立。</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid min-h-40 place-items-center rounded-xl border border-dashed bg-muted/20 p-5 text-center">
              <div>
                <Eye className="mx-auto mb-3 size-7 text-blue-400" />
                <p className="text-sm font-medium">等待 FairyGUI 资源</p>
                <p className="mt-1 text-xs text-muted-foreground">下一阶段接入工程资源与 Laya/FairyGUI runtime。</p>
              </div>
            </div>
            <Button asChild className="w-full"><Link to="/viewer">打开 Viewer</Link></Button>
          </CardContent>
        </Card>
      </section>
    </div>
  )
}

type ProjectListItem = Awaited<ReturnType<typeof projectsQuery.queryFn>>["projects"][number]

function ProjectBindingsCard({ projects, creating, error, create, progress, cancel, removing, remove, cleanup, cleaning, cleanupCount }: {
  projects: ProjectListItem[]
  creating: boolean
  error: Error | null
  create: () => void
  progress: string
  cancel: () => void
  removing: boolean
  remove: (project: ProjectListItem) => void
  cleanup: () => void
  cleaning: boolean
  cleanupCount?: number
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>FairyGUI 工程</CardTitle>
        <CardDescription>浏览器授权保存在 IndexedDB；CLI 授权只注册用户明确指定的只读工程快照。</CardDescription>
        <CardAction className="flex gap-2">
          <Button variant="outline" onClick={cleanup} disabled={creating || removing || cleaning}>清理失效授权</Button>
          <Button onClick={create} disabled={creating}>
            <FolderPlus className={creating ? "animate-pulse" : ""} />{creating ? "正在读取…" : "授权并创建项目"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {error ? <p role="alert" className="mb-4 text-sm text-destructive">{formatError(error)}</p> : null}
        {creating ? <p role="status" className="mb-4 text-sm">{progress || "等待文件夹授权…"} <Button size="sm" variant="outline" onClick={cancel}>取消扫描</Button></p> : null}
        {cleanupCount !== undefined ? <p role="status" className="mb-4 text-sm text-muted-foreground">已清理 {cleanupCount} 条未注册授权。</p> : null}
        {projects.length ? (
          <div className="divide-y">
            {projects.map((project) => (
              <div key={project.projectId} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="truncate text-sm font-medium">{project.name}</p>
                    <Badge variant="outline">READ ONLY</Badge>
                    <PermissionBadge permission={project.permission} />
                  </div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{project.directoryName}/{project.fairyPath}</p>
                </div>
                <Button asChild variant="outline">
                  <Link to="/projects/$projectId/viewer" params={{ projectId: project.projectId }}>打开 Viewer</Link>
                </Button>
                <Button variant="outline" onClick={() => remove(project)} disabled={removing || creating}>移除项目</Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid min-h-32 place-items-center rounded-xl border border-dashed bg-muted/20 p-5 text-center">
            <div>
              <FolderKanban className="mx-auto mb-2 size-6 text-blue-400" />
              <p className="text-sm font-medium">尚未授权 FairyGUI 工程</p>
              <p className="mt-1 text-xs text-muted-foreground">请选择只包含一个 .fairy 工程的文件夹。</p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

type ArtifactListItem = Awaited<ReturnType<typeof getArtifacts>>["artifacts"][number]

function ArtifactImportsCard({ artifacts, importing, progress, error, create }: {
  artifacts: ArtifactListItem[]
  importing: boolean
  progress: string
  error: Error | null
  create: () => void
}) {
  return (
    <Card>
      <CardHeader className="border-b">
        <CardTitle>已发布 Artifacts</CardTitle>
        <CardDescription>选择 FairyGUI 发布目录后，Maker Host 会校验并固化一份不可变快照；不会保留目录写权限。</CardDescription>
        <CardAction>
          <Button onClick={create} disabled={importing}>
            <Archive className={importing ? "animate-pulse" : ""} />{importing ? "正在导入…" : "导入发布目录"}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent>
        {progress ? <p className="mb-4 truncate text-xs text-muted-foreground">{progress}</p> : null}
        {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error.message}</p> : null}
        {artifacts.length ? (
          <div className="divide-y">
            {artifacts.slice(0, 5).map((artifact) => (
              <div key={artifact.artifactId} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><p className="truncate text-sm font-medium">{artifact.name}</p><Badge variant="secondary">IMMUTABLE</Badge></div>
                  <p className="mt-1 truncate text-xs text-muted-foreground">{artifact.packageCount} packages · {artifact.fileCount} files · {artifact.importCount} imports · {artifact.digest.slice(0, 12)}</p>
                </div>
                <Button asChild variant="outline"><Link to="/artifacts/$artifactId/player" params={{ artifactId: artifact.artifactId }}>打开 Player</Link></Button>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid min-h-32 place-items-center rounded-xl border border-dashed bg-muted/20 p-5 text-center">
            <div><Archive className="mx-auto mb-2 size-6 text-blue-400" /><p className="text-sm font-medium">尚无发布快照</p><p className="mt-1 text-xs text-muted-foreground">选择包含 .fui 或 _fui.bytes 的发布目录。</p></div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function PermissionBadge({ permission }: { permission: ProjectBindingPermission }) {
  const label = permission === "host" ? "CLI 授权" : permission === "granted" ? "已授权" : permission === "prompt" ? "需要确认" : permission === "denied" ? "已拒绝" : permission === "missing" ? "绑定缺失" : "权限未知"
  return <Badge variant={permission === "granted" || permission === "host" ? "secondary" : "outline"}>{label}</Badge>
}

function formatError(error: Error) {
  return error.message || "工程创建失败。"
}

function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card size="sm">
      <CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl capitalize">{value}</CardTitle></CardHeader>
      <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  )
}

function SessionTable({ data }: { data: Awaited<ReturnType<typeof getSessions>> | undefined }) {
  const rows = useMemo<SessionRow[]>(() => [
    ...(data?.mcp ?? []).map((session) => ({
      id: session.id ?? "initializing",
      kind: "MCP" as const,
      name: session.id ?? "Initializing",
      state: session.lastError ? "Error" : "Connected",
      activity: formatTime(session.lastActivityAt),
    })),
    ...(data?.projects ?? []).map((session) => ({
      id: session.id,
      kind: "Project" as const,
      name: session.projectName,
      state: session.dirty ? "Dirty" : "Clean",
      activity: formatTime(session.lastActivityAt ?? session.createdAt),
    })),
  ], [data])
  const table = useTable({ features: tableFeatureSet, columns: sessionColumns, data: rows })
  const tableRows = table.getRowModel().rows
  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 43,
    getItemKey: (index) => tableRows[index].id,
    overscan: 5,
  })

  if (!rows.length) {
    return <div className="grid min-h-52 place-items-center text-sm text-muted-foreground">暂无活跃会话</div>
  }

  return (
    <div ref={scrollRef} className="max-h-80 overflow-auto">
      <table className="w-full min-w-[680px] caption-bottom text-sm">
        <TableHeader className="sticky top-0 z-10 bg-card">
          {table.getHeaderGroups().map((group) => (
            <TableRow key={group.id} className="flex">
              {group.headers.map((header, index) => (
                <TableHead key={header.id} style={{ width: columnWidths[index] }}>
                  {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                </TableHead>
              ))}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody style={{ display: "grid", height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = tableRows[item.index]
            return (
              <TableRow
                key={row.id}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute flex w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                {row.getAllCells().map((cell, index) => (
                  <TableCell key={cell.id} style={{ width: columnWidths[index] }} className="truncate">
                    <table.FlexRender cell={cell} />
                  </TableCell>
                ))}
              </TableRow>
            )
          })}
        </TableBody>
      </table>
    </div>
  )
}

function ViewerPage() {
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
                    <p className="mt-1 truncate text-xs text-muted-foreground">{project.directoryName}/{project.fairyPath}</p>
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

function AssetManagerPage() {
  const projects = useQuery({ queryKey: ["projects", "asset-manager"], queryFn: getProjects })
  if (projects.isError) return <ErrorState retry={() => void projects.refetch()} />
  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Project resources</p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Asset Manager</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">按固定工程 revision 扫描资源引用、断链、未使用、字节级重复和同路径冲突；当前保持只读。</p>
      </div>
      <Card>
        <CardHeader className="border-b"><CardTitle>选择工程</CardTitle><CardDescription>首次打开工程时在当前浏览器读取已授权目录，并向 Maker Host 注册不含资源字节的分析快照。</CardDescription></CardHeader>
        <CardContent>
          {projects.data?.projects.length ? (
            <div className="divide-y">
              {projects.data.projects.map((project) => (
                <div key={project.projectId} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{project.name}</p>
                    <p className="mt-1 truncate text-xs text-muted-foreground">{project.directoryName}/{project.fairyPath} · revision {project.revision}</p>
                  </div>
                  <Button asChild variant="outline"><Link to="/projects/$projectId/assets" params={{ projectId: project.projectId }}>分析资源</Link></Button>
                </div>
              ))}
            </div>
          ) : projects.isPending ? <ViewerLoading message="正在读取工程列表…" /> : (
            <div className="grid min-h-52 place-items-center p-8 text-center"><div><FolderPlus className="mx-auto mb-4 size-9 text-blue-400" /><h2 className="text-lg font-medium">尚无可分析工程</h2><p className="mt-2 text-sm text-muted-foreground">先在 Dashboard 授权 FairyGUI 工程文件夹。</p><Button asChild className="mt-4"><Link to="/">返回 Dashboard</Link></Button></div></div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function PlayerPage() {
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

function ArtifactPlayerPage() {
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
        <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Artifact Player</p><h1 className="font-heading text-3xl font-semibold tracking-tight">{artifact.name}</h1><p className="mt-2 text-sm text-muted-foreground">{artifact.runtimeProfile} · {artifact.digest.slice(0, 16)} · 不可变快照</p></div>
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

function ProjectViewerPage() {
  const { projectId } = projectViewerRoute.useParams()
  const project = useQuery({ queryKey: ["projects", projectId], queryFn: () => getProject(projectId) })
  if (project.isError) return <ErrorState retry={() => void project.refetch()} />

  return project.data
    ? <ProjectViewer project={project.data.project} />
    : <ViewerLoading message="正在读取项目绑定…" />
}

function ProjectAssetManagerPage() {
  const { projectId } = projectAssetManagerRoute.useParams()
  const project = useQuery({ queryKey: ["projects", projectId], queryFn: () => getProject(projectId) })
  if (project.isError) return <ErrorState retry={() => void project.refetch()} />
  return project.data ? <ProjectAssetManager project={project.data.project} /> : <ViewerLoading message="正在读取项目绑定…" />
}

function ProjectAssetManager({ project }: { project: RegisteredProjectData }) {
  const queryClient = useQueryClient()
  const [scanProgress, setScanProgress] = useState("")
  const [scanCancelled, setScanCancelled] = useState(false)
  const [selectedKey, setSelectedKey] = useState("")
  const [filter, setFilter] = useState("")
  const [health, setHealth] = useState<"all" | AssetIssue["kind"]>("all")
  const analysis = useQuery({
    queryKey: ["asset-analysis", project.projectId, project.sourceRevision],
    queryFn: async ({ signal }) => {
      setScanCancelled(false)
      const bundle = await readViewerProject(project, { signal, onProgress: setScanProgress })
      const result = await analyzeProjectAssets(bundle.project, { projectId: project.projectId, sourceRevision: bundle.sourceRevision })
      signal.throwIfAborted()
      await registerProjectAssetAnalysis(project.projectId, result)
      return result
    },
    retry: false,
    staleTime: Infinity,
  })

  useEffect(() => {
    if (!analysis.data?.resources.length) return
    setSelectedKey((current) => analysis.data.resources.some(({ key }) => key === current) ? current : analysis.data.resources[0].key)
  }, [analysis.data])

  const issueKeys = useMemo(() => new Set(analysis.data?.issues
    .filter((issue) => health === "all" || issue.kind === health)
    .flatMap(({ resourceKeys }) => resourceKeys) ?? []), [analysis.data, health])
  const resources = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase()
    return analysis.data?.resources.filter((resource) => (
      (health === "all" || issueKeys.has(resource.key))
      && (!query || `${resource.packageName}/${displayAssetPath(resource)} ${resource.kind} ${resource.resourceId}`.toLocaleLowerCase().includes(query))
    )) ?? []
  }, [analysis.data, filter, health, issueKeys])

  if (analysis.isFetching) return <div><ViewerLoading message={scanProgress || "正在读取工程并计算资源哈希与引用…"} /><Button variant="outline" onClick={() => { setScanCancelled(true); void queryClient.cancelQueries({ queryKey: ["asset-analysis", project.projectId] }) }}>取消扫描</Button></div>
  if (scanCancelled) return <div role="status">扫描已取消。<Button onClick={() => void analysis.refetch()}>重新扫描</Button></div>
  if (analysis.isPending) return <Button onClick={() => void analysis.refetch()}>开始扫描</Button>
  if (analysis.isError) {
    return (
      <Card className="border-destructive/40"><CardContent className="flex min-h-64 flex-col items-center justify-center gap-4 text-center"><ServerCog className="size-9 text-destructive" /><div><p className="font-medium">Asset Manager 无法完成扫描</p><p className="mt-2 max-w-xl text-sm text-muted-foreground">{analysis.error instanceof Error ? analysis.error.message : "未知错误"}</p></div><div className="flex gap-2"><Button variant="outline" onClick={() => void analysis.refetch()}>重试</Button><Button asChild><Link to="/asset-manager">返回工程列表</Link></Button></div></CardContent></Card>
    )
  }

  const result = analysis.data
  const summary = summarizeAssetAnalysis(result)
  const selected = result.resources.find(({ key }) => key === selectedKey) ?? null
  const resourceByKey = new Map(result.resources.map((resource) => [resource.key, resource]))
  const incoming = selected ? result.references.filter(({ targetKey }) => targetKey === selected.key) : []
  const outgoing = selected ? result.references.filter(({ sourceKey }) => sourceKey === selected.key) : []
  const selectedIssues = selected ? result.issues.filter(({ resourceKeys }) => resourceKeys.includes(selected.key)) : []
  // ponytail: cap the DOM issue ledger; virtualize it only if real projects regularly exceed this ceiling.
  const visibleIssues = result.issues.slice(0, 200)

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div><p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Asset Manager</p><h1 className="font-heading text-3xl font-semibold tracking-tight">{project.name}</h1><p className="mt-2 text-sm text-muted-foreground">{project.directoryName}/{project.fairyPath} · {result.sourceRevision.slice(0, 12)} · 只读快照</p></div>
        <div className="flex flex-wrap gap-2"><Badge variant="outline">AGENT READY</Badge><Button variant="outline" onClick={() => void analysis.refetch()} disabled={analysis.isFetching}><RefreshCw className={analysis.isFetching ? "animate-spin" : ""} />重新扫描</Button></div>
      </section>

      <section aria-label="资源分析摘要" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Resources" value={String(summary.resources)} detail={`${result.resources.filter(({ kind }) => kind === "component").length} components`} />
        <MetricCard label="References" value={String(summary.references)} detail="Incoming + outgoing occurrences" />
        <MetricCard label="Broken" value={String(summary.missingReferences)} detail="Missing target references" />
        <MetricCard label="Health" value={String(result.issues.length)} detail={`${summary.unusedResources} unused · ${summary.duplicateGroups} duplicate groups · ${summary.conflictGroups} conflicts`} />
      </section>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="grid lg:h-[68vh] lg:min-h-[560px] lg:max-h-[760px] lg:grid-cols-[minmax(320px,.8fr)_minmax(0,1.2fr)]">
            <section className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r" aria-label="资源列表">
              <div className="grid shrink-0 gap-2 border-b p-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                <label className="relative min-w-0"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索资源" aria-label="搜索 Asset Manager 资源" className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
                <select value={health} onChange={(event) => setHealth(event.target.value as typeof health)} aria-label="筛选资源健康状态" className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <option value="all">全部资源</option><option value="missing">断链来源</option><option value="unused">未使用</option><option value="duplicate">完全重复</option><option value="conflict">名称冲突</option>
                </select>
              </div>
              <AssetResourceList resources={resources} selectedKey={selectedKey} onSelect={setSelectedKey} />
            </section>
            <AssetResourceDetail resource={selected} resourceByKey={resourceByKey} incoming={incoming} outgoing={outgoing} issues={selectedIssues} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b"><CardTitle>工程问题</CardTitle><CardDescription>问题只提供定位与影响信息；当前版本不会自动删除、重命名或合并资源。</CardDescription><CardAction><Badge variant={summary.missingReferences || summary.conflictGroups ? "destructive" : "secondary"}>{result.issues.length}</Badge></CardAction></CardHeader>
        <CardContent>
          {visibleIssues.length ? <div className="divide-y">{visibleIssues.map((issue, index) => <AssetIssueRow key={`${issue.kind}:${issue.label}:${index}`} issue={issue} resourceByKey={resourceByKey} />)}</div> : <div className="grid min-h-32 place-items-center text-sm text-muted-foreground">没有发现资源健康问题</div>}
          {result.issues.length > visibleIssues.length ? <p className="mt-4 text-xs text-muted-foreground">仅显示前 {visibleIssues.length} 项；完整结果可通过 Agent 查询。</p> : null}
        </CardContent>
      </Card>
    </div>
  )
}

function AssetResourceList({ resources, selectedKey, onSelect }: { resources: AssetResource[]; selectedKey: string; onSelect: (key: string) => void }) {
  const parentRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({ count: resources.length, getScrollElement: () => parentRef.current, estimateSize: () => 58, overscan: 10 })
  if (!resources.length) return <div className="grid min-h-52 flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">没有匹配的资源</div>
  return (
    <div ref={parentRef} role="listbox" aria-label="FairyGUI 资源" className="h-[500px] min-h-0 overflow-auto lg:h-auto lg:flex-1">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const resource = resources[item.index]
          return <button key={resource.key} type="button" role="option" aria-selected={selectedKey === resource.key} onClick={() => onSelect(resource.key)} className={`absolute left-0 top-0 flex w-full items-center gap-3 border-b px-4 text-left hover:bg-accent ${selectedKey === resource.key ? "bg-accent text-accent-foreground" : "text-muted-foreground"}`} style={{ height: item.size, transform: `translateY(${item.start}px)` }}><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium text-foreground">{resource.packageName}/{displayAssetPath(resource)}</p><p className="mt-0.5 truncate text-[11px]">{resource.kind} · {resource.resourceId}</p></div><span className="shrink-0 text-[11px]">{resource.incomingReferences} in · {resource.outgoingReferences} out</span></button>
        })}
      </div>
    </div>
  )
}

function AssetResourceDetail({ resource, resourceByKey, incoming, outgoing, issues }: {
  resource: AssetResource | null
  resourceByKey: Map<string, AssetResource>
  incoming: AssetReference[]
  outgoing: AssetReference[]
  issues: AssetIssue[]
}) {
  if (!resource) return <section className="grid min-h-64 place-items-center p-8 text-sm text-muted-foreground">选择一个资源查看引用详情</section>
  return (
    <section className="min-w-0 overflow-auto p-5 lg:h-full" aria-label="资源详情">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-400">{resource.kind}</p><h2 className="mt-1 truncate text-xl font-semibold">{resource.name}</h2><p className="mt-1 truncate text-xs text-muted-foreground">{resource.packageName}/{displayAssetPath(resource)} · {resource.key}</p></div><div className="flex gap-2"><Badge variant={resource.exported ? "secondary" : "outline"}>{resource.exported ? "EXPORTED" : "INTERNAL"}</Badge>{issues.map(({ kind }, index) => <Badge key={`${kind}:${index}`} variant={kind === "missing" || kind === "conflict" ? "destructive" : "outline"}>{assetIssueKindLabel(kind)}</Badge>)}</div></div>
      <dl className="mt-5 grid gap-3 rounded-xl border bg-muted/15 p-4 text-sm sm:grid-cols-2"><div><dt className="text-xs text-muted-foreground">分支 / 路径</dt><dd className="mt-1 break-all">{resource.branch || "default"} · {resource.path || "/"}</dd></div><div><dt className="text-xs text-muted-foreground">源文件</dt><dd className="mt-1">{formatAssetBytes(resource.byteLength)}</dd></div><div className="sm:col-span-2"><dt className="text-xs text-muted-foreground">SHA-256</dt><dd className="mt-1 break-all font-mono text-xs">{resource.sha256 ?? "未提供可哈希的源字节"}</dd></div></dl>
      <div className="mt-6 grid gap-6 xl:grid-cols-2"><AssetReferenceList title={`Incoming (${incoming.length})`} references={incoming} direction="incoming" resourceByKey={resourceByKey} /><AssetReferenceList title={`Outgoing (${outgoing.length})`} references={outgoing} direction="outgoing" resourceByKey={resourceByKey} /></div>
    </section>
  )
}

function AssetReferenceList({ title, references, direction, resourceByKey }: { title: string; references: AssetReference[]; direction: "incoming" | "outgoing"; resourceByKey: Map<string, AssetResource> }) {
  const visible = references.slice(0, 100)
  return <div><h3 className="text-sm font-semibold">{title}</h3>{visible.length ? <ul className="mt-2 divide-y rounded-lg border">{visible.map((reference, index) => {
    const key = direction === "incoming" ? reference.sourceKey : reference.targetKey
    const target = key === "project" ? null : resourceByKey.get(key)
    return <li key={`${reference.sourceKey}:${reference.targetKey}:${reference.path}:${index}`} className="p-3"><div className="flex items-center gap-2"><p className="min-w-0 flex-1 truncate text-xs font-medium">{key === "project" ? "Project settings" : target ? `${target.packageName}/${displayAssetPath(target)}` : key}</p>{key !== "project" && !target ? <Badge variant="destructive">MISSING</Badge> : null}</div><p className="mt-1 break-all text-[11px] text-muted-foreground">{reference.path}</p></li>
  })}</ul> : <p className="mt-2 rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">无引用</p>}{references.length > visible.length ? <p className="mt-2 text-[11px] text-muted-foreground">显示前 {visible.length} 条</p> : null}</div>
}

function AssetIssueRow({ issue, resourceByKey }: { issue: AssetIssue; resourceByKey: Map<string, AssetResource> }) {
  const labels = issue.resourceKeys.slice(0, 5).map((key) => {
    const resource = resourceByKey.get(key)
    return resource ? `${resource.packageName}/${displayAssetPath(resource)}` : key
  })
  return <div className="py-4 first:pt-0 last:pb-0"><div className="flex flex-wrap items-center gap-2"><Badge variant={issue.severity === "error" ? "destructive" : "outline"}>{assetIssueKindLabel(issue.kind)}</Badge><p className="text-sm font-medium">{issue.label}</p></div><p className="mt-1 text-xs text-muted-foreground">{issue.detail}</p>{labels.length ? <p className="mt-2 truncate text-[11px] text-muted-foreground">{labels.join(" · ")}{issue.resourceKeys.length > labels.length ? ` · +${issue.resourceKeys.length - labels.length}` : ""}</p> : null}</div>
}

function assetIssueKindLabel(kind: AssetIssue["kind"]) {
  return { missing: "断链", unused: "未使用", duplicate: "重复", conflict: "冲突" }[kind]
}

function formatAssetBytes(value: number | null) {
  if (value === null) return "—"
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / 1_048_576).toFixed(1)} MiB`
}

function ProjectViewer({ project, compact = false, onCapture }: { project: RegisteredProjectData; compact?: boolean; onCapture?: (blob: Blob, info: VisualCaptureInfo) => Promise<void> }) {
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
    queryKey: ["viewer-project", project.projectId],
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
          <p className="mt-2 text-sm text-muted-foreground">{project.directoryName}/{project.fairyPath} · 尚未发布的工程 · 只读</p>
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

type ViewerListRow =
  | { kind: "package"; key: string; packageId: string; packageName: string; count: number }
  | { kind: "component"; key: string; packageId: string; component: ViewerComponent }

function ViewerComponentList({ packages, selected, onSelect, collapsedPackages, onCollapsedPackagesChange }: {
  packages: ViewerCatalogPackage[]
  selected: { packageId: string; componentId: string } | null
  onSelect: (value: { packageId: string; componentId: string }) => void
  collapsedPackages: Set<string>
  onCollapsedPackagesChange: (value: Set<string>) => void
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rows = useMemo<ViewerListRow[]>(() => packages.flatMap((pkg) => [
    { kind: "package", key: `package:${pkg.packageId}`, packageId: pkg.packageId, packageName: pkg.packageName, count: pkg.components.length },
    ...(collapsedPackages.has(pkg.packageId) ? [] : pkg.components.map((component) => ({ kind: "component" as const, key: `${pkg.packageId}:${component.id}`, packageId: pkg.packageId, component }))),
  ]), [collapsedPackages, packages])
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 34, overscan: 12 })

  if (rows.length === 0) return <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">没有匹配的组件</div>

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto" role="tree" aria-label="FairyGUI 组件">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          return (
            <div key={row.key} className="absolute left-0 top-0 w-full" style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
              {row.kind === "package" ? (
                <button type="button" className="flex h-full w-full items-center gap-2 border-b bg-muted/40 px-3 text-left text-xs font-semibold text-muted-foreground hover:bg-muted/70" role="treeitem" aria-expanded={!collapsedPackages.has(row.packageId)} onClick={() => {
                  const next = new Set(collapsedPackages)
                  if (next.has(row.packageId)) next.delete(row.packageId)
                  else next.add(row.packageId)
                  onCollapsedPackagesChange(next)
                }}>
                  {collapsedPackages.has(row.packageId) ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
                  <span className="truncate">{row.packageName}</span><Badge variant="outline" className="ml-auto h-5 px-1.5 text-[10px]">{row.count}</Badge>
                </button>
              ) : (
                <button type="button" role="treeitem" aria-selected={selected?.packageId === row.packageId && selected.componentId === row.component.id} onClick={() => onSelect({ packageId: row.packageId, componentId: row.component.id })} className={`flex h-full w-full items-center px-4 text-left text-sm hover:bg-accent ${selected?.packageId === row.packageId && selected.componentId === row.component.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground"}`}>
                  <span className="truncate">{row.component.name}</span><code className="ml-auto pl-2 text-[10px] opacity-50">{row.component.id}</code>
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function brokerRendered(state: RenderSessionState | null): ViewerRendered | null {
  if (!state?.rendered) return null
  return { ...state.rendered, ...(state.observation ?? { controllers: [], availableTransitions: [] }) }
}

function RenderCommandStatus({ state, error, dismiss }: { state: RenderSessionState | null; error: string; dismiss(): void }) {
  return <div className="text-xs text-muted-foreground">
    {state ? <span aria-label="Broker 状态版本">Semantic {state.semanticStateVersion} · View {state.viewStateVersion}</span> : null}
    {error ? <div role="alert" className="mt-2 flex items-center gap-3 rounded-md border border-amber-500/40 p-3"><span className="flex-1">{error}</span><Button size="sm" variant="outline" onClick={dismiss}>知道了</Button></div> : null}
  </div>
}

function RenderStateControls({ rendered, session, onError }: {
  rendered: ViewerRendered | null
  session: RenderSessionClient | null
  onError: (message: string) => void
}) {
  const [controllerIndex, setControllerIndex] = useState("0")
  const [transitionIndex, setTransitionIndex] = useState("0")
  const [busy, setBusy] = useState(false)
  const targetId = rendered?.objectTree.id
  const controllers = rendered?.controllers.filter((item) => item.targetId === targetId) ?? []
  const transitions = rendered?.availableTransitions.filter((item) => item.targetId === targetId) ?? []
  useEffect(() => {
    setControllerIndex("0")
    setTransitionIndex("0")
  }, [rendered?.packageId, rendered?.componentId])
  if (!rendered || !session || (controllers.length === 0 && transitions.length === 0)) return null

  const apply = async (operation: ViewerOperation) => {
    setBusy(true)
    try {
      await session.applyOperations([operation])
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const controller = controllers[Number(controllerIndex)] ?? controllers[0]
  const transition = transitions[Number(transitionIndex)] ?? transitions[0]

  return (
    <>
      {controller ? <>
        <label className="grid w-44 gap-1">
          <span className="text-[11px] text-muted-foreground">Controller</span>
          <select value={controllerIndex} onChange={(event) => setControllerIndex(event.target.value)} disabled={busy} aria-label="选择 Controller" className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {controllers.map((item, index) => <option key={`${item.targetId}:${item.name}`} value={index}>{item.name} · {item.targetId}</option>)}
          </select>
        </label>
        <label className="grid w-32 gap-1">
          <span className="text-[11px] text-muted-foreground">Page</span>
          <select value={controller.pageId} onChange={(event) => void apply({ op: "set-controller-page", targetId: controller.targetId, controllerName: controller.name, pageId: event.target.value })} disabled={busy || controller.pages.length < 2} aria-label={`切换 Controller ${controller.name} Page`} className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {controller.pages.map((page) => <option key={page.id} value={page.id}>{page.name || page.id}</option>)}
          </select>
        </label>
      </> : null}
      {transitions.length > 0 ? (
        <div className="flex items-end gap-2">
          <label className="grid w-44 gap-1">
            <span className="text-[11px] text-muted-foreground">Transition</span>
            <select value={transitionIndex} onChange={(event) => setTransitionIndex(event.target.value)} disabled={busy} aria-label="选择 Transition" className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {transitions.map((item, index) => <option key={`${item.targetId}:${item.name}`} value={index}>{item.name} · {item.targetId}</option>)}
            </select>
          </label>
          <Button variant="outline" size="sm" onClick={() => transition && void apply({ op: "play-transition", targetId: transition.targetId, transitionName: transition.name })} disabled={busy || !transition}><Play />播放</Button>
        </div>
      ) : null}
    </>
  )
}

function ViewerLoading({ message, compact = false }: { message: string; compact?: boolean }) {
  return (
    <div className={`grid place-items-center text-center text-sm text-muted-foreground ${compact ? "min-h-40 flex-1 p-4" : "min-h-52 p-8"}`}>
      <div><RefreshCw className="mx-auto mb-3 size-5 animate-spin" /><p>{message}</p></div>
    </div>
  )
}

function ErrorState({ retry }: { retry: () => void }) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="flex min-h-52 flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm text-destructive">无法读取 Maker Host 状态。</p>
        <Button variant="outline" onClick={retry}>重新连接</Button>
      </CardContent>
    </Card>
  )
}

const rootRoute = createRootRoute({ component: WorkbenchLayout })
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage })
const viewerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/viewer", component: ViewerPage })
const playerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/player", component: PlayerPage })
const assetManagerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/asset-manager", component: AssetManagerPage })
const designImportRoute = createRoute({ getParentRoute: () => rootRoute, path: "/design-import", component: DesignImportPage })
const artifactPlayerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/artifacts/$artifactId/player", component: ArtifactPlayerPage })
const projectViewerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId/viewer", component: ProjectViewerPage })
const projectAssetManagerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId/assets", component: ProjectAssetManagerPage })
const importDraftRoute = createRoute({ getParentRoute: () => rootRoute, path: "/imports/$draftId", component: ImportDraftRoutePage })
const routeTree = rootRoute.addChildren([dashboardRoute, viewerRoute, playerRoute, assetManagerRoute, designImportRoute, artifactPlayerRoute, projectViewerRoute, projectAssetManagerRoute, importDraftRoute])

function ImportDraftRoutePage() {
  const { draftId } = importDraftRoute.useParams()
  return <ImportDraftPage draftId={draftId} renderPreview={(project, onCapture) => <ProjectViewer project={project} compact onCapture={onCapture} />} />
}

export const router = createRouter({ routeTree, defaultPreload: "intent" })

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
