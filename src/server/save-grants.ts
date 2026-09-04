import { createHash, randomUUID } from "node:crypto"
import { BACKEND_CAPABILITY_SCHEMA_VERSION, BACKEND_CONTRACT_VERSION } from "@openfairygui/backend"
import type { OpenFairyGuiBackendRuntime } from "@openfairygui/mcp"
import { z } from "zod"

export const SAVE_GRANT_TTL_MS = 5 * 60_000
export const MAX_SAVE_APPROVALS = 128
type SaveOperation = "saveSession" | "materializeSession"
const commonInput = {
  sessionId: z.string().min(1).max(128),
  // The upstream schema makes this optional; the Host requires it, including for force-save.
  expectedRevision: z.number().int().nonnegative(),
}
const saveInputs = {
  saveSession: z.object({ ...commonInput, targetPath: z.string().min(1).max(4_096).optional(), force: z.boolean().optional(), mode: z.literal("materializeCleanSession").optional() }).strict(),
  materializeSession: z.object({ ...commonInput, mode: z.literal("fullProject").optional(), reason: z.string().min(1).max(1_000).optional() }).strict(),
}

export type SaveApproval = {
  approvalRequestId: string
  sessionId: string
  revision: number
  operation: SaveOperation
  canonicalProjectPath: string
  targetPath: string | null
  force: boolean
  mode: string | null
  reason: string | null
  operationDigest: string
  status: "pending" | "approved" | "consumed" | "rejected" | "revoked" | "expired" | "stale"
  createdAt: string
  expiresAt: string
  approvalGrantId?: string
  decidedAt?: string
  consumedAt?: string
}

function denied(code: string, message: string, approval?: SaveApproval) {
  return {
    ok: false as const,
    meta: {
      requestId: randomUUID(), durationMs: 0, warnings: [], diagnostics: [], stage: "runtime" as const,
      contractVersion: BACKEND_CONTRACT_VERSION, capabilitySchemaVersion: BACKEND_CAPABILITY_SCHEMA_VERSION,
    },
    error: { code, message, ...(approval ? { approval: { ...approval }, approvalPath: "/#save-approvals" } : {}) },
  }
}

const active = (request: SaveApproval) => request.status === "pending" || request.status === "approved"

// Host-local, single-use authority. It is deliberately not persisted or exposed as an MCP approval tool.
export class HostSaveGrants {
  private readonly requests = new Map<string, SaveApproval>()
  private readonly closing = new Map<string, number>()

  constructor(private readonly runtime: Pick<OpenFairyGuiBackendRuntime, "getSession" | "saveSession" | "materializeSession">) {}

  list() {
    this.prune()
    return [...this.requests.values()].reverse().map((request) => ({ ...request }))
  }

  prune() {
    for (const request of this.requests.values()) {
      if (!active(request)) continue
      if (Date.parse(request.expiresAt) <= Date.now()) { request.status = "expired"; continue }
      const session = this.runtime.getSession({ sessionId: request.sessionId })
      if (this.closing.has(request.sessionId) || !session.ok || session.data.revision !== request.revision
        || session.data.canonicalProjectPath !== request.canonicalProjectPath) request.status = "stale"
    }
  }

  invalidateSession(sessionId: string) {
    for (const request of this.requests.values()) {
      if (request.sessionId === sessionId && active(request)) request.status = "stale"
    }
  }

  beginClose(sessionId: string) {
    this.closing.set(sessionId, (this.closing.get(sessionId) ?? 0) + 1)
    this.invalidateSession(sessionId)
  }

  endClose(sessionId: string) {
    const count = (this.closing.get(sessionId) ?? 1) - 1
    if (count) this.closing.set(sessionId, count)
    else this.closing.delete(sessionId)
    this.invalidateSession(sessionId)
  }

  decide(id: string, decision: "approve" | "reject" | "revoke") {
    this.prune()
    const request = this.requests.get(id)
    if (!request) return { error: "Save approval not found", status: 404 as const }
    if ((decision === "revoke" && request.status !== "approved") || (decision !== "revoke" && request.status !== "pending")) {
      return { error: `Save approval is ${request.status}; request a fresh approval if needed`, status: 409 as const }
    }
    request.status = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "revoked"
    request.decidedAt = new Date().toISOString()
    if (decision === "approve") request.approvalGrantId = randomUUID()
    return { approval: { ...request } }
  }

  execute(operation: SaveOperation, input: unknown) {
    const parsed = saveInputs[operation].safeParse(input)
    if (!parsed.success) return denied("save_input_invalid", "Host saves require an explicit nonnegative expectedRevision and bounded save options. Read getSession and retry with supported arguments.")
    const { sessionId, expectedRevision: revision } = parsed.data
    const snapshot = this.runtime.getSession({ sessionId })
    if (!snapshot.ok) return snapshot
    if (snapshot.data.canonicalProjectPath.length > 4_096) return denied("save_target_invalid", "The session target exceeds the Host approval path limit.")
    if (this.closing.has(sessionId)) return denied("save_session_closing", "The session is closing; no save can be approved.")
    if (snapshot.data.revision !== revision) return denied("save_revision_stale", "The session revision changed. Read getSession and re-plan before requesting approval.")
    this.prune()
    const details = {
      sessionId, revision, operation, canonicalProjectPath: snapshot.data.canonicalProjectPath,
      targetPath: "targetPath" in parsed.data ? parsed.data.targetPath ?? null : null,
      force: "force" in parsed.data ? parsed.data.force ?? false : false,
      mode: parsed.data.mode ?? null,
      reason: "reason" in parsed.data ? parsed.data.reason ?? null : null,
    }
    const operationDigest = createHash("sha256").update(JSON.stringify(details)).digest("hex")
    let request = [...this.requests.values()].find((candidate) => active(candidate) && candidate.operationDigest === operationDigest)
    if (request?.status === "approved") {
      // Consume synchronously before calling the backend: concurrent retries and failed/uncertain writes cannot reuse it.
      request.status = "consumed"
      request.consumedAt = new Date().toISOString()
      return operation === "saveSession"
        ? this.runtime.saveSession(parsed.data as z.infer<typeof saveInputs.saveSession>)
        : this.runtime.materializeSession(parsed.data as z.infer<typeof saveInputs.materializeSession>)
    }
    if (!request) {
      if (this.requests.size >= MAX_SAVE_APPROVALS) {
        const terminal = [...this.requests.values()].find((candidate) => !active(candidate))
        if (terminal) this.requests.delete(terminal.approvalRequestId)
        else return denied("save_approval_limit", "Too many pending save approvals. Resolve them in Workbench or wait for expiry.")
      }
      request = {
        ...details, operationDigest, approvalRequestId: randomUUID(), status: "pending",
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + SAVE_GRANT_TTL_MS).toISOString(),
      }
      this.requests.set(request.approvalRequestId, request)
    }
    return denied("save_approval_required", "No files were written. Ask the Host owner to approve this exact request in Workbench using their separate approval token, then retry the same tool arguments once. Never obtain or supply the owner's approval token yourself.", request)
  }

  close() {
    this.requests.clear()
    this.closing.clear()
  }
}
