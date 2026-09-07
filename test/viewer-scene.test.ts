import assert from "node:assert/strict"
import test from "node:test"

import type { UamComponentResource, UamDisplayNode, UamProject } from "@openfairygui/core"
import { analyzeProjectAssets, assetResourceKey, collectUamResourceReferences, summarizeAssetAnalysis } from "../src/asset-analysis"
import { compileViewerScene, type ViewerProjectBundle } from "../src/web/lib/viewer"

test("Viewer Scene compiles the raw UAM dependency closure without published artifacts", () => {
  const packageA = "pkg00001"
  const packageB = "pkg00002"
  const rootId = "root0001"
  const childId = "child001"
  const fontId = "font0001"
  const glyphId = "glyph001"
  const imageId = "image001"
  const missingId = "missing1"
  const root = component(rootId, [
    node({ kind: "image", id: "image", resource: { packageId: packageB, resourceId: imageId } }),
    node({ kind: "image", id: "missing", resource: { resourceId: missingId } }),
    node({ kind: "component", id: "child", resource: { resourceId: childId } }),
    node({ kind: "text", id: "label", font: `ui://${packageA}${fontId}`, text: "A" }),
  ])
  const child = component(childId, [node({ kind: "component", id: "cycle", resource: { resourceId: rootId } })])
  const fontBytes = new TextEncoder().encode(`info creator=UIBuilder\ncommon lineHeight=16\nchar id=65 img=${glyphId} xadvance=12`)
  const project = {
    projectId: "project",
    packages: [
      {
        id: packageA,
        name: "Main",
        resources: [
          root,
          child,
          asset("font", fontId, fontBytes, { fontSize: 16 }),
          asset("image", glyphId, new Uint8Array([1, 2, 3])),
          asset("image", missingId, null),
        ],
      },
      { id: packageB, name: "Shared", resources: [asset("image", imageId, new Uint8Array([4, 5, 6]))] },
    ],
  } as unknown as UamProject
  const bundle: ViewerProjectBundle = {
    sourceRevision: "revision-1",
    project,
    catalog: { schemaVersion: 1, source: { projectId: "project" }, packages: [] },
    diagnostics: [],
  }

  const scene = compileViewerScene(bundle, packageA, rootId)

  assert.deepEqual(scene.components.map(({ resource }) => resource.id).sort(), [childId, rootId])
  assert.deepEqual(scene.assets.map(({ resource }) => resource.id).sort(), [fontId, glyphId, imageId].sort())
  assert.ok(scene.diagnostics.some(({ code }) => code === "component_cycle"))
  assert.ok(scene.diagnostics.some(({ code }) => code === "asset_bytes_missing"))
  assert.equal(JSON.stringify(scene).includes(".fui"), false)
  assert.equal(scene.assets.every(({ data }) => data instanceof ArrayBuffer), true)
})

test("Asset Manager reports references, broken links, unused resources, exact duplicates, and path conflicts", async () => {
  const packageId = "pkg00001"
  const root = component("root0001", [
    node({ kind: "image", id: "used", resource: { resourceId: "used0001" } }),
    node({ kind: "image", id: "missing", resource: { resourceId: "missing1" } }),
  ])
  const conflictA = { ...asset("image", "same0001", new Uint8Array([1])), name: "Icon", path: "/same/" }
  root.exported = true
  const conflictB = { ...asset("image", "same0002", new Uint8Array([2])), name: "icon", path: "/same/" }
  const project = {
    projectId: "fairygui-project",
    settings: {},
    packages: [{
      id: packageId,
      name: "Main",
      resources: [
        root,
        asset("image", "used0001", new Uint8Array([3])),
        asset("image", "copy0001", new Uint8Array([8, 8])),
        asset("image", "copy0002", new Uint8Array([8, 8])),
        conflictA,
        conflictB,
      ],
    }],
  } as unknown as UamProject

  const analysis = await analyzeProjectAssets(project, { projectId: "project_1", sourceRevision: "a".repeat(64) })
  const summary = summarizeAssetAnalysis(analysis)
  const used = analysis.resources.find(({ resourceId }) => resourceId === "used0001")!
  const rootEntry = analysis.resources.find(({ resourceId }) => resourceId === "root0001")!

  assert.equal(used.incomingReferences, 1)
  assert.equal(rootEntry.outgoingReferences, 2)
  assert.equal(summary.missingReferences, 1)
  assert.equal(summary.duplicateGroups, 1)
  assert.equal(summary.conflictGroups, 1)
  assert.ok(summary.unusedResources >= 4)
  assert.deepEqual(new Set(analysis.issues.map(({ kind }) => kind)), new Set(["missing", "unused", "duplicate", "conflict"]))
})

