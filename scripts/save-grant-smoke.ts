import assert from "node:assert/strict"
import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Document } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"
import type { BrowserContext } from "playwright"

export async function saveGrantSmoke(context: BrowserContext, host: { origin: string; token: string; approvalToken: string }, root: string) {
  const projectRoot = path.join(root, "save-grant-project")
  await mkdir(projectRoot)
  const document = new Document()
  document.getRoot().setProjectId("browser-save-grant")
  document.createPackage("SaveGrant").setId("SAVE0001").addResource(document.createComponent("Main").setId("MAIN0001").setSize(200, 100)
    .addChild(document.createGTextField("label").setId("TEXT0001").setSize(200, 40).setText("Before approval")))
  await new NodeIO().writeProject(document, path.join(projectRoot, "Demo.fairy"))
  const xmlPath = path.join(projectRoot, "assets", "SaveGrant", "Main.xml")
  const before = await readFile(xmlPath, "utf8")
  const client = new Client({ name: "save-grant-browser", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(`${host.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${host.token}` } } })
  const call = async (method: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: `openfairygui_backend_${method}`, arguments: args })
    const backend = (result.structuredContent as { backendResult?: any } | undefined)?.backendResult
    assert.ok(backend, JSON.stringify(result))
    return backend
  }
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  let sessionId = ""
  try {
    await client.connect(transport)
    const opened = await call("open_session", { projectPath: projectRoot })
    assert.ok(opened.ok, JSON.stringify(opened))
    sessionId = opened.data.sessionId
    const edited = await call("apply_transaction", { sessionId, expectedRevision: 0, operations: [{ kind: "setDisplayNodeProps", selector: { packageId: "SAVE0001", componentResourceId: "MAIN0001", displayNodeId: "TEXT0001" }, props: { text: "Saved after approval" } }] })
    assert.ok(edited.ok, JSON.stringify(edited))
    const input = { sessionId, expectedRevision: edited.data.revision }
    const pending = await call("save_session", input)
    assert.equal(pending.error.code, "save_approval_required")
    assert.equal(await readFile(xmlPath, "utf8"), before)
    const id = pending.error.approval.approvalRequestId
    await page.goto(`${host.origin}/#save-approvals`, { waitUntil: "domcontentloaded" })
    const row = page.getByTestId(`save-approval-${id}`)
    await row.getByText("待确认", { exact: true }).waitFor()
    assert.ok((await row.innerText()).includes(projectRoot))
    const key = page.getByLabel("Host 所有者确认密钥", { exact: true })
    const act = async (button: string, token: string, requestRow = row) => {
      await key.fill(token)
      const response = page.waitForResponse((response) => response.url().endsWith("/decision") && response.request().method() === "POST")
      await requestRow.getByRole("button", { name: button, exact: true }).click()
      const result = await response
      assert.equal(await key.inputValue(), "", "owner token must not be retained in the input")
      return result
    }
    assert.equal((await act("批准一次保存", host.token)).status(), 403)
    await page.getByRole("alert").filter({ hasText: "Host owner approval token required" }).waitFor()
    assert.equal((await act("批准一次保存", host.approvalToken)).status(), 200)
    await row.getByText("已授权 · 待执行", { exact: true }).waitFor()
    assert.equal(await readFile(xmlPath, "utf8"), before)
    await page.reload({ waitUntil: "domcontentloaded" })
    await row.getByText("已授权 · 待执行", { exact: true }).waitFor()
    assert.equal(await key.inputValue(), "")
    assert.ok((await call("save_session", input)).ok)
    assert.match(await readFile(xmlPath, "utf8"), /Saved after approval/)
    await row.getByText("已消耗", { exact: true }).waitFor()
    const retried = await call("save_session", input)
    assert.equal(retried.error.code, "save_approval_required")
    const retryRow = page.getByTestId(`save-approval-${retried.error.approval.approvalRequestId}`)
    await retryRow.getByText("待确认", { exact: true }).waitFor()
    assert.equal((await act("批准一次保存", host.approvalToken, retryRow)).status(), 200)
    await retryRow.getByText("已授权 · 待执行", { exact: true }).waitFor()
    assert.equal((await act("撤销授权", host.approvalToken, retryRow)).status(), 200)
    await retryRow.getByText("已撤销", { exact: true }).waitFor()
    const rejected = await call("save_session", input)
    assert.equal(rejected.error.code, "save_approval_required")
    const rejectRow = page.getByTestId(`save-approval-${rejected.error.approval.approvalRequestId}`)
    await rejectRow.getByText("待确认", { exact: true }).waitFor()
    assert.equal((await act("拒绝", host.approvalToken, rejectRow)).status(), 200)
    await rejectRow.getByText("已拒绝", { exact: true }).waitFor()
    assert.deepEqual(errors, [])
    return { ownerConfirmation: true, noWriteBeforeApproval: true, realDiskSave: true, singleUse: true, reload: true, revoke: true, reject: true }
  } finally {
    if (sessionId) await call("close_session", { sessionId }).catch(() => undefined)
    await transport.terminateSession().catch(() => undefined)
    await client.close()
    await page.close()
  }
}
