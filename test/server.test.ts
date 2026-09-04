import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import test from "node:test"
import { Document } from "@openfairygui/core"
import { NodeIO } from "@openfairygui/core/node"

import { readCliArguments, startMakerHost } from "../src/server/index"
import { ViewerRenderBroker } from "../src/server/viewer"
import { VIEWER_PROTOCOL_VERSION } from "../src/viewer-protocol"

test("render sessions retain their stable browser target", () => {
  const project = { projectId: "project_demo", sourceRevision: "project-revision", viewerUrl: "http://127.0.0.1:3847/projects/project_demo/viewer" }
  const artifact = { artifactId: "artifact_demo", digest: "artifact-digest", playerUrl: "http://127.0.0.1:3847/artifacts/artifact_demo/player", packages: [] }
  const broker = new ViewerRenderBroker(
    (projectId) => projectId === project.projectId ? project : undefined,
    (artifactId) => artifactId === artifact.artifactId ? artifact : null,
  )
  const viewer = broker.registerRenderer({ projectId: project.projectId, sourceRevision: project.sourceRevision, protocolVersion: VIEWER_PROTOCOL_VERSION })
  const player = broker.registerRenderer({ mode: "player", artifactId: artifact.artifactId, sourceRevision: artifact.digest, protocolVersion: VIEWER_PROTOCOL_VERSION })
  assert.ok(viewer)
  assert.ok(player)
  assert.deepEqual(broker.getBrowserTarget(viewer.renderSessionId), { projectId: project.projectId, sourceRevision: project.sourceRevision, viewerUrl: project.viewerUrl })
  assert.deepEqual(broker.getBrowserTarget(player.renderSessionId), { artifactId: artifact.artifactId, digest: artifact.digest, playerUrl: artifact.playerUrl })
  assert.equal(broker.getBrowserTarget("render_missing"), null)
  broker.close()
})

test("render sessions reject mismatched catalogs and expire when the source revision changes", () => {
  const project = {
    projectId: "project_revision",
    fairyguiProjectId: "fairy_revision",
    sourceRevision: "revision-1",
    viewerUrl: "http://127.0.0.1:3847/projects/project_revision/viewer",
  }
  const broker = new ViewerRenderBroker((projectId) => projectId === project.projectId ? project : undefined)
  assert.equal(broker.registerRenderer({
    projectId: project.projectId,
    sourceRevision: project.sourceRevision,
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    catalog: { schemaVersion: 1, source: { projectId: "wrong-project" }, packages: [] },
  }), null)

  const renderer = broker.registerRenderer({
    projectId: project.projectId,
    sourceRevision: project.sourceRevision,
    protocolVersion: VIEWER_PROTOCOL_VERSION,
    catalog: { schemaVersion: 1, source: { projectId: project.fairyguiProjectId }, packages: [] },
  })
  assert.ok(renderer)
  project.sourceRevision = "revision-2"
  assert.equal(broker.getSession(renderer.renderSessionId), null)
  assert.equal(broker.executeForProject(project.projectId, "capture", {}), null)
  assert.equal(broker.registerRenderer({ projectId: project.projectId, sourceRevision: "revision-1", protocolVersion: VIEWER_PROTOCOL_VERSION }), null)
  assert.ok(broker.registerRenderer({ projectId: project.projectId, sourceRevision: "revision-2", protocolVersion: VIEWER_PROTOCOL_VERSION }))
  broker.close()
})

