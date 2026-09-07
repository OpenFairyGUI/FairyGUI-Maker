import type { UamAssetResource, UamComponentResource, UamProject, UamResource } from "@openfairygui/core"

export const ASSET_ANALYSIS_SCHEMA_VERSION = 1 as const
export const ASSET_ANALYSIS_MAX_RESOURCES = 5_000
export const ASSET_ANALYSIS_MAX_REFERENCES = 50_000
export const ASSET_RESOURCE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/
export const ASSET_ISSUE_KINDS = ["missing", "unused", "duplicate", "conflict", "invalid-url", "unreachable"] as const

export type AssetResource = {
  key: string
  packageId: string
  packageName: string
  resourceId: string
  kind: UamResource["kind"]
  name: string
  path: string
  branch: string
  exported: boolean
  byteLength: number | null
  sha256: string | null
  incomingReferences: number
  outgoingReferences: number
}

export type AssetReference = {
  sourceKey: string
  targetKey: string
  path: string
}

export type AssetIssue = {
  kind: typeof ASSET_ISSUE_KINDS[number]
  severity: "error" | "warning"
  label: string
  detail: string
  resourceKeys: string[]
}

export type ProjectAssetAnalysis = {
  schemaVersion: typeof ASSET_ANALYSIS_SCHEMA_VERSION
  analysisOwner: "browser"
  trust: "advisory"
  projectId: string
  sourceRevision: string
  resources: AssetResource[]
  references: AssetReference[]
  issues: AssetIssue[]
}

export type CollectedResourceReference = {
  packageId: string
  resourceId: string
  path: string
}

export function collectUamResourceReferences(
  packageId: string,
  resource: UamResource,
  onInvalidUrl: (path: string, value: string) => void = () => undefined,
): CollectedResourceReference[] {
  const references: CollectedResourceReference[] = []
  const add = (targetPackageId: string, resourceId: string, path: string) => {
    if (targetPackageId && resourceId) references.push({ packageId: targetPackageId, resourceId, path })
  }

  if (resource.kind === "component") collectComponentReferences(packageId, resource, add, onInvalidUrl)
  else collectAssetReferences(packageId, resource, add)
  return references
}

