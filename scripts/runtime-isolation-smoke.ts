import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import path from "node:path"
import { createHash } from "node:crypto"
import type { BrowserContext, Frame, Page } from "playwright"
import { VIEWER_PROTOCOL_VERSION } from "../src/viewer-protocol"
import type { ArtifactManifest } from "../src/artifact-protocol"

// Exercise the real opaque iframe entry/nonce/port protocol, not window.postMessage to itself.
export async function openTestRuntime(page: Page, mode: "viewer" | "player", revision: string): Promise<Frame> {
  const assets = path.join(process.cwd(), "dist/web/assets")
  const workers = await Promise.all((await readdir(assets)).filter((name) => /^image-probe\.worker-.*\.js$/.test(name)).map(async (name) => ({ name, source: await readFile(path.join(assets, name), "utf8") })))
  const workerFile = workers.find(({ source }) => source.includes("self.onmessage"))?.name
  assert.ok(workerFile, "image probe worker build output is missing")
  const imageProbeWorker = await page.evaluate(async (url) => (await fetch(url)).text(), `/assets/${workerFile}`)
  const opening = page.evaluate(`new Promise((resolve, reject) => {
    document.getElementById("runtime-harness")?.remove();
    const frame = document.createElement("iframe");
    frame.id = "runtime-harness";
    frame.sandbox = "allow-scripts";
    frame.setAttribute("credentialless", "");
    frame.style.cssText = "position:fixed;inset:0;width:600px;height:400px;z-index:9999";
    const nonce = crypto.randomUUID();
    const channel = new MessageChannel(), pending = new Map();
    const cleanup = () => { clearTimeout(timer); clearInterval(ping); window.removeEventListener("message", onMessage); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("Runtime handshake timeout")); }, 8000);
    let sent = false;
    window.rejectedConnections = 0;
    channel.port1.onmessage = ({ data }) => {
      if (data.kind === "ready") { cleanup(); resolve(true); }
      if (data.kind === "fatal") { cleanup(); reject(new Error(data.error)); }
      if (data.kind === "response") { pending.get(data.requestId)?.(data); pending.delete(data.requestId); }
    };
    window.budgetRequest = command => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(command.requestId); reject(new Error("Runtime command timeout: " + command.kind)); }, 8000);
      pending.set(command.requestId, data => { clearTimeout(timer); resolve(data); });
      channel.port1.postMessage(command);
    });
    const message = { type: "fairygui.viewer.connect", protocolVersion: ${VIEWER_PROTOCOL_VERSION}, sourceRevision: ${JSON.stringify(revision)}, nonce, imageProbeWorker: ${JSON.stringify(imageProbeWorker)} };
    window.replayRuntimeConnect = () => {
      const rejected = new MessageChannel();
      rejected.port1.onmessage = () => window.rejectedConnections++;
      frame.contentWindow.postMessage(message, "*", [rejected.port2]);
    };
    const onMessage = event => {
      if (event.source !== frame.contentWindow || event.origin !== "null" || event.data?.type !== "fairygui.runtime.pong" || event.data.nonce !== nonce || sent) return;
      sent = true;
      for (const invalid of [{ ...message, nonce: crypto.randomUUID() }, { ...message, nonce: window.previousRuntimeNonce }, { ...message, protocolVersion: 0 }]) {
        const rejected = new MessageChannel();
        rejected.port1.onmessage = () => window.rejectedConnections++;
        frame.contentWindow.postMessage(invalid, "*", [rejected.port2]);
      }
      // A same-origin sibling knows the nonce but is not this runtime's parent.
      const sibling = document.createElement("iframe"); sibling.id = "runtime-sibling"; document.body.append(sibling);
      window.siblingAttackMessage = message;
      window.acceptTestRuntime = () => frame.contentWindow.postMessage(message, "*", [channel.port2]);
      window.previousRuntimeNonce = nonce;
    };
    window.addEventListener("message", onMessage);
    const ping = setInterval(() => frame.contentWindow.postMessage({ type: "fairygui.runtime.ping", nonce }, "*"), 50);
    frame.src = "/${mode}-runtime.html?instance=" + crypto.randomUUID() + "#" + nonce;
    document.body.append(frame);
  })`)
  await Promise.all([opening, (async () => {
    await page.waitForFunction(() => Boolean((window as any).acceptTestRuntime))
    const sibling = await (await page.locator("#runtime-sibling").elementHandle())!.contentFrame()
    await sibling!.evaluate(`(() => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => parent.rejectedConnections++;
      parent.document.getElementById("runtime-harness").contentWindow.postMessage(parent.siblingAttackMessage, "*", [channel.port2]);
    })()`)
    await page.evaluate("window.acceptTestRuntime(); delete window.acceptTestRuntime; document.getElementById('runtime-sibling').remove()")
  })()])
  assert.equal(await page.evaluate("window.rejectedConnections"), 0)
  return page.frames().find((frame) => new URL(frame.url()).pathname === `/${mode}-runtime.html`)!
}

