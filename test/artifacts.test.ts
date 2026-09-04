import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { link, mkdir, mkdtemp, open, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Document } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"
import type { ArtifactBlob, ArtifactManifest } from "../src/artifact-protocol"
import { ArtifactStore } from "../src/server/artifacts"
import { readArtifactFile } from "../src/server/artifact-files"
import { startMakerHost } from "../src/server/index"
import { UploadError } from "../src/upload"

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const conflict = (error: unknown) => error instanceof UploadError && error.status === 409

async function fixture(root: string) {
  const document = new Document()
  const pkg = document.createPackage("Demo").setId("DEMO0001")
  for (let index = 0; index < 3; index++) pkg.addResource(document.createComponent(`Main${index}`).setId(`MAIN000${index}`).setExported(true).setSize(40, 40))
  const binaryPath = path.join(root, "Demo.fui")
  await new NodeIO().writeBinary(document, binaryPath, { compressed: true })
  return new Map([["Demo.fui", await readFile(binaryPath)], ["nested/data.bin", Buffer.from("immutable data")]])
}

async function pending(store: ArtifactStore, files: Map<string, Buffer>, name = "Demo") {
  const created = await store.createImport({ name, source: { kind: "published-folder" }, files: [...files].map(([path, data]) => ({ path, size: data.length, sha256: digest(data) })) })
  for (const [name, data] of files) await store.writeImportFile(created.importId, name, data)
  return created.importId
}

test("Artifact HTTP keeps distinct import records, bounded summaries/catalog pages and idempotent completion across restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maker-artifact-records-"))
  const files = await fixture(root)
  let host = await startMakerHost({ port: 0, dataDir: root })
  try {
    const headers = { Authorization: `Bearer ${host.token}`, "Content-Type": "application/json" }
    const importArtifact = async (name: string, projectId: string) => {
      const response = await fetch(`${host.origin}/api/artifact-imports`, { method: "POST", headers, body: JSON.stringify({ name, source: { kind: "browser-publish", projectId, sourceRevision: `revision-${projectId}` }, files: [...files].map(([path, data]) => ({ path, size: data.length, sha256: digest(data) })) }) })
      assert.equal(response.status, 201)
      const { importId } = await response.json()
      for (const [name, data] of files) assert.equal((await fetch(`${host.origin}/api/artifact-imports/${importId}/files?path=${name}`, { method: "PUT", headers, body: data })).status, 200)
      const completed = await fetch(`${host.origin}/api/artifact-imports/${importId}/complete`, { method: "POST", headers })
      assert.equal(completed.status, 201)
      return (await completed.json()).artifact as ArtifactManifest
    }
    const first = await importArtifact("First source", "project-a")
    const blobPath = path.join(root, "artifacts", first.artifactId, "manifest.json")
    const originalBlob = await readFile(blobPath, "utf8")
    const second = await importArtifact("Second source", "project-b")
    assert.equal(first.artifactId, second.artifactId)
    assert.equal(first.digest, second.digest)
    assert.notEqual(first.importId, second.importId)
    assert.equal(second.name, "Second source")
    assert.equal(second.source.projectId, "project-b")
    assert.equal(await readFile(blobPath, "utf8"), originalBlob, "deduplication must not overwrite content or the first record")
    const envelope = JSON.parse(originalBlob)
    assert.equal(envelope.schemaVersion, 2)
    assert.equal(envelope.blob.name, undefined)
    assert.equal(envelope.blob.source, undefined)
    assert.equal((await readdir(path.join(root, "artifacts"))).length, 1)
    assert.equal((await readdir(path.join(root, "artifact-import-records"))).filter((name) => name.endsWith(".json")).length, 1)

    const check = async () => {
      const currentHeaders = { Authorization: `Bearer ${host.token}` }
      const get = async (route: string) => {
        const response = await fetch(host.origin + route, { headers: currentHeaders })
        assert.equal(response.status, 200, route)
        return response.json()
      }
      const list = (await get("/api/artifacts?limit=1")).artifacts
      assert.equal(list.length, 1)
      assert.equal(list[0].name, second.name)
      assert.equal(list[0].importId, second.importId)
      assert.equal(list[0].importCount, 2)
      assert.equal(list[0].fileCount, 2)
      assert.equal(list[0].componentCount, 3)
      assert.equal(list[0].packageCount, 1)
      assert.equal(list[0].files, undefined)
      assert.equal(list[0].packages, undefined)
      assert.equal((await get(`/api/artifacts/${first.artifactId}`)).artifact.source.projectId, "project-b")
      assert.equal((await get(`/api/artifacts/${first.artifactId}?importId=${first.importId}`)).artifact.source.projectId, "project-a")
      const records = await get(`/api/artifacts/${first.artifactId}/import-records?limit=1`)
      assert.equal(records.total, 2)
      assert.equal(records.records[0].importId, second.importId)
      const previous = await get(`/api/artifacts/${first.artifactId}/import-records?limit=1&cursor=${records.nextCursor}`)
      assert.equal(previous.records[0].importId, first.importId)
      assert.equal(previous.nextCursor, null)
      const components = await get(`/api/artifacts/${first.artifactId}/components?limit=1`)
      assert.equal(components.components.length, 1)
      assert.equal(components.total, 3)
      const next = await get(`/api/artifacts/${first.artifactId}/components?limit=2&cursor=${components.nextCursor}`)
      assert.equal(next.components.length, 2)
      assert.equal(next.nextCursor, null)
      assert.equal(new Set([...components.components, ...next.components].map((value) => value.componentId)).size, 3)
      const retry = await fetch(`${host.origin}/api/artifact-imports/${first.importId}/complete`, { method: "POST", headers: currentHeaders })
      assert.equal(retry.status, 201)
      const replay = (await retry.json()).artifact
      assert.equal(replay.name, first.name, "retry must return its own provenance, not the latest import")
      assert.equal(replay.createdAt, first.createdAt)
      assert.equal(replay.playerUrl, `${host.origin}/artifacts/${first.artifactId}/player`)
      assert.equal((await get(`/api/artifacts/${first.artifactId}/import-records`)).total, 2)
      for (const suffix of ["components?limit=501", "components?cursor=-1", "import-records?limit=101", "import-records?cursor=-1"]) assert.equal((await fetch(`${host.origin}/api/artifacts/${first.artifactId}/${suffix}`, { headers: currentHeaders })).status, 400)
      assert.equal((await fetch(`${host.origin}/api/artifacts/${first.artifactId}?importId=unknown`, { headers: currentHeaders })).status, 404)
    }
    await check()
    await host.close()
    host = await startMakerHost({ port: 0, dataDir: root })
    await check()

    const fileUrl = `${host.origin}/api/artifacts/${first.artifactId}/files/nested/data.bin`
    const fileHeaders = { Authorization: `Bearer ${host.token}` }
    const valid = await fetch(fileUrl, { headers: fileHeaders })
    assert.equal(valid.status, 200)
    assert.equal(valid.headers.get("etag"), `"${digest(files.get("nested/data.bin")!)}"`)
    assert.equal(valid.headers.get("cache-control"), "no-store")
    for (const replacement of [Buffer.alloc(files.get("nested/data.bin")!.length), Buffer.from("short"), Buffer.alloc(files.get("nested/data.bin")!.length + 1)]) {
      await writeFile(path.join(root, "artifacts", first.artifactId, "nested/data.bin"), replacement)
      const invalid = await fetch(fileUrl, { headers: fileHeaders })
      assert.equal(invalid.status, 409)
      assert.equal(invalid.headers.get("etag"), null)
      assert.equal((await invalid.json()).error, "artifact_file_integrity_mismatch")
    }
    await unlink(path.join(root, "artifacts", first.artifactId, "nested/data.bin"))
    assert.equal((await fetch(fileUrl, { headers: fileHeaders })).status, 409)
  } finally { await host.close(); await rm(root, { recursive: true, force: true }) }
})

