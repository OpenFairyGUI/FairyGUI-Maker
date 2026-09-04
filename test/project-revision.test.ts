import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { startMakerHost } from "../src/server/index"
import { ViewerRenderBroker } from "../src/server/viewer"
import { VIEWER_PROTOCOL_VERSION } from "../src/viewer-protocol"

test("project invalidation immediately rejects pending commands without waiting for another request", async () => {
  const project = { projectId: "project_demo", sourceRevision: "a".repeat(64), viewerUrl: "http://127.0.0.1/viewer" }
  const broker = new ViewerRenderBroker(() => project)
  try {
    const renderer = broker.registerRenderer({ projectId: project.projectId, sourceRevision: project.sourceRevision, protocolVersion: VIEWER_PROTOCOL_VERSION })!
    const pending = broker.executeForProject(project.projectId, "capture", {})!
    const rejected = assert.rejects(pending, /Project source changed or was removed/)
    broker.invalidateProject(project.projectId)
    await rejected
    assert.equal(broker.getSession(renderer.renderSessionId), null)
    broker.invalidateProject(project.projectId)
  } finally { broker.close() }
})

test("refresh CAS, cache invalidation, immutable Host sources and deletion share the revision boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maker-revision-"))
  const dataDir = await mkdtemp(path.join(tmpdir(), "maker-revision-data-"))
  const token = "revision-test-token-long-enough"
  await writeFile(path.join(root, "Demo.fairy"), '<projectDescription id="host-demo" />')
  await writeFile(path.join(root, ".env"), "never expose this")
  await writeFile(path.join(root, "deployment.json"), "never expose this either")
  const host = await startMakerHost({ port: 0, token, projectPath: root, dataDir })
  const request = (route: string, method = "GET", body?: unknown) => fetch(`${host.origin}${route}`, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5_000),
  })
  try {
    const input = { bindingId: randomUUID(), fairyguiProjectId: "browser-demo", name: "Demo", directoryName: "Demo", fairyPath: "Demo.fairy", sourceRevision: "a".repeat(64) }
    const created = await request("/api/projects", "POST", input)
    assert.equal(created.status, 201)
    const { project } = await created.json()
    const base = `/api/projects/${project.projectId}`
    const refresh = { bindingId: input.bindingId, fairyguiProjectId: input.fairyguiProjectId, expectedSourceRevision: input.sourceRevision, nextSourceRevision: "b".repeat(64) }
    assert.equal((await request("/api/projects", "POST", input)).status, 200)
    assert.equal((await request("/api/projects", "POST", { ...input, sourceRevision: refresh.nextSourceRevision })).status, 409)
    assert.equal((await request(`${base}/refresh`, "POST", { ...refresh, bindingId: randomUUID() })).status, 409)
    assert.equal((await request(`${base}/refresh`, "POST", { ...refresh, fairyguiProjectId: "wrong" })).status, 409)
    assert.equal((await request(`${base}/refresh`, "POST", { ...refresh, expectedSourceRevision: "c".repeat(64) })).status, 409)
    assert.equal((await request(`${base}/refresh`, "POST", { ...refresh, nextSourceRevision: "invalid" })).status, 400)
    const analysis = { schemaVersion: 1, projectId: project.projectId, sourceRevision: project.sourceRevision, resources: [], references: [], issues: [] }
    assert.equal((await request(`${base}/asset-analysis`, "PUT", analysis)).status, 200)
    const renderer = (await (await request("/api/renderers", "POST", { projectId: project.projectId, sourceRevision: project.sourceRevision, protocolVersion: VIEWER_PROTOCOL_VERSION })).json()).session
    const noOp = await request(`${base}/refresh`, "POST", { ...refresh, nextSourceRevision: project.sourceRevision })
    assert.equal((await noOp.json()).project.revision, 1)
    assert.equal((await request(`/api/render-sessions/${renderer.renderSessionId}`)).status, 200)
    assert.equal((await request(`${base}/asset-analysis`)).status, 200)
    // A refresh must wake a sleeping long poll immediately, not after its 25s timeout.
    const poll = request(`/api/render-sessions/${renderer.renderSessionId}/commands?after=0`)
    const results = await Promise.all([request(`${base}/refresh`, "POST", refresh), request(`${base}/refresh`, "POST", { ...refresh, nextSourceRevision: "c".repeat(64) })])
    assert.deepEqual(results.map(({ status }) => status).sort(), [200, 409])
    assert.equal((await poll).status, 404)
    const current = (await (await request(base)).json()).project
    assert.equal(current.revision, 2)
    assert.equal((await request(`${base}/asset-analysis`)).status, 404)
    assert.equal((await request(`${base}/asset-analysis`, "PUT", analysis)).status, 409)
    assert.equal((await request("/api/renderers", "POST", { projectId: project.projectId, sourceRevision: project.sourceRevision, protocolVersion: VIEWER_PROTOCOL_VERSION })).status, 404)
    const nextRenderer = (await (await request("/api/renderers", "POST", { projectId: project.projectId, sourceRevision: current.sourceRevision, protocolVersion: VIEWER_PROTOCOL_VERSION })).json()).session
    assert.equal((await request(`${base}?bindingId=${input.bindingId}&expectedRevision=1`, "DELETE")).status, 409)
    assert.equal((await request(`${base}?bindingId=${randomUUID()}&expectedRevision=2`, "DELETE")).status, 409)
    assert.equal((await request(`${base}?bindingId=${input.bindingId}&expectedRevision=2`, "DELETE")).status, 200)
    assert.equal((await request(base)).status, 404)
    assert.equal((await request(`/api/render-sessions/${nextRenderer.renderSessionId}`)).status, 404)
    assert.equal((await request(`${base}/refresh`, "POST", refresh)).status, 404)

    const cli = host.project!, cliBase = `/api/projects/${cli.projectId}`
    const index = await (await request(`${cliBase}/source-index?sourceRevision=${cli.sourceRevision}`)).json()
    assert.deepEqual(index.files.map((file: { path: string }) => file.path), ["Demo.fairy"])
    assert.equal((await request(`${cliBase}/source-index?sourceRevision=${"0".repeat(64)}`)).status, 409)
    assert.equal((await request(`${cliBase}/source-file?path=Demo.fairy&sourceRevision=${"0".repeat(64)}`)).status, 409)
    for (const file of [".env", "deployment.json"]) assert.equal((await request(`${cliBase}/source-file?path=${file}`)).status, 404)
    assert.equal((await request(`${cliBase}/refresh`, "POST", { ...refresh, bindingId: cli.bindingId, fairyguiProjectId: cli.fairyguiProjectId, expectedSourceRevision: cli.sourceRevision })).status, 403)
    assert.equal((await request("/api/projects", "POST", { ...input, bindingId: cli.bindingId })).status, 403)
    assert.equal((await request(`${cliBase}?bindingId=${cli.bindingId}&expectedRevision=1`, "DELETE")).status, 200)
    assert.equal((await request(`${cliBase}/source-index`)).status, 404)
    assert.equal((await request(`${cliBase}/source-file?path=Demo.fairy`)).status, 404)
    assert.equal(await readFile(path.join(root, ".env"), "utf8"), "never expose this")
    assert.equal(await readFile(path.join(root, "Demo.fairy"), "utf8"), '<projectDescription id="host-demo" />')
  } finally { await host.close(); await rm(root, { recursive: true, force: true }); await rm(dataDir, { recursive: true, force: true }) }
})
