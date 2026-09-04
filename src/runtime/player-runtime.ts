import type { ArtifactManifest, ArtifactPackage, PlayerRenderSource } from "../artifact-protocol"
import { installResourceLoadBudget, loadRuntimeTexture, reserveImage } from "./image-budget"
import { checkBudget, checkImageDimensions, checkRuntimeMetadata, decompressFuiIfNeeded, ObservationBudget, readBoundedStream, ResourceBudget, RUNTIME_LIMITS } from "./resource-budget"
import {
  isViewerConnectMessage,
  type ViewerCommand,
  type ViewerControlKind,
  type ViewerInteractionEvent,
  type ViewerObjectSnapshot,
  type ViewerObservation,
  type ViewerOperation,
  type ViewerRendered,
  type ViewerRuntimeMessage,
} from "../viewer-protocol"

declare const Laya: any
declare const fgui: any

const runtime = {
  sourceRevision: "",
  artifactId: "",
  manifest: null as ArtifactManifest | null,
  current: null as any,
  objects: new Map<string, any>(),
  paths: new WeakMap<object, string>(),
  packageIds: [] as string[],
  loaderUrls: new Set<string>(),
  imageUrls: new Set<string>(),
  blobUrls: [] as string[],
  ownedTextures: [] as any[],
  ownedObjects: new Set<any>(),
  budget: new ResourceBudget(),
  loading: new AbortController(),
  port: null as MessagePort | null,
  interactionSeq: 0,
  zoom: 1,
  background: "#202226",
}

let bootPromise: Promise<void> | null = null
let commandQueue = Promise.resolve()
let connectionSequence = 0
window.addEventListener("pagehide", () => runtime.loading.abort())

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  const ping = event.data as { type?: string; nonce?: string } | null
  if (event.origin === location.origin && ping?.type === "fairygui.player.ping" && typeof ping.nonce === "string") {
    event.source?.postMessage({ type: "fairygui.player.pong", nonce: ping.nonce }, { targetOrigin: event.origin })
    return
  }
  if (event.origin !== location.origin || !isViewerConnectMessage(event.data) || event.ports.length !== 1) return
  void connect(event.data.sourceRevision, event.ports[0])
})

async function connect(sourceRevision: string, port: MessagePort) {
  const sequence = ++connectionSequence
  try {
    await (bootPromise ??= boot())
    if (sequence !== connectionSequence) { port.close(); return }
    runtime.port?.close()
    runtime.port = null
    runtime.loading.abort()
    await commandQueue
    if (sequence !== connectionSequence) { port.close(); return }
    resetArtifact()
    runtime.port = port
    runtime.sourceRevision = sourceRevision
    runtime.interactionSeq = 0
    commandQueue = Promise.resolve()
    port.onmessage = (event: MessageEvent<ViewerCommand>) => {
      commandQueue = commandQueue.then(() => runtime.port === port ? handleCommand(event.data) : undefined)
    }
    port.start()
    post({ kind: "ready", sourceRevision })
  } catch (error) {
    port.postMessage({ kind: "fatal", error: formatError(error) } satisfies ViewerRuntimeMessage)
  }
}

async function boot() {
  if (typeof Laya === "undefined" || typeof fgui === "undefined") throw new Error("LayaAir 或 FairyGUI Web runtime 未加载。")
  const resolution = {
    scaleMode: "full",
    backgroundColor: runtime.background,
    designWidth: Math.max(1, innerWidth),
    designHeight: Math.max(1, innerHeight),
    alignV: "top",
    alignH: "left",
    screenMode: "none",
  }
  Object.assign(Laya.PlayerConfig, { resolution })
  Object.assign(Laya.Config, { FPS: 60, isAntialias: true, useRetinalCanvas: false, isAlpha: false })
  await Laya.init(resolution)
  if (!fgui.GRoot.inst.displayObject.parent) Laya.stage.addChild(fgui.GRoot.inst.displayObject)
  installResourceLoadBudget(runtime.loaderUrls, runtime.imageUrls)
  installConstructionBudget()
  bindInteractionEvents()
  resize()
  window.addEventListener("resize", resize)
}