test("render request idempotency history stays bounded", async () => {
  const project = { projectId: "project_cache", sourceRevision: "revision-cache", viewerUrl: "http://127.0.0.1/viewer" }
  const broker = new ViewerRenderBroker((projectId) => projectId === project.projectId ? project : undefined)
  const renderer = broker.registerRenderer({ projectId: project.projectId, sourceRevision: project.sourceRevision, protocolVersion: VIEWER_PROTOCOL_VERSION })
  assert.ok(renderer)

  for (let index = 0; index <= 256; index += 1) {
    const requestId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`
    const result = broker.executeForProject(project.projectId, "capture", { index }, requestId)
    assert.ok(result)
    await broker.readCommands(renderer.renderSessionId, index, new AbortController().signal)
    assert.equal(broker.submitResult(renderer.renderSessionId, { commandSeq: index + 1, requestId, ok: true, value: { runtimeEventSeq: 0 } }), true)
    await result
  }
  assert.equal(broker.getSession(renderer.renderSessionId)?.commandSeq, 257)

  const evictedRequestId = "00000000-0000-4000-8000-000000000000"
  const repeated = broker.executeForProject(project.projectId, "capture", { index: 0 }, evictedRequestId)
  assert.ok(repeated)
  assert.equal(broker.getSession(renderer.renderSessionId)?.commandSeq, 258)
  await broker.readCommands(renderer.renderSessionId, 257, new AbortController().signal)
  assert.equal(broker.submitResult(renderer.renderSessionId, { commandSeq: 258, requestId: evictedRequestId, ok: true, value: { runtimeEventSeq: 0 } }), true)
  await repeated
  broker.close()
})

test("Maker Host protects Maker Workbench and accepts an MCP session", async () => {
  const token = "test-token-with-at-least-24-characters"
  const dataDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-host-"))
  const host = await startMakerHost({ port: 0, token, dataDir })
  try {
    assert.equal((await fetch(`${host.origin}/api/status`)).status, 401)
    assert.equal((await fetch(`${host.origin}/api/status`, {
      headers: { Origin: "https://example.com", Authorization: `Bearer ${token}` },
    })).status, 403)

    const bootstrap = await fetch(`${host.origin}/?token=${token}`, { redirect: "manual" })
    assert.equal(bootstrap.status, 302)
    assert.equal(bootstrap.headers.get("location"), "/")
    const setCookieHeader = bootstrap.headers.get("set-cookie")
    assert.ok(setCookieHeader)
    const cookie = setCookieHeader.split(";", 1)[0]
    assert.equal((await fetch(`${host.origin}/viewer`, { headers: { Cookie: cookie } })).status, 200)
    assert.equal((await fetch(`${host.origin}/asset-manager`, { headers: { Cookie: cookie } })).status, 200)
    const runtimePage = await fetch(`${host.origin}/viewer-runtime.html`, { headers: { Cookie: cookie } })
    assert.equal(runtimePage.status, 200)
    assert.match(await runtimePage.text(), /FairyGUI Viewer Runtime/)
    assert.match(runtimePage.headers.get("content-security-policy") ?? "", /sandbox allow-scripts;/)
    assert.equal((await fetch(`${host.origin}/viewer-runtime/laya.core.js`, { headers: { Cookie: cookie } })).status, 200)
    const playerRuntimePage = await fetch(`${host.origin}/player-runtime.html`, { headers: { Cookie: cookie } })
    assert.equal(playerRuntimePage.status, 200)
    assert.match(await playerRuntimePage.text(), /FairyGUI Player Runtime/)
    assert.equal((await fetch(`${host.origin}/api/artifacts?limit=0`, { headers: { Cookie: cookie } })).status, 400)

    const projectInput = {
      bindingId: "61f3ab47-5d8d-4d5d-9347-dad43b50bb4a",
      fairyguiProjectId: "42eb7038a35576a032d8aba97f9a18cc",
      name: "FairyGUI-layabox-demo",
      directoryName: "UIProject",
      fairyPath: "FairyGUI-layabox-demo.fairy",
      sourceRevision: "a".repeat(64),
    }
    assert.equal((await fetch(`${host.origin}/api/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...projectInput, fairyPath: "../invalid.fairy" }),
    })).status, 400)

    const createdResponse = await fetch(`${host.origin}/api/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(projectInput),
    })
    assert.equal(createdResponse.status, 201)
    const createdProject = (await createdResponse.json()).project
    assert.equal(createdProject.access, "read-only")
    assert.equal(createdProject.sourceOwner, "browser")
    assert.equal(createdProject.revision, 1)
    assert.equal(createdProject.viewerUrl, `${host.origin}/projects/${createdProject.projectId}/viewer`)
    assert.equal((await fetch(createdProject.viewerUrl, { headers: { Cookie: cookie } })).status, 200)

    const repeatedResponse = await fetch(`${host.origin}/api/projects`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(projectInput),
    })
    assert.equal(repeatedResponse.status, 200)
    assert.equal((await repeatedResponse.json()).project.projectId, createdProject.projectId)
    const projects = await fetch(`${host.origin}/api/projects`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.json())
    assert.equal(projects.projects.length, 1)

    const assetAnalysis = {
      schemaVersion: 1,
      projectId: createdProject.projectId,
      sourceRevision: projectInput.sourceRevision,
      resources: [{
        key: "rbw1tv9t/image001",
        packageId: "rbw1tv9t",
        packageName: "Bag",
        resourceId: "image001",
        kind: "image",
        name: "Image",
        path: "/",
        branch: "",
        exported: false,
        byteLength: 3,
        sha256: null,
        incomingReferences: 0,
        outgoingReferences: 0,
      }],
      references: [],
      issues: [{
        kind: "unused",
        severity: "warning",
        label: "Bag: 1 unused",
        detail: "Unexported resource with zero incoming references.",
        resourceKeys: ["rbw1tv9t/image001"],
      }],
    }
    assert.equal((await fetch(`${host.origin}/api/projects/${createdProject.projectId}/asset-analysis`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...assetAnalysis, sourceRevision: "b".repeat(64) }),
    })).status, 409)
    assert.equal((await fetch(`${host.origin}/api/projects/${createdProject.projectId}/asset-analysis`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(assetAnalysis),
    })).status, 200)
    const registeredAnalysis = await fetch(`${host.origin}/api/projects/${createdProject.projectId}/asset-analysis`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.json())
    assert.equal(registeredAnalysis.analysis.resources[0].resourceId, "image001")

    const rendererResponse = await fetch(`${host.origin}/api/renderers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: createdProject.projectId,
        sourceRevision: projectInput.sourceRevision,
        protocolVersion: VIEWER_PROTOCOL_VERSION,
        catalog: {
          schemaVersion: 1,
          source: { projectId: projectInput.fairyguiProjectId },
          packages: [{ packageId: "rbw1tv9t", packageName: "Bag", components: [{ id: "main", name: "Main" }] }],
        },
      }),
    })
    assert.equal(rendererResponse.status, 201)
    const renderSession = (await rendererResponse.json()).session
    assert.equal(renderSession.stateVersion, 0)

    const initialize = await fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "maker-test", version: "1.0.0" } },
      }),
    })
    assert.equal(initialize.status, 200)
    const sessionId = initialize.headers.get("mcp-session-id")
    assert.ok(sessionId)
    const initializeResult = await initialize.json()
    assert.equal(initializeResult.result.serverInfo.name, "fairygui-maker")
    assert.match(initializeResult.result.instructions, /revision-checked project edits/)

    const viewerComponentsResult = await fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "viewer-components",
        method: "tools/call",
        params: { name: "list_viewer_components", arguments: { projectId: createdProject.projectId } },
      }),
    }).then((response) => response.json())
    const viewerComponents = JSON.parse(viewerComponentsResult.result.content[0].text)
    assert.equal(viewerComponents.projects[0].browserRequired, false)
    assert.equal(viewerComponents.projects[0].renderSession.renderSessionId, renderSession.renderSessionId)
    assert.deepEqual(viewerComponents.projects[0].packages, [
      { packageId: "rbw1tv9t", packageName: "Bag", components: [{ id: "main", name: "Main" }] },
    ])

    const assetInspectionResult = await fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "asset-inspection",
        method: "tools/call",
        params: { name: "inspect_project_assets", arguments: { projectId: createdProject.projectId, packageId: "rbw1tv9t", resourceId: "image001" } },
      }),
    }).then((response) => response.json())
    const assetInspection = JSON.parse(assetInspectionResult.result.content[0].text)
    assert.equal(assetInspection.resource.resourceId, "image001")
    assert.equal(assetInspection.references.incomingTotal, 0)
    assert.equal(assetInspection.issues[0].kind, "unused")

    const toolCall = fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "render_component_preview",
          arguments: { projectId: createdProject.projectId, requestId: "14c08f7d-8c6f-4ef9-a036-fc81ea613fd8", packageId: "rbw1tv9t", componentId: "main", capture: false },
        },
      }),
    })
    const commandBatch = await fetch(`${host.origin}/api/render-sessions/${renderSession.renderSessionId}/commands?after=0`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.json())
    assert.equal(commandBatch.commands[0].kind, "render")
    assert.equal(commandBatch.commands[0].payload.packageId, "rbw1tv9t")
    assert.equal((await fetch(`${host.origin}/api/render-sessions/${renderSession.renderSessionId}/results`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        commandSeq: commandBatch.commands[0].commandSeq,
        requestId: commandBatch.commands[0].requestId,
        ok: true,
        value: { runtimeEventSeq: 0, rendered: { packageName: "Bag", componentName: "Main", width: 1136, height: 640 } },
      }),
    })).status, 200)
    const toolResult = await toolCall.then((response) => response.json())
    assert.equal(JSON.parse(toolResult.result.content[0].text).stateVersion, 1)

    const captureMcpRequest = {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "capture_render_screenshot", arguments: { renderSessionId: renderSession.renderSessionId, requestId: "64f3b92b-4b06-40e5-a88e-9f9d1117475c", afterStateVersion: 1 } },
    }
    const captureCall = fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify(captureMcpRequest),
    })
    const captureBatch = await fetch(`${host.origin}/api/render-sessions/${renderSession.renderSessionId}/commands?after=1`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.json())
    assert.equal(captureBatch.commands[0].kind, "capture")
    const screenshotBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
    assert.equal((await fetch(`${host.origin}/api/render-sessions/${renderSession.renderSessionId}/results`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        commandSeq: captureBatch.commands[0].commandSeq,
        requestId: captureBatch.commands[0].requestId,
        ok: true,
        value: { screenshotBase64, runtimeEventSeq: 0 },
      }),
    })).status, 200)
    const captureResult = await captureCall.then((response) => response.json())
    const captureMetadata = JSON.parse(captureResult.result.content[0].text)
    assert.deepEqual(captureMetadata.screenshot, { attached: true, mimeType: "image/png" })
    assert.equal("screenshotBase64" in captureMetadata.value, false)
    assert.equal(captureResult.result.content[1].type, "image")
    assert.equal(captureResult.result.content[1].data, screenshotBase64)
    const duplicateCapture = await fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ ...captureMcpRequest, id: 4 }),
    }).then((response) => response.json())
    assert.equal(duplicateCapture.result.content[1].data, screenshotBase64)

    const interactionResponse = await fetch(`${host.origin}/api/render-sessions/${renderSession.renderSessionId}/interactions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ runtimeEventSeq: 1, targetId: "/rbw1tv9t/main/button", event: "click", data: { selected: true } }),
    })
    assert.equal(interactionResponse.status, 200)
    assert.equal((await interactionResponse.json()).session.stateVersion, 2)

    const observationCall = fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: {
          name: "get_render_observation",
          arguments: { renderSessionId: renderSession.renderSessionId, requestId: "9e8ca07f-e421-44ec-9f83-13d1cd244b29", afterStateVersion: 1 },
        },
      }),
    })
    const observationBatch = await fetch(`${host.origin}/api/render-sessions/${renderSession.renderSessionId}/commands?after=2`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.json())
    assert.equal(observationBatch.commands[0].kind, "observe")
    const observation = {
      objectTree: { id: "/rbw1tv9t/main", name: "Main", type: "GComponent", x: 0, y: 0, width: 1136, height: 640, visible: true },
      controllers: [{
        targetId: "/rbw1tv9t/main",
        name: "page",
        selectedIndex: 1,
        pageId: "page-2",
        pageName: "Second",
        pages: [{ id: "page-1", name: "First" }, { id: "page-2", name: "Second" }],
      }],
      availableTransitions: [{ targetId: "/rbw1tv9t/main", name: "show" }],
    }
    assert.equal((await fetch(`${host.origin}/api/render-sessions/${renderSession.renderSessionId}/results`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        commandSeq: observationBatch.commands[0].commandSeq,
        requestId: observationBatch.commands[0].requestId,
        ok: true,
        value: { observation, runtimeEventSeq: 1 },
      }),
    })).status, 200)
    const observationResult = await observationCall.then((response) => response.json())
    const observedState = JSON.parse(observationResult.result.content[0].text).value.observation
    assert.equal(observedState.controllers[0].pageId, "page-2")
    assert.deepEqual(observedState.controllers[0].pages, observation.controllers[0].pages)
    assert.deepEqual(observedState.availableTransitions, observation.availableTransitions)

    const updateCall = fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "Mcp-Session-Id": sessionId,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "update_render_session",
          arguments: {
            renderSessionId: renderSession.renderSessionId,
            requestId: "21c4654e-84a7-48bb-bb98-588096bf25d8",
            expectedStateVersion: 2,
            operations: [
              { op: "set-controller-page", targetId: "/rbw1tv9t/main", controllerName: "page", pageId: "page-2" },
              { op: "play-transition", targetId: "/rbw1tv9t/main", transitionName: "show", times: 2 },
              { op: "dispatch-event", targetId: "/rbw1tv9t/main/button", event: "click" },
            ],
          },
        },
      }),
    })
    const updateBatch = await fetch(`${host.origin}/api/render-sessions/${renderSession.renderSessionId}/commands?after=3`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.json())
    assert.equal(updateBatch.commands[0].kind, "update")
    assert.equal(updateBatch.commands[0].payload.operations[0].op, "set-controller-page")
    assert.deepEqual(updateBatch.commands[0].payload.operations[1], { op: "play-transition", targetId: "/rbw1tv9t/main", transitionName: "show", times: 2 })
    assert.equal((await fetch(`${host.origin}/api/render-sessions/${renderSession.renderSessionId}/results`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        commandSeq: updateBatch.commands[0].commandSeq,
        requestId: updateBatch.commands[0].requestId,
        ok: true,
        value: { observation, runtimeEventSeq: 1 },
      }),
    })).status, 200)
    assert.equal(JSON.parse((await updateCall.then((response) => response.json())).result.content[0].text).stateVersion, 3)

    const renderSessionState = await fetch(`${host.origin}/api/render-sessions/${renderSession.renderSessionId}`, {
      headers: { Authorization: `Bearer ${token}` },
    }).then((response) => response.json())
    assert.equal(renderSessionState.session.commandSeq, 4)
    assert.equal(renderSessionState.session.interactionSeq, 1)
    assert.equal(renderSessionState.session.latestInteraction.targetId, "/rbw1tv9t/main/button")
    assert.equal(renderSessionState.session.observation.controllers[0].pageName, "Second")

    const status = await fetch(`${host.origin}/api/status`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.json())
    assert.equal(status.mcp.sessions, 1)
    assert.equal(status.viewer.entry, `${host.origin}/viewer`)
    const sessions = await fetch(`${host.origin}/api/sessions`, { headers: { Authorization: `Bearer ${token}` } }).then((response) => response.json())
    assert.equal(sessions.mcp[0].id, sessionId)

    const closed = await fetch(`${host.origin}/mcp`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}`, "Mcp-Session-Id": sessionId, "MCP-Protocol-Version": "2025-11-25" },
    })
    assert.equal(closed.status, 200)
  } finally {
    await host.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})

