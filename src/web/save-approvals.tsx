import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useRef } from "react"
import { hc } from "hono/client"
import type { AppType } from "../server/index"
import type { SaveApproval } from "../server/save-grants"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

const client = hc<AppType>("/")
const queryKey = ["save-approvals"]
const statusLabels: Record<SaveApproval["status"], string> = {
  pending: "待确认", approved: "已授权 · 待执行", consumed: "已消耗", rejected: "已拒绝", revoked: "已撤销", expired: "已过期", stale: "已失效",
}

export function SaveApprovalsCard() {
  const queryClient = useQueryClient()
  const tokenInput = useRef<HTMLInputElement>(null)
  const approvals = useQuery({
    queryKey, refetchInterval: 2_000,
    queryFn: async ({ signal }) => {
      const response = await client.api["save-approvals"].$get({}, { init: { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) } })
      if (!response.ok) throw new Error(`读取保存授权失败 (${response.status})`)
      return response.json()
    },
  })
  const decision = useMutation({
    retry: false,
    mutationFn: async ({ id, action }: { id: string; action: "approve" | "reject" | "revoke" }) => {
      // Do not put the owner's secret in query/mutation data, browser storage, URLs, or a persistent cookie.
      const token = tokenInput.current?.value ?? ""
      if (tokenInput.current) tokenInput.current.value = ""
      const response = await client.api["save-approvals"][":approvalRequestId"].decision.$post({
        param: { approvalRequestId: id }, json: { decision: action },
      }, { headers: { "x-maker-approval-token": token }, init: { signal: AbortSignal.timeout(10_000) } })
      if (!response.ok) {
        const body = await response.json()
        throw new Error("error" in body && typeof body.error === "string" ? body.error : `保存授权失败 (${response.status})`)
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  const error = decision.error ?? approvals.error
  return (
    <Card id="save-approvals" aria-labelledby="save-approvals-title">
      <CardHeader className="border-b">
        <CardTitle id="save-approvals-title">Host Save Grant</CardTitle>
        <CardDescription>保存必须由工程所有者确认。每份授权仅适用于列出的会话、revision 与操作，从请求创建起 5 分钟内有效，最多执行一次。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {approvals.data?.enabled ? <>
          <p className="text-sm text-muted-foreground">保存可能覆盖工程文件并删除本次编辑移除的资源；完整物化会重写整个工程。确认前请核对目标与 Agent 的改动。授权不改变只读 Viewer / Player 的权限。</p>
          <label className="grid max-w-xl gap-1 text-sm">
            <span>Host 所有者确认密钥</span>
            <input ref={tokenInput} type="password" autoComplete="off" maxLength={256} disabled={decision.isPending}
              placeholder="从 Host 的本地交互终端获取；不是 MCP token"
              className="h-9 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
          </label>
          <p className="text-xs text-muted-foreground">也可由所有者在启动时单独配置 FAIRYGUI_MAKER_APPROVAL_TOKEN。密钥不会保存，每次确认后清空；不要交给 Agent。</p>
        </> : approvals.data ? <p className="text-sm text-muted-foreground">只读 Host 不提供保存授权。</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
        {decision.isSuccess ? <p role="status" className="text-sm text-muted-foreground">决定已记录。批准后由 Agent 使用完全相同的参数重试；“已消耗”表示已尝试执行，不代表保存成功，请检查工具结果。</p> : null}
        <div className="max-h-[36rem] space-y-3 overflow-auto">
          {approvals.data?.approvals.map((request) => (
            <section key={request.approvalRequestId} data-testid={`save-approval-${request.approvalRequestId}`} className="space-y-2 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2"><code className="text-sm">{request.operation}</code><Badge variant={request.status === "pending" ? "outline" : "secondary"}>{statusLabels[request.status]}</Badge></div>
              <dl className="grid gap-1 break-all text-xs">
                <div><dt className="inline text-muted-foreground">Request：</dt><dd className="inline">{request.approvalRequestId}</dd></div>
                <div><dt className="inline text-muted-foreground">Session：</dt><dd className="inline">{request.sessionId} · revision {request.revision}</dd></div>
                <div><dt className="inline text-muted-foreground">工程目标：</dt><dd className="inline">{request.canonicalProjectPath}</dd></div>
                <div><dt className="inline text-muted-foreground">targetPath：</dt><dd className="inline">{request.targetPath ?? "原会话目标（不可另存）"}</dd></div>
                <div><dt className="inline text-muted-foreground">选项：</dt><dd className="inline">force={String(request.force)} · mode={request.mode ?? "default"} · reason={request.reason ?? "—"}</dd></div>
                <div><dt className="inline text-muted-foreground">操作 SHA-256：</dt><dd className="inline font-mono">{request.operationDigest}</dd></div>
                <div><dt className="inline text-muted-foreground">有效期至：</dt><dd className="inline">{new Date(request.expiresAt).toLocaleString()}</dd></div>
              </dl>
              {request.status === "pending" ? <div className="flex gap-2">
                <Button size="sm" disabled={decision.isPending} onClick={() => decision.mutate({ id: request.approvalRequestId, action: "approve" })}>批准一次保存</Button>
                <Button size="sm" variant="outline" disabled={decision.isPending} onClick={() => decision.mutate({ id: request.approvalRequestId, action: "reject" })}>拒绝</Button>
              </div> : request.status === "approved" ? <Button size="sm" variant="outline" disabled={decision.isPending} onClick={() => decision.mutate({ id: request.approvalRequestId, action: "revoke" })}>撤销授权</Button> : null}
            </section>
          ))}
          {approvals.data?.enabled && !approvals.data.approvals.length ? <p className="text-sm text-muted-foreground">暂无保存请求。Agent 调用 save / materialize 时将在这里等待确认。</p> : null}
        </div>
      </CardContent>
    </Card>
  )
}