async function handleCommand(command: ViewerCommand) {
  try {
    if (!command || typeof command.requestId !== "string") return
    switch (command.kind) {
      case "render-artifact": {
        const value = await renderArtifact(command.source)
        post({ kind: "rendered", value })
        respond(command.requestId, value)
        return
      }
      case "set-view":
        runtime.zoom = Math.min(4, Math.max(0.1, command.zoom))
        if (!CSS.supports("color", command.background)) throw new Error("无效的 Player 背景颜色。")
        runtime.background = command.background
        Laya.stage.bgColor = command.background
        layoutCurrent()
        respond(command.requestId)
        return
      case "play-transition":
        playTransition(runtime.current, command.transitionName)
        respond(command.requestId)
        return
      case "observe":
        respond(command.requestId, createObservation())
        return
      case "apply-operations": {
        if (!runtime.current) throw new Error("请先播放一个 FairyGUI 组件。")
        checkRuntimeMetadata(command.operations)
        const budget = new ObservationBudget()
        const observations = command.operations.map((operation) => applyOperation(operation, budget))
        await nextFrame()
        respond(command.requestId, { observations, observation: createObservation(budget) })
        return
      }
      case "capture": {
        checkImageDimensions(Math.max(1, innerWidth), Math.max(1, innerHeight))
        const canvas = Laya.stage.drawToCanvas(Math.max(1, innerWidth), Math.max(1, innerHeight), 0, 0)?.source as HTMLCanvasElement | undefined
        if (!canvas) throw new Error("LayaAir Canvas 尚未创建。")
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Canvas 截图失败。")), "image/png"))
        const data = await blob.arrayBuffer()
        runtime.port?.postMessage({ kind: "response", requestId: command.requestId, ok: true, value: { data, type: blob.type } } satisfies ViewerRuntimeMessage, [data])
        return
      }
      case "render":
        throw new Error("Player runtime 不接受工程态 Viewer Scene。")
    }
  } catch (error) {
    if (command?.kind === "render-artifact") resetArtifact()
    respond(command.requestId, undefined, formatError(error))
  }
}

async function renderArtifact(source: PlayerRenderSource): Promise<ViewerRendered> {
  validateSource(source)
  if (runtime.artifactId !== source.artifact.artifactId || runtime.sourceRevision !== source.artifact.digest) {
    await loadArtifact(source.artifact)
  }
  clearCurrent()
  const pkgSpec = source.artifact.packages.find(({ packageId }) => packageId === source.packageId)
  const componentSpec = pkgSpec?.components.find(({ id }) => id === source.componentId)
  if (!pkgSpec || !componentSpec) throw new Error(`Artifact 组件不存在：${source.packageId}/${source.componentId}`)
  const pkg = fgui.UIPackage.getById(pkgSpec.packageId)
  const item = pkg?.getItemById(source.componentId)
  if (!pkg || !item || item.name !== componentSpec.name) throw new Error(`UIPackage 未注册组件：${pkgSpec.packageName}/${componentSpec.name}`)
  const current = pkg.createObject(componentSpec.name)
  if (!current) throw new Error(`无法创建组件：${pkgSpec.packageName}/${componentSpec.name}`)
  runtime.current = current
  fgui.GRoot.inst.removeChildren(0, -1, false)
  fgui.GRoot.inst.addChild(current)
  indexObjects(current, `/${pkgSpec.packageId}/${componentSpec.id}`)
  layoutCurrent()
  await nextFrame()
  const observation = createObservation()
  return {
    packageId: pkgSpec.packageId,
    componentId: componentSpec.id,
    packageName: pkgSpec.packageName,
    componentName: componentSpec.name,
    width: Number(current.width || 0),
    height: Number(current.height || 0),
    transitions: transitionNames(current),
    diagnostics: [],
    ...observation,
  }
}

