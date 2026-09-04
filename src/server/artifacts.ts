import { createHash, randomUUID } from "node:crypto"
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { NodeIO } from "@openfairygui/core/node"
import { z } from "zod"

import {
  PLAYER_RUNTIME_PROFILE,
  type ArtifactFile,
  type ArtifactImportFile,
  type ArtifactManifest,
  type ArtifactPackage,
} from "../artifact-protocol"

const MAX_FILES = 5_000
const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_PACKAGE_COMPONENTS = 50_000
const FGUI_MAGIC = 0x46475549

const artifactManifestSchema = z.object({
  schemaVersion: z.literal(1),
  artifactId: z.string().regex(/^artifact_[a-f0-9]{24}$/),
  name: z.string().trim().min(1).max(200),
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().max(64).refine((value) => Number.isFinite(Date.parse(value)), "Invalid artifact creation time"),
  runtimeProfile: z.literal(PLAYER_RUNTIME_PROFILE),
  source: z.object({
    kind: z.enum(["published-folder", "browser-publish"]),
    projectId: z.string().min(1).max(128).optional(),
    sourceRevision: z.string().min(1).max(128).optional(),
  }).strict(),
  files: z.array(z.object({
    path: z.string().min(1).max(1_024),
    size: z.number().int().nonnegative().max(MAX_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.string().min(1).max(128),
  }).strict()).min(1).max(MAX_FILES),
  packages: z.array(z.object({
    packageId: z.string().min(1).max(128),
    packageName: z.string().min(1).max(256),
    binaryPath: z.string().min(1).max(1_024),
    dependencies: z.array(z.string().min(1).max(128)).max(MAX_FILES),
    components: z.array(z.object({
      id: z.string().min(1).max(128),
      name: z.string().min(1).max(256),
    }).strict()).max(MAX_FILES),
  }).strict()).min(1).max(MAX_FILES),
  playerUrl: z.string().min(1).max(2_048),
}).strict().refine(
  (manifest) => manifest.packages.reduce((count, pkg) => count + pkg.components.length, 0) <= MAX_PACKAGE_COMPONENTS,
  "Artifact contains too many package components",
)

type PendingImport = {
  importId: string
  name: string
  source: ArtifactManifest["source"]
  files: Map<string, ArtifactImportFile>
  uploaded: Set<string>
  root: string
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactManifest>()
  private readonly imports = new Map<string, PendingImport>()
  private readonly artifactsRoot: string
  private readonly importsRoot: string

  constructor(private readonly dataDir: string) {
    this.artifactsRoot = path.join(dataDir, "artifacts")
    this.importsRoot = path.join(dataDir, "imports")
  }

  async init() {
    await mkdir(this.artifactsRoot, { recursive: true })
    await mkdir(this.importsRoot, { recursive: true })

    for (const entry of await readdir(this.importsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^import_[0-9a-f-]{36}$/.test(entry.name)) {
        await rm(this.resolveImportRoot(entry.name), { recursive: true, force: true })
      }
    }

    for (const entry of await readdir(this.artifactsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const artifactRoot = this.resolveArtifactRoot(entry.name)
        const manifestPath = path.join(artifactRoot, "manifest.json")
        const manifestStat = await stat(manifestPath)
        if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) continue
        const manifest = artifactManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")))
        await validateStoredArtifact(artifactRoot, entry.name, manifest)
        this.artifacts.set(manifest.artifactId, manifest)
      } catch {
        // Ignore incomplete, tampered, or foreign directories; never trust persisted manifests blindly.
      }
    }
  }

  list(limit = 50) {
    return [...this.artifacts.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
  }

  count() {
    return this.artifacts.size
  }

  get(artifactId: string) {
    return this.artifacts.get(artifactId) ?? null
  }

  setOrigin(origin: string) {
    for (const manifest of this.artifacts.values()) manifest.playerUrl = `${origin}/artifacts/${manifest.artifactId}/player`
  }

  async createImport(input: { name: string; source: ArtifactManifest["source"]; files: ArtifactImportFile[] }) {
    const files = validateDeclaredFiles(input.files)
    const importId = `import_${randomUUID()}`
    const root = this.resolveImportRoot(importId)
    await mkdir(root, { recursive: true })
    this.imports.set(importId, {
      importId,
      name: input.name,
      source: input.source,
      files,
      uploaded: new Set(),
      root,
    })
    return { importId, files: files.size }
  }

  async writeImportFile(importId: string, filePath: string, data: Uint8Array) {
    const pending = this.imports.get(importId)
    if (!pending) return null
    const safePath = normalizeRelativePath(filePath)
    const declared = pending.files.get(safePath)
    if (!declared) throw new Error("artifact_file_not_declared")
    if (data.byteLength !== declared.size) throw new Error(`artifact_file_size_mismatch:${safePath}`)
    const target = resolveWithin(pending.root, safePath)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, data, { flag: "wx" }).catch(async (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error
      const existing = await stat(target)
      if (existing.size !== data.byteLength) throw new Error(`artifact_file_already_uploaded:${safePath}`)
    })
    pending.uploaded.add(safePath)
    return { uploaded: safePath }
  }

  async completeImport(importId: string, origin: string) {
    const pending = this.imports.get(importId)
    if (!pending) return null
    const missing = [...pending.files.keys()].filter((filePath) => !pending.uploaded.has(filePath))
    if (missing.length) throw new Error(`artifact_files_missing:${missing.slice(0, 5).join(",")}`)

    const files: ArtifactFile[] = []
    for (const declared of [...pending.files.values()].sort((left, right) => left.path.localeCompare(right.path))) {
      const absolutePath = resolveWithin(pending.root, declared.path)
      const fileStat = await stat(absolutePath)
      if (!fileStat.isFile() || fileStat.size !== declared.size) throw new Error(`artifact_file_changed:${declared.path}`)
      files.push({
        ...declared,
        sha256: await hashFile(absolutePath),
        mimeType: mimeType(declared.path),
      })
    }

    const binaryFiles = files.filter(({ path: filePath }) => /(?:\.fui|_fui\.bytes)$/i.test(filePath))
    if (binaryFiles.length === 0) throw new Error("artifact_has_no_fui_packages")
    const packages = await readPackages(pending.root, binaryFiles)
    validatePackageDependencies(packages)
    const digest = artifactDigest(files)
    const artifactId = `artifact_${digest.slice(0, 24)}`
    const existing = this.artifacts.get(artifactId)
    if (existing) {
      await this.discardImport(pending)
      return existing
    }

    const artifactRoot = this.resolveArtifactRoot(artifactId)
    const manifest: ArtifactManifest = {
      schemaVersion: 1,
      artifactId,
      name: pending.name,
      digest,
      createdAt: new Date().toISOString(),
      runtimeProfile: PLAYER_RUNTIME_PROFILE,
      source: pending.source,
      files,
      packages,
      playerUrl: `${origin}/artifacts/${artifactId}/player`,
    }
    await writeFile(path.join(pending.root, "manifest.json"), JSON.stringify(manifest, null, 2), { flag: "wx" })
    await rename(pending.root, artifactRoot)
    this.imports.delete(importId)
    this.artifacts.set(artifactId, manifest)
    return manifest
  }

  async openFile(artifactId: string, filePath: string) {
    const artifact = this.artifacts.get(artifactId)
    if (!artifact) return null
    const safePath = normalizeRelativePath(filePath)
    const metadata = artifact.files.find(({ path: candidate }) => candidate === safePath)
    if (!metadata) return null
    const absolutePath = resolveWithin(this.resolveArtifactRoot(artifactId), safePath)
    const handle = await open(absolutePath, "r")
    return { handle, metadata }
  }

  private async discardImport(pending: PendingImport) {
    this.imports.delete(pending.importId)
    const expectedRoot = this.resolveImportRoot(pending.importId)
    if (path.resolve(pending.root) !== expectedRoot) throw new Error("artifact_import_root_mismatch")
    await rm(expectedRoot, { recursive: true, force: true })
  }

  private resolveImportRoot(importId: string) {
    if (!/^import_[0-9a-f-]{36}$/.test(importId)) throw new Error("invalid_artifact_import_id")
    return resolveWithin(this.importsRoot, importId)
  }

  private resolveArtifactRoot(artifactId: string) {
    if (!/^artifact_[a-f0-9]{24}$/.test(artifactId)) throw new Error("invalid_artifact_id")
    return resolveWithin(this.artifactsRoot, artifactId)
  }
}

