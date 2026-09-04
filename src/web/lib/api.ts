import { hc } from "hono/client"

import type { AppType } from "../../server/index"
import type { ArtifactManifest } from "../../artifact-protocol"
import type { ProjectAssetAnalysis } from "../../asset-analysis"
import { VIEWER_PROTOCOL_VERSION, type ViewerBrokerCommand, type ViewerInteractionEvent, type ViewerProjectCatalog } from "../../viewer-protocol"

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

export async function getProject(projectId: string) {
  const response = await client.api.projects[":projectId"].$get({ param: { projectId } })
  if (!response.ok) throw new Error(`Project request failed: ${response.status}`)
  return response.json()
}

export type RegisteredProjectData = Awaited<ReturnType<typeof getProject>>["project"]

export async function registerProjectAssetAnalysis(projectId: string, analysis: ProjectAssetAnalysis) {
  const response = await client.api.projects[":projectId"]["asset-analysis"].$put({ param: { projectId }, json: analysis })
  if (!response.ok) throw new Error(`Asset analysis registration failed: ${response.status}`)
  return response.json()
}

export async function getArtifacts() {
  const response = await fetch("/api/artifacts?limit=100")
  if (!response.ok) throw new Error(`Artifact request failed: ${response.status}`)
  return await response.json() as { artifacts: ArtifactManifest[] }
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
}) {
  const response = await fetch("/api/renderers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(`Renderer registration failed: ${response.status}`)
  return await response.json() as {
    session: { renderSessionId: string; stateVersion: number; commandSeq: number }
  }
}

export async function registerPlayerRenderer(input: { artifactId: string; sourceRevision: string; protocolVersion: typeof VIEWER_PROTOCOL_VERSION }) {
  const response = await fetch("/api/renderers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode: "player", ...input }),
  })
  if (!response.ok) throw new Error(`Player renderer registration failed: ${response.status}`)
  return await response.json() as {
    session: { renderSessionId: string; stateVersion: number; commandSeq: number }
  }
}

export async function readViewerCommands(renderSessionId: string, after: number, signal: AbortSignal) {
  const response = await fetch(`/api/render-sessions/${encodeURIComponent(renderSessionId)}/commands?after=${after}`, { signal })
  if (response.status === 404) throw new DOMException("Viewer renderer session closed.", "AbortError")
  if (!response.ok) throw new Error(`Renderer command request failed: ${response.status}`)
  return await response.json() as { commands: ViewerBrokerCommand[] }
}

export async function submitViewerCommandResult(renderSessionId: string, input: {
  commandSeq: number
  requestId: string
  ok: boolean
  value?: Record<string, unknown>
  error?: string
}) {
  const response = await fetch(`/api/render-sessions/${encodeURIComponent(renderSessionId)}/results`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(`Renderer result submission failed: ${response.status}`)
}

export async function submitViewerInteraction(renderSessionId: string, input: ViewerInteractionEvent) {
  const response = await fetch(`/api/render-sessions/${encodeURIComponent(renderSessionId)}/interactions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (!response.ok) throw new Error(`Renderer interaction submission failed: ${response.status}`)
}
