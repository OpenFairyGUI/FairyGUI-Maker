import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { captureProjectSnapshot, PROJECT_SCAN_LIMITS, projectPath, type ProjectSnapshotSource } from "../src/project-snapshot"
import { createHostProjectSnapshot } from "../src/server/project-snapshot"
import { readBrowserProjectSnapshot } from "../src/web/lib/project-source"

const fairy = '<projectDescription id="snapshot-project" type="Layabox" version="5.0" />'
const component = '<component size="100,100"><displayList><text id="n0" name="title" xy="0,0" size="100,30" text="Before" /></displayList></component>'
function fixture(extraResources = "") {
  return new Map<string, string | Uint8Array>([
    ["Demo.fairy", fairy], ["settings/Publish.json", "{}"],
    ["assets/Demo/package.xml", `<packageDescription id="PACK0001"><resources><component id="MAIN0001" name="Main.xml" path="/" />${extraResources}</resources></packageDescription>`],
    ["assets/Demo/Main.xml", component],
    [".env", "secret"], [".env.local", "secret"], ["assets/Demo/private.pem", "secret"],
    ["assets/Demo/deployment.json", "secret"], ["settings/deployment.json", "secret"], ["source.ts", "secret"],
    ["node_modules/another/Demo.fairy", fairy], [".git/config", "secret"], [".fairygui-maker/state.json", "secret"], ["dist/Demo.fairy", fairy],
  ])
}
function memorySource(files: Map<string, string | Uint8Array>) {
  const reads: string[] = []
  const source: ProjectSnapshotSource = {
    async *entries(directory) {
      const prefix = directory ? `${directory}/` : ""
      const children = new Map<string, "file" | "directory">()
      for (const file of files.keys()) if (file.startsWith(prefix)) {
        const parts = file.slice(prefix.length).split("/")
        children.set(parts[0], parts.length > 1 ? "directory" : "file")
      }
      for (const [name, kind] of children) yield { name, kind }
    },
    async readFile(file, maxBytes, signal) {
      signal.throwIfAborted()
      reads.push(file)
      const value = files.get(file)
      assert.notEqual(value, undefined)
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value!
      if (bytes.byteLength > maxBytes) throw new Error("project_snapshot_byte_budget_exceeded")
      return bytes.slice()
    },
  }
  return { source, reads }
}

test("snapshot reads dependency closure only; revision hashes bytes, not metadata or unreferenced secrets", async () => {
  const files = fixture(), memory = memorySource(files)
  const first = await captureProjectSnapshot(memory.source)
  assert.deepEqual([...first.files.keys()].sort(), ["Demo.fairy", "assets/Demo/Main.xml", "assets/Demo/package.xml", "settings/Publish.json"])
  assert.ok(memory.reads.every((file) => first.files.has(file)))
  files.set("assets/Demo/deployment.json", "new secret")
  assert.equal((await captureProjectSnapshot(memory.source)).sourceRevision, first.sourceRevision)
  files.set("assets/Demo/Main.xml", component.replace("Before", "After!"))
  assert.notEqual((await captureProjectSnapshot(memory.source)).sourceRevision, first.sourceRevision)
  const reordered = await captureProjectSnapshot(memorySource(new Map([...fixture()].reverse())).source)
  assert.equal(reordered.sourceRevision, first.sourceRevision)
  const nested = await captureProjectSnapshot(memorySource(new Map([...fixture()].map(([file, data]) => [`nested/${file}`, data]))).source)
  assert.equal(nested.fairyPath, "nested/Demo.fairy")
})

