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
import { artifactPackageClosure } from "../../runtime/artifact-resources"

async function connectPlayerFrame(frame: HTMLIFrameElement, artifact: ArtifactManifest, signal: AbortSignal): Promise<RendererFrameSession> {
  if (!frame.contentWindow) throw new Error("Player iframe 尚未就绪。")
  const connection = await prepareRuntimeFrame(frame, signal)
  const runtime = await connectRendererChannel(frame.contentWindow, "Player", { ...connection, sourceRevision: artifact.digest }, signal)
  const loading = new AbortController()
  const lifetime = AbortSignal.any([signal, loading.signal])
  let loadedPackageId = ""
  return {
    ...runtime,
    async render(packageId, componentId, expectedRuntimeEventSeq) {
      const component = artifact.packages.find((pkg) => pkg.packageId === packageId)?.components.find((item) => item.id === componentId)
      if (!component) throw new Error(`Artifact component not found: ${packageId}/${componentId}`)
      try {
        let files: PlayerFiles | undefined
        if (loadedPackageId !== packageId) {
          const binaries = artifactPackageClosure(artifact.packages, packageId).map(pkg => pkg.binaryPath)
          const packageFiles = await readArtifactFiles(artifact, lifetime, binaries)
          const { files: required } = await runtime.send<{ files: string[] }>({ kind: "prepare-artifact", source: { artifact, packageId, componentId, files: packageFiles }, expectedRuntimeEventSeq }, packageFiles.map(({ data }) => data))
          if (!Array.isArray(required) || required.some(path => typeof path !== "string")) throw new Error("Invalid Artifact resource request")
          checkBudget(required.length, RUNTIME_LIMITS.nodes, "artifact_files")
          // The opaque runtime can request only files in the immutable manifest.
          const budget = new ResourceBudget()
          for (const name of [...binaries, ...required]) {
            const file = artifact.files.find(file => file.path === name)
            if (!file) throw new Error(`Artifact resource not found: ${name}`)
            budget.encoded(file.size)
          }
          files = await readArtifactFiles(artifact, lifetime, required)
        }
        lifetime.throwIfAborted()
        const result = await runtime.send<ViewerRendered & { runtimeEventSeq: number }>({ kind: "render-artifact", source: { artifact, packageId, componentId, files }, expectedRuntimeEventSeq }, files?.map(({ data }) => data))
        loadedPackageId = packageId
        return result
      } catch (error) {
        loadedPackageId = ""
        if (!lifetime.aborted) await runtime.send({ kind: "unload-artifact" }).catch(() => {})
        throw error
      }
    },
    destroy() {
      loading.abort()
      runtime.destroy()
    },
  }
}

type PlayerFiles = Array<{ path: string; data: ArrayBuffer }>

export async function readArtifactFiles(artifact: ArtifactManifest, lifetime: AbortSignal, paths = artifact.files.map(file => file.path)) {
  checkBudget(artifact.files.length, RUNTIME_LIMITS.nodes, "artifact_files")
  checkBudget(paths.length, RUNTIME_LIMITS.nodes, "artifact_files")
  const byPath = new Map(artifact.files.map(file => [file.path, file]))
  if (byPath.size !== artifact.files.length) throw new Error("Duplicate Artifact file path")
  if (new Set(paths).size !== paths.length) throw new Error("Duplicate Artifact resource request")
  const selected = paths.map(path => {
    const file = byPath.get(path)
    if (!file) throw new Error(`Artifact resource not found: ${path}`)
    return file
  })
  const budget = new ResourceBudget()
  for (const file of selected) {
    budget.encoded(file.size)
    if (file.mimeType.startsWith("audio/")) budget.audio(file.size)
  }
  const files: Array<{ path: string; data: ArrayBuffer }> = []
  for (const file of selected) {
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
