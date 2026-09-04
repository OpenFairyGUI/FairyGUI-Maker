import type { ArtifactManifest } from "../../artifact-protocol"
import {
  VIEWER_PROTOCOL_VERSION,
  type ViewerRendered,
  type RenderSessionState,
} from "../../viewer-protocol"
import { registerPlayerRenderer } from "./api"
import { startRendererDelivery } from "./renderer-delivery"
import { connectRendererChannel, executeRendererCommand, type RendererFrameSession } from "./renderer-frame"
import { createRenderSessionClient, type RenderSessionClient } from "./render-session"
import { prepareRuntimeFrame } from "../../runtime-channel"
import { checkBudget, readBoundedResponse, ResourceBudget, RUNTIME_LIMITS, withRuntimeLoad } from "../../runtime/resource-budget"

async function connectPlayerFrame(frame: HTMLIFrameElement, artifact: ArtifactManifest, signal: AbortSignal): Promise<RendererFrameSession> {
  if (!frame.contentWindow) throw new Error("Player iframe 尚未就绪。")
  const connection = await prepareRuntimeFrame(frame, signal)
  const runtime = await connectRendererChannel(frame.contentWindow, "Player", { ...connection, sourceRevision: artifact.digest }, signal)
  const loading = new AbortController()
  const lifetime = AbortSignal.any([signal, loading.signal])
  let loaded = false
  return {
    ...runtime,
    async render(packageId, componentId, expectedRuntimeEventSeq) {
      const component = artifact.packages.find((pkg) => pkg.packageId === packageId)?.components.find((item) => item.id === componentId)
      if (!component) throw new Error(`Artifact component not found: ${packageId}/${componentId}`)
      try {
        const files = loaded ? undefined : await readArtifactFiles(artifact, lifetime)
        lifetime.throwIfAborted()
        const result = await runtime.send<ViewerRendered & { runtimeEventSeq: number }>({ kind: "render-artifact", source: { artifact, packageId, componentId, files }, expectedRuntimeEventSeq }, files?.map(({ data }) => data))
        loaded = true
        return result
      } catch (error) { loaded = false; throw error }
    },
    destroy() {
      loading.abort()
      runtime.destroy()
    },
  }
}

export async function readArtifactFiles(artifact: ArtifactManifest, lifetime: AbortSignal) {
  checkBudget(artifact.files.length, RUNTIME_LIMITS.nodes, "artifact_files")
  const budget = new ResourceBudget()
  for (const file of artifact.files) budget.encoded(file.size)
  const files: Array<{ path: string; data: ArrayBuffer }> = []
  for (const file of artifact.files) {
    lifetime.throwIfAborted()
    const path = file.path.split("/").map(encodeURIComponent).join("/")
    const bytes = await withRuntimeLoad(lifetime, async (signal) => {
      const response = await fetch(`/api/artifacts/${encodeURIComponent(artifact.artifactId)}/files/${path}`, { signal, redirect: "error" })
      if (!response.ok || !response.body) throw new Error(`读取 Artifact 失败：${file.path} (${response.status})`)
      return readBoundedResponse(response, file.size, signal)
    })
    if (bytes.byteLength !== file.size) throw new Error(`Artifact file size mismatch: ${file.path}`)
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))
    if (Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("") !== file.sha256) throw new Error(`Artifact file digest mismatch: ${file.path}`)
    files.push({ path: file.path, data: bytes.buffer })
  }
  return files
}

export async function startPlayerRenderer(artifact: ArtifactManifest, iframe: HTMLIFrameElement, onState: (state: RenderSessionState) => void, onError: (error: Error) => void, signal: AbortSignal) {
  const frame = await connectPlayerFrame(iframe, artifact, signal)
  if (signal.aborted) { frame.destroy(); signal.throwIfAborted() }
  let client: RenderSessionClient | undefined
  const delivery = await startRendererDelivery(
    (signal) => registerPlayerRenderer({ artifactId: artifact.artifactId, sourceRevision: artifact.digest, protocolVersion: VIEWER_PROTOCOL_VERSION }, signal),
    frame,
    (command) => executeRendererCommand("Player", frame, command),
    onError,
    signal,
    (state) => client?.accept(state),
  )
  client = createRenderSessionClient(delivery.session, onState, signal)
  return { client, renderSessionId: delivery.renderSessionId, stop: () => { delivery.stop(); frame.destroy() } }
}
