import { basename } from "node:path"
import type { OpenFairyGuiBackendRuntime } from "@openfairygui/mcp"

import type { BackendActivity, BackendSession } from "./host-types"
import { hostBackendFailure, type HostSaveGrants } from "./save-grants"

const TRACKED_METHODS = new Set([
  "getCapabilities",
  "openSession",
  "openProjectSession",
  "getSession",
  "getProjectOutline",
  "queryEntity",
  "readSessionState",
  "readResourceBytes",
  "validateSession",
  "preflightTransaction",
  "applyTransaction",
  "saveSession",
  "materializeSession",
  "closeSession",
  "getEvents",
  "getCacheSnapshot",
  "refreshCache",
])

export function publicBackendSession(session: BackendSession) {
  return {
    id: session.id,
    projectName: session.projectName,
    revision: session.revision,
    lastSavedRevision: session.lastSavedRevision,
    dirty: session.dirty,
    lockHeld: session.lockHeld,
    createdAt: session.createdAt,
    lastActivityAt: session.lastActivityAt,
    lastMethod: session.lastMethod,
    lastError: session.lastError,
  }
}

export function trackBackendResult(sessions: Map<string, BackendSession>, activity: BackendActivity[], method: string, input: any, result: any) {
  const sessionId = result?.data?.sessionId ?? input?.sessionId
  const now = new Date().toISOString()
  const errorCode = result?.ok === false ? String(result.error?.code ?? "backend_error").slice(0, 128) : null
  activity.push({ method, sessionId: sessionId ?? null, at: now, errorCode })
  if (activity.length > 100) activity.shift()
  if (method === "closeSession" && result?.ok && sessionId) {
    sessions.delete(sessionId)
    return
  }
  // Failed calls with invented IDs are activity, not new long-lived project sessions.
  if (!sessionId || (!sessions.has(sessionId) && !result?.ok)) return
  const current: BackendSession = sessions.get(sessionId) ?? {
    id: sessionId,
    projectName: "In-memory project",
    createdAt: now,
  }
  const snapshot = result?.ok && typeof result.data?.revision === "number" ? result.data : undefined
  sessions.set(sessionId, {
    ...current,
    projectName: snapshot?.canonicalProjectPath ? basename(snapshot.canonicalProjectPath) : current.projectName,
    revision: snapshot?.revision ?? current.revision,
    lastSavedRevision: snapshot?.lastSavedRevision ?? current.lastSavedRevision,
    dirty: snapshot?.dirty ?? current.dirty,
    lockHeld: snapshot?.lockHeld ?? current.lockHeld,
    lastActivityAt: now,
    lastMethod: method,
    lastError: errorCode,
  })
}

export function createTrackedRuntime(runtime: OpenFairyGuiBackendRuntime, sessions: Map<string, BackendSession>, activity: BackendActivity[], saveGrants: HostSaveGrants, onResult: (method: string, input: any, result: any) => void) {
  return new Proxy(runtime, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== "function") return value
      if (typeof property !== "string" || !TRACKED_METHODS.has(property)) return value.bind(target)
      return (...args: any[]) => {
        const closingId = property === "closeSession" ? args[0]?.sessionId as string : undefined
        if (closingId) saveGrants.beginClose(closingId)
        const finish = (result: any) => {
          trackBackendResult(sessions, activity, property, args[0], result)
          if (result?.ok && (property === "openSession" || property === "openProjectSession")) saveGrants.invalidateSession(result.data.sessionId)
          onResult(property, args[0], result)
          return result
        }
        const fail = () => finish(hostBackendFailure("backend_unhandled_error", "Backend tool execution failed."))
        try {
          const result = value.apply(target, args)
          if (result && typeof result.then === "function") return result.then(finish, fail).finally(() => { if (closingId) saveGrants.endClose(closingId) })
          if (closingId) saveGrants.endClose(closingId)
          return finish(result)
        } catch {
          if (closingId) saveGrants.endClose(closingId)
          return fail()
        }
      }
    },
  })
}
