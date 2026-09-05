import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { Document } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"
import { createHostBackendFileSystem, PRIVATE_PROJECT_ERROR } from "../src/server/backend-files"
import { startMakerHost } from "../src/server/index"

test("Host project writes exclude private data, ancestors and aliases while sibling projects remain editable", async (t) => {
  // Exercise the real default Host allowlist, which is process.cwd(), without changing cwd for other tests.
  const root = await mkdtemp(join(process.cwd(), ".maker-path-test-"))
  const dataDir = join(root, "private")
  const projectDir = join(root, "private-sibling")
  const insideDir = join(dataDir, "generated")
  const alias = join(root, "alias")
  const document = new Document()
  document.getRoot().setProjectId("private-boundary")
  document.createPackage("Demo").setId("DEMO0001").addResource(document.createComponent("Before").setId("MAIN0001").setSize(40, 40))
  for (const directory of [root, dataDir, projectDir, insideDir]) {
    await mkdir(directory, { recursive: true })
    await new NodeIO().writeProject(document, join(directory, "Demo.fairy"))
  }
  const sentinel = join(dataDir, "sentinel.json")
  await writeFile(sentinel, "private-state")
  const host = await startMakerHost({ port: 0, dataDir })
  const client = new Client({ name: "private-path-test", version: "1" })
  let sessionId: string | undefined
  const call = async (method: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: `openfairygui_backend_${method}`, arguments: args })
    const backend = (result.structuredContent as { backendResult: any }).backendResult
    assert.ok(backend, JSON.stringify(result))
    return backend
  }
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${host.origin}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${host.token}` } } }))
    await symlink(insideDir, alias, process.platform === "win32" ? "junction" : "dir")
    for (const projectPath of [root, join(root, "Demo.fairy"), dataDir, insideDir, alias, join(alias, "Demo.fairy")]) {
      assert.equal((await call("open_session", { projectPath })).error.code, "project_open_failed", projectPath)
    }
    const state = await fetch(`${host.origin}/api/sessions`, { headers: { Authorization: `Bearer ${host.token}` } }).then((response) => response.json())
    assert.equal(state.projects.length, 0)
    assert.equal(state.activity[0].errorCode, "project_open_failed")
    assert.ok(!(await readdir(root)).some((name) => name.endsWith(".backend.lock")), "denied opens must not create locks")
    const opened = await call("open_session", { projectPath: projectDir })
    assert.equal(opened.ok, true)
    sessionId = opened.data.sessionId
    assert.equal((await call("apply_transaction", { sessionId, expectedRevision: 0, operations: [{ kind: "renameResource", selector: { packageId: "DEMO0001", resourceId: "MAIN0001" }, newName: "After" }] })).ok, true)
    const input = { sessionId, expectedRevision: 1 }
    const approval = (await call("save_session", input)).error.approval
    assert.ok(approval)
    assert.equal((await fetch(`${host.origin}/api/save-approvals/${approval.approvalRequestId}/decision`, {
      method: "POST", headers: { Authorization: `Bearer ${host.token}`, "x-maker-approval-token": host.approvalToken, "Content-Type": "application/json" }, body: '{"decision":"approve"}',
    })).status, 200)
    assert.equal((await call("save_session", input)).ok, true)
    assert.ok((await readFile(join(projectDir, "assets", "Demo", "After.xml"), "utf8")).includes("component"))

    const fs = await createHostBackendFileSystem(dataDir)
    let writes = 0
    const write = async () => { writes++ }
    for (const projectPath of [root, dataDir, insideDir, alias, join(alias, "new-project")]) {
      await assert.rejects(fs.runProjectWriteTransaction!(projectPath, write), { code: PRIVATE_PROJECT_ERROR })
    }
    await call("close_session", { sessionId }); sessionId = undefined
    await rename(projectDir, `${projectDir}-original`)
    await symlink(insideDir, projectDir, process.platform === "win32" ? "junction" : "dir")
    await assert.rejects(fs.runProjectWriteTransaction!(projectDir, write), { code: PRIVATE_PROJECT_ERROR }, "save must recheck a replaced ancestor")
    assert.equal(writes, 0)
    assert.equal(await readFile(sentinel, "utf8"), "private-state")
    await unlink(projectDir)
    await unlink(alias)
  } catch (error) {
    if (error instanceof Error && error.cause) t.diagnostic(`Host ${host.origin}: ${String(error.cause)}`)
    throw error
  } finally {
    if (sessionId) await call("close_session", { sessionId })
    await client.close(); await host.close(); await rm(root, { recursive: true, force: true })
  }
})
