import { createHash } from "node:crypto"
import type { OpenFairyGuiBackendRuntime } from "@openfairygui/mcp"
import { z } from "zod"

import type { RegisteredProject } from "./host-types"

export const sessionPreviewInput = z.object({ sessionId: z.string().min(1).max(256), expectedRevision: z.number().int().nonnegative() }).strict()

export function sessionPreviewResult(runtime: OpenFairyGuiBackendRuntime, sessionId: string, expectedRevision: number) {
  const result = runtime.readSessionState({ sessionId, expectedRevision })
  if (!result.ok) return { ok: false as const, error: result.error }
  const state = result.data
  if (!state.readComplete || state.uamFidelity !== "full") return { ok: false as const, error: {
    code: "session_preview_incomplete", message: "The Backend session model is incomplete or unsupported; inspect its read diagnostics before previewing.", readDiagnostics: state.readDiagnostics,
  } }
  const packageIds = new Set<string>()
  let components = 0
  for (const pkg of state.project.packages) {
    const resourceIds = new Set<string>()
    if (packageIds.has(pkg.id) || pkg.resources.some((resource) => { if (resourceIds.has(resource.id)) return true; resourceIds.add(resource.id); return false })) {
      return { ok: false as const, error: { code: "session_preview_ambiguous", message: "Duplicate package or resource IDs cannot identify a Viewer source." } }
    }
    packageIds.add(pkg.id)
    components += pkg.resources.filter((resource) => resource.kind === "component").length
  }
  if (packageIds.size > 5_000 || components > 5_000) return { ok: false as const, error: { code: "session_preview_budget_exceeded", message: "Viewer supports at most 5000 packages and components." } }
  return { ok: true as const, state }
}

export function advanceSessionPreview(project: RegisteredProject, snapshot: NonNullable<RegisteredProject["backendSession"]>): RegisteredProject {
  const revision = project.revision + 1
  const backendSession = { sessionId: snapshot.sessionId, revision: snapshot.revision, lastSavedRevision: snapshot.lastSavedRevision, dirty: snapshot.dirty }
  // A preview generation identifies reads of the session, including save bookkeeping; it is not a file-content digest.
  const sourceRevision = createHash("sha256").update(JSON.stringify({ bindingId: project.bindingId, generation: revision, ...backendSession })).digest("hex")
  return { ...project, revision, sourceRevision, backendSession, updatedAt: new Date().toISOString() }
}
