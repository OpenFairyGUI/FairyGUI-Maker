import { hc } from "hono/client"

import type { AppType } from "../../server/index"
import type { ArtifactManifest, ArtifactSummary } from "../../artifact-protocol"
import type { ProjectAssetAnalysis } from "../../asset-analysis"
import { VIEWER_PROTOCOL_VERSION, type ViewerBrokerCommand, type ViewerProjectCatalog, type RenderSessionState, type RenderCommandResult } from "../../viewer-protocol"
import type { z } from "zod"
import type { renderSessionCommandSchema } from "../../server/viewer"

const client = hc<AppType>("/")

export async function getStatus() {
  const response = await client.api.status.$get()
  if (!response.ok) throw new Error(`Host status request failed: ${response.status}`)
  return response.json()
}

export async function getSessions() {
  const response = await client.api.sessions.$get()
  if (!response.ok) throw new Error(`Session request failed: ${response.status}`)
  return response.json()
}

export type CreateProjectInput = {
  bindingId: string
  directoryName: string
  fairyguiProjectId: string
  fairyPath: string
  name: string
  sourceRevision: string
}

export async function getProjects() {
  const response = await client.api.projects.$get()
  if (!response.ok) throw new Error(`Project request failed: ${response.status}`)
  return response.json()
}

export async function createProject(input: CreateProjectInput) {
  const response = await client.api.projects.$post({ json: input })
  if (!response.ok) throw new Error(`Project creation failed: ${response.status}`)
  return response.json()
}

export async function getProject(projectId: string, signal?: AbortSignal) {
  const response = await client.api.projects[":projectId"].$get({ param: { projectId } }, { init: { signal } })
  if (!response.ok) throw new Error(`Project request failed: ${response.status}`)
  return response.json()
}

export type RegisteredProjectData = Awaited<ReturnType<typeof getProject>>["project"]

export async function refreshProject(projectId: string, input: { bindingId: string; fairyguiProjectId: string; expectedSourceRevision: string; nextSourceRevision: string }, signal?: AbortSignal) {
  const response = await client.api.projects[":projectId"].refresh.$post({ param: { projectId }, json: input }, { init: { signal } })
  if (!response.ok) throw new Error(`工程刷新失败 (${response.status})：绑定或 revision 已改变，请重新读取工程后重试。`)
  return response.json()
}

export async function deleteProject(project: Pick<RegisteredProjectData, "projectId" | "bindingId" | "revision">) {
  const response = await client.api.projects[":projectId"].$delete({ param: { projectId: project.projectId }, query: { bindingId: project.bindingId, expectedRevision: String(project.revision) } })
  if (!response.ok && response.status !== 404) throw new Error(`工程移除失败 (${response.status})，请刷新列表后重试。`)
}

export async function registerProjectAssetAnalysis(projectId: string, analysis: ProjectAssetAnalysis) {
  const response = await client.api.projects[":projectId"]["asset-analysis"].$put({ param: { projectId }, json: analysis })
  if (!response.ok) throw new Error(`Asset analysis registration failed: ${response.status}`)
  return response.json()
}

export async function getArtifacts() {
  const response = await fetch("/api/artifacts?limit=100")
  if (!response.ok) throw new Error(`Artifact request failed: ${response.status}`)
  return await response.json() as { artifacts: ArtifactSummary[] }
}

export async function getArtifact(artifactId: string) {
  const response = await fetch(`/api/artifacts/${encodeURIComponent(artifactId)}`)
  if (!response.ok) throw new Error(`Artifact request failed: ${response.status}`)
  return await response.json() as { artifact: ArtifactManifest }
}

export async function registerViewerRenderer(input: {
  projectId: string
  sourceRevision: string
  protocolVersion: typeof VIEWER_PROTOCOL_VERSION
  catalog: ViewerProjectCatalog
}, signal?: AbortSignal) {
  const response = await fetch("/api/renderers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Renderer registration failed: ${response.status}`)
  return await response.json() as {
    session: RenderSessionState
  }
}

export async function registerPlayerRenderer(input: { artifactId: string; sourceRevision: string; protocolVersion: typeof VIEWER_PROTOCOL_VERSION }, signal?: AbortSignal) {
  const response = await fetch("/api/renderers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "player", ...input }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`Player renderer registration failed: ${response.status}`)
  return await response.json() as {
    session: RenderSessionState
  }
}

export async function readViewerCommands(renderSessionId: string, after: number, signal: AbortSignal) {
  const response = await fetch(`/api/render-sessions/${encodeURIComponent(renderSessionId)}/commands?after=${after}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]) })
  return await rendererJson(response) as { commands: ViewerBrokerCommand[]; session: RenderSessionState }
}

export async function submitViewerCommandResult(renderSessionId: string, body: string, signal: AbortSignal) {
  const response = await fetch(`/api/render-sessions/${encodeURIComponent(renderSessionId)}/results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  return await rendererJson(response) as { accepted: true; commandSeq: number; requestId: string; session: RenderSessionState }
}

export async function submitViewerInteraction(renderSessionId: string, body: string, signal: AbortSignal) {
  const response = await fetch(`/api/render-sessions/${encodeURIComponent(renderSessionId)}/interactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  })
  return await rendererJson(response) as { accepted: true; runtimeEventSeq: number; session: RenderSessionState }
}

export async function getRenderSession(renderSessionId: string, signal: AbortSignal) {
  return await rendererJson(await fetch(`/api/render-sessions/${encodeURIComponent(renderSessionId)}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })) as { session: RenderSessionState }
}

export async function sendRenderCommand(renderSessionId: string, command: z.input<typeof renderSessionCommandSchema>, signal: AbortSignal) {
  return await rendererJson(await fetch(`/api/render-sessions/${encodeURIComponent(renderSessionId)}/commands`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(command),
    signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]),
  })) as { result: RenderCommandResult; session: RenderSessionState }
}

export async function closeRendererSession(renderSessionId: string) {
  const response = await fetch(`/api/render-sessions/${encodeURIComponent(renderSessionId)}`, {
    method: "DELETE", keepalive: true, signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok && response.status !== 404) throw new Error(`Renderer close failed: ${response.status}`)
}

export class RendererRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

async function rendererJson(response: Response) {
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { error?: string } | null
    throw new RendererRequestError(body?.error ?? `Renderer request failed: ${response.status}`, response.status)
  }
  return response.json()
}
