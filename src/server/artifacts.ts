import { createHash, randomUUID } from "node:crypto"
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { BinaryReader } from "@openfairygui/core"
import { z } from "zod"
import { MemoryFileSystem } from "../design-import/memory-fs"
import { readArtifactFile } from "./artifact-files"

import {
  PLAYER_RUNTIME_PROFILE,
  MAX_ARTIFACT_FILES as MAX_FILES,
  MAX_ARTIFACT_FILE_BYTES as MAX_FILE_BYTES,
  MAX_ARTIFACT_TOTAL_BYTES as MAX_TOTAL_BYTES,
  type ArtifactFile,
  type ArtifactImportFile,
  type ArtifactManifest,
  type ArtifactBlob,
  type ArtifactImportRecord,
  type ArtifactSummary,
  type ArtifactPackage,
} from "../artifact-protocol"
import { MAX_PENDING_UPLOADS, PENDING_UPLOAD_TTL_MS, receiveUpload, UploadError, type UploadBody } from "../upload"

const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_RECORD_BYTES = 16 * 1024
const MAX_PACKAGE_COMPONENTS = 50_000
const FGUI_MAGIC = 0x46475549

const legacyManifestFields = z.object({
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
}).strict()
const artifactBlobSchema = legacyManifestFields.pick({ artifactId: true, digest: true, runtimeProfile: true, files: true, packages: true }).refine(
  (manifest) => manifest.packages.reduce((count, pkg) => count + pkg.components.length, 0) <= MAX_PACKAGE_COMPONENTS,
  "Artifact contains too many package components",
)
const importRecordSchema = legacyManifestFields.pick({ artifactId: true, digest: true, name: true, createdAt: true, source: true }).extend({
  importId: z.string().regex(/^(?:import_[0-9a-f-]{36}|legacy_artifact_[0-9a-f]{24})$/),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict()
const storedArtifactSchema = z.object({ schemaVersion: z.literal(2), blob: artifactBlobSchema, initialImport: importRecordSchema }).strict()

type PendingImport = {
  importId: string
  name: string
  source: ArtifactManifest["source"]
  files: Map<string, ArtifactImportFile>
  uploaded: Set<string>
  root: string
  expiresAt: number
  state: "open" | "uploading" | "finalizing" | "cancelled"
  upload: { controller: AbortController; done: Promise<unknown> } | null
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, ArtifactBlob>()
  private readonly records = new Map<string, ArtifactImportRecord>()
  private readonly latestImports = new Map<string, ArtifactImportRecord>()
  private readonly imports = new Map<string, PendingImport>()
  private readonly artifactsRoot: string
  private readonly importsRoot: string
  private readonly recordsRoot: string
  private origin = ""
  // ponytail: finalize one local artifact at a time; a queue is unnecessary while callers can retry 409.
  private finalizing = false

  constructor(private readonly dataDir: string) {
    this.artifactsRoot = path.join(dataDir, "artifacts")
    this.importsRoot = path.join(dataDir, "imports")
    this.recordsRoot = path.join(dataDir, "artifact-import-records")
  }

  async init() {
    await mkdir(this.artifactsRoot, { recursive: true })
    await mkdir(this.importsRoot, { recursive: true })
    await mkdir(this.recordsRoot, { recursive: true })

    for (const entry of await readdir(this.importsRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && /^import_[0-9a-f-]{36}$/.test(entry.name)) {
        await rm(this.resolveImportRoot(entry.name), { recursive: true, force: true })
      }
    }

    for (const entry of await readdir(this.artifactsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      try {
        const { blob, initialImport } = await readStoredArtifact(this.resolveArtifactRoot(entry.name), entry.name)
        if (this.records.has(initialImport.importId)) continue
        this.artifacts.set(blob.artifactId, blob)
        this.addRecord(initialImport)
      } catch {
        // Ignore incomplete, tampered, or foreign directories; never trust persisted manifests blindly.
      }
    }
    for (const entry of await readdir(this.recordsRoot, { withFileTypes: true })) {
      if (!entry.isFile() || !/^import_[0-9a-f-]{36}\.json$/.test(entry.name)) continue
      try {
        const record = importRecordSchema.parse(JSON.parse((await readArtifactFile(this.recordsRoot, entry.name, MAX_RECORD_BYTES)).toString("utf8")))
        if (entry.name !== `${record.importId}.json`) continue
        this.addRecord(record)
      } catch {
        // Incomplete, foreign or orphan records never relabel a validated blob.
      }
    }
  }

  list(limit = 50) {
    return [...this.latestImports.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.artifactId.localeCompare(right.artifactId))
      .slice(0, limit)
      .map(({ artifactId }) => this.summary(artifactId))
  }

  count() {
    return this.artifacts.size
  }

  get(artifactId: string, importId?: string): ArtifactManifest | null {
    const blob = this.artifacts.get(artifactId)
    const record = importId ? this.records.get(importId) : this.latestImports.get(artifactId)
    if (!blob || !record || record.artifactId !== artifactId || record.digest !== blob.digest) return null
    const { name, source, createdAt } = record
    return { schemaVersion: 1, ...blob, importId: record.importId, name, source, createdAt, playerUrl: `${this.origin}/artifacts/${artifactId}/player` }
  }

  setOrigin(origin: string) {
    this.origin = origin
  }

  importRecords(artifactId: string, cursor?: number, limit = 50) {
    if (!this.artifacts.has(artifactId)) return null
    // ponytail: scan the local record map; index by artifact if import history becomes large.
    const records = [...this.records.values()].filter((record) => record.artifactId === artifactId).sort((a, b) => b.sequence - a.sequence)
    const page = records.filter((record) => cursor === undefined || record.sequence < cursor).slice(0, limit)
    return { records: page, total: records.length, nextCursor: page.length && records.some((record) => record.sequence < page.at(-1)!.sequence) ? page.at(-1)!.sequence : null }
  }

  components(artifactId: string, cursor = 0, limit = 100) {
    const blob = this.artifacts.get(artifactId)
    if (!blob) return null
    const components = blob.packages.flatMap((pkg) => pkg.components.map((component) => ({ packageId: pkg.packageId, packageName: pkg.packageName, componentId: component.id, componentName: component.name })))
    return { components: components.slice(cursor, cursor + limit), total: components.length, nextCursor: cursor + limit < components.length ? cursor + limit : null }
  }

  private summary(artifactId: string): ArtifactSummary {
    const { files, packages, ...manifest } = this.get(artifactId)!
    return { ...manifest, fileCount: files.length, packageCount: packages.length, componentCount: packages.reduce((sum, pkg) => sum + pkg.components.length, 0), totalBytes: files.reduce((sum, file) => sum + file.size, 0), importCount: this.importRecords(artifactId)!.total }
  }

  private addRecord(record: ArtifactImportRecord) {
    const blob = this.artifacts.get(record.artifactId)
    if (!blob || record.digest !== blob.digest) throw new Error("artifact_import_record_mismatch")
    if (this.records.has(record.importId) || [...this.records.values()].some((entry) => entry.artifactId === record.artifactId && entry.sequence === record.sequence)) throw new Error("artifact_import_record_duplicate")
    this.records.set(record.importId, record)
    if (record.sequence > (this.latestImports.get(record.artifactId)?.sequence ?? 0)) this.latestImports.set(record.artifactId, record)
  }

  async createImport(input: { name: string; source: ArtifactManifest["source"]; files: ArtifactImportFile[] }) {
    const files = validateDeclaredFiles(input.files)
    await this.pruneExpiredImports()
    if (this.imports.size >= MAX_PENDING_UPLOADS) throw new UploadError("artifact_import_limit_reached", 503)
    const pendingBytes = [...this.imports.values()].reduce((total, pending) => total + [...pending.files.values()].reduce((size, file) => size + file.size, 0), 0)
    if (pendingBytes + [...files.values()].reduce((total, file) => total + file.size, 0) > MAX_TOTAL_BYTES) {
      throw new UploadError("artifact_import_capacity_exceeded", 503)
    }
    const importId = `import_${randomUUID()}`
    const root = this.resolveImportRoot(importId)
    const expiresAt = Date.now() + PENDING_UPLOAD_TTL_MS
    this.imports.set(importId, {
      importId,
      name: input.name,
      source: input.source,
      files,
      uploaded: new Set(),
      root,
      expiresAt,
      state: "open",
      upload: null,
    })
    try {
      await mkdir(root, { recursive: true })
      return { importId, files: files.size, expiresAt: new Date(expiresAt).toISOString() }
    } catch (error) {
      this.imports.delete(importId)
      throw error
    }
  }

  async writeImportFile(importId: string, filePath: string, body: UploadBody, signal?: AbortSignal) {
    const pending = this.currentImport(importId)
    if (!pending) return null
    if (pending.state !== "open") throw new UploadError("artifact_import_busy", 409)
    const safePath = normalizeRelativePath(filePath)
    const declared = pending.files.get(safePath)
    if (!declared) throw new Error("artifact_file_not_declared")
    pending.state = "uploading"
    const controller = new AbortController()
    const cancellation = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
    const done = receiveUpload(resolveWithin(pending.root, safePath), path.join(pending.root, ".uploads"), body, declared, cancellation).then(() => {
      pending.uploaded.add(safePath)
      pending.expiresAt = Date.now() + PENDING_UPLOAD_TTL_MS
      return { uploaded: safePath, sha256: declared.sha256 }
    })
    pending.upload = { controller, done }
    try {
      return await done
    } finally {
      if (pending.state === "uploading") pending.state = "open"
      pending.upload = null
    }
  }

  async completeImport(importId: string, origin: string) {
    this.setOrigin(origin)
    const completed = this.records.get(importId)
    if (completed) return this.get(completed.artifactId, importId)
    const pending = this.currentImport(importId)
    if (!pending) return null
    if (pending.state !== "open" || this.finalizing) throw new UploadError("artifact_import_busy", 409)
    const missing = [...pending.files.keys()].filter((filePath) => !pending.uploaded.has(filePath))
    if (missing.length) throw new Error(`artifact_files_missing:${missing.slice(0, 5).join(",")}`)

    pending.state = "finalizing"
    this.finalizing = true
    try {
      const files: ArtifactFile[] = []
      for (const declared of [...pending.files.values()].sort((left, right) => left.path.localeCompare(right.path))) {
        await readArtifactFile(pending.root, declared.path, MAX_FILE_BYTES, declared)
        files.push({
          ...declared,
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
      if (existing && existing.digest !== digest) throw new UploadError("artifact_id_digest_collision", 409)

      const artifactRoot = this.resolveArtifactRoot(artifactId)
      const blob = artifactBlobSchema.parse({ artifactId, digest, runtimeProfile: PLAYER_RUNTIME_PROFILE, files, packages })
      const record = importRecordSchema.parse({
        importId,
        artifactId,
        name: pending.name,
        digest,
        sequence: (this.latestImports.get(artifactId)?.sequence ?? 0) + 1,
        createdAt: new Date().toISOString(),
        source: pending.source,
      })
      if (existing) {
        // Never deduplicate against stale in-memory metadata or a changed disk blob.
        const stored = await readStoredArtifact(artifactRoot, artifactId)
        if (stored.blob.digest !== digest) throw new UploadError("artifact_id_digest_collision", 409)
        const bytes = Buffer.from(JSON.stringify(record))
        await receiveUpload(path.join(this.recordsRoot, `${importId}.json`), path.join(this.recordsRoot, ".uploads"), bytes, { size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })
      } else {
        // An invalid/unindexed destination is evidence, not permission to replace it.
        const occupied = await lstat(artifactRoot).then(() => true, (error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return false; throw error })
        if (occupied) throw new UploadError("artifact_storage_conflict", 409)
        const envelope = JSON.stringify({ schemaVersion: 2, blob, initialImport: record })
        if (Buffer.byteLength(envelope) > MAX_MANIFEST_BYTES) throw new UploadError("artifact_manifest_too_large", 413)
        await rm(path.join(pending.root, ".uploads"), { recursive: true, force: true })
        await writeFile(path.join(pending.root, "manifest.json"), envelope, { flush: true })
        // Content and its first provenance record become visible together.
        await rename(pending.root, artifactRoot)
        this.artifacts.set(artifactId, blob)
      }
      this.addRecord(record)
      // Commit is already published; cleanup failure must not turn it into an ambiguous failure.
      await this.discardImport(pending).catch(() => undefined)
      return this.get(artifactId, importId)
    } finally {
      pending.state = "open"
      this.finalizing = false
    }
  }

  async cancelImport(importId: string) {
    const pending = this.imports.get(importId)
    if (!pending) return false
    if (pending.state === "finalizing") throw new UploadError("artifact_import_busy", 409)
    pending.state = "cancelled"
    this.imports.delete(importId)
    if (pending.upload) {
      pending.upload.controller.abort(new UploadError("artifact_import_cancelled", 409))
      await pending.upload.done.catch(() => undefined)
    }
    await this.discardImport(pending)
    return true
  }

  async pruneExpiredImports() {
    for (const pending of this.imports.values()) {
      if (pending.expiresAt <= Date.now() && pending.state !== "finalizing") await this.cancelImport(pending.importId)
    }
  }

  async close() {
    const uploads = [...this.imports.values()].flatMap((pending) => pending.upload ? [pending.upload] : [])
    for (const upload of uploads) upload.controller.abort()
    await Promise.allSettled(uploads.map((upload) => upload.done))
  }

  private currentImport(importId: string) {
    const pending = this.imports.get(importId)
    if (pending && pending.expiresAt <= Date.now()) throw new UploadError("artifact_import_expired", 404)
    return pending
  }

  async readFile(artifactId: string, filePath: string, signal?: AbortSignal) {
    const artifact = this.artifacts.get(artifactId)
    if (!artifact) return null
    const safePath = normalizeRelativePath(filePath)
    const metadata = artifact.files.find(({ path: candidate }) => candidate === safePath)
    if (!metadata) return null
    try {
      const data = await readArtifactFile(this.artifactsRoot, `${artifactId}/${safePath}`, MAX_FILE_BYTES, metadata, signal)
      return { data, metadata }
    } catch (error) {
      if (signal?.aborted) throw error
      throw new UploadError("artifact_file_integrity_mismatch", 409)
    }
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
  const paths = new Set<string>()
  for (const item of input) {
    const filePath = normalizeRelativePath(item.path)
    if (!Number.isSafeInteger(item.size) || item.size < 0 || item.size > MAX_FILE_BYTES) throw new Error(`artifact_file_size_invalid:${filePath}`)
    if (paths.has(filePath.toLowerCase())) throw new Error(`artifact_file_duplicate:${filePath}`)
    if (["manifest.json", ".uploads"].includes(filePath.split("/")[0].toLowerCase())) throw new Error("artifact_path_reserved")
    if (!/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`artifact_file_digest_invalid:${filePath}`)
    total += item.size
    if (total > MAX_TOTAL_BYTES) throw new Error("artifact_total_size_exceeded")
    paths.add(filePath.toLowerCase())
    files.set(filePath, { path: filePath, size: item.size, sha256: item.sha256 })
  }
  return files
}

function normalizeRelativePath(value: string) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1_024 || value.includes("\\") || value.startsWith("/") || /^[a-z]:/i.test(value)) throw new Error("artifact_path_invalid")
  const parts = value.split("/")
  if (parts.some((part) => !part || part === "." || part === ".." || /[\0:]/.test(part) || /[. ]$/.test(part))) throw new Error("artifact_path_invalid")
  return parts.join("/")
}

function resolveWithin(root: string, relativePath: string) {
  const absoluteRoot = path.resolve(root)
  const target = path.resolve(absoluteRoot, ...relativePath.split("/"))
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error("artifact_path_outside_root")
  return target
}

async function readStoredArtifact(artifactRoot: string, directoryName: string) {
  const value = JSON.parse((await readArtifactFile(path.dirname(artifactRoot), `${directoryName}/manifest.json`, MAX_MANIFEST_BYTES)).toString("utf8"))
  let stored: { blob: ArtifactBlob; initialImport: ArtifactImportRecord }
  if (value.schemaVersion === 1) {
    // Read-only compatibility: retain the original import without rewriting old content.
    const { schemaVersion, playerUrl, name, source, createdAt, ...content } = legacyManifestFields.parse(value)
    const blob = artifactBlobSchema.parse(content)
    stored = { blob, initialImport: { importId: `legacy_${blob.artifactId}`, artifactId: blob.artifactId, digest: blob.digest, sequence: 1, name, source, createdAt } }
  } else stored = storedArtifactSchema.parse(value)
  const { blob, initialImport } = stored
  if (initialImport.artifactId !== blob.artifactId || initialImport.digest !== blob.digest || initialImport.sequence !== 1) throw new Error("artifact_import_record_mismatch")
  await validateStoredArtifact(artifactRoot, directoryName, blob)
  return stored
}

async function validateStoredArtifact(artifactRoot: string, directoryName: string, manifest: ArtifactBlob) {
  if (manifest.artifactId !== directoryName) throw new Error("artifact_manifest_id_mismatch")
  validateDeclaredFiles(manifest.files)
  const files = [...manifest.files].sort((left, right) => left.path.localeCompare(right.path))
  for (const file of files) {
    const safePath = normalizeRelativePath(file.path)
    await readArtifactFile(artifactRoot, safePath, MAX_FILE_BYTES, file)
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

async function readPackages(root: string, files: ArtifactFile[]): Promise<ArtifactPackage[]> {
  const packages: ArtifactPackage[] = []
  for (const file of files) {
    const bytes = await readArtifactFile(root, file.path, MAX_FILE_BYTES, file)
    const header = readPackageHeader(bytes)
    // Parse the verified snapshot, never reopen the path between hash and parsing.
    const fs = new MemoryFileSystem()
    await fs.writeFileRaw(file.path, bytes)
    const document = await new BinaryReader(fs).read(file.path)
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
