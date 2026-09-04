import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Document } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"
import type { ArtifactManifest } from "../src/artifact-protocol"
import { startMakerHost } from "../src/server/index"
import { readArtifactFiles } from "../src/web/lib/player"
import { RUNTIME_LIMITS } from "../src/runtime/resource-budget"

test("opaque runtime entries expose only installed static code, never Host capabilities or active uploads", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "maker-isolation-"))
  const host = await startMakerHost({ port: 0, dataDir })
  try {
    const headers = { Authorization: `Bearer ${host.token}` }
    const cookie = `fairygui_maker_token=${host.token}`
    const bootstrap = await fetch(`${host.origin}/?token=${host.token}`, { headers: { "Sec-Fetch-Site": "cross-site" }, redirect: "manual" })
    assert.equal(bootstrap.status, 302, "a user following the explicit bootstrap link must still be able to sign in")
    for (const mode of ["viewer", "player"]) {
      const page = await fetch(`${host.origin}/${mode}-runtime.html`)
      assert.equal(page.status, 200)
      const csp = page.headers.get("content-security-policy")!
      assert.match(csp, /sandbox allow-scripts;/)
      assert.doesNotMatch(csp, /allow-same-origin/)
      assert.match(csp, /connect-src blob:;/)
      assert.match(csp, /form-action 'none';/)
      const html = await page.text()
      for (const [, asset] of html.matchAll(/(?:src|href)="(\/(?:assets|viewer-runtime)\/[^"?#]+)"/g)) {
        const response = await fetch(`${host.origin}${asset}`, { headers: { Origin: "null" } })
        assert.equal(response.status, 200, asset)
        assert.equal(response.headers.get("access-control-allow-origin"), "*")
        assert.equal(response.headers.get("access-control-allow-credentials"), null)
        assert.equal(response.headers.get("set-cookie"), null)
      }
      const noBootstrap = await fetch(`${host.origin}/${mode}-runtime.html?token=${host.token}`)
      assert.equal(noBootstrap.headers.get("set-cookie"), null, "runtime entry must never bootstrap credentials")
    }
    for (const route of ["/", "/mcp", "/api/status", "/api/projects", "/api/save-approvals", "/api/projects/private/source-index", "/api/projects/private/source-file?path=private.fairy", "/api/artifacts/private/files/code.svg", "/assets/%2e%2e%2fapi/status"]) {
      assert.equal((await fetch(host.origin + route)).status, 401, route)
      const response = await fetch(host.origin + route, { headers: { Cookie: cookie, Origin: "null" } })
      assert.equal(response.status, 403, route)
      assert.equal(response.headers.get("access-control-allow-origin"), null)
      assert.equal((await fetch(host.origin + route, { headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } })).status, 403, route)
    }
    for (const route of ["/api/save-approvals/forged/decision", "/api/artifact-imports", "/mcp"]) {
      assert.equal((await fetch(host.origin + route, { method: "POST", headers: { Cookie: cookie, Origin: "null" }, body: "{}" })).status, 403)
    }

    const document = new Document()
    document.createPackage("Demo").setId("DEMO0001").addResource(document.createComponent("Main").setId("MAIN0001").setExported(true))
    const binaryPath = path.join(dataDir, "Demo.fui")
    await new NodeIO().writeBinary(document, binaryPath)
    const active = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="parent.document.body.dataset.escaped=1"/>')
    const bytes = new Map([["Demo.fui", await readFile(binaryPath)], ["active.svg", active], ["active.html", active], ["active.js", active]])
    const created = await fetch(`${host.origin}/api/artifact-imports`, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Isolation", files: [...bytes].map(([path, data]) => ({ path, size: data.length, sha256: createHash("sha256").update(data).digest("hex") })) }) })
    assert.equal(created.status, 201)
    const { importId } = await created.json()
    for (const [name, data] of bytes) assert.equal((await fetch(`${host.origin}/api/artifact-imports/${importId}/files?path=${name}`, { method: "PUT", headers, body: data })).status, 200)
    const completed = await fetch(`${host.origin}/api/artifact-imports/${importId}/complete`, { method: "POST", headers })
    assert.equal(completed.status, 201)
    const { artifact } = await completed.json()
    for (const [name, data] of bytes) {
      const response = await fetch(`${host.origin}/api/artifacts/${artifact.artifactId}/files/${name}`, { headers })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("content-type"), "application/octet-stream")
      assert.equal(response.headers.get("content-disposition"), "attachment")
      assert.equal(response.headers.get("content-security-policy"), "default-src 'none'; sandbox")
      assert.equal(response.headers.get("x-content-type-options"), "nosniff")
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), data)
    }
  } finally { await host.close(); await rm(dataDir, { recursive: true, force: true }) }
})

test("parent Artifact transfer enforces budgets, size, digest, cancellation and no redirects", async (t) => {
  const bytes = new Uint8Array([1, 2, 3])
  const file = { path: "Demo.fui", size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), mimeType: "application/octet-stream" }
  const artifact = { artifactId: "artifact_test", files: [file] } as ArtifactManifest
  const signal = new AbortController().signal
  const requests: RequestInit[] = []
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => { requests.push(init); return new Response(bytes) })
  const result = await readArtifactFiles(artifact, signal)
  assert.deepEqual(new Uint8Array(result[0].data), bytes)
  assert.equal(requests[0].redirect, "error")
  await assert.rejects(readArtifactFiles({ ...artifact, files: [{ ...file, sha256: "0".repeat(64) }] }, signal), /digest mismatch/)
  await assert.rejects(readArtifactFiles({ ...artifact, files: [{ ...file, size: 4 }] }, signal), /size mismatch/)
  await assert.rejects(readArtifactFiles({ ...artifact, files: [{ ...file, size: 2 }] }, signal), /stream_bytes/)
  const reads = requests.length
  await assert.rejects(readArtifactFiles({ ...artifact, files: [{ ...file, size: RUNTIME_LIMITS.fileBytes + 1 }] }, signal), /file_bytes/)
  await assert.rejects(readArtifactFiles({ ...artifact, files: Array(3).fill({ ...file, size: RUNTIME_LIMITS.fileBytes }) }, signal), /encoded_bytes/)
  await assert.rejects(readArtifactFiles(artifact, AbortSignal.abort()), /abort/i)
  assert.equal(requests.length, reads, "invalid budgets/cancellation must fail before reading bytes")
  fetchMock.mock.mockImplementation(async () => new Response("denied", { status: 403 }))
  await assert.rejects(readArtifactFiles(artifact, signal), /403/)
})