export async function analyzeProjectAssets(
  project: UamProject,
  source: { projectId: string; sourceRevision: string },
): Promise<ProjectAssetAnalysis> {
  const resources: AssetResource[] = []
  const resourceByKey = new Map<string, AssetResource>()
  for (const pkg of project.packages) {
    for (const resource of pkg.resources) {
      if (resources.length >= ASSET_ANALYSIS_MAX_RESOURCES) {
        throw new Error(`Asset Manager 最多分析 ${ASSET_ANALYSIS_MAX_RESOURCES} 个资源。`)
      }
      const key = assetResourceKey(pkg.id, resource.id)
      if (resourceByKey.has(key)) throw new Error(`Asset Manager 资源 ID 重复：${key}`)
      const bytes = resource.kind === "component" ? null : resource.sourceBytes ?? null
      const entry: AssetResource = {
        key,
        packageId: pkg.id,
        packageName: pkg.name,
        resourceId: resource.id,
        kind: resource.kind,
        name: resource.name,
        path: resource.path,
        branch: resource.branch,
        exported: resource.exported,
        byteLength: bytes?.byteLength ?? null,
        sha256: null,
        incomingReferences: 0,
        outgoingReferences: 0,
      }
      resources.push(entry)
      resourceByKey.set(key, entry)
    }
  }

  const references: AssetReference[] = []
  const issues: AssetIssue[] = []
  const invalidUrl = (sourceKey: string) => (path: string, value: string) => {
    if (issues.length >= ASSET_ANALYSIS_MAX_REFERENCES) {
      throw new Error(`Asset Manager 最多记录 ${ASSET_ANALYSIS_MAX_REFERENCES} 个问题。`)
    }
    issues.push({
      kind: "invalid-url",
      severity: "error",
      label: `无法解析 Fairy URL ${value.slice(0, 120)}`,
      detail: `位置：${path.slice(0, 1_600)}；分析器仅支持 ui:// + 8 位包 ID + 资源 ID，不会将无法解析的 URL 计入断链。`,
      resourceKeys: sourceKey === "project" ? [] : [sourceKey],
    })
  }
  const addReference = (sourceKey: string, targetPackageId: string, targetResourceId: string, path: string) => {
    if (references.length >= ASSET_ANALYSIS_MAX_REFERENCES) {
      throw new Error(`Asset Manager 最多分析 ${ASSET_ANALYSIS_MAX_REFERENCES} 条资源引用。`)
    }
    const targetKey = assetResourceKey(targetPackageId, targetResourceId)
    references.push({ sourceKey, targetKey, path })
    const sourceResource = resourceByKey.get(sourceKey)
    if (sourceResource) sourceResource.outgoingReferences += 1
    const targetResource = resourceByKey.get(targetKey)
    if (targetResource) targetResource.incomingReferences += 1
  }

  collectFairyUrls(project.settings, "project:settings", (packageId, resourceId, path) => (
    addReference("project", packageId, resourceId, path)
  ), invalidUrl("project"))
  for (const pkg of project.packages) {
    for (const resource of pkg.resources) {
      const sourceKey = assetResourceKey(pkg.id, resource.id)
      for (const reference of collectUamResourceReferences(pkg.id, resource, invalidUrl(sourceKey))) {
        addReference(sourceKey, reference.packageId, reference.resourceId, reference.path)
      }
      for (const id of resource.branchItemIds ?? []) {
        if (id) addReference(sourceKey, pkg.id, id, `resource:${sourceKey}/branch-item`)
      }
    }
  }

  // Web Crypto snapshots its input. Keep only one native hash allocation in flight.
  for (const pkg of project.packages) {
    for (const resource of pkg.resources) {
      if (resource.kind === "component" || !resource.sourceBytes?.byteLength) continue
      resourceByKey.get(assetResourceKey(pkg.id, resource.id))!.sha256 = await sha256(resource.sourceBytes)
    }
  }

  const missing = new Map<string, AssetReference[]>()
  for (const reference of references) {
    if (resourceByKey.has(reference.targetKey)) continue
    const group = missing.get(reference.targetKey) ?? []
    group.push(reference)
    missing.set(reference.targetKey, group)
  }
  for (const [targetKey, entries] of missing) {
    issues.push({
      kind: "missing",
      severity: "error",
      label: `缺失资源 ${targetKey}`,
      detail: `${entries.length} 条引用无法解析；首个位置：${entries[0].sourceKey} · ${entries[0].path}`,
      resourceKeys: [...new Set(entries.flatMap(({ sourceKey }) => sourceKey === "project" ? [] : [sourceKey]))],
    })
  }

  const conflicts = new Map<string, AssetResource[]>()
  for (const resource of resources) {
    const key = [resource.packageId, resource.branch, resource.path, resource.name.toLocaleLowerCase()].join("\0")
    const group = conflicts.get(key) ?? []
    group.push(resource)
    conflicts.set(key, group)
  }
  for (const entries of conflicts.values()) {
    if (entries.length < 2) continue
    issues.push({
      kind: "conflict",
      severity: "error",
      label: `${entries[0].packageName}/${displayAssetPath(entries[0])} 存在 ${entries.length} 个同名资源`,
      detail: "同包、同分支、同路径下的资源名称发生大小写无关冲突。",
      resourceKeys: entries.map(({ key }) => key),
    })
  }

  const unusedByPackage = new Map<string, AssetResource[]>()
  for (const resource of resources) {
    if (resource.kind === "component" || resource.exported || resource.incomingReferences > 0) continue
    const group = unusedByPackage.get(resource.packageId) ?? []
    group.push(resource)
    unusedByPackage.set(resource.packageId, group)
  }
  for (const entries of unusedByPackage.values()) {
    issues.push({
      kind: "unused",
      severity: "warning",
      label: `${entries[0].packageName}: ${entries.length} 个未使用资源`,
      detail: "未导出、非组件且没有入站引用；删除仍需显式写事务。",
      resourceKeys: entries.map(({ key }) => key),
    })
  }

  // Reachability, not incoming counts: a private cycle is still unreachable.
  const outgoing = new Map<string, string[]>()
  for (const { sourceKey, targetKey } of references) {
    const targets = outgoing.get(sourceKey) ?? []
    targets.push(targetKey)
    outgoing.set(sourceKey, targets)
  }
  const reachable = new Set(["project", ...resources.filter(({ exported }) => exported).map(({ key }) => key)])
  for (const key of reachable) for (const target of outgoing.get(key) ?? []) reachable.add(target)
  const unreachableByPackage = new Map<string, AssetResource[]>()
  for (const resource of resources) {
    if (resource.kind !== "component" || reachable.has(resource.key)) continue
    const group = unreachableByPackage.get(resource.packageId) ?? []
    group.push(resource)
    unreachableByPackage.set(resource.packageId, group)
  }
  for (const entries of unreachableByPackage.values()) {
    issues.push({
      kind: "unreachable",
      severity: "warning",
      label: `${entries[0].packageName}: ${entries.length} 个不可达私有组件`,
      detail: "从导出资源和项目设置出发，沿已识别引用不可达（包括私有循环）。动态加载、外部引用和无法解析的 URL 不在证明范围内，不代表可以安全删除。",
      resourceKeys: entries.map(({ key }) => key),
    })
  }

  const duplicates = new Map<string, AssetResource[]>()
  for (const resource of resources) {
    if (!resource.sha256 || !resource.byteLength) continue
    const key = `${resource.kind}:${resource.byteLength}:${resource.sha256}`
    const group = duplicates.get(key) ?? []
    group.push(resource)
    duplicates.set(key, group)
  }
  for (const entries of duplicates.values()) {
    if (entries.length < 2) continue
    issues.push({
      kind: "duplicate",
      severity: "warning",
      label: `${entries.length} 个完全重复的 ${entries[0].kind} 资源`,
      detail: `SHA-256 ${entries[0].sha256}；合并前必须先支持引用重写。`,
      resourceKeys: entries.map(({ key }) => key),
    })
  }

  resources.sort((left, right) => left.packageName.localeCompare(right.packageName) || displayAssetPath(left).localeCompare(displayAssetPath(right)))
  if (issues.length > ASSET_ANALYSIS_MAX_REFERENCES) throw new Error(`Asset Manager 最多记录 ${ASSET_ANALYSIS_MAX_REFERENCES} 个问题。`)
  issues.sort((left, right) => left.kind.localeCompare(right.kind) || left.label.localeCompare(right.label))
  return { schemaVersion: ASSET_ANALYSIS_SCHEMA_VERSION, ...source, analysisOwner: "browser", trust: "advisory", resources, references, issues }
}

