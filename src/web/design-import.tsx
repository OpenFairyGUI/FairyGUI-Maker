import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { AlertTriangle, ArrowRight, CheckCircle2, FileUp, FolderUp, Loader2, Trash2 } from "lucide-react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { RegisteredProjectData } from "@/lib/api"
import type { ImportDraftOutlineNode, ImportDraftV1, ImportVisualEvidenceV1 } from "../design-import/draft-store"
import type { FairyBuildPlanV2 } from "../design-import/plan"
import type { MakerSemanticOverlayV1, SemanticTarget } from "../design-import/semantic-overlay"
import { compareVisualBlobs } from "@/lib/visual-evidence"

export type VisualCaptureInfo = { packageId: string; componentId: string; packageName: string; componentName: string; renderState: NonNullable<ImportVisualEvidenceV1["renderState"]> }

type DraftDetail = {
  draft: ImportDraftV1
  buildPlan: FairyBuildPlanV2 | null
  outline: { name: string; pages: Array<{ id: string; name: string; roots: ImportDraftOutlineNode[] }> } | null
  semanticOverlay: MakerSemanticOverlayV1 | null
  preview: RegisteredProjectData | null
  previewError: string | null
}

type UploadFile = { file: File; path: string }

const draftListQuery = {
  queryKey: ["import-drafts"],
  queryFn: () => requestJson<{ drafts: ImportDraftV1[] }>("/api/import-drafts?limit=100"),
}

