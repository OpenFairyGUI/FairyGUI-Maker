import { isAbsolute, relative, resolve, sep } from "node:path"
import { createNodeBackendFileSystem, type BackendFileSystem } from "@openfairygui/backend/node"

export const PRIVATE_PROJECT_ERROR = "maker_private_path_forbidden"
export const PRIVATE_PROJECT_MESSAGE = "Maker private data cannot be opened or replaced through project writes. Choose a separate project directory."

const contains = (parent: string, child: string) => {
  const path = relative(parent, child)
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

export async function createHostBackendFileSystem(dataDir: string): Promise<BackendFileSystem> {
  const base = createNodeBackendFileSystem()
  const privateRoots = [resolve(dataDir), await base.resolvePath(dataDir)]
  const assertProjectRoot = async (projectRoot: string) => {
    const canonical = await base.resolvePath(projectRoot)
    const roots = [...privateRoots, await base.resolvePath(dataDir)]
    // Node commits by replacing the whole project directory: ancestors are unsafe too.
    if ([resolve(projectRoot), canonical].some((project) => roots.some((root) => contains(root, project) || contains(project, root)))) {
      throw Object.assign(new Error(PRIVATE_PROJECT_MESSAGE), { code: PRIVATE_PROJECT_ERROR })
    }
  }
  return {
    ...base,
    async validateProjectRoot(projectRoot) {
      await assertProjectRoot(projectRoot)
      await base.validateProjectRoot!(projectRoot)
    },
    async runProjectWriteTransaction(projectRoot, write) {
      // Recheck at every save, not just open; existing ancestors can be retargeted through a link.
      await assertProjectRoot(projectRoot)
      await base.runProjectWriteTransaction!(projectRoot, write)
    },
  }
}
