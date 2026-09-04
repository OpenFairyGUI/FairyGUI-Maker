import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Document } from "@openfairygui/core"
import { createHash } from "node:crypto"
import { NodeIO } from "@openfairygui/core/node"

import { startMakerHost } from "../src/server/index"

const token = "player-browser-smoke-token-123456"
const dataDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-browser-data-"))
const publishDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-browser-publish-"))
const binaryPath = path.join(publishDir, "Smoke.fui")
const document = new Document()
const pkg = document.createPackage("Smoke").setId("SMOKE001")
const component = document.createComponent("Main").setId("MAIN0001").setExported(true).setSize(520, 300)
const background = document.createGGraph("background").setId("BACK0001").setXY(0, 0).setSize(520, 300).setGraphType(1).setFillColor("#172554").setLineColor("#3b82f6").setLineSize(3).setCornerRadius([18, 18, 18, 18])
const title = document.createGTextField("title").setId("TITLE001").setXY(42, 58).setSize(440, 64).setFontSize(32).setColor("#dbeafe").setText("FairyGUI Player")
const subtitle = document.createGTextField("subtitle").setId("SUBT0001").setXY(42, 132).setSize(440, 48).setFontSize(18).setColor("#93c5fd").setText("Native UIPackage · compressed .fui")
component.addChild(background).addChild(title).addChild(subtitle)
pkg.addResource(component)
await new NodeIO().writeBinary(document, binaryPath, { compressed: true })

const host = await startMakerHost({ port: 0, token, dataDir })
const binary = await readFile(binaryPath)
const headers = { Authorization: `Bearer ${token}` }
const created = await fetch(`${host.origin}/api/artifact-imports`, {
  method: "POST",
  headers: { ...headers, "Content-Type": "application/json" },
  body: JSON.stringify({ name: "Player browser smoke", source: { kind: "published-folder" }, files: [{ path: "Smoke.fui", size: binary.byteLength, sha256: createHash("sha256").update(binary).digest("hex") }] }),
})
if (!created.ok) throw new Error(await created.text())
const { importId } = await created.json() as { importId: string }
const uploaded = await fetch(`${host.origin}/api/artifact-imports/${importId}/files?path=Smoke.fui`, { method: "PUT", headers, body: binary })
if (!uploaded.ok) throw new Error(await uploaded.text())
const completed = await fetch(`${host.origin}/api/artifact-imports/${importId}/complete`, { method: "POST", headers })
if (!completed.ok) throw new Error(await completed.text())
const { artifact } = await completed.json() as { artifact: { artifactId: string } }
process.stdout.write(`PLAYER_URL=${host.origin}/artifacts/${artifact.artifactId}/player?token=${token}\n`)

let closing = false
const close = async () => {
  if (closing) return
  closing = true
  await host.close()
  await rm(dataDir, { recursive: true, force: true })
  await rm(publishDir, { recursive: true, force: true })
  process.exit(0)
}
process.once("SIGINT", () => void close())
process.once("SIGTERM", () => void close())
await new Promise(() => undefined)
