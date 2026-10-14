import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm, stat } from "node:fs/promises"
import path from "node:path"
import { ProjectType } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"
import { resolvePublishOptions } from "@openfairygui/functions"
import { publishNode } from "@openfairygui/functions/node"
import type { OpenFairyGuiBackendRuntime } from "@openfairygui/mcp"
import { z } from "zod"

import type { ArtifactStore } from "./artifacts"

export const sessionPublishInput = z.object({
  sessionId: z.string().min(1).max(256),
  expectedRevision: z.number().int().nonnegative(),
  name: z.string().trim().min(1).max(200).optional(),
}).strict()

type PublishFailure = { ok: false; error: { code: string; message: string } }
const failure = (code: string, message: string): PublishFailure => ({ ok: false, error: { code, message } })

// Publishes the saved project of a clean Backend session with the Player's LayaAir profile and imports the output as an artifact.
// Project plugins and code generation are skipped: they would run project code or write outside Maker's private data directory.
export function createSessionPublisher({ runtime, artifactStore, workRoot }: {
  runtime: Pick<OpenFairyGuiBackendRuntime, "getSession">
  artifactStore: ArtifactStore
  workRoot: string
}) {
  let publishing = false

  const savedSession = (sessionId: string, expectedRevision: number) => {
    const session = runtime.getSession({ sessionId })
    if (!session.ok) return failure("publish_session_unavailable", "The session is unavailable; open the project before publishing.")
    const { revision, lastSavedRevision, dirty, canonicalProjectPath } = session.data
    if (revision !== expectedRevision) return failure("publish_revision_stale", "The session revision changed. Read getSession and retry with its current revision.")
    if (dirty || lastSavedRevision !== revision) return failure("publish_requires_saved_session", "Publish reads the saved project. Save the session first, then publish its saved revision.")
    return { ok: true as const, canonicalProjectPath }
  }

  return {
    async init() {
      // Staging directories never outlive a Host process.
      await rm(workRoot, { recursive: true, force: true })
      await mkdir(workRoot, { recursive: true })
    },
    async publish(input: z.infer<typeof sessionPublishInput>) {
      const { sessionId, expectedRevision } = input
      const before = savedSession(sessionId, expectedRevision)
      if (!before.ok) return before
      if (publishing) return failure("publish_busy", "Another publish is running. Retry after it finishes.")
      publishing = true
      const staging = path.join(workRoot, `publish_${randomUUID()}`)
      const output = path.join(staging, "output")
      try {
        const fairyPath = await resolveFairyPath(before.canonicalProjectPath)
        const document = await new NodeIO().readProject(fairyPath)
        document.getRoot().setProjectType(ProjectType.LayaBox)
        const resolved = resolvePublishOptions(document, { targetProjectType: ProjectType.LayaBox })
        const result = await publishNode({
          document,
          output,
          compressed: resolved.compressed,
          fileExtension: resolved.fileExtension,
          packages: resolved.packages,
          assetsPath: path.join(path.dirname(fairyPath), "assets"),
          atlas: resolved.atlas,
          plugins: [],
          codeGeneration: false,
        })
        const outside = result.files.find((file) => {
          const relative = path.relative(output, path.resolve(file.path))
          return relative.startsWith("..") || path.isAbsolute(relative)
        })
        if (outside) return failure("publish_output_outside_staging", "Publish wrote outside its staging directory; nothing was imported.")
        // A save during publish could mix revisions; only an unchanged saved session produces an artifact.
        const after = savedSession(sessionId, expectedRevision)
        if (!after.ok || after.canonicalProjectPath !== before.canonicalProjectPath) {
          return failure("publish_session_changed", "The session changed while publishing; nothing was imported. Read getSession and publish again.")
        }
        const name = input.name ?? `${path.basename(fairyPath, path.extname(fairyPath))} r${expectedRevision}`
        const artifact = await artifactStore.importDirectory(output, name, { kind: "host-publish", sessionId, revision: expectedRevision })
        if (!artifact) return failure("publish_import_failed", "The published output could not be imported.")
        return { ok: true as const, artifact }
      } catch (error) {
        return failure("publish_failed", error instanceof Error ? error.message : String(error))
      } finally {
        publishing = false
        await rm(staging, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined)
      }
    },
  }
}

// Same rule as the OpenFairyGUI CLI: a .fairy path, or a directory holding exactly one .fairy file.
async function resolveFairyPath(projectPath: string) {
  if ((await stat(projectPath)).isFile()) {
    if (!projectPath.toLowerCase().endsWith(".fairy")) throw new Error("publish_project_not_fairy")
    return projectPath
  }
  const fairyFiles = (await readdir(projectPath)).filter((name) => name.toLowerCase().endsWith(".fairy"))
  if (fairyFiles.length !== 1) throw new Error(`publish_project_requires_one_fairy_file:${fairyFiles.length}`)
  return path.join(projectPath, fairyFiles[0])
}
