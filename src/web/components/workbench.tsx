import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { RegisteredProjectData } from "@/lib/api"
import type { ArtifactManifest } from "../../artifact-protocol"

export function formatTime(value?: string) {
  return value ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)) : "—"
}

export function ArtifactTrust({ artifact }: { artifact: Pick<ArtifactManifest, "verification"> }) {
  const source = artifact.verification?.source
  return <span>{artifact.verification?.content === "host-validated" ? "内容已校验" : "内容校验未知"} · {source === "host-published" ? "由 Host 从已保存会话发布" : source === "client-declared" ? "来源为客户端声明" : "来源未经验证"}</span>
}

export function MetricCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <Card size="sm">
      <CardHeader><CardDescription>{label}</CardDescription><CardTitle className="text-2xl capitalize">{value}</CardTitle></CardHeader>
      <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
    </Card>
  )
}

export function projectSourceLabel(project: Pick<RegisteredProjectData, "backendSession" | "directoryName" | "fairyPath">) {
  return project.backendSession ? `会话 revision ${project.backendSession.revision} · ${project.backendSession.dirty ? "未保存" : "已保存"}` : `${project.directoryName}/${project.fairyPath}`
}

export function ViewerLoading({ message, compact = false }: { message: string; compact?: boolean }) {
  return (
    <div className={`grid place-items-center text-center text-sm text-muted-foreground ${compact ? "min-h-40 flex-1 p-4" : "min-h-52 p-8"}`}>
      <div><RefreshCw className="mx-auto mb-3 size-5 animate-spin" /><p>{message}</p></div>
    </div>
  )
}

export function ErrorState({ retry }: { retry: () => void }) {
  return (
    <Card className="border-destructive/40">
      <CardContent className="flex min-h-52 flex-col items-center justify-center gap-4 text-center">
        <p className="text-sm text-destructive">无法读取 Maker Host 状态。</p>
        <Button variant="outline" onClick={retry}>重新连接</Button>
      </CardContent>
    </Card>
  )
}