test("Artifact legacy recovery, collision checks and failed record commits preserve the existing blob", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const root = await mkdtemp(path.join(tmpdir(), "maker-artifact-commit-"))
  const files = await fixture(root)
  let store = new ArtifactStore(root)
  try {
    await store.init()
    const first = (await store.completeImport(await pending(store, files), "http://localhost"))!
    const blobRoot = path.join(root, "artifacts", first.artifactId)
    const manifestPath = path.join(blobRoot, "manifest.json")
    // Build the actual v1 disk shape; the migration must not silently rewrite it.
    const { importId, ...legacy } = first
    const legacyBytes = JSON.stringify(legacy)
    await writeFile(manifestPath, legacyBytes)
    await store.close()
    store = new ArtifactStore(root)
    await store.init()
    const recovered = store.get(first.artifactId)!
    assert.equal(recovered.importId, `legacy_${first.artifactId}`)
    assert.equal(recovered.name, first.name)
    assert.equal(await readFile(manifestPath, "utf8"), legacyBytes)

    const nextId = await pending(store, files, "New import")
    // A real 96-bit collision is infeasible to generate; seed the indexed collision branch.
    const blobs = Reflect.get(store, "artifacts") as Map<string, ArtifactBlob>
    const original = blobs.get(first.artifactId)!
    blobs.set(first.artifactId, { ...original, digest: original.digest.slice(0, 24) + "f".repeat(40) })
    await assert.rejects(store.completeImport(nextId, "http://localhost"), /artifact_id_digest_collision/)
    blobs.set(first.artifactId, original)
    assert.equal(store.importRecords(first.artifactId)!.total, 1)
    const blockedRecord = path.join(root, "artifact-import-records", `${nextId}.json`)
    await mkdir(blockedRecord)
    await assert.rejects(store.completeImport(nextId, "http://localhost"), conflict)
    assert.equal(store.get(first.artifactId)!.importId, recovered.importId)
    assert.equal(await readFile(manifestPath, "utf8"), legacyBytes)
    await rm(blockedRecord, { recursive: true })
    const next = (await store.completeImport(nextId, "http://localhost"))!
    assert.equal(next.importId, nextId)
    assert.equal(next.name, "New import")
    assert.equal(store.importRecords(first.artifactId)!.total, 2)
    await store.close()
    const recordPath = path.join(root, "artifact-import-records", `${nextId}.json`)
    const recordBytes = await readFile(recordPath, "utf8")
    await writeFile(recordPath, JSON.stringify({ ...JSON.parse(recordBytes), digest: "0".repeat(64) }))
    store = new ArtifactStore(root)
    await store.init()
    assert.equal(store.get(first.artifactId)!.importId, recovered.importId, "an invalid record must not relabel valid content")
    assert.equal(store.importRecords(first.artifactId)!.total, 1)
    await store.close()
    await writeFile(recordPath, recordBytes)
    store = new ArtifactStore(root)
    await store.init()
    assert.equal(store.get(first.artifactId)!.importId, nextId)
    assert.equal(store.get(first.artifactId, recovered.importId)!.name, first.name)
    assert.equal(await readFile(manifestPath, "utf8"), legacyBytes)

    // Corrupt data is not silently accepted by deduplication, even after init.
    const dataPath = path.join(blobRoot, "nested/data.bin")
    await writeFile(dataPath, Buffer.alloc(files.get("nested/data.bin")!.length))
    const rejectedId = await pending(store, files)
    await assert.rejects(store.completeImport(rejectedId, "http://localhost"), conflict)
    assert.equal(store.importRecords(first.artifactId)!.total, 2)
    await store.close()
    store = new ArtifactStore(root)
    await store.init()
    assert.equal(store.count(), 0)
    assert.equal(store.importRecords(first.artifactId), null, "orphan records must not resurrect a corrupt blob")
    const retryId = await pending(store, files)
    await assert.rejects(store.completeImport(retryId, "http://localhost"), /artifact_storage_conflict/)
    assert.deepEqual(await readFile(dataPath), Buffer.alloc(files.get("nested/data.bin")!.length), "an occupied invalid destination must not be replaced")
  } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
})

