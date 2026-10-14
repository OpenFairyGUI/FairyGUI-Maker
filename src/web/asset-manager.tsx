import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, getRouteApi } from "@tanstack/react-router"
import { useVirtualizer } from "@tanstack/react-virtual"
import { FolderPlus, RefreshCw, Search, ServerCog } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ErrorState, MetricCard, ViewerLoading } from "@/components/workbench"
import { getProject, getProjects, registerProjectAssetAnalysis, type RegisteredProjectData } from "@/lib/api"
import { readViewerProject } from "@/lib/viewer"
import { analyzeProjectAssets, displayAssetPath, summarizeAssetAnalysis, type AssetIssue, type AssetReference, type AssetResource } from "../asset-analysis"

const projectAssetManagerRoute = getRouteApi("/projects/$projectId/assets")

export function AssetManagerPage() {
  const projects = useQuery({ queryKey: ["projects", "asset-manager"], queryFn: getProjects })
  const availableProjects = projects.data?.projects.filter((project) => project.sourceOwner !== "session") ?? []
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
          {availableProjects.length ? (
            <div className="divide-y">
              {availableProjects.map((project) => (
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

export function ProjectAssetManagerPage() {
  const { projectId } = projectAssetManagerRoute.useParams()
  const project = useQuery({ queryKey: ["projects", projectId], queryFn: () => getProject(projectId) })
  if (project.isError) return <ErrorState retry={() => void project.refetch()} />
  if (project.data?.project.sourceOwner === "session") return <p role="status">会话预览按组件读取资源，暂不支持工程资源分析。请授权已保存的工程目录。</p>
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

  useEffect(() => {
    setSelectedKey((current) => resources.some(({ key }) => key === current) ? current : resources[0]?.key ?? "")
  }, [resources])

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

      <p role="note" className="rounded-lg border bg-muted/20 p-3 text-sm text-muted-foreground">浏览器分析 · 仅供参考（{result.analysisOwner} / {result.trust}）。Host 仅校验结构与版本，未独立验证引用和结论；动态加载、外部引用可能未被识别，不能据此自动删除资源。</p>

      <section aria-label="资源分析摘要" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Resources" value={String(summary.resources)} detail={`${result.resources.filter(({ kind }) => kind === "component").length} components`} />
        <MetricCard label="References" value={String(summary.references)} detail="Incoming + outgoing occurrences" />
        <MetricCard label="Broken" value={String(summary.missingReferences)} detail={`${summary.invalidUrls} invalid URLs (not counted as missing)`} />
        <MetricCard label="Health" value={String(result.issues.length)} detail={`${summary.unusedResources} unused · ${summary.unreachableComponents} unreachable · ${summary.duplicateGroups} duplicate groups · ${summary.conflictGroups} conflicts`} />
      </section>

      <Card className="overflow-hidden">
        <CardContent className="p-0">
          <div className="grid lg:h-[68vh] lg:min-h-[560px] lg:max-h-[760px] lg:grid-cols-[minmax(320px,.8fr)_minmax(0,1.2fr)]">
            <section className="flex min-h-0 flex-col border-b lg:border-b-0 lg:border-r" aria-label="资源列表">
              <div className="grid shrink-0 gap-2 border-b p-3 sm:grid-cols-[minmax(0,1fr)_150px]">
                <label className="relative min-w-0"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="搜索资源" aria-label="搜索 Asset Manager 资源" className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
                <select value={health} onChange={(event) => setHealth(event.target.value as typeof health)} aria-label="筛选资源健康状态" className="h-9 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <option value="all">全部资源</option><option value="missing">断链来源</option><option value="invalid-url">无法解析 URL</option><option value="unreachable">不可达私有组件</option><option value="unused">未使用</option><option value="duplicate">完全重复</option><option value="conflict">名称冲突</option>
                </select>
              </div>
              <AssetResourceList resources={resources} selectedKey={selectedKey} onSelect={setSelectedKey} />
            </section>
            <AssetResourceDetail resource={selected} resourceByKey={resourceByKey} incoming={incoming} outgoing={outgoing} issues={selectedIssues} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="border-b"><CardTitle>工程问题</CardTitle><CardDescription>问题只提供定位与影响信息；项目设置中的 URL 问题只在此列出，不对应单个资源。当前版本不会自动删除、重命名或合并资源。</CardDescription><CardAction><Badge variant={result.issues.some(({ severity }) => severity === "error") ? "destructive" : "secondary"}>{result.issues.length}</Badge></CardAction></CardHeader>
        <CardContent>
          {visibleIssues.length ? <div className="divide-y">{visibleIssues.map((issue, index) => <AssetIssueRow key={`${issue.kind}:${issue.label}:${index}`} issue={issue} resourceByKey={resourceByKey} />)}</div> : <div className="grid min-h-32 place-items-center text-sm text-muted-foreground">没有发现资源健康问题</div>}
          {result.issues.length > visibleIssues.length ? <p className="mt-4 text-xs text-muted-foreground">仅显示前 {visibleIssues.length} 项；可通过 Agent 按资源查询影响与截断信息。</p> : null}
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
  const issueKinds = [...new Set(issues.map(({ kind }) => kind))]
  return (
    <section className="min-w-0 overflow-auto p-5 lg:h-full" aria-label="资源详情">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-400">{resource.kind}</p><h2 className="mt-1 truncate text-xl font-semibold">{resource.name}</h2><p className="mt-1 truncate text-xs text-muted-foreground">{resource.packageName}/{displayAssetPath(resource)} · {resource.key}</p></div><div className="flex flex-wrap gap-2"><Badge variant={resource.exported ? "secondary" : "outline"}>{resource.exported ? "EXPORTED" : "INTERNAL"}</Badge>{issueKinds.map((kind) => <Badge key={kind} variant={issues.some((issue) => issue.kind === kind && issue.severity === "error") ? "destructive" : "outline"}>{assetIssueKindLabel(kind)}</Badge>)}</div></div>
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
  return { missing: "断链", unused: "未使用", duplicate: "重复", conflict: "冲突", "invalid-url": "无法解析 URL", unreachable: "不可达私有组件" }[kind]
}

function formatAssetBytes(value: number | null) {
  if (value === null) return "—"
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / 1_048_576).toFixed(1)} MiB`
}