export function summarizeAssetAnalysis(analysis: ProjectAssetAnalysis) {
  const resourceKeys = new Set(analysis.resources.map(({ key }) => key))
  return {
    resources: analysis.resources.length,
    references: analysis.references.length,
    missingReferences: analysis.references.filter(({ targetKey }) => !resourceKeys.has(targetKey)).length,
    invalidUrls: analysis.issues.filter(({ kind }) => kind === "invalid-url").length,
    unreachableComponents: new Set(analysis.issues.filter(({ kind }) => kind === "unreachable").flatMap(({ resourceKeys }) => resourceKeys)).size,
    unusedResources: new Set(analysis.issues.filter(({ kind }) => kind === "unused").flatMap(({ resourceKeys }) => resourceKeys)).size,
    duplicateGroups: analysis.issues.filter(({ kind }) => kind === "duplicate").length,
    conflictGroups: analysis.issues.filter(({ kind }) => kind === "conflict").length,
  }
}

export function assetResourceKey(packageId: string, resourceId: string) {
  if (!ASSET_RESOURCE_ID_PATTERN.test(packageId) || !ASSET_RESOURCE_ID_PATTERN.test(resourceId)) {
    throw new Error("Asset Manager 包和资源 ID 必须是 1–128 位字母、数字、下划线或连字符。")
  }
  return `${packageId}/${resourceId}`
}