test("Asset Manager diagnoses unparseable Fairy URLs without turning them into missing resources", async () => {
  const root = component("root0001", [node({ kind: "text", id: "text", font: "ui://abc", text: "A" })])
  root.exported = true
  Object.assign(root.component.properties, { icon: "ui://pkg00001bad/id", valid: "ui://pkg00001missing1" })
  const project = {
    settings: { defaultFont: "ui://", packageNameUrl: "ui://Main/Root" },
    packages: [{ id: "pkg00001", name: "Main", resources: [root] }],
  } as unknown as UamProject
  const analysis = await analyzeProjectAssets(project, { projectId: "project", sourceRevision: "revision" })
  assert.equal(analysis.analysisOwner, "browser")
  assert.equal(analysis.trust, "advisory")
  assert.equal(summarizeAssetAnalysis(analysis).invalidUrls, 4)
  assert.equal(summarizeAssetAnalysis(analysis).missingReferences, 1)
  assert.deepEqual(analysis.references.map(({ targetKey }) => targetKey), ["pkg00001/missing1"])
  const invalid = analysis.issues.filter(({ kind }) => kind === "invalid-url")
  assert.equal(invalid.filter(({ resourceKeys }) => resourceKeys.length === 0).length, 2)
  assert.ok(invalid.some(({ detail, resourceKeys }) => detail.includes("node:text/font") && resourceKeys[0] === "pkg00001/root0001"))
  assert.ok(invalid.some(({ detail }) => detail.includes("project:settings/defaultFont")))
  const viewerWarnings: string[] = []
  collectUamResourceReferences("pkg00001", root, (_path, url) => viewerWarnings.push(url))
  assert.deepEqual(viewerWarnings, ["ui://abc", "ui://pkg00001bad/id"])
})

test("private component reachability follows exported/settings roots, branches, cross-package links, and cycles", async () => {
  const ref = (resourceId: string, packageId?: string) => node({ kind: "component", id: resourceId, resource: { resourceId, packageId } })
  const root = component("root0001", [ref("live0001", "pkg00002")])
  root.exported = true
  root.branchItemIds = ["branch01"]
  Object.assign(root.component, {
    controllers: [{ actions: [{ icon: "ui://pkg00001control1" }] }],
    transitions: [{ items: [{ value: "ui://pkg00001trans001" }] }],
  })
  const project = {
    settings: { root: "ui://pkg00001setting1" },
    packages: [
      { id: "pkg00001", name: "Main", resources: [root, component("branch01", []), component("control1", []), component("trans001", []),
        component("setting1", [ref("setting2")]), component("setting2", [ref("setting1")]),
        component("dead0001", [ref("dead0002")]), component("dead0002", [ref("dead0001")]), component("alone001", [])] },
      { id: "pkg00002", name: "Shared", resources: [component("live0001", [ref("live0002")]), component("live0002", [ref("live0001")])] },
    ],
  } as unknown as UamProject
  const analysis = await analyzeProjectAssets(project, { projectId: "project", sourceRevision: "revision" })
  assert.equal(summarizeAssetAnalysis(analysis).unreachableComponents, 3)
  assert.deepEqual(analysis.issues.filter(({ kind }) => kind === "unreachable").flatMap(({ resourceKeys }) => resourceKeys).sort(),
    ["pkg00001/alone001", "pkg00001/dead0001", "pkg00001/dead0002"])
  assert.equal(analysis.resources.find(({ resourceId }) => resourceId === "dead0001")!.incomingReferences, 1)
  assert.equal(analysis.issues.some(({ kind }) => kind === "missing"), false)
})

test("Asset Manager rejects ambiguous or duplicate stable IDs", async () => {
  assert.equal(assetResourceKey("pkg_0001", "resource-1"), "pkg_0001/resource-1")
  for (const id of ["", "a/b", "a b", "a?b", "a".repeat(129)]) {
    assert.throws(() => assetResourceKey(id, "id"), /ID/)
    assert.throws(() => assetResourceKey("pkg00001", id), /ID/)
  }
  const project = { packages: [{ id: "pkg00001", name: "Main", resources: [component("same", []), component("same", [])] }] } as unknown as UamProject
  await assert.rejects(analyzeProjectAssets(project, { projectId: "project", sourceRevision: "revision" }), /ID 重复/)
})

test("Asset Manager bounds malformed URL diagnostics before hashing", async () => {
  const project = { packages: [], settings: { urls: Array(50_001).fill("ui://bad") } } as unknown as UamProject
  await assert.rejects(analyzeProjectAssets(project, { projectId: "project", sourceRevision: "revision" }), /最多记录 50000 个问题/)
})

function component(id: string, displayList: UamDisplayNode[]) {
  return {
    kind: "component",
    id,
    name: id,
    path: "/",
    exported: false,
    favorite: false,
    branch: "",
    branchItemIds: [],
    component: {
      size: { width: 100, height: 100 },
      properties: {},
      displayList,
      controllers: [],
      transitions: [],
    },
  } as unknown as UamComponentResource
}

function node(value: Record<string, unknown>) {
  return {
    name: String(value.id),
    position: { x: 0, y: 0 },
    size: { width: 10, height: 10 },
    minSize: { width: 0, height: 0 },
    maxSize: { width: 0, height: 0 },
    scale: { x: 1, y: 1 },
    skew: { x: 0, y: 0 },
    visible: true,
    touchable: true,
    grayed: false,
    alpha: 1,
    rotation: 0,
    tooltips: "",
    blendMode: "normal",
    filter: "",
    filterData: "",
    customData: "",
    relations: [],
    gears: [],
    ...value,
  } as unknown as UamDisplayNode
}

function asset(kind: "image" | "font", id: string, sourceBytes: Uint8Array | null, metadata: Record<string, unknown> = {}) {
  return {
    kind,
    id,
    name: id,
    path: "/",
    exported: false,
    favorite: false,
    branch: "",
    branchItemIds: [],
    sourceBytes,
    metadata,
    ...(kind === "image" ? { dimensions: { width: 10, height: 10 }, image: { scaleOption: 0 } } : {}),
  }
}
