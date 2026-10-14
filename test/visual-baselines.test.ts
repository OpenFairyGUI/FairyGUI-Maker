import assert from "node:assert/strict"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import sharp from "sharp"

import { VisualBaselineStore, type VisualEnvironment } from "../src/server/visual-baselines"

const environment: VisualEnvironment = {
  runtimeProfile: "layaair-3.3.10/fairygui",
  mode: "player",
  userAgent: "test-agent",
  view: { zoom: 1, background: "#202226", width: 320, height: 200 },
  image: { width: 4, height: 4 },
}
const png = (color: { r: number; g: number; b: number }) => sharp({ create: { width: 4, height: 4, channels: 4, background: { ...color, alpha: 1 } } }).png().toBuffer()

test("visual baselines are named safely, replaced only explicitly, keep bounded history and survive restarts", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "maker-visual-baselines-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const store = new VisualBaselineStore(dataDir)
  await store.init()
  const red = await png({ r: 255, g: 0, b: 0 })
  const save = (replace: boolean, reason: string | null, image = red) => store.save({ suite: "hud", key: "reward/claimable", png: image, environment, source: { artifactId: "artifact_x" }, replace, reason })

  const first = await save(false, null)
  assert.equal(first.ok, true)
  assert.equal(first.ok && first.baseline.revision, 1)
  const duplicate = await save(false, null)
  assert.equal(duplicate.ok, false)
  assert.equal(!duplicate.ok && duplicate.code, "visual_baseline_exists")
  assert.deepEqual(await store.readImage("hud", "reward/claimable"), red)

  for (let revision = 2; revision <= 8; revision += 1) {
    const replaced = await save(true, `accepted change ${revision}`, await png({ r: revision * 20, g: 0, b: 0 }))
    assert.equal(replaced.ok && replaced.baseline.revision, revision)
    assert.equal(replaced.ok && replaced.replaced, revision - 1)
  }
  const history = (await readdir(path.join(dataDir, "visual-baselines", "hud", "reward", "claimable", "history"))).filter((name) => name.endsWith(".json")).sort()
  assert.deepEqual(history, ["3.json", "4.json", "5.json", "6.json", "7.json"], "only the newest five superseded revisions are kept")

  await store.recordComparison("hud", "reward/claimable", {
    comparedAt: new Date().toISOString(), baselineRevision: 8, identical: false, withinTolerance: false, environmentDifferences: ["userAgent"],
    metrics: { width: 4, height: 4, totalPixels: 16, differentPixels: 16, meanAbsoluteError: 10, maxChannelDelta: 40 },
  }, red)
  await save(false, null).then((result) => assert.equal(result.ok, false))
  await store.save({ suite: "hud", key: "title", png: red, environment, source: {}, replace: false, reason: null })
  await store.save({ suite: "menu", key: "main", png: red, environment, source: {}, replace: false, reason: null })

  const reopened = new VisualBaselineStore(dataDir)
  await reopened.init()
  const all = await reopened.list()
  assert.deepEqual(all.map(({ suite, key }) => `${suite}/${key}`), ["hud/reward/claimable", "hud/title", "menu/main"])
  assert.equal(all[0].revision, 8)
  assert.equal(all[0].reason, "accepted change 8")
  assert.deepEqual(all[0].lastComparison?.environmentDifferences, ["userAgent"])
  assert.deepEqual((await reopened.list("menu")).map(({ key }) => key), ["main"])

  for (const [suite, key] of [["..", "x"], ["hud", "../escape"], ["hud", "a/b/c/d/e"], ["hud", ".hidden"], ["", "x"], ["hud", "a b"]]) {
    await assert.rejects(store.save({ suite, key, png: red, environment, source: {}, replace: false, reason: null }), /suite|key/)
  }
})
