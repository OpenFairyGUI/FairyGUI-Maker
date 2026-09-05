export const PLAYER_RUNTIME_PROFILE = "layaair-3.3.10/fairygui" as const
export const MAX_ARTIFACT_FILES = 5_000
export const MAX_ARTIFACT_FILE_BYTES = 128 * 1024 * 1024
export const MAX_ARTIFACT_TOTAL_BYTES = 512 * 1024 * 1024

// Host checks bytes/package metadata, not who published them or which project produced them.
export const ARTIFACT_VERIFICATION = Object.freeze({ content: "host-validated", source: "client-declared" } as const)

export type ArtifactFile = {
  path: string
  size: number
  sha256: string
  mimeType: string
}

export type ArtifactComponent = {
  id: string
  name: string
}

export type ArtifactPackage = {
  packageId: string
  packageName: string
  binaryPath: string
  dependencies: string[]
  components: ArtifactComponent[]
}

export type ArtifactBlob = {
  artifactId: string
  digest: string
  runtimeProfile: typeof PLAYER_RUNTIME_PROFILE
  files: ArtifactFile[]
  packages: ArtifactPackage[]
}

export type ArtifactImportRecord = {
  importId: string
  artifactId: string
  digest: string
  sequence: number
  name: string
  createdAt: string
  source: {
    kind: "published-folder" | "browser-publish"
    projectId?: string
    sourceRevision?: string
  }
}

// API projection: immutable content plus one explicit import's provenance.
export type ArtifactManifest = ArtifactBlob & Pick<ArtifactImportRecord, "importId" | "name" | "createdAt" | "source"> & {
  schemaVersion: 1
  verification: typeof ARTIFACT_VERIFICATION
  playerUrl: string
}

export type ArtifactSummary = Omit<ArtifactManifest, "files" | "packages"> & {
  fileCount: number
  packageCount: number
  componentCount: number
  totalBytes: number
  importCount: number
}

export type ArtifactImportFile = {
  path: string
  size: number
  sha256: string
}

export type PlayerRenderSource = {
  artifact: ArtifactManifest
  packageId: string
  componentId: string
  /** Verified bytes: package binaries for prepare, required resources for render; omitted on reuse. */
  files?: Array<{ path: string; data: ArrayBuffer }>
}