test("CLI view registers one bounded read-only project snapshot", async () => {
  const token = "cli-view-test-token-with-24-chars"
  const dataDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-cli-data-"))
  const projectRoot = await mkdtemp(path.join(tmpdir(), "fairygui-maker-cli-project-"))
  const projectXml = '<projectDescription id="cli-project-id" type="Layabox" version="5.0" />'
  await writeFile(path.join(projectRoot, "Demo.fairy"), projectXml)
  const host = await startMakerHost({ port: 0, token, dataDir, projectPath: projectRoot })
  try {
    assert.deepEqual(readCliArguments(["--", "view", projectRoot, "--port", "3900", "--data-dir", dataDir]), {
      help: false,
      port: 3900,
      dataDir,
      projectPath: projectRoot,
    })
    assert.deepEqual(readCliArguments(["import", "source.fig", "--out", "generated"]), {
      help: false,
      importSource: "source.fig",
      outputPath: "generated",
    })
    assert.deepEqual(readCliArguments(["import", "inspect", "source.fig", "--data-dir", dataDir]), {
      help: false,
      importAction: "inspect",
      importSource: "source.fig",
      dataDir,
    })
    assert.deepEqual(readCliArguments(["import", "plan", "source.fig", "--out", "plan.json"]), {
      help: false,
      importAction: "plan",
      importSource: "source.fig",
      outputPath: "plan.json",
    })
    assert.deepEqual(readCliArguments(["import", "source.fig", "--dry-run"]), {
      help: false,
      importSource: "source.fig",
      dryRun: true,
    })
    assert.deepEqual(readCliArguments(["reimport", projectRoot, "--dry-run"]), {
      help: false,
      reimportPath: projectRoot,
      dryRun: true,
    })
    assert.throws(() => readCliArguments(["reimport", projectRoot]), /reimport <project-directory> --dry-run/)
    assert.throws(() => readCliArguments(["reimport", projectRoot, "--apply"]), /Unknown option/)
    assert.throws(() => readCliArguments(["import", "source.fig"]), /--out <new-directory>/)
    assert.throws(() => readCliArguments(["import", "source.fig", "--out", "generated", "--port", "3900"]), /--out <new-directory>/)
    assert.deepEqual(readCliArguments(["--version"]), { version: true })
    assert.ok(host.project)
    assert.equal(host.project.sourceOwner, "host")
    assert.equal(host.project.access, "read-only")
    assert.equal(host.project.fairyguiProjectId, "cli-project-id")
    assert.equal(host.project.viewerUrl, `${host.origin}/projects/${host.project.projectId}/viewer`)

    const headers = { Authorization: `Bearer ${token}` }
    const projects = await fetch(`${host.origin}/api/projects`, { headers }).then((response) => response.json())
    assert.equal(projects.projects.length, 1)
    assert.equal((await fetch(`${host.origin}/api/import-drafts`, { headers })).status, 403)
    assert.equal(JSON.stringify(projects).includes(projectRoot), false)
    const sourceIndex = await fetch(`${host.origin}/api/projects/${host.project.projectId}/source-index`, { headers }).then((response) => response.json())
    assert.deepEqual(sourceIndex.files, [{ path: "Demo.fairy", size: Buffer.byteLength(projectXml) }])

    const sourceUrl = `${host.origin}/api/projects/${host.project.projectId}/source-file?path=Demo.fairy`
    const sourceResponse = await fetch(sourceUrl, { headers })
    assert.equal(sourceResponse.headers.get("content-disposition"), "attachment")
    assert.equal(sourceResponse.headers.get("content-security-policy"), "default-src 'none'; sandbox")
    assert.equal(await sourceResponse.text(), projectXml)
    await writeFile(path.join(projectRoot, "Demo.fairy"), '<projectDescription id="changed" />')
    assert.equal(await fetch(sourceUrl, { headers }).then((response) => response.text()), projectXml)
    assert.equal((await fetch(`${host.origin}/api/projects/${host.project.projectId}/source-file?path=${encodeURIComponent("../outside")}`, { headers })).status, 400)

    const initialize = await fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: { ...headers, Accept: "application/json, text/event-stream", "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "view-only-test", version: "1.0.0" } },
      }),
    })
    assert.equal(initialize.status, 200)
    const mcpSessionId = initialize.headers.get("mcp-session-id")
    assert.ok(mcpSessionId)
    assert.match((await initialize.json()).result.instructions, /Read-only FairyGUI Viewer and Player/)
    const tools = await fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: {
        ...headers,
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        "Mcp-Session-Id": mcpSessionId,
        "MCP-Protocol-Version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    }).then((response) => response.json())
    const toolNames = tools.result.tools.map((tool: { name: string }) => tool.name)
    assert.ok(toolNames.includes("list_viewer_components"))
    assert.ok(toolNames.includes("capture_render_screenshot"))
    assert.equal(toolNames.some((name: string) => name.startsWith("openfairygui_backend_")), false)
  } finally {
    await host.close()
    await rm(dataDir, { recursive: true, force: true })
    await rm(projectRoot, { recursive: true, force: true })
  }
})