test("Artifact reads reject links and in-flight mutations, and return a verified independent snapshot", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "maker-artifact-read-"))
  const inside = path.join(root, "inside")
  const outside = path.join(root, "outside")
  const bytes = Buffer.from("same bytes, different file")
  const expected = { size: bytes.length, sha256: digest(bytes) }
  try {
    await mkdir(inside)
    await mkdir(outside)
    await writeFile(path.join(inside, "data.bin"), bytes)
    await writeFile(path.join(outside, "data.bin"), bytes)
    const snapshot = await readArtifactFile(root, "inside/data.bin", bytes.length, expected)
    await writeFile(path.join(inside, "data.bin"), Buffer.alloc(bytes.length))
    assert.deepEqual(snapshot, bytes)
    await assert.rejects(readArtifactFile(root, "inside/data.bin", bytes.length, expected), conflict)
    await unlink(path.join(inside, "data.bin"))
    await link(path.join(outside, "data.bin"), path.join(inside, "data.bin"))
    await assert.rejects(readArtifactFile(root, "inside/data.bin", bytes.length, expected), conflict)
    await unlink(path.join(inside, "data.bin"))
    await writeFile(path.join(inside, "data.bin"), bytes)
    await rename(inside, `${inside}-original`)
    await symlink(outside, inside, process.platform === "win32" ? "junction" : "dir")
    await assert.rejects(readArtifactFile(root, "inside/data.bin", bytes.length, expected), conflict)
    await unlink(inside)
    await rename(`${inside}-original`, inside)
    await assert.rejects(readArtifactFile(root, "inside/data.bin", bytes.length, expected, AbortSignal.abort()), /abort/i)

    const probe = await open(path.join(inside, "data.bin"), "r")
    const prototype = Object.getPrototypeOf(probe)
    const originalRead = prototype.read
    await probe.close()
    const mutation = t.mock.method(prototype, "read", async function (this: unknown, ...args: unknown[]) {
      const result = await originalRead.apply(this, args)
      await writeFile(path.join(inside, "data.bin"), Buffer.alloc(bytes.length))
      return result
    })
    await assert.rejects(readArtifactFile(root, "inside/data.bin", bytes.length, expected), conflict)
    mutation.mock.restore()
  } finally { await rm(root, { recursive: true, force: true }) }
})
