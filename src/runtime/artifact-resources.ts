import type { ArtifactPackage } from "../artifact-protocol"
import { checkBudget, RUNTIME_LIMITS } from "./resource-budget"

// Package-level closure: retain all items in each selected package (controllers,
// transitions and ui:// operations may select items not visible in the first frame).
export function artifactPackageClosure(packages: ArtifactPackage[], packageId: string) {
  const byId = new Map(packages.map(pkg => [pkg.packageId, pkg]))
  if (byId.size !== packages.length) throw new Error("Duplicate Artifact package ID")
  const sorted: ArtifactPackage[] = [], visited = new Set<string>(), visiting = new Set<string>()
  const visit = (id: string, depth = 1) => {
    checkBudget(depth, RUNTIME_LIMITS.depth, "package_depth")
    if (visiting.has(id)) throw new Error("Artifact package dependency cycle")
    if (visited.has(id)) return
    const pkg = byId.get(id)
    if (!pkg) throw new Error(`Artifact package dependency missing: ${id}`)
    visiting.add(id)
    for (const dependency of pkg.dependencies) visit(dependency, depth + 1)
    visiting.delete(id)
    visited.add(id)
    sorted.push(pkg)
  }
  visit(packageId)
  return sorted
}
