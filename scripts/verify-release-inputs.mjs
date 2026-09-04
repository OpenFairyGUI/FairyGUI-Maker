import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

const runtimeFiles = ["fairygui.js", "laya.core.js", "laya.webgl_2D.js"]
const repository = "OpenFairyGUI/FairyGUI-Maker"

export async function verifyReleaseInputs(root, { upstream = false, githubRepository = process.env.GITHUB_REPOSITORY } = {}) {
  const metadata = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
  const url = `https://github.com/${repository}`
  assert.equal(metadata.name, "fairygui-maker", "Release package name changed")
  assert.equal(metadata.license, "MIT", "Release license changed")
  assert.equal(metadata.repository?.url, `${url}.git`, "Release repository metadata disagrees")
  assert.equal(metadata.homepage, `${url}#readme`, "Release homepage disagrees")
  assert.equal(metadata.bugs?.url, `${url}/issues`, "Release issue tracker disagrees")
  if (githubRepository) assert.equal(githubRepository, repository, "Release must run in its declared repository")
  const notices = await readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8")
  const lock = JSON.parse(await readFile(path.join(root, "vendor-runtime.lock.json"), "utf8"))
  assert.equal(lock.schemaVersion, 1)
  assert.equal(lock.runtimeProfile, "layaair-3.3.10/fairygui")
  assert.match(lock.source.repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
  assert.match(lock.source.commit, /^[a-f0-9]{40}$/)
  assert.equal(lock.source.method, "copy-prebuilt")
  assert.deepEqual(lock.files.map((file) => file.path).sort(), runtimeFiles.map((file) => `public/viewer-runtime/${file}`))
  assert.deepEqual((await readdir(path.join(root, "public/viewer-runtime"))).filter((file) => file.endsWith(".js")).sort(), runtimeFiles)
  for (const file of lock.files) {
    assert.match(file.sourcePath, /^(?:[\w-]+\/)+[\w.-]+\.js$/)
    assert.equal(file.license, "MIT")
    assert.match(file.upstream, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/)
    assert.ok(Number.isSafeInteger(file.byteLength) && file.byteLength > 0)
    assert.match(file.sha256, /^[a-f0-9]{64}$/)
    const bytes = await readFile(path.join(root, file.path))
    assert.equal(bytes.length, file.byteLength, `Runtime byte length changed: ${file.path}`)
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256, `Runtime checksum changed: ${file.path}`)
    assert.ok(notices.includes(`| \`${file.path}\` | ${file.byteLength} | \`${file.sha256}\` |`), `Runtime notice disagrees with lock: ${file.path}`)
    if (upstream) {
      const source = `${lock.source.repository.replace("github.com", "raw.githubusercontent.com")}/${lock.source.commit}/${file.sourcePath}`
      const response = await fetch(source, { signal: AbortSignal.timeout(30_000) })
      assert.equal(response.status, 200, `Runtime source is unavailable: ${source}`)
      assert.ok(bytes.equals(Buffer.from(await response.arrayBuffer())), `Runtime differs from pinned source: ${file.path}`)
    }
  }
  return { repository, version: metadata.version, runtimeProfile: lock.runtimeProfile, sourceCommit: lock.source.commit, files: lock.files.length, upstream }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  assert.ok(process.argv.slice(2).every((arg) => arg === "--upstream"), "Only --upstream is supported")
  console.log(JSON.stringify(await verifyReleaseInputs(path.resolve(import.meta.dirname, ".."), { upstream: process.argv.includes("--upstream") })))
}