export async function assertRuntimeIsolated(page: Page, mode: "viewer" | "player", sourcePath: string) {
  const frame = page.frames().find((frame) => new URL(frame.url()).pathname === `/${mode}-runtime.html`)!
  assert.ok(frame)
  const result = await frame.evaluate(`(async () => {
    const blocked = { credentialless: window.credentialless === true };
    for (const [name, read] of Object.entries({
      parentDOM: () => parent.document.body.innerHTML,
      cookie: () => document.cookie,
      localStorage: () => localStorage.getItem("anything"),
      sessionStorage: () => sessionStorage.length,
      indexedDB: () => indexedDB.open("fairygui-maker"),
      directoryHandles: () => parent.indexedDB.open("fairygui-maker"),
      topNavigation: () => { top.location.href = "/?escaped=1"; },
    })) { try { read(); blocked[name] = false; } catch (error) { blocked[name] = error.name === "SecurityError"; } }
    const paths = ["/api/status", "/api/projects", "/api/save-approvals", "/mcp", ${JSON.stringify(sourcePath)}];
    blocked.hostRequests = (await Promise.all(paths.map(async path => {
      try { await fetch(path, { credentials: "include" }); return false; } catch { return true; }
    }))).every(Boolean);
    blocked.hostWrites = await fetch("/api/save-approvals/forged/decision", { method: "POST", credentials: "include", body: "{}" }).then(() => false, () => true);
    blocked.popup = window.open("/") === null;
    return blocked;
  })()`)
  assert.deepEqual(result, { credentialless: true, parentDOM: true, cookie: true, localStorage: true, sessionStorage: true, indexedDB: true, directoryHandles: true, topNavigation: true, hostRequests: true, hostWrites: true, popup: true })
  assert.equal(new URL(page.url()).searchParams.has("escaped"), false)
  // CSP events are dispatched after fetch rejection. Drain their evidence callbacks before changing phases.
  await frame.evaluate("new Promise(resolve => setTimeout(resolve, 0)).then(() => Promise.all(window.__makerEvidenceCspPending ?? []))")
  return result
}

export async function runtimeNavigationSmoke(context: BrowserContext, origin: string, artifact: ArtifactManifest) {
  const page = await context.newPage()
  try {
    // CSP sandbox also applies when the runtime is opened directly, without an iframe attribute.
    for (const mode of ["viewer", "player"]) {
      await page.goto(`${origin}/${mode}-runtime.html`)
      assert.equal(await page.evaluate("(() => { try { return document.cookie } catch (error) { return error.name } })()"), "SecurityError")
    }
    await page.goto(origin)
    const binaryPath = artifact.packages[0].binaryPath
    const binary = await (await context.request.get(`${origin}/api/artifacts/${artifact.artifactId}/files/${binaryPath}`)).body()
    const script = "parent.document.body.dataset.escaped = 'yes'"
    const files = new Map([[binaryPath, binary],
      ["active.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" onload="${script}"/>`)],
      ["active.html", Buffer.from(`<script>${script}</script>`)], ["active.js", Buffer.from(script)]])
    const created = await context.request.post(`${origin}/api/artifact-imports`, { data: { name: "Active content isolation", files: [...files].map(([path, bytes]) => ({ path, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") })) } })
    assert.equal(created.status(), 201)
    const { importId } = await created.json()
    for (const [name, bytes] of files) assert.equal((await context.request.put(`${origin}/api/artifact-imports/${importId}/files?path=${name}`, { data: bytes })).status(), 200)
    const completed = await context.request.post(`${origin}/api/artifact-imports/${importId}/complete`)
    assert.equal(completed.status(), 201)
    const imported = (await completed.json()).artifact
    for (const name of ["active.svg", "active.html", "active.js"]) {
      const downloading = page.waitForEvent("download")
      await page.evaluate((url) => { const link = document.createElement("a"); link.href = url; document.body.append(link); link.click(); link.remove() }, `${origin}/api/artifacts/${imported.artifactId}/files/${name}`)
      const download = await downloading
      assert.equal(await download.failure(), null)
      await download.delete()
      assert.equal(new URL(page.url()).pathname, "/", "uploaded active content navigated the Workbench")
      assert.equal(await page.evaluate(() => document.body.dataset.escaped), undefined)
    }
    return { directEntrySandbox: true, activeUploadsDownloadOnly: true }
  } finally { await page.close() }
}
