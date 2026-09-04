import assert from "node:assert/strict"
import test from "node:test"

import type { UamComponentResource, UamDisplayNode, UamProject } from "@openfairygui/core"
import { analyzeProjectAssets, summarizeAssetAnalysis } from "../src/asset-analysis"
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
