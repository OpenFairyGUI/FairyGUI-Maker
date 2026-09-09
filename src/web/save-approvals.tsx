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
    mutationFn: async ({ id, action }: { id: string; action: "approve" | "approve-session" | "reject" | "revoke" }) => {
      const response = await client.api["save-approvals"][":approvalRequestId"].decision.$post({
        param: { approvalRequestId: id }, json: { decision: action },
      }, { init: { signal: AbortSignal.timeout(10_000) } })
      if (!response.ok) {
        const body = await response.json()
        throw new Error("error" in body && typeof body.error === "string" ? body.error : `保存授权失败 (${response.status})`)
      }
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  const owner = useMutation({
    retry: false,
    mutationFn: async (action: "unlock" | "lock") => {
      // Only the one-time verification request sees the key; React Query never stores it as mutation data.
      const token = tokenInput.current?.value ?? ""
      if (tokenInput.current) tokenInput.current.value = ""
      const endpoint = client.api["save-approvals"]["owner-session"]
      const response = action === "unlock"
        ? await endpoint.$post({}, { headers: { "x-maker-approval-token": token }, init: { signal: AbortSignal.timeout(10_000) } })
        : await endpoint.$delete({}, { init: { signal: AbortSignal.timeout(10_000) } })
      if (!response.ok) {
        const body = await response.json()
        throw new Error("error" in body ? body.error : "所有者验证失败")
      }
      decision.reset()
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey }),
  })
  const verified = approvals.data?.ownerVerified === true
  const disabled = !verified || decision.isPending || owner.isPending
  const error = owner.error ?? decision.error ?? approvals.error
  return (
    <Card id="save-approvals" aria-labelledby="save-approvals-title">
      <CardHeader className="border-b">
        <CardTitle id="save-approvals-title">工程保存权限</CardTitle>
        <CardDescription>验证一次所有者身份，再选择仅批准这次保存，或允许指定工程会话连续普通保存。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {approvals.data?.enabled ? <>
          <p className="text-sm text-muted-foreground">会话授权允许后续修改写回原工程，包括移除已删除的资源。强制覆盖、指定保存路径和完整物化仍需单次确认；Viewer / Player 保持只读。</p>
          {verified ? <div className="flex flex-wrap items-center gap-3">
            <Badge variant="secondary">所有者已验证</Badge>
            <Button size="sm" variant="outline" disabled={owner.isPending || decision.isPending} onClick={() => owner.mutate("lock")}>锁定授权管理</Button>
            <p className="text-xs text-muted-foreground">锁定后需重新验证；已授予的保存权限仍有效，可在下方单独撤销。</p>
          </div> : <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); owner.mutate("unlock") }}>
            <label className="grid max-w-xl gap-1 text-sm">
              <span>Host 所有者确认密钥</span>
              <input ref={tokenInput} type="password" autoComplete="off" maxLength={256} required disabled={owner.isPending}
                placeholder="从 Host 的本地交互终端获取；不是 MCP token"
                className="h-9 rounded-md border bg-background px-3 outline-none focus-visible:ring-2 focus-visible:ring-ring" />
            </label>
            <Button type="submit" size="sm" disabled={owner.isPending}>{owner.isPending ? "正在验证…" : "验证所有者"}</Button>
            <p className="text-xs text-muted-foreground">确认密钥仅用于本次验证，不保存在页面或浏览器存储中；刷新页面无需重输，重启 Host 后需重新验证。不要把密钥交给 Agent。</p>
          </form>}
        </> : approvals.data ? <p className="text-sm text-muted-foreground">只读 Host 不提供保存授权。</p> : null}
        {error ? <p role="alert" className="text-sm text-destructive">{error.message}</p> : null}
        {decision.isSuccess ? <p role="status" className="text-sm text-muted-foreground">权限已更新。授权本身不会保存文件；请以 Agent 返回的保存结果为准。</p> : null}
        <div className="max-h-[36rem] space-y-3 overflow-auto">
          {approvals.data?.approvals.map((request) => (
            <section key={request.approvalRequestId} data-testid={`save-approval-${request.approvalRequestId}`} className="space-y-2 rounded-lg border p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium">{request.force ? "强制保存" : request.targetPath ? "指定路径保存" : request.operation === "materializeSession" || request.mode ? "完整物化" : "普通保存"}</span>
                <Badge variant={request.status === "pending" ? "outline" : "secondary"}>{request.scope === "session" && request.status === "approved" ? "本次会话允许普通保存" : statusLabels[request.status]}</Badge>
              </div>
              <p className="break-all text-sm">{request.canonicalProjectPath}</p>
              {request.targetPath ? <p className="break-all text-sm">保存目标：{request.targetPath}</p> : null}
              <p className="text-xs text-muted-foreground">{request.scope === "session" ? "授权绑定当前工程会话；撤销、关闭或重开工程、重启 Host 后失效。" : "本次请求从创建起 5 分钟内有效；单次授权仅执行一次，revision 改变后失效。"}</p>
              <details className="text-xs">
                <summary className="cursor-pointer text-muted-foreground">技术详情</summary>
                <dl className="mt-2 grid gap-1 break-all">
                <div><dt className="inline text-muted-foreground">Request：</dt><dd className="inline">{request.approvalRequestId}</dd></div>
                <div><dt className="inline text-muted-foreground">Session：</dt><dd className="inline">{request.sessionId} · revision {request.revision}</dd></div>
                <div><dt className="inline text-muted-foreground">工程目标：</dt><dd className="inline">{request.canonicalProjectPath}</dd></div>
                <div><dt className="inline text-muted-foreground">targetPath：</dt><dd className="inline">{request.targetPath ?? "原会话目标（不可另存）"}</dd></div>
                <div><dt className="inline text-muted-foreground">选项：</dt><dd className="inline">force={String(request.force)} · mode={request.mode ?? "default"} · reason={request.reason ?? "—"}</dd></div>
                <div><dt className="inline text-muted-foreground">操作 SHA-256：</dt><dd className="inline font-mono">{request.operationDigest}</dd></div>
                <div><dt className="inline text-muted-foreground">有效期至：</dt><dd className="inline">{request.expiresAt ? new Date(request.expiresAt).toLocaleString() : "当前工程会话结束"}</dd></div>
                </dl>
              </details>
              {request.status === "pending" ? <div className="flex flex-wrap gap-2">
                {request.sessionEligible ? <Button size="sm" disabled={disabled} onClick={() => decision.mutate({ id: request.approvalRequestId, action: "approve-session" })}>允许本次会话连续保存</Button> : null}
                <Button size="sm" variant={request.sessionEligible ? "outline" : "default"} disabled={disabled} onClick={() => decision.mutate({ id: request.approvalRequestId, action: "approve" })}>批准一次保存</Button>
                <Button size="sm" variant="outline" disabled={disabled} onClick={() => decision.mutate({ id: request.approvalRequestId, action: "reject" })}>拒绝</Button>
              </div> : request.status === "approved" ? <Button size="sm" variant="outline" disabled={disabled} onClick={() => decision.mutate({ id: request.approvalRequestId, action: "revoke" })}>撤销授权</Button> : null}
            </section>
          ))}
          {approvals.data?.enabled && !approvals.data.approvals.length ? <p className="text-sm text-muted-foreground">暂无保存请求。Agent 调用 save / materialize 时将在这里等待确认。</p> : null}
        </div>
      </CardContent>
    </Card>
  )
}
