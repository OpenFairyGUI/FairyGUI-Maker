import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { createColumnHelper, tableFeatures, useTable } from "@tanstack/react-table"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Archive, Eye, FolderKanban, FolderPlus, RefreshCw } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ArtifactTrust, ErrorState, MetricCard, formatTime, projectSourceLabel } from "@/components/workbench"
import { SaveApprovalsCard } from "@/save-approvals"
import { createProject, deleteProject, getArtifacts, getProjects, getSessions, openSessionPreview } from "@/lib/api"
import { importPublishedFolder } from "@/lib/artifacts"
import {
  authorizeProjectDirectory,
  cleanupProjectBindings,
  deleteProjectBinding,
  saveProjectBinding,
  type ProjectBindingPermission,
} from "@/lib/project-source"
import { artifactsQuery, projectsQuery, sessionsQuery, statusQuery } from "@/lib/queries"

type SessionRow = {
  id: string
  kind: "MCP" | "Project"
  name: string
  state: string
  activity: string
  revision?: number
}

const tableFeatureSet = tableFeatures({})
const columnHelper = createColumnHelper<typeof tableFeatureSet, SessionRow>()
const sessionColumns = columnHelper.columns([
  columnHelper.accessor("kind", { header: "类型" }),
  columnHelper.accessor("name", { header: "会话", cell: ({ row }) => <div className="flex items-center gap-2"><span className="truncate">{row.original.name}</span>{row.original.kind === "Project" && row.original.revision !== undefined ? <SessionPreviewButton sessionId={row.original.id} revision={row.original.revision} /> : null}</div> }),
  columnHelper.accessor("state", { header: "状态" }),
  columnHelper.accessor("activity", { header: "最近活动" }),
])
const columnWidths = ["14%", "36%", "18%", "32%"]

export function DashboardPage() {
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
            <CardDescription>MCP 空闲 30 分钟自动回收，活跃调用不受影响；工程会话需显式关闭。</CardDescription>
            <CardAction><Badge variant="secondary">{(sessions.data?.mcp.length ?? 0) + (sessions.data?.projects.length ?? 0)} active</Badge></CardAction>
          </CardHeader>
          <CardContent>
            <SessionTable data={sessions.data} />
            {sessions.data?.activity.some((entry) => entry.errorCode) ? (
              <details className="mt-4 border-t pt-3 text-xs text-muted-foreground">
                <summary className="cursor-pointer">最近 Backend 错误</summary>
                <ul className="mt-2 space-y-2">
                  {sessions.data.activity.filter((entry) => entry.errorCode).slice(0, 10).map((entry, index) => (
                    <li key={index} className="break-words">{entry.method} · {entry.errorCode} · {formatTime(entry.at)}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </CardContent>
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
                  <p className="mt-1 truncate text-xs text-muted-foreground">{projectSourceLabel(project)}</p>
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
                  <p className="mt-1 text-xs text-muted-foreground"><ArtifactTrust artifact={artifact} /></p>
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
  const label = permission === "session" ? "会话预览" : permission === "host" ? "CLI 授权" : permission === "granted" ? "已授权" : permission === "prompt" ? "需要确认" : permission === "denied" ? "已拒绝" : permission === "missing" ? "绑定缺失" : "权限未知"
  return <Badge variant={permission === "granted" || permission === "host" ? "secondary" : "outline"}>{label}</Badge>
}

function formatError(error: Error) {
  return error.message || "工程创建失败。"
}

function SessionPreviewButton({ sessionId, revision }: { sessionId: string; revision: number }) {
  const preview = useMutation({
    mutationFn: () => openSessionPreview(sessionId, revision),
    onSuccess: (project) => window.location.assign(project.viewerUrl),
  })
  return <div><Button size="sm" variant="outline" disabled={preview.isPending} onClick={() => preview.mutate()}>预览会话</Button>{preview.error ? <p role="alert" className="whitespace-normal text-xs text-destructive">{preview.error.message}</p> : null}</div>
}

function SessionTable({ data }: { data: Awaited<ReturnType<typeof getSessions>> | undefined }) {
  const rows = useMemo<SessionRow[]>(() => [
    ...(data?.mcp ?? []).map((session) => ({
      id: session.id ?? "initializing",
      kind: "MCP" as const,
      name: session.id ?? "Initializing",
      state: session.lastError ?? (session.activeRequests ? "Running" : "Connected"),
      activity: formatTime(session.lastActivityAt),
    })),
    ...(data?.projects ?? []).map((session) => ({
      id: session.id,
      kind: "Project" as const,
      name: session.projectName,
      revision: session.revision,
      state: session.lastError ?? (session.dirty ? "Dirty" : "Clean"),
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