test("dependency closure includes branches, bitmap fonts, Spine atlas pages and DragonBones textures", async () => {
  const files = fixture('<font id="FONT0001" name="font.fnt" path="/" /><font id="FONT0002" name="binary.fnt" path="/" /><spine id="SPINE001" name="spine.json" path="/" /><dragonbones id="DRAGON01" name="dragon_ske.json" path="/" />')
  files.set("assets/Demo/font.fnt", 'info face="Example"\npage id=0 file="pages/font.png"\n')
  const page = new TextEncoder().encode("pages/binary.png\0"), binary = new Uint8Array(9 + page.length)
  binary.set([66, 77, 70, 3, 3]); new DataView(binary.buffer).setUint32(5, page.length, true); binary.set(page, 9)
  files.set("assets/Demo/binary.fnt", binary)
  files.set("assets/Demo/spine.json", "{}")
  files.set("assets/Demo/spine.atlas", 'pages/spine.png\nsize: 1,1\nfilter: Linear,Linear\nregion\n  xy: 0,0\n')
  files.set("assets/Demo/dragon_ske.json", "{}")
  files.set("assets/Demo/dragon_tex.json", '{"imagePath":"pages/dragon.png"}')
  for (const name of ["font", "binary", "spine", "dragon"]) files.set(`assets/Demo/pages/${name}.png`, new Uint8Array([1, 2, 3]))
  files.set("assets_mobile/Demo/package_branch.xml", '<branchDescription><resources><component id="MAIN0002" name="Main.xml" path="/" /></resources></branchDescription>')
  files.set("assets_mobile/Demo/Main.xml", component)
  const snapshot = await captureProjectSnapshot(memorySource(files).source)
  for (const name of ["font", "binary", "spine", "dragon"]) assert.ok(snapshot.files.has(`assets/Demo/pages/${name}.png`), name)
  assert.ok(snapshot.files.has("assets_mobile/Demo/Main.xml"))
  assert.equal(snapshot.files.has("assets/Demo/deployment.json"), false)
  files.set("assets/Demo/font.fnt", 'page id=0 file="../../../../outside.png"')
  await assert.rejects(captureProjectSnapshot(memorySource(files).source), /outside_root/)
  files.set("assets/Demo/font.fnt", 'page id=0 file="private.pem"')
  await assert.rejects(captureProjectSnapshot(memorySource(files).source), /dependency_path_not_allowed/)
})

test("snapshot fails closed on mid-read edits, missing components, unsafe paths, symlinks and scan budgets", async () => {
  for (const invalid of ['<projectDescription id="broken">', '<notAProject id="broken" />']) {
    await assert.rejects(captureProjectSnapshot(memorySource(new Map([["Demo.fairy", invalid]])).source), /snapshot_invalid/)
  }
  const files = fixture(), memory = memorySource(files)
  let reads = 0
  await assert.rejects(captureProjectSnapshot({ ...memory.source, async readFile(...args) {
    const bytes = await memory.source.readFile(...args)
    if (++reads === 4) files.set("assets/Demo/Main.xml", component.replace("Before", "After!"))
    return bytes
  } }), /source_changed_during_read/)
  files.delete("assets/Demo/Main.xml")
  await assert.rejects(captureProjectSnapshot(memorySource(files).source), /dependency_missing/)
  for (const invalid of ["../escape", "C:/secret", "/absolute", "a/CON.txt", "a/b."]) assert.throws(() => projectPath(invalid))
  await assert.rejects(captureProjectSnapshot({ ...memory.source, async *entries() { yield { name: "link", kind: "unsafe" } } }), /symlink/)
  await assert.rejects(captureProjectSnapshot({ ...memory.source, async *entries() { for (let i = 0; i <= PROJECT_SCAN_LIMITS.files; i++) yield { name: `${i}.txt`, kind: "file" } } }), /file_budget/)
  await assert.rejects(captureProjectSnapshot({ ...memory.source, async *entries() { for (let i = 0; i <= PROJECT_SCAN_LIMITS.entries; i++) yield { name: `.ignore-${i}`, kind: "file" } } }), /entry_budget/)
  await assert.rejects(captureProjectSnapshot({ ...memory.source, async *entries() { yield { name: "deep", kind: "directory" } } }), /directory_budget/)
  await assert.rejects(captureProjectSnapshot({ ...memory.source, async *entries(directory) { if (!directory) for (let i = 0; i <= PROJECT_SCAN_LIMITS.directories; i++) yield { name: `dir${i}`, kind: "directory" } } }), /directory_budget/)
  const abort = new AbortController(); abort.abort()
  await assert.rejects(captureProjectSnapshot(memory.source, { signal: abort.signal }), { name: "AbortError" })
})

