import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Hono } from "hono"
import { Document } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"

import { MAX_ARTIFACT_FILE_BYTES, MAX_ARTIFACT_TOTAL_BYTES } from "../src/artifact-protocol"
import { ImportDraftStore, MAX_IMPORT_SOURCE_BYTES } from "../src/design-import/draft-store"
import { ArtifactStore } from "../src/server/artifacts"
import { startMakerHost } from "../src/server/index"
import { MAX_ACTIVE_UPLOADS, MAX_JSON_BODY_BYTES, MAX_VISUAL_UPLOAD_BYTES, uploadLimits } from "../src/server/upload-limits"
import { MAX_PENDING_UPLOADS, PENDING_UPLOAD_TTL_MS, receiveUpload, UploadError } from "../src/upload"

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const exists = (file: string) => access(file).then(() => true, () => false)
const stream = (chunks: Uint8Array[]) => new ReadableStream<Uint8Array>({
  pull(controller) {
    const chunk = chunks.shift()
    if (chunk) controller.enqueue(chunk)
    else controller.close()
  },
})
const status = (expected: number) => (error: unknown) => error instanceof UploadError && error.status === expected

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}

test("upload streams enforce declared bytes and digests, retry by content, and clean interrupted parts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maker-upload-stream-"))
  const target = path.join(root, "source", "asset.bin")
  const staging = path.join(root, ".uploads")
  const bytes = Buffer.from("trusted bytes")
  const declared = { size: bytes.length, sha256: digest(bytes) }
  try {
    await assert.rejects(receiveUpload(target, staging, stream([bytes, Buffer.from("!")]), declared), status(413))
    assert.equal(await exists(target), false)
    assert.deepEqual(await readdir(staging), [])
    await assert.rejects(receiveUpload(target, staging, stream([bytes.subarray(1)]), declared), status(400))
    await assert.rejects(receiveUpload(target, staging, stream([Buffer.alloc(bytes.length)]), declared), status(409))
    assert.deepEqual(await readdir(staging), [])

    await receiveUpload(target, staging, stream([bytes.subarray(0, 2), bytes.subarray(2)]), declared)
    await receiveUpload(target, staging, stream([bytes]), declared)
    await assert.rejects(receiveUpload(target, staging, stream([Buffer.alloc(bytes.length)]), { size: bytes.length }), status(409))
    assert.deepEqual(await readFile(target), bytes)

    const cancellation = new AbortController()
    let cancelled = false
    const interrupted = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(bytes.subarray(0, 1)) },
      cancel() { cancelled = true },
    })
    const pending = receiveUpload(path.join(root, "incomplete.bin"), staging, interrupted, declared, cancellation.signal)
    const rejected = assert.rejects(pending, status(408))
    cancellation.abort()
    await rejected
    assert.equal(await exists(path.join(root, "incomplete.bin")), false)
    assert.deepEqual(await readdir(staging), [])
    assert.equal(cancelled, true)

    await assert.rejects(receiveUpload(path.join(root, "broken.bin"), staging, new ReadableStream({
      pull(controller) { controller.error(new Error("connection lost")) },
    }), declared), /connection lost/)
    assert.deepEqual(await readdir(staging), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("artifact pending imports reserve capacity, expire, cancel active streams, and serialize finalization", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const root = await mkdtemp(path.join(tmpdir(), "maker-artifact-upload-"))
  const store = new ArtifactStore(root)
  const bytes = Buffer.from("abc")
  const input = { name: "test", source: { kind: "published-folder" as const }, files: [{ path: "test.fui", size: bytes.length, sha256: digest(bytes) }] }
  try {
    await store.init()
    const full = await store.createImport({ ...input, files: Array.from({ length: MAX_ARTIFACT_TOTAL_BYTES / MAX_ARTIFACT_FILE_BYTES }, (_, index) => ({
      path: `${index}.bin`, size: MAX_ARTIFACT_FILE_BYTES, sha256: digest(bytes),
    })) })
    await assert.rejects(store.createImport(input), /artifact_import_capacity_exceeded/)
    await store.cancelImport(full.importId)
    const attempts = await Promise.allSettled(Array.from({ length: MAX_PENDING_UPLOADS + 1 }, () => store.createImport(input)))
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, MAX_PENDING_UPLOADS)
    assert.ok(attempts.some((result) => result.status === "rejected" && status(503)(result.reason)))
    t.mock.timers.tick(PENDING_UPLOAD_TTL_MS + 1)
    await store.pruneExpiredImports()
    assert.deepEqual(await readdir(path.join(root, "imports")), [])

    const active = await store.createImport(input)
    let cancelled = false
    const started = deferred()
    const pending = store.writeImportFile(active.importId, "test.fui", new ReadableStream({
      pull(controller) { controller.enqueue(bytes.subarray(0, 1)); started.resolve(); return new Promise<void>(() => {}) },
      cancel() { cancelled = true },
    }))
    const rejected = assert.rejects(pending, status(409))
    await started.promise
    await assert.rejects(store.writeImportFile(active.importId, "test.fui", bytes), status(409))
    await assert.rejects(store.completeImport(active.importId, "http://localhost"), status(409))
    assert.equal(await store.cancelImport(active.importId), true)
    await rejected
    assert.equal(cancelled, true)
    assert.equal(await exists(path.join(root, "imports", active.importId)), false)

    const document = new Document()
    document.createPackage("Demo").setId("DEMO0001")
      .addResource(document.createComponent("Main").setId("MAIN0001").setExported(true).setSize(40, 40))
    const binaryPath = path.join(root, "Demo.fui")
    await new NodeIO().writeBinary(document, binaryPath)
    const binary = await readFile(binaryPath)
    const valid = await store.createImport({ ...input, files: [{ path: "Demo.fui", size: binary.length, sha256: digest(binary) }] })
    await store.writeImportFile(valid.importId, "Demo.fui", stream([binary]))
    const finishing = store.completeImport(valid.importId, "http://localhost")
    await assert.rejects(store.completeImport(valid.importId, "http://localhost"), status(409))
    await assert.rejects(store.cancelImport(valid.importId), status(409))
    await assert.rejects(store.writeImportFile(valid.importId, "Demo.fui", binary), status(409))
    assert.ok((await finishing)?.artifactId)
    assert.deepEqual(await readdir(path.join(root, "imports")), [])
    assert.equal(store.count(), 1)
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})

