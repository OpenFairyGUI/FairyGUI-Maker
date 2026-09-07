import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { BrowserContext, Page } from "playwright"

/** Real OPFS handles/IndexedDB + real Workbench/Host/runtime; only the native picker result is injected. */
export async function projectRevisionSmoke(context: BrowserContext, origin: string, evidenceDirectory: string) {
  const page = await context.newPage(), assets = await context.newPage()
  const errors: string[] = []
  for (const target of [page, assets]) target.on("pageerror", (error) => errors.push(error.message))
  const component = (text: string) => `<component size="200,80"><displayList><text id="TITLE001" name="title" xy="0,0" size="180,50" fontSize="24" text="${text}" /></displayList></component>`
  const files = {
    "Demo.fairy": '<projectDescription id="browser-revision" type="Layabox" version="5.0" />',
    "assets/Demo/package.xml": '<packageDescription id="REV00001"><resources><component id="MAIN0001" name="Main.xml" path="/" exported="true" /><component id="DEAD0001" name="ZZ_DeadA.xml" path="/" /><component id="DEAD0002" name="ZZ_DeadB.xml" path="/" /></resources></packageDescription>',
    "assets/Demo/Main.xml": component("Before"),
    "assets/Demo/ZZ_DeadA.xml": '<component size="200,80"><displayList><component id="child" name="child" src="DEAD0002" /><text id="bad" name="badFont" font="ui://abc" text="Bad" /><text id="bad2" name="badFont2" font="ui://short" text="Bad" /></displayList></component>',
    "assets/Demo/ZZ_DeadB.xml": '<component size="200,80"><displayList><component id="child" name="child" src="DEAD0001" /></displayList></component>',
    ".env": "secret", "assets/Demo/deployment.json": "secret", "build/Unused.fairy": "ignored",
  }
  await page.addInitScript(`(() => {
    window.snapshotReads = [];
    const getFile = FileSystemFileHandle.prototype.getFile;
    FileSystemFileHandle.prototype.getFile = async function() {
      window.snapshotReads.push(this.name);
      if (window.pauseNextRead) { window.pauseNextRead = false; await new Promise(resolve => { window.releaseRead = resolve; }); }
      return getFile.call(this);
    };
  })()`)
  const ready = (target: Page) => target.getByText("AGENT READY", { exact: true }).waitFor()
  const registered = () => page.waitForResponse((r) => r.url() === `${origin}/api/renderers` && r.request().method() === "POST" && r.status() === 201).then(async (r) => (await r.json()).session)
  const change = (text: string) => page.evaluate(`(async () => {
    let dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("revision-smoke");
    dir = await (await dir.getDirectoryHandle("assets")).getDirectoryHandle("Demo");
    const writer = await (await dir.getFileHandle("Main.xml")).createWritable(); await writer.write(${JSON.stringify(component(text))}); await writer.close();
  })()`)
  try {
    await page.goto(origin)
    await page.evaluate(`(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("revision-smoke", {create:true});
      for (const [path, content] of Object.entries(${JSON.stringify(files)})) {
        const parts = path.split("/"); const name = parts.pop(); let dir = root;
        for (const part of parts) dir = await dir.getDirectoryHandle(part, {create:true});
        const writer = await (await dir.getFileHandle(name, {create:true})).createWritable(); await writer.write(content); await writer.close();
      }
      Object.defineProperty(window, "showDirectoryPicker", {configurable:true, value:async () => root});
    })()`)
    const creation = page.waitForResponse((r) => r.url() === `${origin}/api/projects` && r.request().method() === "POST")
    await page.getByRole("button", { name: "授权并创建项目", exact: true }).click()
    const created = await creation
    assert.equal(created.status(), 201, await created.text())
    const { project } = await created.json()
    const source = `/api/projects/${project.projectId}`
    const readProject = async () => (await (await page.request.get(`${origin}${source}`)).json()).project
    const firstRegistration = registered()
    await page.goto(project.viewerUrl)
    const first = await firstRegistration
    await ready(page)
    const observe = async (id: string) => {
      const result = await page.request.post(`${origin}/api/render-sessions/${id}/commands`, { data: { kind: "observe", requestId: randomUUID(), afterStateVersion: 0, afterViewStateVersion: 0 } })
      assert.equal(result.status(), 200, await result.text())
      return (await result.json()).result
    }
    assert.match(JSON.stringify(await observe(first.renderSessionId)), /Before/)
    assert.equal((await readProject()).revision, 1)
    await change("After!")
    const refreshResponse = page.waitForResponse((r) => r.url() === `${origin}${source}/refresh` && r.request().method() === "POST")
    const secondRegistration = registered()
    await page.getByRole("button", { name: "刷新工程", exact: true }).click()
    assert.equal((await refreshResponse).status(), 200)
    const second = await secondRegistration
    await ready(page)
    assert.notEqual(second.sourceRevision, first.sourceRevision)
    assert.match(JSON.stringify(await observe(second.renderSessionId)), /After!/)
    assert.equal((await readProject()).revision, 2)
    assert.equal((await page.request.get(`${origin}/api/render-sessions/${first.renderSessionId}`)).status(), 404)

    // Asset Manager shares the exact refresh operation and invalidates an already-open Viewer.
    await assets.goto(project.assetManagerUrl)
    await ready(assets)
    await assets.getByRole("note").filter({ hasText: "browser / advisory" }).waitFor()
    await assets.getByText("无法解析 Fairy URL ui://abc", { exact: true }).waitFor()
    await assets.getByText("Demo: 2 个不可达私有组件", { exact: true }).waitFor()
    const health = assets.getByRole("combobox", { name: "筛选资源健康状态" })
    await health.selectOption("unreachable")
    assert.equal(await assets.getByRole("listbox", { name: "FairyGUI 资源" }).getByRole("option").count(), 2)
    await assets.getByRole("region", { name: "资源详情" }).getByRole("heading", { name: "ZZ_DeadA" }).waitFor()
    await health.selectOption("invalid-url")
    const resourceOptions = assets.getByRole("listbox", { name: "FairyGUI 资源" }).getByRole("option")
    assert.equal(await resourceOptions.count(), 1)
    await resourceOptions.filter({ hasText: "ZZ_DeadA" }).waitFor()
    assert.equal(await assets.getByRole("region", { name: "资源详情" }).getByText("无法解析 URL", { exact: true }).count(), 1, "Repeated diagnostics must not multiply detail badges")
    await assets.screenshot({ path: path.join(evidenceDirectory, "asset-manager-diagnostics.png"), fullPage: true })
    await assets.reload()
    await ready(assets)
    await assets.getByRole("note").filter({ hasText: "browser / advisory" }).waitFor()
    await assets.getByText("Demo: 2 个不可达私有组件", { exact: true }).waitFor()
    await change("Third!")
    const analysis = assets.waitForResponse((r) => r.url().endsWith(`${source}/asset-analysis`) && r.request().method() === "PUT")
    await assets.getByRole("button", { name: "重新扫描", exact: true }).click()
    const registeredAnalysis = await analysis
    assert.equal(registeredAnalysis.status(), 200)
    const snapshot = (await registeredAnalysis.json()).analysis
    assert.equal(snapshot.analysisOwner, "browser")
    assert.equal(snapshot.trust, "advisory")
    assert.equal(snapshot.issues.filter((issue: { kind: string }) => issue.kind === "invalid-url").length, 2)
    assert.deepEqual(snapshot.issues.find((issue: { kind: string }) => issue.kind === "unreachable").resourceKeys.sort(), ["REV00001/DEAD0001", "REV00001/DEAD0002"])
    await page.getByText("Viewer 已停止", { exact: true }).waitFor()
    assert.equal((await readProject()).revision, 3)
    const thirdRegistration = registered()
    await page.getByRole("button", { name: "刷新工程", exact: true }).click()
    const third = await thirdRegistration
    await ready(page)
    assert.match(JSON.stringify(await observe(third.renderSessionId)), /Third!/)
    assert.equal((await readProject()).revision, 3)

    // Abort an actual pending file read. No late refresh is permitted when its bytes arrive.
    await change("Fourth")
    await page.evaluate("window.pauseNextRead = true")
    await page.getByRole("button", { name: "刷新工程", exact: true }).click()
    await page.waitForFunction(() => typeof (window as unknown as { releaseRead?: () => void }).releaseRead === "function")
    await page.getByRole("button", { name: "取消扫描", exact: true }).click()
    await page.evaluate("window.releaseRead()")
    await page.getByText("扫描已取消，请点击“刷新工程”重新读取。", { exact: true }).waitFor()
    assert.equal((await readProject()).revision, 3)
    const resumedRegistration = registered()
    await page.getByRole("button", { name: "刷新工程", exact: true }).click()
    await resumedRegistration
    await ready(page)
    assert.equal((await readProject()).revision, 4)
    const reads = await page.evaluate<string[]>("window.snapshotReads")
    assert.ok(reads.length > 0)
    assert.ok(reads.every((file) => ["Demo.fairy", "Main.xml", "ZZ_DeadA.xml", "ZZ_DeadB.xml", "package.xml"].includes(file)), JSON.stringify(reads))

    await page.goto(origin)
    page.once("dialog", (dialog) => dialog.accept())
    const removed = page.waitForResponse((r) => r.url().includes(source) && r.request().method() === "DELETE")
    await page.getByRole("button", { name: "移除项目", exact: true }).last().click()
    assert.equal((await removed).status(), 200)
    await page.waitForFunction(async (bindingId) => {
      const db = await new Promise<IDBDatabase>((resolve,reject) => { const r=indexedDB.open("fairygui-maker",1); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); })
      try { return await new Promise<boolean>(resolve => { const r=db.transaction("project-bindings").objectStore("project-bindings").get(bindingId); r.onsuccess=()=>resolve(!r.result); }) } finally { db.close() }
    }, project.bindingId)
    assert.equal((await page.request.get(`${origin}${source}`)).status(), 404)
    const remaining = await page.evaluate(`(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("revision-smoke");
      return await (await (await root.getFileHandle(".env")).getFile()).text();
    })()`)
    assert.equal(remaining, "secret")

    await page.evaluate(`(async () => {
      const db = await new Promise(resolve => { const r=indexedDB.open("fairygui-maker",1); r.onsuccess=()=>resolve(r.result); });
      await new Promise((resolve,reject) => { const tx=db.transaction("project-bindings","readwrite"), store=tx.objectStore("project-bindings");
        store.put({bindingId:"legacy"}); store.put({bindingId:"recent",savedAt:Date.now()}); store.put({bindingId:"expired",savedAt:1});
        tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error);
      }); db.close();
    })()`)
    page.once("dialog", (dialog) => dialog.accept())
    await page.getByRole("button", { name: "清理失效授权", exact: true }).click()
    await page.getByText("已清理 2 条未注册授权。", { exact: true }).waitFor()
    assert.equal(errors.length, 0, errors.join("; "))
    return { contentRefresh: true, assetManagerRefresh: true, assetDiagnostics: true, advisory: true, assetFilters: true, assetReload: true, abort: true, bindingCleanup: true, sourcePreserved: true }
  } finally { await page.close(); await assets.close() }
}
