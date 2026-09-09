import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { Document } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"
import type { BrowserContext } from "playwright"

export async function saveGrantSmoke(context: BrowserContext, host: { origin: string; token: string; approvalToken: string }, root: string, evidence: string) {
  const projectRoot = path.join(root, "save-grant-project")
  await mkdir(projectRoot)
  const document = new Document()
  document.getRoot().setProjectId("browser-save-grant")
  document.createPackage("SaveGrant").setId("SAVE0001").addResource(document.createComponent("Main").setId("MAIN0001").setSize(200, 100)
    .addChild(document.createGTextField("label").setId("TEXT0001").setSize(200, 40).setColor("#eeeeee").setText("Before approval")))
  await new NodeIO().writeProject(document, path.join(projectRoot, "Demo.fairy"))
  const xmlPath = path.join(projectRoot, "assets", "SaveGrant", "Main.xml")
  const before = await readFile(xmlPath, "utf8")
  const client = new Client({ name: "save-grant-browser", version: "1" })
  const transport = new StreamableHTTPClientTransport(new URL(`${host.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${host.token}` } } })
  const toolValue = (result: CallToolResult) => {
    const text = result.content.find((content) => content.type === "text")
    return (result.structuredContent ?? (text?.type === "text" ? JSON.parse(text.text) : undefined)) as any
  }
  const call = async (method: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: `openfairygui_backend_${method}`, arguments: args })
    const backend = (result.structuredContent as { backendResult?: any } | undefined)?.backendResult
    assert.ok(backend, JSON.stringify(result))
    return backend
  }
  const page = await context.newPage()
  const previewPage = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  previewPage.on("pageerror", (error) => errors.push(error.message))
  let sessionId = ""
  try {
    await client.connect(transport)
    const opened = await call("open_session", { projectPath: projectRoot })
    assert.ok(opened.ok, JSON.stringify(opened))
    sessionId = opened.data.sessionId
    const edited = await call("apply_transaction", { sessionId, expectedRevision: 0, operations: [{ kind: "setDisplayNodeProps", selector: { packageId: "SAVE0001", componentResourceId: "MAIN0001", displayNodeId: "TEXT0001" }, props: { text: "Saved after approval" } }] })
    assert.ok(edited.ok, JSON.stringify(edited))
    const input = { sessionId, expectedRevision: edited.data.revision }
    const preview = (await client.callTool({ name: "open_session_preview", arguments: input })).structuredContent as any
    assert.equal(preview.ok, true, JSON.stringify(preview))
    const register = () => previewPage.waitForResponse((response) => response.url() === `${host.origin}/api/renderers` && response.status() === 201).then(async (response) => (await response.json()).session)
    const registration = register()
    await previewPage.goto(`${preview.project.viewerUrl}?token=${host.token}`)
    const firstRenderer = await registration
    await previewPage.getByText("AGENT READY", { exact: true }).waitFor()
    await previewPage.getByText("会话 revision 1 · 未保存", { exact: false }).waitFor()
    const render = async (sourceRevision: string, filename: string) => {
      const result = await client.callTool({ name: "render_component_preview", arguments: {
        projectId: preview.project.projectId, packageId: "SAVE0001", componentId: "MAIN0001", requestId: randomUUID(),
      } }) as CallToolResult
      assert.ok(!result.isError, JSON.stringify(result))
      const rendered = toolValue(result)
      assert.equal(rendered.sourceRevision, sourceRevision)
      const observed = await client.callTool({ name: "get_render_observation", arguments: {
        renderSessionId: rendered.renderSessionId, requestId: randomUUID(), afterStateVersion: rendered.semanticStateVersion,
      } })
      assert.ok(!observed.isError, JSON.stringify(observed))
      assert.match(JSON.stringify(toolValue(observed as CallToolResult)), /Saved after approval/)
      const image = result.content.find((content) => content.type === "image")
      assert.ok(image?.type === "image")
      await writeFile(path.join(evidence, filename), Buffer.from(image.data, "base64"))
    }
    await render(firstRenderer.sourceRevision, "save-preview-dirty.png")
    const pending = await call("save_session", input)
    assert.equal(pending.error.code, "save_approval_required")
    assert.equal(await readFile(xmlPath, "utf8"), before)
    const id = pending.error.approval.approvalRequestId
    await page.goto(`${host.origin}/#save-approvals`, { waitUntil: "domcontentloaded" })
    const row = page.getByTestId(`save-approval-${id}`)
    await row.getByText("待确认", { exact: true }).waitFor()
    assert.ok((await row.innerText()).includes(projectRoot))
    const key = page.getByLabel("Host 所有者确认密钥", { exact: true })
    const unlock = async (token: string) => {
      await key.fill(token)
      const response = page.waitForResponse((response) => response.url().endsWith("/owner-session") && response.request().method() === "POST")
      await page.getByRole("button", { name: "验证所有者", exact: true }).click()
      return response
    }
    const act = async (button: string, requestRow = row) => {
      const response = page.waitForResponse((response) => response.url().endsWith("/decision") && response.request().method() === "POST")
      await requestRow.getByRole("button", { name: button, exact: true }).click()
      return response
    }
    assert.equal((await unlock(host.token)).status(), 403)
    await page.getByRole("alert").filter({ hasText: "Host owner approval token required" }).waitFor()
    assert.equal(await key.inputValue(), "")
    assert.equal((await unlock(host.approvalToken)).status(), 200)
    await page.getByText("所有者已验证", { exact: true }).waitFor()
    assert.equal(await key.count(), 0, "the owner key input is removed after verification")
    const ownerCookie = (await context.cookies()).find(cookie => cookie.name === "fairygui_maker_owner")
    assert.equal(ownerCookie?.httpOnly, true)
    assert.equal(ownerCookie?.sameSite, "Strict")
    assert.equal(await page.evaluate(() => globalThis.document.cookie.includes("fairygui_maker_owner")), false)
    assert.equal((await act("批准一次保存")).status(), 200)
    await row.getByText("已授权 · 待执行", { exact: true }).waitFor()
    assert.equal(await readFile(xmlPath, "utf8"), before)
    await page.reload({ waitUntil: "domcontentloaded" })
    await row.getByText("已授权 · 待执行", { exact: true }).waitFor()
    await page.getByText("所有者已验证", { exact: true }).waitFor()
    assert.equal(await key.count(), 0)
    assert.ok((await call("save_session", input)).ok)
    assert.match(await readFile(xmlPath, "utf8"), /Saved after approval/)
    await previewPage.getByText("Viewer 已停止", { exact: true }).waitFor()
    assert.equal((await previewPage.request.get(`${host.origin}/api/render-sessions/${firstRenderer.renderSessionId}`)).status(), 404)
    const refreshed = register()
    await previewPage.getByRole("button", { name: "刷新工程", exact: true }).click()
    const savedRenderer = await refreshed
    assert.notEqual(savedRenderer.sourceRevision, firstRenderer.sourceRevision)
    await previewPage.getByText("AGENT READY", { exact: true }).waitFor()
    await previewPage.getByText("会话 revision 1 · 已保存", { exact: false }).waitFor()
    await render(savedRenderer.sourceRevision, "save-preview-clean.png")
    await previewPage.screenshot({ path: path.join(evidence, "save-preview-workbench.png"), fullPage: true })
    await row.getByText("已消耗", { exact: true }).waitFor()
    const retried = await call("save_session", input)
    assert.equal(retried.error.code, "save_approval_required")
    const retryRow = page.getByTestId(`save-approval-${retried.error.approval.approvalRequestId}`)
    await retryRow.getByText("待确认", { exact: true }).waitFor()
    assert.equal((await act("批准一次保存", retryRow)).status(), 200)
    await retryRow.getByText("已授权 · 待执行", { exact: true }).waitFor()
    assert.equal((await act("撤销授权", retryRow)).status(), 200)
    await retryRow.getByText("已撤销", { exact: true }).waitFor()
    const rejected = await call("save_session", input)
    assert.equal(rejected.error.code, "save_approval_required")
    const rejectRow = page.getByTestId(`save-approval-${rejected.error.approval.approvalRequestId}`)
    await rejectRow.getByText("待确认", { exact: true }).waitFor()
    assert.equal((await act("拒绝", rejectRow)).status(), 200)
    await rejectRow.getByText("已拒绝", { exact: true }).waitFor()

    const continuous = await call("save_session", input)
    assert.equal(continuous.error.code, "save_approval_required")
    const continuousRow = page.getByTestId(`save-approval-${continuous.error.approval.approvalRequestId}`)
    await continuousRow.getByText("待确认", { exact: true }).waitFor()
    assert.equal((await act("允许本次会话连续保存", continuousRow)).status(), 200)
    await continuousRow.getByText("本次会话允许普通保存", { exact: true }).waitFor()
    let revision = input.expectedRevision
    for (const text of ["Saved with session permission", "Saved again with session permission"]) {
      const edit = await call("apply_transaction", { sessionId, expectedRevision: revision, operations: [{ kind: "setDisplayNodeProps", selector: {
        packageId: "SAVE0001", componentResourceId: "MAIN0001", displayNodeId: "TEXT0001",
      }, props: { text } }] })
      assert.ok(edit.ok, JSON.stringify(edit))
      revision = edit.data.revision
      const saved = await call("save_session", { sessionId, expectedRevision: revision })
      assert.ok(saved.ok, JSON.stringify(saved))
      assert.ok((await readFile(xmlPath, "utf8")).includes(text))
    }
    await page.reload({ waitUntil: "domcontentloaded" })
    await continuousRow.getByText("本次会话允许普通保存", { exact: true }).waitFor()
    await page.getByText("所有者已验证", { exact: true }).waitFor()
    await continuousRow.scrollIntoViewIfNeeded()
    await page.locator("#save-approvals").screenshot({ path: path.join(evidence, "session-save-permission.png") })
    const forced = await call("save_session", { sessionId, expectedRevision: revision, force: true })
    assert.equal(forced.error.code, "save_approval_required")
    const forcedRow = page.getByTestId(`save-approval-${forced.error.approval.approvalRequestId}`)
    await forcedRow.getByText("待确认", { exact: true }).waitFor()
    assert.equal(await forcedRow.getByRole("button", { name: "允许本次会话连续保存", exact: true }).count(), 0)
    assert.equal((await act("撤销授权", continuousRow)).status(), 200)
    const revoked = await call("save_session", { sessionId, expectedRevision: revision })
    assert.equal(revoked.error.code, "save_approval_required")
    const revokedRow = page.getByTestId(`save-approval-${revoked.error.approval.approvalRequestId}`)
    await revokedRow.getByText("待确认", { exact: true }).waitFor()
    assert.equal((await act("允许本次会话连续保存", revokedRow)).status(), 200)
    await previewPage.close()
    assert.ok((await call("close_session", { sessionId })).ok)
    sessionId = ""
    const reopened = await call("open_session", { projectPath: projectRoot })
    assert.ok(reopened.ok, JSON.stringify(reopened))
    sessionId = reopened.data.sessionId
    assert.equal(reopened.data.dirty, false)
    const readback = await call("query_entity", { sessionId, target: {
      kind: "displayNode", selector: { packageId: "SAVE0001", componentResourceId: "MAIN0001", displayNodeId: "TEXT0001" },
    } })
    assert.ok(readback.ok, JSON.stringify(readback))
    assert.equal(readback.data.revision, reopened.data.revision)
    assert.equal(readback.data.entity.properties.text, "Saved again with session permission")
    const afterReopen = await call("save_session", { sessionId, expectedRevision: reopened.data.revision })
    assert.equal(afterReopen.error.code, "save_approval_required", "reopening does not inherit permission")
    const locked = page.waitForResponse(response => response.url().endsWith("/owner-session") && response.request().method() === "DELETE")
    await page.getByRole("button", { name: "锁定授权管理", exact: true }).click()
    assert.equal((await locked).status(), 200)
    await key.waitFor()
    assert.equal(await key.inputValue(), "")
    const reopenedRow = page.getByTestId(`save-approval-${afterReopen.error.approval.approvalRequestId}`)
    await reopenedRow.getByText("待确认", { exact: true }).waitFor()
    assert.equal(await reopenedRow.getByRole("button", { name: "允许本次会话连续保存", exact: true }).isEnabled(), false)
    assert.equal((await context.cookies()).some(cookie => cookie.name === "fairygui_maker_owner"), false)
    assert.deepEqual(errors, [])
    return { ownerConfirmation: true, ownerCookie: true, ownerLock: true, sessionPermission: true, repeatedDiskSaves: true, forceStillRequiresApproval: true,
      noWriteBeforeApproval: true, realDiskSave: true, singleUse: true, reload: true, revoke: true, reject: true, reopenReadback: true, saveInvalidatesPreview: true }
  } finally {
    if (sessionId) await call("close_session", { sessionId }).catch(() => undefined)
    await transport.terminateSession().catch(() => undefined)
    await client.close()
    await page.close()
    await previewPage.close()
  }
}