test("draft uploads keep source atomic, recover after restart, cancel, and bound pending lifetime", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const root = await mkdtemp(path.join(tmpdir(), "maker-draft-stream-"))
  const bytes = Buffer.from("abc")
  let store = new ImportDraftStore(root)
  try {
    await store.init()
    const input = { kind: "fig" as const, name: "test.fig", files: [{ path: "test.fig", size: bytes.length }] }
    const full = await store.createUpload({ ...input, files: [{ path: "test.fig", size: MAX_IMPORT_SOURCE_BYTES }] })
    await assert.rejects(store.createUpload(input), /import_draft_upload_capacity_exceeded/)
    await store.delete(full.draftId, full.revision)
    const draft = await store.createUpload(input)
    const draftRoot = path.join(root, "import-drafts", draft.draftId)
    const target = path.join(draftRoot, "source", "test.fig")
    await assert.rejects(store.writeUploadFile(draft.draftId, "test.fig", stream([bytes, bytes])), status(413))
    assert.equal(await exists(target), false)
    await store.writeUploadFile(draft.draftId, "test.fig", stream([bytes]))
    await assert.rejects(store.writeUploadFile(draft.draftId, "test.fig", stream([Buffer.from("xyz")])), status(409))
    assert.deepEqual(await readFile(target), bytes)
    await mkdir(path.join(draftRoot, ".uploads"), { recursive: true })
    await writeFile(path.join(draftRoot, ".uploads", "orphan.part"), "partial")
    store = new ImportDraftStore(root)
    await store.init()
    assert.equal(await exists(path.join(draftRoot, ".uploads")), false)
    assert.equal((await store.completeUpload(draft.draftId, draft.revision)).status, "created")

    const active = await store.createUpload(input)
    const started = deferred()
    const uploading = store.writeUploadFile(active.draftId, "test.fig", new ReadableStream({
      pull(controller) { controller.enqueue(bytes.subarray(0, 1)); started.resolve(); return new Promise<void>(() => {}) },
    }))
    const rejected = assert.rejects(uploading, status(409))
    await started.promise
    await assert.rejects(store.completeUpload(active.draftId, active.revision), /busy/)
    await store.delete(active.draftId, active.revision)
    await rejected
    assert.equal(await exists(path.join(root, "import-drafts", active.draftId)), false)

    await Promise.all(Array.from({ length: MAX_PENDING_UPLOADS }, () => store.createUpload(input)))
    await assert.rejects(store.createUpload(input), status(503))
    t.mock.timers.tick(PENDING_UPLOAD_TTL_MS + 1)
    await store.pruneExpiredUploads()
    assert.equal(store.count(), 1) // A completed draft keeps the existing seven-day retention.
    assert.ok(await store.createUpload(input))
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})

