import { createHash } from "node:crypto"
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Document } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"

export const FIXTURE = {
  fairyFile: "Card.fairy",
  packageId: "MAIN0001",
  packageName: "Main",
  componentId: "CARD0001",
  componentName: "Card",
  componentFile: "assets/Main/Card.xml",
  size: { width: 240, height: 120 },
  title: { id: "TITLE001", text: "Hello" },
  badge: { id: "BADGE001", x: 10, y: 60, fill: "#2563eb" },
} as const

/** One exported component: a title text and a filled badge, small enough to render and diff quickly. */
export async function writeFixtureProject(projectDir: string) {
  await mkdir(projectDir, { recursive: true })
  const document = new Document()
  document.getRoot().setProjectId("maker-agent-eval")
  const component = document.createComponent(FIXTURE.componentName).setId(FIXTURE.componentId).setExported(true).setSize(FIXTURE.size.width, FIXTURE.size.height)
    .addChild(document.createGTextField("title").setId(FIXTURE.title.id).setXY(10, 10).setSize(220, 40).setFontSize(24).setColor("#111827").setText(FIXTURE.title.text))
    .addChild(document.createGGraph("badge").setId(FIXTURE.badge.id).setXY(FIXTURE.badge.x, FIXTURE.badge.y).setSize(40, 40).setGraphType(1).setFillColor(FIXTURE.badge.fill))
  document.createPackage(FIXTURE.packageName).setId(FIXTURE.packageId).addResource(component)
  await new NodeIO().writeProject(document, path.join(projectDir, FIXTURE.fairyFile))
  // Editor-created projects carry these settings files; without them every Backend save would add them and blur the diff.
  await mkdir(path.join(projectDir, "settings"), { recursive: true })
  for (const name of ["Adaptation.json", "Common.json", "Publish.json"]) {
    await writeFile(path.join(projectDir, "settings", name), "{}", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error })
  }
}

/** Relative POSIX path → SHA-256 of every file, so judges can prove exactly which files changed. */
export async function snapshotFiles(root: string) {
  const files: Record<string, string> = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const absolute = path.join(entry.parentPath, entry.name)
    files[path.relative(root, absolute).split(path.sep).join("/")] = createHash("sha256").update(await readFile(absolute)).digest("hex")
  }
  return files
}

export function changedFiles(before: Record<string, string>, after: Record<string, string>) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((file) => before[file] !== after[file]).sort()
}

/** The fixture's two nodes as saved on disk, read through the public Core reader rather than the product under test. */
export async function readFixtureNodes(projectDir: string) {
  const document = await new NodeIO().readProject(path.join(projectDir, FIXTURE.fairyFile))
  const component = document.getRoot().getPackageById(FIXTURE.packageId)?.listComponents().find((candidate) => candidate.getId() === FIXTURE.componentId)
  if (!component) return null
  const nodes = component.listChildren() as unknown as Array<{ getId(): string } & Record<string, (...args: never[]) => unknown>>
  const node = (id: string) => nodes.find((candidate) => candidate.getId() === id)
  const title = node(FIXTURE.title.id)
  const badge = node(FIXTURE.badge.id)
  return {
    componentName: component.getName(),
    titleText: title ? String((title.getText as () => string)()) : null,
    badgeX: badge ? Number((badge.getX as () => number)()) : null,
    badgeY: badge ? Number((badge.getY as () => number)()) : null,
    badgeFill: badge ? String((badge.getFillColor as () => string)()).toLowerCase() : null,
  }
}