function validateDeclaredFiles(input: ArtifactImportFile[]) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_FILES) throw new Error("artifact_file_count_invalid")
  let total = 0
  const files = new Map<string, ArtifactImportFile>()
  for (const item of input) {
    const filePath = normalizeRelativePath(item.path)
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE_BYTES) throw new Error(`artifact_file_size_invalid:${filePath}`)
    if (files.has(filePath)) throw new Error(`artifact_file_duplicate:${filePath}`)
    total += item.size
    if (total > MAX_TOTAL_BYTES) throw new Error("artifact_total_size_exceeded")
    files.set(filePath, { path: filePath, size: item.size })
  }
  return files
}

function normalizeRelativePath(value: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value)) throw new Error("artifact_path_invalid")
  const parts = value.split("/")
  if (parts.some((part) => !part || part === "." || part === ".." || part.includes("\0"))) throw new Error("artifact_path_invalid")
  return parts.join("/")
}

function resolveWithin(root: string, relativePath: string) {
  const absoluteRoot = path.resolve(root)
  const target = path.resolve(absoluteRoot, ...relativePath.split("/"))
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("artifact_path_outside_root")
  return target
}

async function validateStoredArtifact(artifactRoot: string, directoryName: string, manifest: ArtifactManifest) {
  if (manifest.artifactId !== directoryName) throw new Error("artifact_manifest_id_mismatch")
  validateDeclaredFiles(manifest.files.map(({ path: filePath, size }) => ({ path: filePath, size })))
  const files = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path))
  for (const file of files) {
    const safePath = normalizeRelativePath(file.path)
    const absolutePath = resolveWithin(artifactRoot, safePath)
    const fileStat = await stat(absolutePath)
    if (!fileStat.isFile() || fileStat.size !== file.size) throw new Error(`artifact_file_changed:${safePath}`)
    if (await hashFile(absolutePath) !== file.sha256) throw new Error(`artifact_file_digest_mismatch:${safePath}`)
    if (file.mimeType !== mimeType(safePath)) throw new Error(`artifact_file_mime_mismatch:${safePath}`)
  }

  const digest = artifactDigest(files)
  if (manifest.digest !== digest || manifest.artifactId !== `artifact_${digest.slice(0, 24)}`) {
    throw new Error("artifact_manifest_digest_mismatch")
  }
  const binaryFiles = files.filter(({ path: filePath }) => /(?:\.fui|_fui\.bytes)$/i.test(filePath))
  if (binaryFiles.length === 0) throw new Error("artifact_has_no_fui_packages")
  const packages = await readPackages(artifactRoot, binaryFiles)
  validatePackageDependencies(packages)
  if (JSON.stringify(packages) !== JSON.stringify(manifest.packages)) throw new Error("artifact_manifest_packages_mismatch")
}