test("Maker Host imports, validates, serves, and reloads immutable Player artifacts", async () => {
  const token = "artifact-test-token-with-24-chars"
  const dataDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-artifacts-"))
  const publishedDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-published-"))
  const binaryPath = path.join(publishedDir, "Demo.fui")
  const document = new Document()
  const pkg = document.createPackage("Demo").setId("DEMO0001")
  const component = document.createComponent("Main").setId("MAIN0001").setExported(true).setSize(480, 270)
  const title = document.createGTextField("title").setId("TITLE001").setXY(32, 32).setSize(360, 56).setFontSize(28).setColor("#2563eb").setText("FairyGUI Player")
  component.addChild(title)
  pkg.addResource(component)
  await new NodeIO().writeBinary(document, binaryPath, { compressed: true })
  const binary = await readFile(binaryPath)
  let host = await startMakerHost({ port: 0, token, dataDir })
  try {
    const headers = { Authorization: `Bearer ${token}` }
    const created = await fetch(`${host.origin}/api/artifact-imports`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Demo publish", source: { kind: "published-folder" }, files: [{ path: "Demo.fui", size: binary.byteLength, sha256: createHash("sha256").update(binary).digest("hex") }] }),
    })
    assert.equal(created.status, 201)
    const { importId } = await created.json()
    assert.equal((await fetch(`${host.origin}/api/artifact-imports/${importId}/files?path=Demo.fui`, { method: "PUT", headers, body: binary })).status, 200)
    const completed = await fetch(`${host.origin}/api/artifact-imports/${importId}/complete`, { method: "POST", headers })
    assert.equal(completed.status, 201)
    const artifact = (await completed.json()).artifact
    assert.match(artifact.artifactId, /^artifact_[a-f0-9]{24}$/)
    assert.equal(artifact.runtimeProfile, "layaair-3.3.10/fairygui")
    assert.equal(artifact.packages[0].packageId, "DEMO0001")
    assert.deepEqual(artifact.packages[0].components, [{ id: "MAIN0001", name: "Main" }])
    assert.equal(artifact.files[0].size, binary.byteLength)
    assert.match(artifact.files[0].sha256, /^[a-f0-9]{64}$/)
    assert.equal(artifact.playerUrl, `${host.origin}/artifacts/${artifact.artifactId}/player`)
    assert.equal((await fetch(artifact.playerUrl, { headers })).status, 200)

    const served = await fetch(`${host.origin}/api/artifacts/${artifact.artifactId}/files/Demo.fui`, { headers })
    assert.equal(served.status, 200)
    assert.equal(served.headers.get("etag"), `"${artifact.files[0].sha256}"`)
    assert.deepEqual(Buffer.from(await served.arrayBuffer()), binary)
    assert.equal((await fetch(`${host.origin}/api/artifacts/${artifact.artifactId}/files/../manifest.json`, { headers })).status, 404)

    const renderer = await fetch(`${host.origin}/api/renderers`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "player", artifactId: artifact.artifactId, sourceRevision: artifact.digest, protocolVersion: VIEWER_PROTOCOL_VERSION }),
    })
    assert.equal(renderer.status, 201)
    assert.equal((await renderer.json()).session.mode, "player")

    await host.close()
    host = await startMakerHost({ port: 0, token, dataDir })
    const reloaded = await fetch(`${host.origin}/api/artifacts?limit=10`, { headers }).then((response) => response.json())
    assert.equal(reloaded.artifacts.length, 1)
    assert.equal(reloaded.artifacts[0].artifactId, artifact.artifactId)
    assert.equal(reloaded.artifacts[0].playerUrl, `${host.origin}/artifacts/${artifact.artifactId}/player`)

    await host.close()
    const manifestPath = path.join(dataDir, "artifacts", artifact.artifactId, "manifest.json")
    const manifestText = await readFile(manifestPath, "utf8")
    const invalidManifest = JSON.parse(manifestText)
    invalidManifest.blob.digest = "0".repeat(64)
    await writeFile(manifestPath, JSON.stringify(invalidManifest))
    host = await startMakerHost({ port: 0, token, dataDir })
    assert.equal((await fetch(`${host.origin}/api/artifacts?limit=10`, { headers }).then((response) => response.json())).artifacts.length, 0)

    await host.close()
    await writeFile(manifestPath, manifestText)
    const orphanRoot = path.join(dataDir, "imports", "import_00000000-0000-4000-8000-000000000000")
    await mkdir(orphanRoot, { recursive: true })
    await writeFile(path.join(orphanRoot, "partial.fui"), binary)
    const tampered = Buffer.from(binary)
    tampered[tampered.length - 1] ^= 1
    await writeFile(path.join(dataDir, "artifacts", artifact.artifactId, "Demo.fui"), tampered)

    host = await startMakerHost({ port: 0, token, dataDir })
    const rejected = await fetch(`${host.origin}/api/artifacts?limit=10`, { headers }).then((response) => response.json())
    assert.equal(rejected.artifacts.length, 0)
    await assert.rejects(readFile(path.join(orphanRoot, "partial.fui")), { code: "ENOENT" })
  } finally {
    await host.close()
    await rm(dataDir, { recursive: true, force: true })
    await rm(publishedDir, { recursive: true, force: true })
  }
})

