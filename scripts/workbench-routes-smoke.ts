import assert from "node:assert/strict"
import path from "node:path"
import type { BrowserContext } from "playwright"
import type { createBrowserEvidence } from "./browser-evidence"

export async function workbenchRoutesSmoke(context: BrowserContext, origin: string, evidence: Awaited<ReturnType<typeof createBrowserEvidence>>) {
  const page = await context.newPage()
  const scripts: string[] = [], errors: string[] = []
  page.on("request", (request) => { if (request.resourceType() === "script") scripts.push(request.url()) })
  page.on("pageerror", (error) => errors.push(error.message))
  const faultUrl = "**/api/import-drafts?limit=100"
  try {
    await page.goto(origin)
    await page.getByRole("button", { name: "授权并创建项目", exact: true }).waitFor()
    assert.equal(scripts.some((url) => /\/design-import-[^/]+\.js$/.test(url)), false, "Dashboard eagerly loaded Design Import")
    // Deliberately malformed success data throws during rendering, not during fetch.
    await page.route(faultUrl, (route) => route.fulfill({ json: { drafts: [null] } }))
    evidence.phase("workbench-route-fault")
    await page.getByRole("link", { name: "Design Import", exact: true }).click()
    await page.getByRole("alert").filter({ hasText: "此功能页面发生错误" }).waitFor()
    await page.waitForURL(`${origin}/design-import`)
    assert.ok(scripts.some((url) => /\/design-import-[^/]+\.js$/.test(url)), "Design Import did not load on navigation")
    await page.getByRole("navigation", { name: "Maker Workbench 模块" }).waitFor()
    await page.screenshot({ path: path.join(evidence.directory, "feature-route-error.png") })
    await page.getByRole("link", { name: "Viewer", exact: true }).click()
    await page.waitForURL(`${origin}/viewer`)
    await page.locator("main h1").waitFor()
    assert.equal(await page.getByRole("alert").count(), 0, "Feature error replaced the Workbench shell")
    await page.goto(`${origin}/design-import`)
    await page.getByRole("alert").filter({ hasText: "此功能页面发生错误" }).waitFor()
    await page.unroute(faultUrl)
    await page.getByRole("button", { name: "重新加载页面", exact: true }).click()
    await page.getByRole("heading", { name: "设计稿导入", exact: true }).waitFor()
    await page.getByText("还没有 Import Draft。", { exact: true }).waitFor()
    assert.equal(await page.getByRole("alert").count(), 0)
    assert.deepEqual(errors, [], "Render exception escaped the route boundary")
    evidence.phase("workbench-route-recovered")
    return { lazyDesignImport: true, renderErrorIsolated: true, navigation: true, reloadRecovery: true }
  } finally { await page.close() }
}
