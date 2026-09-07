import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { mock } from "node:test"
import type { BrowserContext } from "playwright"
import { ImportDraftStore, type ImportDraftV1 } from "../src/design-import/draft-store"
import { digestReimportPath } from "../src/design-import/node"
import type { createBrowserEvidence } from "./browser-evidence"

export async function importRecoverySmoke(context: BrowserContext, origin: string, evidence: Awaited<ReturnType<typeof createBrowserEvidence>>) {
  const root = await mkdtemp(path.join(tmpdir(), "maker-import-recovery-browser-"))
  const outputDirectory = path.join(root, "output")
  const page = await context.newPage()
  const create = await context.request.post(`${origin}/api/import-drafts`, { data: { sourcePath: path.resolve("test/fixtures/design-import/basic-shapes.fig") } })
  assert.equal(create.status(), 201)
  let draft: ImportDraftV1 = (await create.json()).draft
  const endpoint = `${origin}/api/import-drafts/${draft.draftId}`
  let fault: ReturnType<typeof mock.method> | undefined
  try {
    for (const step of ["parse", "plan", "compile"]) {
      const response = await context.request.post(`${endpoint}/${step}`, { data: { expectedRevision: draft.revision } })
      assert.equal(response.status(), 200, await response.text())
      draft = (await response.json()).draft
    }
    const originalUpdate = (ImportDraftStore.prototype as any).update
    fault = mock.method(ImportDraftStore.prototype as any, "update", function (this: ImportDraftStore, current: ImportDraftV1, status: string, patch: unknown) {
      if (current.draftId === draft.draftId && status === "materialized") throw new Error("injected materialize metadata failure")
      return originalUpdate.call(this, current, status, patch)
    })
    await page.goto(`${origin}/imports/${draft.draftId}`)
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    await page.getByLabel("Maker Host 本机绝对路径").fill(outputDirectory)
    const failed = page.waitForResponse((response) => response.url() === `${endpoint}/materialize` && response.status() === 409)
    await page.getByRole("button", { name: "Materialize", exact: true }).click()
    const failure = await (await failed).json()
    assert.equal(failure.code, "materialize_recovery_required")
    assert.equal(failure.committed, true)
    assert.equal(failure.outputDirectory, outputDirectory)
    await page.getByRole("button", { name: "核对并完成上次物化", exact: true }).waitFor()
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    const committedDigest = await digestReimportPath(outputDirectory)
    fault?.mock.restore()
    await page.reload()
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    await page.getByRole("button", { name: "核对并完成上次物化", exact: true }).click()
    await page.getByText("已写入", { exact: false }).waitFor()
    await page.getByText("AGENT READY", { exact: true }).waitFor()
    assert.equal(await digestReimportPath(outputDirectory), committedDigest)
    const detail = await (await context.request.get(endpoint)).json()
    assert.equal(detail.draft.status, "materialized")
    assert.equal(detail.materializeAttempt, null)
    await page.screenshot({ path: path.join(evidence.directory, "materialize-recovered.png") })
    return { committedError: true, reloadRecovery: true, unchangedTarget: true }
  } finally {
    fault?.mock.restore()
    await page.close()
    const detail = await (await context.request.get(endpoint)).json()
    await context.request.delete(`${endpoint}?expectedRevision=${detail.draft.revision}`)
    await rm(root, { recursive: true, force: true })
  }
}