function limitTestApp() {
  const app = new Hono()
  app.use("*", uploadLimits())
  app.onError((error, c) => c.json({ error: error.message }, 400))
  app.post("/mcp", async (c) => c.json(await c.req.json()))
  app.post("/api/import-drafts/id/visual-evidence", async (c) => c.json({ fields: [...(await c.req.formData()).keys()] }))
  return app
}

test("JSON and multipart limits count chunked bytes even with a false Content-Length", async () => {
  const app = limitTestApp()
  const chunk = Buffer.alloc(1024 * 1024, 32)
  for (const length of [undefined, "1"]) {
    const request = new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(length ? { "Content-Length": length } : {}) },
      body: stream(Array.from({ length: Math.ceil(MAX_JSON_BODY_BYTES / chunk.length) + 1 }, () => chunk)),
      duplex: "half",
    } as RequestInit)
    assert.equal((await app.fetch(request)).status, 413)
  }
  let cancelled = false
  let pulled = 0
  const multipart = new Request("http://localhost/api/import-drafts/id/visual-evidence", {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=x", "Content-Length": "1" },
    body: new ReadableStream({
      pull(controller) {
        pulled += 1
        controller.enqueue(pulled === 1 ? Buffer.from('--x\r\nContent-Disposition: form-data; name="reference"; filename="ref.png"\r\nContent-Type: image/png\r\n\r\n') : chunk)
      },
      cancel() { cancelled = true },
    }),
    duplex: "half",
  } as RequestInit)
  assert.equal((await app.fetch(multipart)).status, 413)
  assert.equal(cancelled, true)
  assert.ok(pulled <= Math.ceil(MAX_VISUAL_UPLOAD_BYTES / chunk.length) + 4)

  const form = new FormData()
  form.append("report", "{}")
  assert.equal((await app.request("http://localhost/api/import-drafts/id/visual-evidence", { method: "POST", body: form })).status, 200)
  assert.equal((await app.request("http://localhost/mcp", { method: "POST", headers: { "Content-Type": "application/json" }, body: '{}' })).status, 200)
})

test("Host ingress caps simultaneous uploads and releases slots on abort", async () => {
  const app = limitTestApp()
  let entered = 0
  const started = deferred()
  app.put("/api/artifact-imports/id/files", async (c) => {
    entered += 1
    if (entered === MAX_ACTIVE_UPLOADS) started.resolve()
    return c.json({ bytes: (await c.req.arrayBuffer()).byteLength })
  })
  const controllers = Array.from({ length: MAX_ACTIVE_UPLOADS }, () => new AbortController())
  const pending = controllers.map((controller) => app.fetch(new Request("http://localhost/api/artifact-imports/id/files", {
    method: "PUT", body: new ReadableStream(), signal: controller.signal, duplex: "half",
  } as RequestInit)))
  await started.promise
  assert.equal((await app.request("http://localhost/api/artifact-imports/id/files", { method: "PUT", body: "x" })).status, 503)
  for (const controller of controllers) controller.abort()
  assert.deepEqual((await Promise.all(pending)).map((response) => response.status), controllers.map(() => 408))
  assert.equal((await app.request("http://localhost/api/artifact-imports/id/files", { method: "PUT", body: "x" })).status, 200)
})