async function loadArtifact(artifact: ArtifactManifest) {
  if (artifact.runtimeProfile !== "layaair-3.3.10/fairygui") throw new Error(`Player 不支持 runtime profile：${artifact.runtimeProfile}`)
  resetArtifact()
  for (const file of artifact.files) runtime.budget.encoded(file.size)
  let inflatedBytes = 0
  let packageItems = 0
  const metadataBudget = new ObservationBudget()
  for (const pkg of sortPackages(artifact.packages)) {
    const binaryUrl = artifactFileUrl(artifact.artifactId, pkg.binaryPath)
    const signal = AbortSignal.any([runtime.loading.signal, AbortSignal.timeout(RUNTIME_LIMITS.loadMs)])
    const bytes = await decompressFuiIfNeeded(await fetchArtifactFile(artifact, pkg.binaryPath, signal), signal, RUNTIME_LIMITS.inflatedBytes - inflatedBytes)
    inflatedBytes += bytes.byteLength
    packageItems += validatePackageMetadata(bytes, metadataBudget)
    checkBudget(packageItems, RUNTIME_LIMITS.nodes, "package_items")
    const loaded = fgui.UIPackage.addPackage(binaryUrl.replace(/(?:\.fui|_fui\.bytes)$/i, ""), bytes.buffer)
    runtime.packageIds.push(loaded.id)
    if (loaded.id !== pkg.packageId || loaded.name !== pkg.packageName) throw new Error(`FairyGUI 包身份不匹配：${pkg.binaryPath}`)
  }
  await preloadArtifactFiles(artifact)
  runtime.artifactId = artifact.artifactId
  runtime.manifest = artifact
}

async function preloadArtifactFiles(artifact: ArtifactManifest) {
  for (const file of artifact.files) {
    if (/(?:\.fui|_fui\.bytes)$/i.test(file.path)) continue
    const url = artifactFileUrl(artifact.artifactId, file.path)
    runtime.loaderUrls.add(url)
    // ponytail: PCM/audio duration is not a batch-11 budget; leave decoding to native playback.
    if (file.mimeType.startsWith("audio/")) continue
    const signal = AbortSignal.any([runtime.loading.signal, AbortSignal.timeout(RUNTIME_LIMITS.loadMs)])
    const bytes = await fetchArtifactFile(artifact, file.path, signal)
    if (file.mimeType.startsWith("image/")) {
      const image = await reserveImage(bytes.buffer, file.mimeType, runtime.budget, signal)
      const blobUrl = URL.createObjectURL(new Blob([image.data], { type: file.mimeType }))
      runtime.blobUrls.push(blobUrl)
      runtime.loaderUrls.add(blobUrl)
      runtime.imageUrls.add(blobUrl)
      runtime.imageUrls.add(url)
      const texture = await loadRuntimeTexture(blobUrl, signal)
      Laya.loader.cacheRes(url, texture)
    } else {
      Laya.loader.cacheRes(url, bytes.buffer)
    }
  }
}

function validatePackageMetadata(bytes: Uint8Array<ArrayBuffer>, budget: ObservationBudget) {
  const buffer = new fgui.ByteBuffer(bytes.buffer)
  buffer.pos = 9
  budget.text(buffer.readUTFString())
  budget.text(buffer.readUTFString())
  buffer.skip(20)
  const start = buffer.pos
  if (!buffer.seek(start, 4)) throw new Error("FairyGUI string table is missing")
  const count = buffer.getInt32()
  checkBudget(count, RUNTIME_LIMITS.observationEntries, "package_strings")
  for (let index = 0; index < count; index++) { budget.entry(); budget.text(buffer.readUTFString()) }
  if (buffer.seek(start, 5)) {
    const count = buffer.getInt32()
    checkBudget(count, RUNTIME_LIMITS.observationEntries, "package_strings")
    for (let index = 0; index < count; index++) {
      budget.entry()
      buffer.skip(2)
      const length = buffer.getInt32()
      checkBudget(length, RUNTIME_LIMITS.stringLength, "package_string")
      budget.text(buffer.getCustomString(length))
    }
  }
  if (!buffer.seek(start, 1)) throw new Error("FairyGUI item table is missing")
  const items = buffer.getInt16()
  checkBudget(items, RUNTIME_LIMITS.nodes, "package_items")
  return items
}