test("Maker Host persists revision-checked import drafts and materializes only on request", async () => {
  const token = "import-draft-test-token-with-24-chars"
  const dataDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-import-drafts-"))
  const outputParent = await mkdtemp(path.join(tmpdir(), "fairygui-maker-import-output-"))
  const targetPath = path.join(outputParent, "generated")
  const sourcePath = path.join(process.cwd(), "test", "fixtures", "design-import", "basic-shapes.fig")
  const source = await readFile(sourcePath)
  let host = await startMakerHost({ port: 0, token, dataDir })
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
  try {
    assert.equal((await fetch(`${host.origin}/design-import`, { headers })).status, 200)
    const createdResponse = await fetch(`${host.origin}/api/import-drafts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ kind: "fig", name: "basic-shapes.fig", files: [{ path: "basic-shapes.fig", size: source.byteLength }] }),
    })
    assert.equal(createdResponse.status, 201)
    let draft = (await createdResponse.json()).draft
    assert.equal(draft.status, "uploading")
    assert.equal((await fetch(`${host.origin}/api/import-drafts/${draft.draftId}/source?path=undeclared.fig`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: source,
    })).status, 400)
    assert.equal((await fetch(`${host.origin}/api/import-drafts/${draft.draftId}/source?path=basic-shapes.fig`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream" },
      body: source,
    })).status, 200)
    const completed = await fetch(`${host.origin}/api/import-drafts/${draft.draftId}/source/complete`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: draft.revision }),
    })
    assert.equal(completed.status, 200)
    draft = (await completed.json()).draft
    assert.equal(draft.status, "created")
    assert.equal((await fetch(`${host.origin}/imports/${draft.draftId}`, { headers })).status, 200)
    assert.equal((await fetch(`${host.origin}/api/import-drafts/${draft.draftId}/plan`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: draft.revision }),
    })).status, 409)

    const advance = async (action: "parse" | "plan" | "compile", body: Record<string, unknown> = {}) => {
      const response = await fetch(`${host.origin}/api/import-drafts/${draft.draftId}/${action}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ expectedRevision: draft.revision, ...body }),
      })
      assert.equal(response.status, 200)
      const result = await response.json()
      draft = result.draft
      return result
    }
    await advance("parse")
    const parsedDetail = await fetch(`${host.origin}/api/import-drafts/${draft.draftId}`, { headers }).then((response) => response.json())
    const mappedRootId = parsedDetail.outline.pages[0].roots[0].id
    const mapped = await fetch(`${host.origin}/api/import-drafts/${draft.draftId}/semantic-overlay`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        expectedRevision: draft.revision,
        nodeId: mappedRootId,
        directive: { target: "button", confidence: 1, rationale: "User mapping" },
      }),
    })
    assert.equal(mapped.status, 200)
    const mappedResult = await mapped.json()
    draft = mappedResult.draft
    assert.equal(mappedResult.semanticOverlay.nodes[mappedRootId].target, "button")
    const planned = await advance("plan")
  assert.equal(planned.buildPlan.schemaVersion, 2)
    await advance("compile")
    assert.equal(await readFile(path.join(dataDir, "import-drafts", draft.draftId, "generated", "project", draft.generated.fairyFile)).then(() => true), true)
    await assert.rejects(readFile(path.join(targetPath, draft.generated.fairyFile)), { code: "ENOENT" })
    const compiledDetail = await fetch(`${host.origin}/api/import-drafts/${draft.draftId}`, { headers }).then((response) => response.json())
    assert.equal(compiledDetail.outline.pages.length, 1)
    assert.equal(compiledDetail.preview.sourceOwner, "host")
    assert.equal(compiledDetail.preview.access, "read-only")
    assert.equal((await fetch(compiledDetail.preview.viewerUrl, { headers })).status, 200)
    const previewFiles = await fetch(`${host.origin}/api/projects/${compiledDetail.preview.projectId}/source-index`, { headers }).then((response) => response.json())
    assert.ok(previewFiles.files.some((file: { path: string }) => file.path.endsWith(".fairy")))

    const stale = await fetch(`${host.origin}/api/import-drafts/${draft.draftId}/materialize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: draft.revision - 1, targetPath }),
    })
    assert.equal(stale.status, 409)
    const materialized = await fetch(`${host.origin}/api/import-drafts/${draft.draftId}/materialize`, {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedRevision: draft.revision, targetPath }),
    })
    assert.equal(materialized.status, 200)
    draft = (await materialized.json()).draft
    assert.equal(draft.status, "materialized")
    assert.equal(await readFile(path.join(targetPath, draft.generated.fairyFile)).then(() => true), true)

    await host.close()
    host = await startMakerHost({ port: 0, token, dataDir })
    const detail = await fetch(`${host.origin}/api/import-drafts/${draft.draftId}`, { headers }).then((response) => response.json())
    assert.equal(detail.draft.revision, draft.revision)
  assert.equal(detail.buildPlan.schemaVersion, 2)
    assert.equal(detail.semanticOverlay.nodes[mappedRootId].target, "button")
    assert.equal(detail.preview.viewerUrl, `${host.origin}/projects/${detail.preview.projectId}/viewer`)
    const removed = await fetch(`${host.origin}/api/import-drafts/${draft.draftId}?expectedRevision=${draft.revision}`, {
      method: "DELETE",
      headers,
    })
    assert.equal(removed.status, 204)
  } finally {
    await host.close()
    await rm(dataDir, { recursive: true, force: true })
    await rm(outputParent, { recursive: true, force: true })
  }
})

test("Maker Host caps concurrent MCP sessions", async () => {
  const token = "mcp-cap-test-token-with-24-characters"
  const dataDir = await mkdtemp(path.join(tmpdir(), "fairygui-maker-mcp-cap-"))
  const host = await startMakerHost({ port: 0, token, dataDir })
  try {
    const request = (id: number) => fetch(`${host.origin}/mcp`, {
      method: "POST",
      headers: {
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "mcp-cap-test", version: "1.0.0" } },
      }),
    })
    const initialized = await Promise.all(Array.from({ length: 32 }, (_, index) => request(index)))
    assert.deepEqual(initialized.map(({ status }) => status), Array(32).fill(200))
    const rejected = await request(33)
    assert.equal(rejected.status, 503)
    assert.equal((await rejected.json()).error.message, "MCP session limit reached")
  } finally {
    await host.close()
    await rm(dataDir, { recursive: true, force: true })
  }
})