test("HTTP upload endpoints reject chunked overflow and conflicting retries without leaving published or source partials", { timeout: 10_000 }, async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "maker-upload-http-"))
  const token = "test-upload-token-at-least-24-characters"
  const host = await startMakerHost({ port: 0, dataDir, token })
  const headers = { Authorization: `Bearer ${token}` }
  const bytes = Buffer.from("abc")
  const declared = { path: "Demo.fui", size: bytes.length, sha256: digest(bytes) }
  const create = (files: unknown[]) => fetch(`${host.origin}/api/artifact-imports`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ name: "test", files }),
  })
  const put = (url: string, chunks: Uint8Array[]) => fetch(url, {
    method: "PUT", headers, body: stream(chunks), duplex: "half",
  } as RequestInit)
  try {
    assert.equal((await create([{ path: declared.path, size: declared.size }])).status, 400)
    for (const reserved of ["manifest.json", "MANIFEST.JSON/child", ".uploads/part"]) {
      assert.equal((await create([{ ...declared, path: reserved }])).status, 400)
    }
    const created = await create([declared])
    assert.equal(created.status, 201)
    const { importId, expiresAt } = await created.json() as { importId: string; expiresAt: string }
    assert.ok(Date.parse(expiresAt) > Date.now())
    const target = path.join(dataDir, "imports", importId, declared.path)
    const endpoint = `${host.origin}/api/artifact-imports/${importId}/files?path=${declared.path}`
    const overflow = await put(endpoint, [bytes, bytes])
    assert.equal(overflow.status, 413)
    assert.equal(overflow.headers.get("connection"), "close")
    assert.equal(await exists(target), false)
    assert.deepEqual(await readdir(path.join(dataDir, "imports", importId, ".uploads")), [])
    assert.equal((await put(endpoint, [bytes.subarray(1)])).status, 400)
    assert.equal((await put(endpoint, [bytes])).status, 200)
    assert.equal((await put(endpoint, [bytes])).status, 200)
    assert.equal((await put(endpoint, [Buffer.from("xyz")])).status, 409)
    assert.deepEqual(await readFile(target), bytes)
    assert.deepEqual(await readdir(path.join(dataDir, "artifacts")), [])
    assert.equal((await fetch(`${host.origin}/api/artifact-imports/${importId}`, { method: "DELETE", headers })).status, 204)
    assert.equal(await exists(path.dirname(target)), false)
    assert.equal((await put(endpoint, [bytes])).status, 404)

    const draftResponse = await fetch(`${host.origin}/api/import-drafts`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "fig", name: "test.fig", files: [{ path: "test.fig", size: bytes.length }] }),
    })
    assert.equal(draftResponse.status, 201)
    const { draft } = await draftResponse.json() as { draft: { draftId: string; revision: number } }
    const draftEndpoint = `${host.origin}/api/import-drafts/${draft.draftId}`
    const draftRoot = path.join(dataDir, "import-drafts", draft.draftId)
    assert.equal((await put(`${draftEndpoint}/source?path=test.fig`, [bytes, bytes])).status, 413)
    assert.equal(await exists(path.join(draftRoot, "source", "test.fig")), false)
    assert.deepEqual(await readdir(path.join(draftRoot, ".uploads")), [])
    assert.equal((await put(`${draftEndpoint}/source?path=test.fig`, [bytes])).status, 200)
    assert.equal((await put(`${draftEndpoint}/source?path=test.fig`, [Buffer.from("xyz")])).status, 409)
    assert.equal((await fetch(`${draftEndpoint}?expectedRevision=${draft.revision}`, { method: "DELETE", headers })).status, 204)
    assert.equal(await exists(draftRoot), false)

    const chunk = Buffer.alloc(1024 * 1024, 32)
    const oversized = await fetch(`${host.origin}/api/artifact-imports`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" },
      body: stream(Array.from({ length: Math.ceil(MAX_JSON_BODY_BYTES / chunk.length) + 1 }, () => chunk)), duplex: "half",
    } as RequestInit)
    assert.equal(oversized.status, 413)
    assert.equal((await fetch(`${host.origin}/api/status`, { headers })).status, 200)
  } finally {
    await host.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