async function fetchArtifactFile(artifact: ArtifactManifest, path: string, signal: AbortSignal) {
  const file = artifact.files.find((file) => file.path === path)
  if (!file) throw new Error(`Artifact file is not declared: ${path}`)
  checkBudget(file.size, RUNTIME_LIMITS.fileBytes, "file_bytes")
  const response = await fetch(artifactFileUrl(artifact.artifactId, path), { signal })
  if (!response.ok || !response.body) throw new Error(`读取 Artifact 失败：${path} (${response.status})`)
  const bytes = await readBoundedStream(response.body, file.size, signal)
  if (bytes.byteLength !== file.size) throw new Error(`Artifact file size mismatch: ${path}`)
  return bytes
}

function sortPackages(packages: ArtifactPackage[]) {
  const byId = new Map(packages.map((pkg) => [pkg.packageId, pkg]))
  const sorted: ArtifactPackage[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()
  const visit = (pkg: ArtifactPackage, depth = 1) => {
    checkBudget(depth, RUNTIME_LIMITS.depth, "package_depth")
    if (visiting.has(pkg.packageId)) throw new Error("Artifact package dependency cycle")
    if (visited.has(pkg.packageId)) return
    visiting.add(pkg.packageId)
    for (const dependency of pkg.dependencies) {
      const target = byId.get(dependency)
      if (target) visit(target, depth + 1)
    }
    visiting.delete(pkg.packageId)
    visited.add(pkg.packageId)
    sorted.push(pkg)
  }
  packages.forEach((pkg) => visit(pkg))
  return sorted
}

function validateSource(source: PlayerRenderSource) {
  if (source?.artifact?.schemaVersion !== 1 || !Array.isArray(source.artifact.packages) || !Array.isArray(source.artifact.files)) throw new Error("Player Artifact 契约无效。")
  if (source.artifact.digest !== runtime.sourceRevision) throw new Error("Player Artifact 与当前会话版本不一致。")
  checkRuntimeMetadata(source)
  checkBudget(source.artifact.files.length, RUNTIME_LIMITS.nodes, "artifact_files")
}

function applyOperation(operation: ViewerOperation, budget: ObservationBudget) {
  const target = runtime.objects.get(operation.targetId)
  if (!target) throw new Error(`Player 对象不存在：${operation.targetId}`)
  if (operation.op === "set-property") {
    setProperty(target, operation.property, operation.value)
  } else if (operation.op === "set-controller-page") {
    if (!(target instanceof fgui.GComponent)) throw new Error(`对象没有 Controller：${operation.targetId}`)
    const controller = target.getController(operation.controllerName)
    if (!controller || controller.getPageIndexById(operation.pageId) < 0) throw new Error(`Controller page 不存在：${operation.controllerName}/${operation.pageId}`)
    controller.selectedPageId = operation.pageId
  } else if (operation.op === "play-transition") {
    if (!(target instanceof fgui.GComponent)) throw new Error(`对象没有 Transition：${operation.targetId}`)
    const transition = target.getTransition(operation.transitionName)
    if (!transition) throw new Error(`Transition 不存在：${operation.transitionName}`)
    transition.play(null, operation.times ?? 1)
  } else {
    dispatchEvent(target, operation)
  }
  return snapshotObject(target, budget)
}

function setProperty(target: any, property: string, value: string | number | boolean | null) {
  if (property === "enabled") {
    target.grayed = value !== true
    target.touchable = value === true
  } else if (property === "text" && "text" in target) target.text = String(value ?? "")
  else if (property === "icon" && "icon" in target) target.icon = value == null ? null : String(value)
  else if (property === "visible") target.visible = value === true
  else if (property === "selected" && "selected" in target) target.selected = value === true
  else if (property === "value" && "value" in target && typeof value === "number") target.value = value
  else if (property === "selectedIndex" && "selectedIndex" in target && typeof value === "number") target.selectedIndex = value
  else throw new Error(`属性不适用于目标对象：${property}`)
}

function dispatchEvent(target: any, operation: Extract<ViewerOperation, { op: "dispatch-event" }>) {
  if (operation.event === "input") {
    if (typeof operation.data?.text === "string" && "text" in target) target.text = operation.data.text
    if (typeof operation.data?.value === "number" && "value" in target) target.value = operation.data.value
    if (typeof operation.data?.selectedIndex === "number" && "selectedIndex" in target) target.selectedIndex = operation.data.selectedIndex
    target.displayObject.event(Laya.Event.INPUT)
  } else if (operation.event === "scroll") {
    const pane = target.scrollPane
    if (!pane) throw new Error(`对象不可滚动：${operation.targetId}`)
    pane.setPosX(pane.posX + (operation.data?.deltaX ?? 0), false)
    pane.setPosY(pane.posY + (operation.data?.deltaY ?? 0), false)
    target.displayObject.event(Laya.Event.SCROLL)
  } else target.displayObject.event(Laya.Event.CLICK)
}

function createObservation(budget = new ObservationBudget()): ViewerObservation {
  if (!runtime.current) throw new Error("当前没有已播放组件。")
  return { objectTree: snapshotObject(runtime.current, budget), controllers: snapshotControllers(runtime.current, budget), availableTransitions: snapshotTransitions(runtime.current, budget) }
}

function snapshotObject(object: any, budget: ObservationBudget, depth = 1): ViewerObjectSnapshot {
  budget.node(depth)
  const snapshot: ViewerObjectSnapshot = {
    id: budget.text(runtime.paths.get(object)),
    name: budget.text(object.name),
    type: budget.text(object.constructor?.name || "GObject"),
    x: number(object.x),
    y: number(object.y),
    width: number(object.width),
    height: number(object.height),
    visible: object.visible !== false,
  }
  const kind = controlKind(object)
  if (kind) snapshot.controlKind = kind
  if ("grayed" in object) snapshot.enabled = object.grayed !== true
  if ("selected" in object && typeof object.selected === "boolean") snapshot.selected = object.selected
  if ("value" in object && typeof object.value === "number") snapshot.value = object.value
  if ("selectedIndex" in object && typeof object.selectedIndex === "number") snapshot.selectedIndex = object.selectedIndex
  if ("text" in object && typeof object.text === "string") snapshot.text = budget.text(object.text)
  if (object instanceof fgui.GComponent) {
    checkBudget(object.numChildren, RUNTIME_LIMITS.nodes, "observation_nodes")
    snapshot.children = Array.from({ length: object.numChildren }, (_, index) => snapshotObject(object.getChildAt(index), budget, depth + 1))
  }
  return snapshot
}

function snapshotControllers(root: any, budget: ObservationBudget) {
  const snapshots: ViewerObservation["controllers"] = []
  walkObjects(root, (object) => {
    if (!(object instanceof fgui.GComponent)) return
    for (const controller of object.controllers as any[]) {
      budget.entry()
      checkBudget(controller.pageCount, RUNTIME_LIMITS.observationEntries, "observation_pages")
      snapshots.push({
        targetId: budget.text(runtime.paths.get(object)),
        name: budget.text(controller.name),
        selectedIndex: controller.selectedIndex,
        pageId: budget.text(controller.selectedPageId),
        pageName: budget.text(controller.selectedPage),
        pages: Array.from({ length: controller.pageCount }, (_, index) => {
          budget.entry()
          return { id: budget.text(controller.getPageId(index)), name: budget.text(controller.getPageName(index)) }
        }),
      })
    }
  })
  return snapshots
}

function snapshotTransitions(root: any, budget: ObservationBudget): ViewerObservation["availableTransitions"] {
  const snapshots: ViewerObservation["availableTransitions"] = []
  walkObjects(root, (object) => {
    if (!(object instanceof fgui.GComponent)) return
    const targetId = runtime.paths.get(object) ?? ""
    for (const name of transitionNames(object)) {
      budget.entry()
      snapshots.push({ targetId: budget.text(targetId), name: budget.text(name) })
    }
  })
  return snapshots
}

function indexObjects(root: any, rootPath: string) {
  runtime.objects.clear()
  runtime.paths = new WeakMap()
  const index = (object: any, objectPath: string, depth = 1) => {
    checkBudget(depth, RUNTIME_LIMITS.depth, "scene_depth")
    checkBudget(runtime.objects.size + 1, RUNTIME_LIMITS.nodes, "scene_nodes")
    checkBudget(objectPath.length, RUNTIME_LIMITS.stringLength, "object_path")
    runtime.objects.set(objectPath, object)
    runtime.paths.set(object, objectPath)
    if (!(object instanceof fgui.GComponent)) return
    const used = new Set<string>()
    for (let childIndex = 0; childIndex < object.numChildren; childIndex += 1) {
      const child = object.getChildAt(childIndex)
      let segment = String(child.id || child.name || `@${childIndex}`).replaceAll("/", "%2F")
      if (used.has(segment)) segment = `${segment}:${childIndex}`
      used.add(segment)
      index(child, `${objectPath}/${segment}`, depth + 1)
    }
  }
  index(root, rootPath)
}

function bindInteractionEvents() {
  const relay = (eventName: ViewerInteractionEvent["event"]) => (event: any) => {
    const object = event?.target?.$owner
    const targetId = object && runtime.paths.get(object)
    if (!targetId) return
    const data: Record<string, string | number | boolean | null> = {}
    if ("text" in object && typeof object.text === "string") data.text = object.text
    if ("value" in object && typeof object.value === "number") data.value = object.value
    if ("selected" in object && typeof object.selected === "boolean") data.selected = object.selected
    if ("selectedIndex" in object && typeof object.selectedIndex === "number") data.selectedIndex = object.selectedIndex
    runtime.interactionSeq += 1
    post({ kind: "interaction", value: { runtimeEventSeq: runtime.interactionSeq, targetId, event: eventName, data } })
  }
  Laya.stage.on(Laya.Event.CLICK, Laya.stage, relay("click"))
  Laya.stage.on(Laya.Event.INPUT, Laya.stage, relay("input"))
  Laya.stage.on(Laya.Event.CHANGE, Laya.stage, relay("change"))
  Laya.stage.on(Laya.Event.MOUSE_WHEEL, Laya.stage, relay("scroll"))
}

function controlKind(object: any): ViewerControlKind | undefined {
  if (object instanceof fgui.GButton) return "button"
  if (object instanceof fgui.GComboBox) return "comboBox"
  if (object instanceof fgui.GLabel) return "label"
  if (object instanceof fgui.GTree) return "tree"
  if (object instanceof fgui.GList) return "list"
  if (object instanceof fgui.GSlider) return "slider"
  if (object instanceof fgui.GProgressBar) return "progressBar"
  if (object instanceof fgui.GScrollBar) return "scrollBar"
  if (object instanceof fgui.GTextInput) return "textInput"
  return undefined
}

function transitionNames(component: any) {
  if (!(component instanceof fgui.GComponent)) return []
  const result: string[] = []
  for (let index = 0; index < 1_000; index += 1) {
    const transition = component.getTransitionAt(index)
    if (!transition) break
    result.push(transition.name)
  }
  return result
}

function playTransition(component: any, name?: string) {
  if (!(component instanceof fgui.GComponent)) throw new Error("当前对象没有 Transition。")
  const transition = name ? component.getTransition(name) : component.getTransitionAt(0)
  if (!transition) throw new Error(name ? `Transition 不存在：${name}` : "当前组件没有 Transition。")
  transition.play()
}

function walkObjects(root: any, visit: (object: any) => void, depth = 1, budget = new ObservationBudget()) {
  budget.entry(depth)
  visit(root)
  if (!(root instanceof fgui.GComponent)) return
  for (let index = 0; index < root.numChildren; index += 1) walkObjects(root.getChildAt(index), visit, depth + 1, budget)
}

function resetArtifact() {
  runtime.loading.abort()
  runtime.loading = new AbortController()
  clearCurrent()
  for (const packageId of runtime.packageIds.reverse()) {
    try { fgui.UIPackage.removePackage(packageId) } catch { /* already removed */ }
  }
  runtime.packageIds = []
  runtime.artifactId = ""
  runtime.manifest = null
  for (const texture of runtime.ownedTextures) { try { texture.destroy?.() } catch {} }
  runtime.ownedTextures = []
  for (const url of runtime.loaderUrls) { try { Laya.loader.clearRes(url) } catch {} }
  runtime.loaderUrls.clear()
  runtime.imageUrls.clear()
  for (const url of runtime.blobUrls) URL.revokeObjectURL(url)
  runtime.blobUrls = []
  runtime.budget = new ResourceBudget()
}

function clearCurrent() {
  fgui.GRoot.inst?.removeChildren(0, -1, true)
  for (const object of runtime.ownedObjects) {
    if (!object.parent && !object.isDisposed) { try { object.dispose() } catch {} }
  }
  runtime.ownedObjects.clear()
  runtime.budget.nodes = 0
  runtime.current = null
  runtime.objects.clear()
  runtime.paths = new WeakMap()
}

function installConstructionBudget() {
  // Guard the native allocation seams, not a second parser of FairyGUI component bytecode.
  const factory = fgui.UIObjectFactory.newObject
  let factoryDepth = 0
  let componentDepth = 0
  fgui.UIObjectFactory.newObject = function (...args: any[]) {
    if (factoryDepth === 0) runtime.budget.node(Math.max(1, componentDepth + 1))
    factoryDepth++
    try {
      const object = factory.apply(this, args)
      if (object) runtime.ownedObjects.add(object)
      return object
    } finally { factoryDepth-- }
  }
  const construct = fgui.GComponent.prototype.constructFromResource2
  fgui.GComponent.prototype.constructFromResource2 = function (...args: any[]) {
    componentDepth++
    try {
      checkBudget(componentDepth, RUNTIME_LIMITS.depth, "scene_depth")
      return construct.apply(this, args)
    } finally { componentDepth-- }
  }
  const create = fgui.UIPackage.prototype.internalCreateObject
  fgui.UIPackage.prototype.internalCreateObject = function (...args: any[]) {
    const constructing = fgui.UIPackage._constructing
    try { return create.apply(this, args) }
    finally { fgui.UIPackage._constructing = constructing }
  }
  const texture = Laya.Texture.create
  Laya.Texture.create = function (...args: any[]) {
    runtime.budget.texture()
    const result = texture.apply(this, args)
    runtime.ownedTextures.push(result)
    return result
  }
  // External Loader URLs would bypass the validated image bytes/cache above.
  fgui.GLoader.prototype.loadExternal = function () { throw new Error("Player external Loader URLs are outside the runtime resource budget") }
  fgui.GLoader3D.prototype.loadExternal = function () { throw new Error("Player external 3D resources are outside the runtime resource budget") }
}

function resize() {
  if (!fgui.GRoot?.inst) return
  fgui.GRoot.inst.setSize(Math.max(1, innerWidth), Math.max(1, innerHeight))
  layoutCurrent()
}

function layoutCurrent() {
  const current = runtime.current
  if (!current) return
  current.setScale(runtime.zoom, runtime.zoom)
  current.setXY(Math.max(0, (fgui.GRoot.inst.width - current.width * runtime.zoom) / 2), Math.max(0, (fgui.GRoot.inst.height - current.height * runtime.zoom) / 2))
}

function artifactFileUrl(artifactId: string, filePath: string) {
  return `/api/artifacts/${encodeURIComponent(artifactId)}/files/${filePath.split("/").map(encodeURIComponent).join("/")}`
}

function respond(requestId: string, value?: unknown, error?: string) {
  post(error ? { kind: "response", requestId, ok: false, error } : { kind: "response", requestId, ok: true, value })
}

function post(message: ViewerRuntimeMessage) {
  runtime.port?.postMessage(message)
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function formatError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
}