export function displayAssetPath(resource: Pick<AssetResource, "name" | "path">) {
  const path = resource.path.replace(/^\/+|\/+$/g, "")
  return path ? `${path}/${resource.name}` : resource.name
}

type AddReference = (packageId: string, resourceId: string, path: string) => void

function collectComponentReferences(
  packageId: string,
  component: UamComponentResource,
  add: AddReference,
  onInvalidUrl: (path: string, value: string) => void,
) {
  const componentPath = `component:${packageId}/${component.id}`
  for (const node of component.component.displayList) {
    const path = `${componentPath}/node:${node.id}`
    if (node.kind === "image" || node.kind === "movieClip" || node.kind === "component") {
      add(node.resource.packageId || packageId, node.resource.resourceId, path)
    } else if (["button", "label", "comboBox", "progressBar", "slider", "scrollBar"].includes(node.kind)) {
      const derived = node as typeof node & { src: string; packageId: string }
      if (derived.src) add(derived.packageId || packageId, derived.src, path)
    }
    collectFairyUrls(node, path, add, onInvalidUrl)
  }
  collectFairyUrls(component.component.properties, `${componentPath}/properties`, add, onInvalidUrl)
  collectFairyUrls(component.component.controllers, `${componentPath}/controllers`, add, onInvalidUrl)
  collectFairyUrls(component.component.transitions, `${componentPath}/transitions`, add, onInvalidUrl)
}

function collectAssetReferences(packageId: string, resource: UamAssetResource, add: AddReference) {
  const path = `resource:${packageId}/${resource.id}`
  if (resource.kind === "font") {
    const textureId = typeof resource.metadata?.textureId === "string" ? resource.metadata.textureId : ""
    if (textureId) add(packageId, textureId, `${path}/font-texture`)
    if (resource.sourceBytes?.byteLength) {
      const source = new TextDecoder().decode(resource.sourceBytes)
      for (const match of source.matchAll(/(?:^|\s)img=([^\s\r\n]+)/gm)) {
        if (match[1]) add(packageId, match[1].replace(/^"|"$/g, ""), `${path}/font-glyph`)
      }
    }
  }
  if (resource.kind === "spine" || resource.kind === "dragonBones") {
    const requireIds = Array.isArray(resource.metadata?.requireIds) ? resource.metadata.requireIds : []
    for (const id of requireIds) if (typeof id === "string") add(packageId, id, `${path}/skeleton-dependency`)
  }
}

function collectFairyUrls(
  value: unknown,
  path: string,
  add: AddReference,
  onInvalidUrl: (path: string, value: string) => void = () => undefined,
  seen = new Set<object>(),
) {
  if (typeof value === "string") {
    if (!value.startsWith("ui://")) return
    const body = value.slice(5)
    if (body.length >= 9 && ASSET_RESOURCE_ID_PATTERN.test(body.slice(0, 8)) && ASSET_RESOURCE_ID_PATTERN.test(body.slice(8))) add(body.slice(0, 8), body.slice(8), path)
    else onInvalidUrl(path, value)
    return
  }
  if (!value || typeof value !== "object" || value instanceof Uint8Array || value instanceof ArrayBuffer || seen.has(value)) return
  seen.add(value)
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectFairyUrls(item, `${path}[${index}]`, add, onInvalidUrl, seen))
    return
  }
  for (const [key, item] of Object.entries(value)) collectFairyUrls(item, `${path}/${key}`, add, onInvalidUrl, seen)
}

async function sha256(bytes: Uint8Array) {
  const data = bytes.buffer instanceof ArrayBuffer ? bytes as Uint8Array<ArrayBuffer> : new Uint8Array(bytes)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
