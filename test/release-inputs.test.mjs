import assert from "node:assert/strict"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { verifyReleaseInputs } from "../scripts/verify-release-inputs.mjs"

test("release inputs reject runtime, provenance, notice and repository drift", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "maker-release-inputs-"))
  try {
    await mkdir(path.join(root, "public"))
    await cp("public/viewer-runtime", path.join(root, "public/viewer-runtime"), { recursive: true })
    for (const file of ["package.json", "vendor-runtime.lock.json", "THIRD_PARTY_NOTICES.md"]) await cp(file, path.join(root, file))
    const verify = (githubRepository = "OpenFairyGUI/FairyGUI-Maker") => verifyReleaseInputs(root, { githubRepository })
    assert.equal((await verify()).files, 3)
    await assert.rejects(verify("somebody/another-repository"), /declared repository/)

    const target = path.join(root, "public/viewer-runtime/fairygui.js")
    const bytes = await readFile(target)
    const changed = Buffer.from(bytes)
    changed[0] ^= 1
    await writeFile(target, changed)
    await assert.rejects(verify(), /checksum changed/)
    await writeFile(target, bytes.toString().replaceAll("\n", "\r\n"))
    await assert.rejects(verify(), /byte length changed/)
    await writeFile(target, bytes)

    const lockPath = path.join(root, "vendor-runtime.lock.json")
    const original = await readFile(lockPath, "utf8")
    const lock = JSON.parse(original)
    lock.source.commit = "main"
    await writeFile(lockPath, JSON.stringify(lock))
    await assert.rejects(verify())
    await writeFile(lockPath, original)
    const noticePath = path.join(root, "THIRD_PARTY_NOTICES.md")
    const notices = await readFile(noticePath, "utf8")
    await writeFile(noticePath, notices.replace("681357", "698425"))
    await assert.rejects(verify(), /notice disagrees/)
    await writeFile(noticePath, notices)
    const metadataPath = path.join(root, "package.json")
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"))
    metadata.repository.url = "https://github.com/somebody/another-repository.git"
    await writeFile(metadataPath, JSON.stringify(metadata))
    await assert.rejects(verify(), /repository metadata/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