function artifactDigest(files: Pick<ArtifactFile, "path" | "size" | "sha256">[]) {
  const canonicalFiles = [...files]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(({ path: filePath, size, sha256 }) => ({ path: filePath, size, sha256 }))
  return createHash("sha256").update(JSON.stringify({ runtimeProfile: PLAYER_RUNTIME_PROFILE, files: canonicalFiles })).digest("hex")
}

async function hashFile(filePath: string) {
  const data = await readFile(filePath)
  return createHash("sha256").update(data).digest("hex")
}

async function readPackages(root: string, files: ArtifactFile[]): Promise<ArtifactPackage[]> {
  const io = new NodeIO()
  const packages: ArtifactPackage[] = []
  for (const file of files) {
    const absolutePath = resolveWithin(root, file.path)
    const header = readPackageHeader(await readFile(absolutePath))
    const document = await io.readBinary(absolutePath)
    const pkg = document.getRoot().getPackageById(header.packageId)
    if (!pkg) throw new Error(`artifact_package_parse_failed:${file.path}`)
    packages.push({
      packageId: pkg.getId(),
      packageName: pkg.getName(),
      binaryPath: file.path,
      dependencies: pkg.listDependencies().map((dependency) => dependency.getId()).filter(Boolean),
      components: pkg.listComponents().map((component) => ({ id: component.getId(), name: component.getName() })),
    })
  }
  const ids = new Set<string>()
  for (const pkg of packages) {
    if (ids.has(pkg.packageId)) throw new Error(`artifact_package_duplicate:${pkg.packageId}`)
    ids.add(pkg.packageId)
  }
  return packages.sort((left, right) => left.packageName.localeCompare(right.packageName))
}

function readPackageHeader(data: Uint8Array) {
  if (data.byteLength < 13) throw new Error("artifact_package_header_invalid")
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  if (view.getUint32(0, false) !== FGUI_MAGIC) throw new Error("artifact_package_magic_invalid")
  let offset = 9
  const readString = () => {
    if (offset + 2 > data.byteLength) throw new Error("artifact_package_header_invalid")
    const length = view.getUint16(offset, false)
    offset += 2
    if (offset + length > data.byteLength) throw new Error("artifact_package_header_invalid")
    const value = new TextDecoder().decode(data.subarray(offset, offset + length))
    offset += length
    return value
  }
  const packageId = readString()
  const packageName = readString()
  if (!packageId || !packageName) throw new Error("artifact_package_identity_invalid")
  return { packageId, packageName }
}

function validatePackageDependencies(packages: ArtifactPackage[]) {
  const ids = new Set(packages.map(({ packageId }) => packageId))
  const missing = packages.flatMap((pkg) => pkg.dependencies.filter((dependency) => !ids.has(dependency)).map((dependency) => `${pkg.packageName}->${dependency}`))
  if (missing.length) throw new Error(`artifact_package_dependencies_missing:${missing.slice(0, 10).join(",")}`)
}

function mimeType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()
  if (extension === ".png") return "image/png"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  if (extension === ".webp") return "image/webp"
  if (extension === ".gif") return "image/gif"
  if (extension === ".svg") return "image/svg+xml"
  if (extension === ".mp3") return "audio/mpeg"
  if (extension === ".wav") return "audio/wav"
  if (extension === ".ogg") return "audio/ogg"
  if (extension === ".json") return "application/json"
  if (extension === ".txt" || extension === ".fnt") return "text/plain; charset=utf-8"
  return "application/octet-stream"
}
