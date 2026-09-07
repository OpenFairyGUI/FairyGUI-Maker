import assert from "node:assert/strict"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { ProjectAssetAnalysis } from "../src/asset-analysis"
import { registerViewerMcpTools, ViewerRenderBroker } from "../src/server/viewer"

test("MCP pages every asset issue/reference/key and artifact/component, rejecting changed snapshots and selectors", async () => {
  const project = { projectId: "project", sourceRevision: "revision", viewerUrl: "http://localhost/viewer" }
  const resources: ProjectAssetAnalysis["resources"] = Array.from({ length: 601 }, (_, index) => ({
    key: `pkg/r${index}`, packageId: "pkg", packageName: "Package", resourceId: `r${index}`, kind: "image", name: `Image ${index}`,
    path: "/", branch: "", exported: false, byteLength: null, sha256: null, incomingReferences: 0, outgoingReferences: 0,
  }))
  const analysis: ProjectAssetAnalysis = {
    schemaVersion: 1, analysisOwner: "browser", trust: "advisory", ...project,
    resources,
    references: resources.map((_, index) => ({ sourceKey: "pkg/r0", targetKey: "pkg/r0", path: `reference:${index}` })),
    issues: resources.map((_, index) => ({ kind: "unused", severity: "warning", label: `Issue ${index}`, detail: "Synthetic advisory claim", resourceKeys: index === 0 ? resources.map(({ key }) => key) : ["pkg/r0"] })),
  }
  const artifacts = Array.from({ length: 101 }, (_, index) => ({
    artifactId: `artifact_${String(index).padStart(3, "0")}`, digest: `digest${index}`, playerUrl: `http://localhost/player/${index}`,
    packages: [{ packageId: "pkg", packageName: "Package", binaryPath: "Package.fui", dependencies: [], components: Array.from({ length: index === 0 ? 601 : 1 }, (_, component) => ({ id: `c${component}`, name: `Component ${component}` })) }],
  }))
  artifacts[0].packages.push({ packageId: "empty", packageName: "Empty", binaryPath: "Empty.fui", dependencies: [], components: [] })
  const server = new McpServer({ name: "pagination-test", version: "1.0.0" })
  registerViewerMcpTools(server, new ViewerRenderBroker(() => project), () => project, (id) => artifacts.find((artifact) => artifact.artifactId === id) ?? null, () => [...artifacts], () => [project], () => analysis)
  const client = new Client({ name: "pagination-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args })
    return JSON.parse((result.content as { text: string }[])[0].text)
  }
  const pages = async (name: string, args: Record<string, unknown>) => {
    const results = []
    let cursor: string | null = null
    do {
      const result = await call(name, { ...args, ...(cursor ? { cursor } : {}) })
      assert.equal(result.ok, true)
      results.push(result)
      cursor = result.nextCursor
      assert.ok(results.length < 20, "cursor must terminate")
    } while (cursor)
    return results
  }
  try {
    const summaries = await pages("inspect_project_assets", { projectId: "project", limit: 500 })
    assert.deepEqual(summaries.flatMap((page) => page.issues.map((issue: { label: string }) => issue.label)), analysis.issues.map(({ label }) => label))
    const resourcePages = await pages("inspect_project_assets", { projectId: "project", packageId: "pkg", resourceId: "r0", limit: 500 })
    for (const direction of ["incoming", "outgoing"]) assert.deepEqual(resourcePages.flatMap((page) => page.references[direction].map((ref: { path: string }) => ref.path)), analysis.references.map(({ path }) => path))
    assert.equal(resourcePages.flatMap((page) => page.issues).length, 601)
    const issueId = summaries[0].issues[0].issueId
    const keys = await pages("inspect_project_assets", { projectId: "project", issueId, limit: 500 })
    assert.deepEqual(keys.flatMap((page) => page.resourceKeys), resources.map(({ key }) => key))
    assert.equal((await call("inspect_project_assets", { projectId: "project", cursor: resourcePages[0].nextCursor })).code, "cursor_invalid_or_stale")
    analysis.issues[0].detail = "Rescanned at the same source revision"
    assert.equal((await call("inspect_project_assets", { projectId: "project", cursor: summaries[0].nextCursor })).code, "cursor_invalid_or_stale")
    assert.equal((await call("inspect_project_assets", { projectId: "project", issueId })).code, "issue_invalid_or_stale")
    const catalog = await pages("list_artifact_components", { limit: 100 })
    assert.deepEqual(catalog.flatMap((page) => page.artifacts.map((artifact: { artifactId: string }) => artifact.artifactId)), artifacts.map(({ artifactId }) => artifactId))
    assert.ok(catalog.every((page) => page.artifacts.every((artifact: object) => !("packages" in artifact))), "discovery must not return unbounded component arrays")
    const components = await pages("list_artifact_components", { artifactId: artifacts[0].artifactId, limit: 500 })
    assert.deepEqual(components.flatMap((page) => page.artifacts[0].packages.flatMap((pkg: { components: { id: string }[] }) => pkg.components.map(({ id }) => id))), artifacts[0].packages[0].components.map(({ id }) => id))
    assert.equal(components.at(-1).artifacts[0].packages.at(-1).packageId, "empty")
    assert.equal((await call("list_artifact_components", { artifactId: artifacts[1].artifactId, cursor: components[0].nextCursor })).code, "cursor_invalid_or_stale")
    artifacts.pop()
    assert.equal((await call("list_artifact_components", { cursor: catalog[0].nextCursor })).code, "cursor_invalid_or_stale")
    const invalid = await client.callTool({ name: "list_artifact_components", arguments: { cursor: "invalid" } })
    assert.equal(invalid.isError, true)
  } finally {
    await client.close()
    await server.close()
  }
})