test("snapshot enforces text and aggregate byte budgets even when Core catches read errors", async () => {
  const files = fixture(Array.from({ length: 5 }, (_, i) => `<misc id="MISC000${i}" name="${i}.bin" path="/" />`).join(""))
  for (let i = 0; i < 5; i++) files.set(`assets/Demo/${i}.bin`, new Uint8Array([1]))
  const memory = memorySource(files)
  let constrained = false
  await assert.rejects(captureProjectSnapshot({ ...memory.source, async readFile(file, maxBytes, signal) {
    if (!file.endsWith(".bin")) return memory.source.readFile(file, maxBytes, signal)
    if (maxBytes < PROJECT_SCAN_LIMITS.fileBytes) { constrained = true; throw new Error("project_snapshot_byte_budget_exceeded") }
    // Model a 128 MiB file at the adapter boundary without allocating half a GiB in the test process.
    return Object.defineProperty(new Uint8Array([1]), "byteLength", { value: PROJECT_SCAN_LIMITS.fileBytes })
  } }), /byte_budget/)
  assert.equal(constrained, true)
  await assert.rejects(captureProjectSnapshot({ ...memory.source, async readFile(file, maxBytes) {
    assert.equal(file, "Demo.fairy")
    assert.equal(maxBytes, PROJECT_SCAN_LIMITS.textBytes)
    throw new Error("project_snapshot_byte_budget_exceeded")
  } }), /byte_budget/)
})

test("browser adapter prechecks file size before arrayBuffer and matches the Host/shared digest", async () => {
  const files = fixture(), memory = memorySource(files)
  let oversized = false, buffers = 0
  const directory = (prefix = ""): FileSystemDirectoryHandle => ({
    kind: "directory", name: "fixture",
    entries: () => memory.source.entries(prefix),
    getDirectoryHandle: async (name: string) => directory(prefix ? `${prefix}/${name}` : name),
    getFileHandle: async (name: string) => ({ getFile: async () => {
      const value = files.get(prefix ? `${prefix}/${name}` : name)!
      const data = typeof value === "string" ? new TextEncoder().encode(value) : value
      return { size: oversized ? PROJECT_SCAN_LIMITS.fileBytes + 1 : data.length, lastModified: 1, arrayBuffer: async () => { buffers++; return data.slice().buffer } }
    } }),
  } as unknown as FileSystemDirectoryHandle)
  // Browser entries are handle tuples, not the shared adapter's metadata objects.
  const root = directory()
  const wrap = (handle: FileSystemDirectoryHandle, prefix = "") => {
    Object.assign(handle, { async *entries() { for await (const entry of memory.source.entries(prefix)) yield [entry.name, { kind: entry.kind }] }, getDirectoryHandle: async (name: string) => { const next = prefix ? `${prefix}/${name}` : name; return wrap(directory(next), next) } })
    return handle
  }
  wrap(root)
  assert.equal((await readBrowserProjectSnapshot(root)).sourceRevision, (await captureProjectSnapshot(memory.source)).sourceRevision)
  oversized = true; buffers = 0
  await assert.rejects(readBrowserProjectSnapshot(root), /byte_budget/)
  assert.equal(buffers, 0)
})

test("Host snapshot excludes secrets, rejects links, and detects same-size same-mtime byte edits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maker-snapshot-"))
  try {
    for (const [file, bytes] of fixture()) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), bytes) }
    const first = await createHostProjectSnapshot(root)
    const main = path.join(root, "assets/Demo/Main.xml"), before = await stat(main)
    await writeFile(main, component.replace("Before", "After!")); await utimes(main, before.atime, before.mtime)
    assert.notEqual((await createHostProjectSnapshot(root)).sourceRevision, first.sourceRevision)
    assert.equal(first.readFile(".env"), null)
    assert.equal(first.readFile("assets/Demo/deployment.json"), null)
    assert.equal(new TextDecoder().decode(first.readFile("assets/Demo/Main.xml")!), component)
    assert.equal(await readFile(path.join(root, ".env"), "utf8"), "secret")
    await symlink(path.join(root, "assets"), path.join(root, "linked-assets"), "junction")
    await assert.rejects(createHostProjectSnapshot(root), /symlink/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
