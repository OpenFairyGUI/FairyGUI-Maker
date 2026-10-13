import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import type { BrowserContext } from "playwright"

/** Value gears without a default (UAM defaultValue: null) must restore the owner's initial values on pages without state. */
export async function gearDefaultSmoke(context: BrowserContext, origin: string, call: (name: string, args: Record<string, unknown>) => Promise<any>) {
  const page = await context.newPage()
  const errors: string[] = []
  page.on("pageerror", (error) => errors.push(error.message))
  const files = {
    "Demo.fairy": '<projectDescription id="browser-gear-default" type="Layabox" version="5.0" />',
    "assets/Gear/package.xml": '<packageDescription id="GEAR0001"><resources><component id="MAIN0001" name="Main.xml" path="/" exported="true" /></resources></packageDescription>',
    // Only page 1 has state; no gear declares a default, so pages 0 and 2 keep the label's own values.
    "assets/Gear/Main.xml": '<component size="300,200"><controller name="state" pages="0,First,1,Second,2,Third" selected="0"/><displayList>'
      + '<text id="TEXT0001" name="label" xy="10,20" size="120,30" fontSize="20" autoSize="none" text="Initial">'
      + '<gearXY controller="state" pages="1" values="150,60"/><gearSize controller="state" pages="1" values="80,40,1,1"/><gearText controller="state" pages="1" values="Second"/>'
      + '</text></displayList></component>',
  }
  try {
    await page.goto(origin)
    await page.evaluate(`(async () => {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("gear-default-smoke", {create:true});
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
    const registration = page.waitForResponse((r) => r.url() === `${origin}/api/renderers` && r.request().method() === "POST" && r.status() === 201)
    await page.goto(project.viewerUrl)
    await registration
    await page.getByText("AGENT READY", { exact: true }).waitFor()

    let state = (await call("render_component_preview", { projectId: project.projectId, packageId: "GEAR0001", componentId: "MAIN0001", requestId: randomUUID() })).value
    const renderSessionId = state.renderSessionId
    const observe = async () => {
      const observed = await call("get_render_observation", { renderSessionId, requestId: randomUUID(), afterStateVersion: state.semanticStateVersion, afterViewStateVersion: state.viewStateVersion })
      const { objectTree, controllers } = observed.value.value.observation
      const label = (objectTree.children ?? []).find((node: any) => node.name === "label")
      assert.ok(label, "Viewer observation must include the gear owner")
      return { root: objectTree, controller: controllers.find((item: any) => item.targetId === objectTree.id && item.name === "state"), label }
    }
    const pick = ({ x, y, width, height, text }: any) => ({ x, y, width, height, text })
    const initial = { x: 10, y: 20, width: 120, height: 30, text: "Initial" }
    const first = await observe()
    assert.ok(first.controller, "Viewer observation must include the state controller")
    assert.deepEqual(pick(first.label), initial)

    const visited: Record<string, unknown> = {}
    for (const [pageName, expected] of [["Second", { x: 150, y: 60, width: 80, height: 40, text: "Second" }], ["Third", initial], ["Second", null], ["First", initial]] as const) {
      const pageId = first.controller.pages.find((item: any) => item.name === pageName)?.id
      assert.ok(pageId, `Controller page ${pageName} missing`)
      state = (await call("update_render_session", { renderSessionId, requestId: randomUUID(), expectedStateVersion: state.semanticStateVersion,
        operations: [{ op: "set-controller-page", targetId: first.root.id, controllerName: "state", pageId }] })).value
      const current = await observe()
      assert.equal(current.controller.pageId, pageId)
      if (expected) assert.deepEqual(pick(current.label), expected, `Gear values on page ${pageName}`)
      visited[pageName] = pick(current.label)
    }
    assert.deepEqual(errors, [])
    return { nullDefaults: ["xy", "size", "text"], restoredOnPageWithoutState: true, restoredOnHomePage: true, visited }
  } finally {
    await page.close()
  }
}