export function DesignImportPage() {
  const queryClient = useQueryClient()
  const drafts = useQuery(draftListQuery)
  const directoryInput = useRef<HTMLInputElement>(null)
  const [progress, setProgress] = useState("")
  const upload = useMutation({
    mutationFn: (input: { kind: "fig" | "psd" | "bundle"; name: string; files: UploadFile[] }) => (
      uploadDraft(input, ({ uploaded, total, path }) => setProgress(`${uploaded}/${total} · ${path}`))
    ),
    onSuccess: (draft) => window.location.assign(`/imports/${encodeURIComponent(draft.draftId)}`),
    onSettled: async () => queryClient.invalidateQueries({ queryKey: draftListQuery.queryKey }),
  })

  const chooseSingle = (files: FileList | null) => {
    const file = files?.[0]
    if (!file) return
    const kind = file.name.toLowerCase().endsWith(".fig") ? "fig" : file.name.toLowerCase().endsWith(".psd") ? "psd" : null
    if (!kind) {
      setProgress("请选择 .fig 或 .psd 文件")
      return
    }
    upload.mutate({ kind, name: file.name, files: [{ file, path: file.name }] })
  }

  const chooseBundle = (files: FileList | null) => {
    if (!files?.length) return
    try {
      const selected = [...files]
      const roots = new Set(selected.map((file) => file.webkitRelativePath.split("/", 1)[0]))
      if (roots.size !== 1) throw new Error("请选择一个 Maker Import Bundle 文件夹。")
      const name = [...roots][0]
      const uploadFiles = selected.map((file) => {
        const path = file.webkitRelativePath.slice(name.length + 1)
        if (!path) throw new Error("Bundle 包含无效文件路径。")
        return { file, path }
      })
      upload.mutate({ kind: "bundle", name, files: uploadFiles })
    } catch (error) {
      setProgress(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Design Import Studio</p>
        <h1 className="font-heading text-3xl font-semibold tracking-tight">设计稿导入</h1>
        <p className="mt-2 max-w-3xl text-sm text-muted-foreground">上传 FIG、PSD 或 Maker Import Bundle，在私有 Draft 中检查结构与诊断，确认后再写入新工程目录。</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>新建 Import Draft</CardTitle>
          <CardDescription>源文件先复制到 Maker 数据目录；只有点击 Materialize 才会写入目标工程。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-3">
          <Button asChild disabled={upload.isPending}>
            <label><FileUp />上传 FIG / PSD<input className="sr-only" type="file" accept=".fig,.psd" disabled={upload.isPending} onChange={(event) => { chooseSingle(event.target.files); event.currentTarget.value = "" }} /></label>
          </Button>
          <Button variant="outline" type="button" disabled={upload.isPending} onClick={() => directoryInput.current?.click()}><FolderUp />上传 Bundle 文件夹</Button>
          <input ref={(element) => { directoryInput.current = element; element?.setAttribute("webkitdirectory", "") }} className="sr-only" type="file" multiple disabled={upload.isPending} onChange={(event) => { chooseBundle(event.target.files); event.currentTarget.value = "" }} />
          {upload.isPending ? <span className="inline-flex min-w-0 items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 shrink-0 animate-spin" /><span className="truncate">{progress || "正在准备上传…"}</span></span> : null}
          {upload.isError ? <p className="w-full text-sm text-destructive">{errorMessage(upload.error)}</p> : null}
          {!upload.isPending && progress ? <p className="w-full text-sm text-muted-foreground">{progress}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Import Drafts</CardTitle><CardDescription>草稿保留 7 天，并可在 Maker 重启后继续。</CardDescription></CardHeader>
        <CardContent>
          {drafts.isPending ? <Loading label="正在读取 Draft…" /> : drafts.isError ? <p className="text-sm text-destructive">{errorMessage(drafts.error)}</p> : drafts.data.drafts.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">还没有 Import Draft。</p>
          ) : (
            <div className="divide-y rounded-lg border">
              {drafts.data.drafts.map((draft) => (
                <a key={draft.draftId} href={`/imports/${encodeURIComponent(draft.draftId)}`} className="flex items-center gap-4 p-4 transition-colors hover:bg-muted/40">
                  <div className="min-w-0 flex-1"><p className="truncate font-medium">{draft.input.name}</p><p className="mt-1 truncate text-xs text-muted-foreground">{draft.input.kind.toUpperCase()} · {formatTime(draft.updatedAt)}</p></div>
                  <StatusBadge status={draft.status} />
                  <ArrowRight className="size-4 text-muted-foreground" />
                </a>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

export function ImportDraftPage({ draftId, renderPreview }: { draftId: string; renderPreview: (project: RegisteredProjectData, onCapture: (blob: Blob, info: VisualCaptureInfo) => Promise<void>) => ReactNode }) {
  const queryClient = useQueryClient()
  const [profile, setProfile] = useState("legacy-hybrid")
  const [targetPath, setTargetPath] = useState("")
  const queryKey = ["import-drafts", draftId]
  const detail = useQuery({ queryKey, queryFn: () => requestJson<DraftDetail>(`/api/import-drafts/${encodeURIComponent(draftId)}`) })
  const action = useMutation({
    mutationFn: async (input: { kind: "parse" | "plan" | "compile" | "materialize" | "delete" | "mapping"; revision: number; nodeId?: string; target?: SemanticTarget }) => {
      if (input.kind === "delete") {
        await requestEmpty(`/api/import-drafts/${encodeURIComponent(draftId)}?expectedRevision=${input.revision}`, { method: "DELETE" })
        return null
      }
      if (input.kind === "mapping") {
        return requestJson(`/api/import-drafts/${encodeURIComponent(draftId)}/semantic-overlay`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: input.revision,
            nodeId: input.nodeId,
            directive: { target: input.target, confidence: 1, rationale: "User mapping" },
          }),
        })
      }
      return requestJson(`/api/import-drafts/${encodeURIComponent(draftId)}/${input.kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          expectedRevision: input.revision,
          ...(input.kind === "materialize" ? { targetPath } : {}),
          ...(input.kind === "plan" && detail.data?.draft.status === "planned" && detail.data.buildPlan ? {
            rootIds: detail.data.buildPlan.packages.flatMap((pkg) => pkg.components.filter((root) => root.exported).map((root) => root.sourceNodeId)),
          } : {}),
        }),
      })
    },
    onSuccess: async (_result, input) => {
      if (input.kind === "delete") window.location.assign("/design-import")
      else await queryClient.invalidateQueries({ queryKey })
    },
  })

  if (detail.isPending) return <Loading label="正在读取 Import Draft…" />
  if (detail.isError) return <Card className="border-destructive/40"><CardContent className="py-12 text-center text-sm text-destructive">{errorMessage(detail.error)}</CardContent></Card>
  const { draft, buildPlan, outline, semanticOverlay, preview, previewError } = detail.data
  const busy = action.isPending

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <p className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-blue-400">Import Draft</p>
          <h1 className="truncate font-heading text-3xl font-semibold tracking-tight">{draft.input.name}</h1>
          <p className="mt-2 text-sm text-muted-foreground">{draft.input.kind.toUpperCase()} · revision {draft.revision} · 到期 {formatTime(draft.expiresAt)}</p>
        </div>
        <StatusBadge status={draft.status} />
        <Button variant="destructive" size="sm" disabled={busy} onClick={() => action.mutate({ kind: "delete", revision: draft.revision })}><Trash2 />删除 Draft</Button>
      </div>

      <Card>
        <CardHeader><CardTitle>转换流程</CardTitle><CardDescription>当前 MVP 仅启用已验证的 Hybrid 编译策略。</CardDescription></CardHeader>
        <CardContent className="flex flex-wrap items-end gap-3">
          <label className="grid w-64 gap-1.5 text-sm"><span className="text-muted-foreground">Profile</span><select value={profile} onChange={(event) => setProfile(event.target.value)} disabled={busy || draft.status !== "parsed"} className="h-9 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"><option value="legacy-hybrid">Hybrid · legacy-hybrid</option></select></label>
          {draft.status === "created" ? <Button disabled={busy} onClick={() => action.mutate({ kind: "parse", revision: draft.revision })}>解析 Source</Button> : null}
          {draft.status === "parsed" || draft.status === "planned" ? <Button disabled={busy || profile !== "legacy-hybrid"} onClick={() => action.mutate({ kind: "plan", revision: draft.revision })}>{draft.status === "planned" ? "重新生成 Build Plan" : "生成 Build Plan"}</Button> : null}
          {draft.status === "planned" ? <Button disabled={busy} onClick={() => action.mutate({ kind: "compile", revision: draft.revision })}>编译 Viewer Preview</Button> : null}
          {draft.status === "uploading" ? <p className="text-sm text-amber-500">上传尚未完成。浏览器不会保留文件授权，请删除后重新上传。</p> : null}
          {busy ? <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在处理…</span> : null}
          {action.isError ? <p className="w-full text-sm text-destructive">{errorMessage(action.error)}</p> : null}
        </CardContent>
      </Card>

      <div className="grid gap-6 xl:grid-cols-2">
        <OutlineCard
          outline={outline}
          semanticOverlay={semanticOverlay}
          editable={draft.status === "parsed" && !busy}
          mappingNodeId={action.isPending && action.variables?.kind === "mapping" ? action.variables.nodeId ?? null : null}
          onMap={(nodeId, target) => action.mutate({ kind: "mapping", revision: draft.revision, nodeId, target })}
        />
        <DiagnosticsCard diagnostics={draft.diagnostics} />
      </div>

      <BuildSummaryCard draft={draft} buildPlan={buildPlan} />

      {draft.generated ? <VisualEvidenceWorkspace draft={draft} preview={preview} previewError={previewError} renderPreview={renderPreview} /> : null}

      {draft.status === "compiled" ? (
        <Card>
          <CardHeader><CardTitle>Materialize</CardTitle><CardDescription>目标必须是尚不存在的新目录；写入采用临时目录校验后原子改名。</CardDescription></CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <label className="grid min-w-[280px] flex-1 gap-1.5 text-sm"><span className="text-muted-foreground">Maker Host 本机绝对路径</span><input value={targetPath} onChange={(event) => setTargetPath(event.target.value)} placeholder="E:\\Projects\\ImportedUI" className="h-9 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring" /></label>
            <Button disabled={busy || !targetPath.trim()} onClick={() => action.mutate({ kind: "materialize", revision: draft.revision })}><CheckCircle2 />Materialize</Button>
          </CardContent>
        </Card>
      ) : draft.materialized ? (
        <Card><CardContent className="flex items-center gap-3 py-5 text-sm"><CheckCircle2 className="size-5 text-emerald-500" /><span>已写入 <code>{draft.materialized.outputDirectory}</code></span></CardContent></Card>
      ) : null}
    </div>
  )
}

function VisualEvidenceWorkspace({ draft, preview, previewError, renderPreview }: {
  draft: ImportDraftV1
  preview: RegisteredProjectData | null
  previewError: string | null
  renderPreview: (project: RegisteredProjectData, onCapture: (blob: Blob, info: VisualCaptureInfo) => Promise<void>) => ReactNode
}) {
  const queryClient = useQueryClient()
  const [reference, setReference] = useState<File | null>(null)
  const [referenceUrl, setReferenceUrl] = useState("")
  const [mode, setMode] = useState<"overlay" | "side-by-side" | "diff">("overlay")
  const [opacity, setOpacity] = useState(50)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!reference) { setReferenceUrl(""); return }
    const url = URL.createObjectURL(reference)
    setReferenceUrl(url)
    return () => URL.revokeObjectURL(url)
  }, [reference])

  const saved = reference ? null : draft.visualEvidence
  const imageUrl = (name: "reference" | "capture" | "diff") => `/api/import-drafts/${encodeURIComponent(draft.draftId)}/visual-evidence/${name}?revision=${draft.revision}`
  const visibleReference = referenceUrl || (saved ? imageUrl("reference") : "")

  const capture = async (blob: Blob, info: VisualCaptureInfo) => {
    setError("")
    setSaving(true)
    try {
      const referenceBlob = reference ?? (draft.visualEvidence
        ? await fetch(imageUrl("reference")).then(async (response) => {
          if (!response.ok) throw new Error("读取已保存的 Reference Image 失败。")
          return response.blob()
        })
        : null)
      if (!referenceBlob) throw new Error("请先选择 Reference Image PNG。")
      if (referenceBlob.type !== "image/png" || referenceBlob.size > 16 * 1024 * 1024) {
        throw new Error("Reference Image 必须是小于 16 MiB 的 PNG。")
      }
      const compared = await compareVisualBlobs(referenceBlob, blob)
      const report = {
        schemaVersion: 1 as const,
        ...info,
        reference: compared.reference,
        capture: compared.capture,
        comparison: compared.metrics,
      }
      const form = new FormData()
      form.set("report", JSON.stringify(report))
      form.set("reference", referenceBlob, "reference.png")
      form.set("capture", blob, "capture.png")
      form.set("diff", compared.diff, "diff.png")
      await requestJson(`/api/import-drafts/${encodeURIComponent(draft.draftId)}/visual-evidence?expectedRevision=${draft.revision}`, { method: "POST", body: form })
      setReference(null)
      await queryClient.invalidateQueries({ queryKey: ["import-drafts", draft.draftId] })
    } catch (captureError) {
      setError(errorMessage(captureError))
    } finally {
      setSaving(false)
    }
  }

  return <div className="space-y-6">
    <Card>
      <CardHeader><CardTitle>Visual Evidence</CardTitle><CardDescription>选择 Reference Image 后从 Viewer 捕获；报告保留原始像素指标，不使用全局相似度通过线。</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <Button asChild variant="outline" disabled={saving}>
            <label><FileUp />Reference Image<input data-testid="visual-reference-input" className="sr-only" type="file" accept="image/png" disabled={saving} onChange={(event) => { setError(""); setReference(event.target.files?.[0] ?? null); event.currentTarget.value = "" }} /></label>
          </Button>
          {visibleReference ? <span className="text-xs text-muted-foreground">{reference ? `${reference.name} · 等待 Viewer Capture` : `已保存 · ${saved?.componentName}`}</span> : <span className="text-xs text-muted-foreground">尚未选择 PNG 基线</span>}
          {saving ? <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />正在生成 Pixel Diff…</span> : null}
        </div>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
        {visibleReference ? <VisualComparison referenceUrl={visibleReference} evidence={saved} imageUrl={imageUrl} mode={mode} opacity={opacity} onMode={setMode} onOpacity={setOpacity} /> : null}
      </CardContent>
    </Card>
    <Card className="overflow-hidden">
      <CardHeader><CardTitle>Viewer Preview</CardTitle><CardDescription>直接读取 Draft 内的只读生成工程；选择组件后点击“捕获视觉证据”。</CardDescription></CardHeader>
      <CardContent>{preview ? renderPreview(preview, capture) : <p className="py-10 text-center text-sm text-destructive">{previewError ?? "Viewer Preview 尚未就绪。"}</p>}</CardContent>
    </Card>
  </div>
}

function VisualComparison({ referenceUrl, evidence, imageUrl, mode, opacity, onMode, onOpacity }: {
  referenceUrl: string
  evidence: ImportVisualEvidenceV1 | null
  imageUrl: (name: "reference" | "capture" | "diff") => string
  mode: "overlay" | "side-by-side" | "diff"
  opacity: number
  onMode: (mode: "overlay" | "side-by-side" | "diff") => void
  onOpacity: (opacity: number) => void
}) {
  if (!evidence) return <div className="grid max-h-[480px] place-items-center overflow-auto rounded-lg border bg-muted/20 p-3"><img src={referenceUrl} alt="Reference Image" className="max-h-[440px] max-w-full" /></div>
  return <div className="space-y-4" data-testid="visual-report">
    <p className="text-xs text-muted-foreground">{evidence.renderState ? `Semantic ${evidence.renderState.semanticStateVersion} · View ${evidence.renderState.viewStateVersion} · ${evidence.renderState.sourceRevision.slice(0, 12)}` : "旧版证据：未记录 Broker 状态版本"}</p>
    <div className="flex flex-wrap items-center gap-2">
      {(["overlay", "side-by-side", "diff"] as const).map((value) => <Button key={value} type="button" size="sm" variant={mode === value ? "default" : "outline"} onClick={() => onMode(value)}>{value === "overlay" ? "Opacity Overlay" : value === "side-by-side" ? "Side-by-side" : "Pixel Diff"}</Button>)}
      {mode === "overlay" ? <label className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">Capture {opacity}%<input aria-label="Overlay opacity" type="range" min="0" max="100" value={opacity} onChange={(event) => onOpacity(Number(event.target.value))} /></label> : null}
    </div>
    {mode === "side-by-side" ? <div className="grid gap-3 lg:grid-cols-2"><EvidenceImage label="Reference" src={referenceUrl} /><EvidenceImage label="Viewer Capture" src={imageUrl("capture")} /></div> : mode === "diff" ? <EvidenceImage label="Pixel Diff" src={imageUrl("diff")} dark /> : <div className="grid max-h-[480px] place-items-center overflow-auto rounded-lg border bg-muted/20 p-3"><div className="relative grid max-w-full"><img src={referenceUrl} alt="Reference Image" className="col-start-1 row-start-1 max-h-[440px] max-w-full" /><img src={imageUrl("capture")} alt="Viewer Capture overlay" className="col-start-1 row-start-1 max-h-[440px] max-w-full" style={{ opacity: opacity / 100 }} /></div></div>}
    <div className="grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-4">
      <VisualMetric label="Compared" value={`${evidence.comparison.width}×${evidence.comparison.height}`} />
      <VisualMetric label="Different pixels" value={`${evidence.comparison.differentPixels} / ${evidence.comparison.totalPixels}`} />
      <VisualMetric label="Mean absolute error" value={evidence.comparison.meanAbsoluteError.toFixed(4)} />
      <VisualMetric label="Max channel delta" value={String(evidence.comparison.maxChannelDelta)} />
    </div>
  </div>
}

function EvidenceImage({ label, src, dark = false }: { label: string; src: string; dark?: boolean }) {
  return <figure className={`overflow-auto rounded-lg border p-3 ${dark ? "bg-[#202226]" : "bg-muted/20"}`}><figcaption className="mb-2 text-xs text-muted-foreground">{label}</figcaption><img src={src} alt={label} className="mx-auto max-h-[420px] max-w-full" /></figure>
}

function VisualMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 font-medium">{value}</p></div>
}

function OutlineCard({ outline, semanticOverlay, editable, mappingNodeId, onMap }: {
  outline: DraftDetail["outline"]
  semanticOverlay: MakerSemanticOverlayV1 | null
  editable: boolean
  mappingNodeId: string | null
  onMap: (nodeId: string, target: SemanticTarget) => void
}) {
  return <Card><CardHeader><CardTitle>Source Outline</CardTitle><CardDescription>{outline ? `${outline.pages.length} pages · ${outline.name} · Mapping Review` : "解析后显示源文档结构。"}</CardDescription></CardHeader><CardContent className="max-h-96 overflow-auto">{outline ? outline.pages.map((page) => <div key={page.id} className="mb-4"><p className="mb-2 text-sm font-semibold">{page.name}</p><div className="space-y-1 border-l pl-3">{page.roots.map((root) => <OutlineNode key={root.id} node={root} semanticOverlay={semanticOverlay} editable={editable} mappingNodeId={mappingNodeId} onMap={onMap} />)}</div></div>) : <p className="py-8 text-center text-sm text-muted-foreground">尚无 Outline</p>}</CardContent></Card>
}

function OutlineNode({ node, semanticOverlay, editable, mappingNodeId, onMap }: {
  node: ImportDraftOutlineNode
  semanticOverlay: MakerSemanticOverlayV1 | null
  editable: boolean
  mappingNodeId: string | null
  onMap: (nodeId: string, target: SemanticTarget) => void
}) {
  const directive = semanticOverlay?.nodes[node.id]
  const row = <div className="flex min-w-0 items-center gap-2 py-1"><span className="shrink-0 text-[10px] uppercase text-muted-foreground">{node.kind}</span><span className="min-w-0 flex-1 truncate text-sm">{node.name}</span><span className="shrink-0 text-xs text-muted-foreground">{Math.round(node.width)}×{Math.round(node.height)}</span><select aria-label={`Mapping ${node.name}`} title={directive?.rationale ?? "Default auto"} value={directive?.target ?? "auto"} disabled={!editable || mappingNodeId === node.id} onChange={(event) => onMap(node.id, event.target.value as SemanticTarget)} className="h-7 w-28 shrink-0 rounded-md border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring">{mappingTargets(node.kind).map((target) => <option key={target} value={target}>{semanticTargetLabel(target)}</option>)}</select></div>
  if (!node.children?.length) return row
  return <details open className="py-1"><summary className="cursor-pointer marker:text-muted-foreground">{row}</summary><div className="ml-3 border-l pl-3">{node.children.map((child) => <OutlineNode key={child.id} node={child} semanticOverlay={semanticOverlay} editable={editable} mappingNodeId={mappingNodeId} onMap={onMap} />)}</div></details>
}

function DiagnosticsCard({ diagnostics }: { diagnostics: ImportDraftV1["diagnostics"] }) {
  return <Card><CardHeader><CardTitle>Diagnostics</CardTitle><CardDescription>{diagnostics.length ? `${diagnostics.length} 条解析与转换诊断` : "没有诊断。"}</CardDescription></CardHeader><CardContent className="max-h-96 space-y-2 overflow-auto">{diagnostics.length ? diagnostics.map((diagnostic, index) => <div key={`${diagnostic.code}:${diagnostic.nodeId}:${index}`} className="flex gap-3 rounded-md border p-3 text-sm"><AlertTriangle className={`mt-0.5 size-4 shrink-0 ${diagnostic.severity === "error" ? "text-destructive" : "text-amber-500"}`} /><div className="min-w-0"><p className="font-medium">{diagnostic.code}</p><p className="mt-1 text-muted-foreground">{diagnostic.message}</p><p className="mt-1 truncate text-xs text-muted-foreground">{[diagnostic.pageName, diagnostic.rootName, diagnostic.nodeName].filter(Boolean).join(" / ") || diagnostic.nodeId}</p></div></div>) : <p className="py-8 text-center text-sm text-muted-foreground">暂无 Diagnostics</p>}</CardContent></Card>
}

function BuildSummaryCard({ draft, buildPlan }: { draft: ImportDraftV1; buildPlan: FairyBuildPlanV2 | null }) {
  const report = draft.generated?.report
  const semanticNodes = Object.values(buildPlan?.semanticOverlay?.nodes ?? {}).filter(({ target }) => target !== "auto").length
  const metrics = buildPlan ? [
    ["Profile", buildPlan.profile],
    ["Packages", String(buildPlan.packages.length)],
    ["Components", String(buildPlan.packages.reduce((count, pkg) => count + pkg.components.length, 0))],
    ["Nodes", report ? String(report.nodes) : "—"],
    ["Editable", report ? String(report.editableText + report.editableShapes + report.editableInstances) : "—"],
    ["Rasterized", report ? String(report.rasterizedNodes) : "—"],
    ["Semantic", String(semanticNodes)],
  ] : []
  return <Card><CardHeader><CardTitle>Build Summary</CardTitle><CardDescription>{buildPlan ? "当前 Draft 的可复现 Build Plan。" : "规划后显示包、组件和转换统计。"}</CardDescription></CardHeader><CardContent>{metrics.length ? <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-7">{metrics.map(([label, value]) => <div key={label} className="rounded-lg border bg-muted/20 p-3"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 truncate font-heading text-lg font-semibold">{value}</p></div>)}</div> : <p className="py-8 text-center text-sm text-muted-foreground">尚无 Build Plan</p>}</CardContent></Card>
}

function mappingTargets(kind: ImportDraftOutlineNode["kind"]): SemanticTarget[] {
  if (kind === "frame") return ["auto", "component", "button", "label", "list", "list-item", "progress-bar", "slider", "rasterize", "ignore"]
  if (kind === "instance") return ["auto", "component", "list-item", "rasterize", "ignore"]
  if (kind === "text") return ["auto", "text-input", "rasterize", "ignore"]
  if (kind === "shape") return ["auto", "graph", "rasterize", "ignore"]
  return ["auto", "image", "rasterize", "ignore"]
}

function semanticTargetLabel(target: SemanticTarget) {
  return { auto: "Auto", component: "Component", button: "Button", label: "Label", list: "List", "list-item": "ListItem", "progress-bar": "ProgressBar", slider: "Slider", "text-input": "TextInput", graph: "Graph", image: "Image", ignore: "Ignore", rasterize: "Rasterize" }[target]
}

function StatusBadge({ status }: { status: ImportDraftV1["status"] }) {
  const labels: Record<ImportDraftV1["status"], string> = { uploading: "UPLOADING", created: "CREATED", parsed: "PARSED", planned: "PLANNED", compiled: "COMPILED", materialized: "MATERIALIZED" }
  return <Badge variant={status === "materialized" ? "secondary" : "outline"}>{labels[status]}</Badge>
}

function Loading({ label }: { label: string }) {
  return <div className="grid min-h-52 place-items-center text-sm text-muted-foreground"><span className="inline-flex items-center gap-2"><Loader2 className="size-4 animate-spin" />{label}</span></div>
}

async function uploadDraft(input: { kind: "fig" | "psd" | "bundle"; name: string; files: UploadFile[] }, onProgress: (value: { uploaded: number; total: number; path: string }) => void) {
  const created = await requestJson<{ draft: ImportDraftV1 }>("/api/import-drafts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind: input.kind, name: input.name, files: input.files.map(({ file, path }) => ({ path, size: file.size })) }),
  })
  let uploaded = 0
  for (const { file, path } of input.files) {
    onProgress({ uploaded, total: input.files.length, path })
    await requestJson(`/api/import-drafts/${encodeURIComponent(created.draft.draftId)}/source?path=${encodeURIComponent(path)}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: file })
    uploaded += 1
  }
  onProgress({ uploaded, total: input.files.length, path: "正在校验并解析…" })
  const completed = await requestJson<{ draft: ImportDraftV1 }>(`/api/import-drafts/${encodeURIComponent(created.draft.draftId)}/source/complete`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: created.draft.revision }),
  })
  return (await requestJson<{ draft: ImportDraftV1 }>(`/api/import-drafts/${encodeURIComponent(created.draft.draftId)}/parse`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: completed.draft.revision }),
  })).draft
}

async function requestJson<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(await responseError(response))
  return await response.json() as T
}

async function requestEmpty(url: string, init?: RequestInit): Promise<void> {
  const response = await fetch(url, init)
  if (!response.ok) throw new Error(await responseError(response))
}

async function responseError(response: Response) {
  try { return (await response.json() as { error?: string }).error ?? `请求失败 (${response.status})` } catch { return `请求失败 (${response.status})` }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "short" }).format(new Date(value))
}
