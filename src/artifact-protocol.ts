export const PLAYER_RUNTIME_PROFILE = "layaair-3.3.10/fairygui" as const

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

export type ArtifactManifest = {
  schemaVersion: 1
  artifactId: string
  name: string
  digest: string
  createdAt: string
  runtimeProfile: typeof PLAYER_RUNTIME_PROFILE
  source: {
    kind: "published-folder" | "browser-publish"
    projectId?: string
    sourceRevision?: string
  }
  files: ArtifactFile[]
  packages: ArtifactPackage[]
  playerUrl: string
}

export type ArtifactImportFile = {
  path: string
  size: number
}

export type PlayerRenderSource = {
  artifact: ArtifactManifest
  packageId: string
  componentId: string
}
