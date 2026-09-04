import { parseJta, type UamAssetResource, type UamComponentResource, type UamDisplayNode, type UamGearBinding, type UamTextProperties, type UamTransitionItem, type UamTransitionModel } from "@openfairygui/core"
import {
  isViewerConnectMessage,
  type ViewerControlKind,
  type ViewerCommand,
  type ViewerDiagnostic,
  type ViewerDispatchEventOperation,
  type ViewerInteractionEvent,
  type ViewerObjectSnapshot,
  type ViewerObservation,
  type ViewerOperation,
  type ViewerRendered,
  type ViewerRuntimeMessage,
  type ViewerScene,
} from "../viewer-protocol"

declare const Laya: any
declare const fgui: any

type ComponentRecord = {
  path: string
  packageId: string
  resource: UamComponentResource
  object: any
  nodes: Map<string, any>
  controllers: Map<string, number>
  previousControllers: Map<string, number>
}

type InteractiveControl = {
  path: string
  kind: ViewerControlKind
  object: any
  record: ComponentRecord
  ownerRecord: ComponentRecord
  enabled: boolean
  touchable: boolean
  selected: boolean
  value: number
  min: number
  max: number
  selectedIndex: number
  visibleItemCount: number
  selectionController: string
  items: string[]
  icons: string[]
  title: string
  selectedTitle: string
  icon: string
  selectedIcon: string
  mode: number
  downEffect: number
  downEffectValue: number
  wholeNumbers: boolean
  titleType: number
  relatedController: string
  relatedPage: string
  over: boolean
  down: boolean
  baseAlpha: number
  baseScaleX: number
  baseScaleY: number
  visual: { barH?: any; barV?: any; grip?: any; barWidth?: number; barHeight?: number; barY?: number; gripX?: number; gripY?: number } | null
  popup: any | null
}

type ScrollState = {
  path: string
  object: any
  scrollType: number
  x: number
  y: number
  maxX: number
  maxY: number
}

type PreparedAsset = {
  resource: UamAssetResource
  url?: string
  texture?: any
  frames?: Array<{ addDelay: number; texture?: any }>
}

const runtime = {
  sourceRevision: "",
  scene: null as ViewerScene | null,
  current: null as any,
  rootRecord: null as ComponentRecord | null,
  objects: new Map<string, any>(),
  objectPaths: new WeakMap<object, string>(),
  records: new Map<string, ComponentRecord>(),
  recordByObject: new WeakMap<object, ComponentRecord>(),
  controls: new Map<string, InteractiveControl>(),
  scrollAreas: new Map<string, ScrollState>(),
  listItemOwners: new Map<string, { listPath: string; index: number }>(),
  components: new Map<string, ViewerScene["components"][number]>(),
  assets: new Map<string, ViewerScene["assets"][number]>(),
  prepared: new Map<string, PreparedAsset>(),
  diagnostics: [] as ViewerDiagnostic[],
  blobUrls: [] as string[],
  loaderUrls: [] as string[],
  ownedTextures: [] as any[],
  bitmapFonts: [] as string[],
  tweeners: [] as any[],
  zoom: 1,
  background: "#202226",
  port: null as MessagePort | null,
  interactionSeq: 0,
}

let bootPromise: Promise<void> | null = null
let commandQueue = Promise.resolve()

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (event.origin !== location.origin || !isViewerConnectMessage(event.data) || event.ports.length !== 1) return
  void connect(event.data.sourceRevision, event.ports[0])
})

async function connect(sourceRevision: string, port: MessagePort) {
  try {
    await (bootPromise ??= boot())
    resetScene()
    runtime.port?.close()
    runtime.port = port
    runtime.sourceRevision = sourceRevision
    runtime.interactionSeq = 0
    commandQueue = Promise.resolve()
    port.onmessage = (event: MessageEvent<ViewerCommand>) => {
      commandQueue = commandQueue.then(() => handleCommand(event.data))
    }
    port.start()
    post({ kind: "ready", sourceRevision })
  } catch (error) {
    port.postMessage({ kind: "fatal", error: formatError(error) } satisfies ViewerRuntimeMessage)
  }
}

async function boot() {
  if (typeof Laya === "undefined" || typeof fgui === "undefined") throw new Error("LayaAir 或 FairyGUI Web runtime 未加载。")
  const stageConfig = {
    scaleMode: "full",
    backgroundColor: runtime.background,
    designWidth: Math.max(1, innerWidth),
    designHeight: Math.max(1, innerHeight),
    alignV: "top",
    alignH: "left",
    screenMode: "none",
  }
  Object.assign(Laya.PlayerConfig, { resolution: stageConfig })
  Object.assign(Laya.Config, { FPS: 60, isAntialias: true, useRetinalCanvas: false, isAlpha: false })
  await Laya.init(stageConfig)
  if (!fgui.GRoot.inst.displayObject.parent) Laya.stage.addChild(fgui.GRoot.inst.displayObject)
  resize()
  window.addEventListener("resize", resize)
}

async function handleCommand(command: ViewerCommand) {
  try {
    if (!command || typeof command.requestId !== "string") return
    switch (command.kind) {
      case "render": {
        const value = await renderScene(command.scene)
        post({ kind: "rendered", value })
        respond(command.requestId, value)
        return
      }
      case "set-view":
        runtime.zoom = Math.min(4, Math.max(0.1, command.zoom))
        if (!CSS.supports("color", command.background)) throw new Error("无效的 Viewer 背景颜色。")
        runtime.background = command.background
        Laya.stage.bgColor = command.background
        layoutCurrent()
        respond(command.requestId)
        return
      case "play-transition":
        playRootTransition(command.transitionName)
        respond(command.requestId)
        return
      case "observe":
        respond(command.requestId, createObservation())
        return
      case "apply-operations": {
        if (!runtime.current) throw new Error("请先渲染一个 FairyGUI 组件。")
        const observations = command.operations.map(applyOperation)
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
        respond(command.requestId, { observations, observation: createObservation() })
        return
      }
      case "capture": {
        const canvas = Laya.stage.drawToCanvas(Math.max(1, innerWidth), Math.max(1, innerHeight), 0, 0)?.source as HTMLCanvasElement | undefined
        if (!canvas) throw new Error("LayaAir Canvas 尚未创建。")
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Canvas 截图失败。")), "image/png"))
        const data = await blob.arrayBuffer()
        runtime.port?.postMessage({ kind: "response", requestId: command.requestId, ok: true, value: { data, type: blob.type } } satisfies ViewerRuntimeMessage, [data])
        return
      }
    }
  } catch (error) {
    respond(command.requestId, undefined, formatError(error))
  }
}

async function renderScene(scene: ViewerScene): Promise<ViewerRendered> {
  validateScene(scene)
  resetScene()
  runtime.scene = scene
  runtime.diagnostics = scene.diagnostics.map((item) => ({ ...item }))
  runtime.components = new Map(scene.components.map((entry) => [resourceKey(entry.packageId, entry.resource.id), entry]))
  runtime.assets = new Map(scene.assets.map((entry) => [resourceKey(entry.packageId, entry.resource.id), entry]))
  await prepareAssets()

  const rootEntry = runtime.components.get(resourceKey(scene.root.packageId, scene.root.resourceId))
  if (!rootEntry) throw new Error(`Viewer Scene 缺少根组件 ${scene.root.packageId}/${scene.root.resourceId}。`)
  const rootPath = `/${scene.root.packageId}/${scene.root.resourceId}`
  const current = await buildComponent(scene.root.packageId, scene.root.resourceId, rootPath, new Set())
  runtime.current = current
  runtime.rootRecord = runtime.records.get(rootPath) ?? null
  fgui.GRoot.inst.removeChildren(0, -1, false)
  fgui.GRoot.inst.addChild(current)
  layoutCurrent()
  playAutoTransitions()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

  return {
    packageId: rootEntry.packageId,
    componentId: rootEntry.resource.id,
    packageName: rootEntry.packageName,
    componentName: rootEntry.resource.name,
    width: Number(current.width || 0),
    height: Number(current.height || 0),
    transitions: rootEntry.resource.component.transitions.map(({ name }) => name),
    diagnostics: runtime.diagnostics.map((item) => ({ ...item })),
    objectTree: snapshotObject(current),
    controllers: snapshotControllers(),
    availableTransitions: snapshotTransitions(),
  }
}

function validateScene(scene: ViewerScene) {
  if (scene?.schemaVersion !== 1 || !Array.isArray(scene.components) || !Array.isArray(scene.assets)) throw new Error("Viewer Scene 契约无效。")
  if (scene.sourceRevision !== runtime.sourceRevision) throw new Error("Viewer Scene 与当前工程版本不一致，请刷新工程。")
  if (scene.components.length + scene.assets.length > 5_000) throw new Error("Viewer Scene 资源数量超过上限。")
  let totalBytes = 0
  for (const asset of scene.assets) {
    if (!(asset.data instanceof ArrayBuffer)) throw new Error(`Viewer 资产 ${asset.packageId}/${asset.resource.id} 缺少二进制数据。`)
    totalBytes += asset.data.byteLength
  }
  if (totalBytes > 256 * 1024 * 1024) throw new Error("Viewer Scene 二进制资源超过 256 MiB。")
}

async function prepareAssets() {
  for (const [key, entry] of runtime.assets) {
    const resource = entry.resource as UamAssetResource
    const prepared: PreparedAsset = { resource }
    if (resource.kind === "image") {
      prepared.texture = await loadTexture(entry.data, resource.sourcePath || resource.fileName || resource.name)
    } else if (resource.kind === "movieClip") {
      prepared.frames = await loadMovieClip(entry.data, resource)
    } else {
      prepared.url = createBlobUrl(entry.data, mimeType(resource.sourcePath || resource.fileName || resource.file || resource.name))
    }
    runtime.prepared.set(key, prepared)
  }
  for (const [key, entry] of runtime.assets) {
    if (entry.resource.kind === "font") prepareBitmapFont(key, entry.resource as UamAssetResource, entry.data)
  }
}

async function loadTexture(data: ArrayBuffer, path: string) {
  const url = createBlobUrl(data, mimeType(path, data))
  runtime.loaderUrls.push(url)
  const texture = await fgui.AssetProxy.inst.load(url, Laya.Loader.IMAGE)
  if (!texture) throw new Error(`无法解码 Viewer 图片资源：${path}`)
  return texture
}

async function loadMovieClip(data: ArrayBuffer, resource: UamAssetResource) {
  const parsed = parseJta(new Uint8Array(data))
  const textures = await Promise.all(parsed.textures.map((texture, index) => loadTexture(texture.raw.slice().buffer, `${resource.name}#${index}.png`)))
  return parsed.frames.map((frame, index) => {
    if (frame.textureIndex < 0) return { addDelay: movieFrameDelay(resource, index, parsed.fps) }
    const base = textures[frame.textureIndex]
    const texture = Laya.Texture.create(
      base,
      0,
      0,
      frame.rectWidth || base.width,
      frame.rectHeight || base.height,
      frame.rectX,
      frame.rectY,
      parsed.boundsWidth,
      parsed.boundsHeight,
    )
    runtime.ownedTextures.push(texture)
    return { addDelay: movieFrameDelay(resource, index, parsed.fps), texture }
  })
}

function movieFrameDelay(resource: UamAssetResource, index: number, fps: number) {
  return resource.kind === "movieClip"
    ? resource.movieClip.frames[index]?.addDelay ?? Math.round(1_000 / Math.max(1, fps))
    : 0
}

function prepareBitmapFont(key: string, resource: UamAssetResource, data: ArrayBuffer) {
  const parsed = parseFnt(new TextDecoder().decode(data))
  const font = new Laya.BitmapFont()
  const metadata = resource.kind === "font" ? resource.metadata ?? {} : {}
  font.tint = metadata.tint !== false
  font.autoScaleSize = metadata.autoScale === true || parsed.resizable
  font.fontSize = Math.max(1, parsed.fontSize || numberValue(metadata.fontSize, 12))
  font.lineHeight = Math.max(font.fontSize, parsed.lineHeight || numberValue(metadata.lineHeight, font.fontSize))
  const [packageId, resourceId] = splitResourceKey(key)
  const mainTextureId = typeof metadata.textureId === "string" ? metadata.textureId : ""
  const mainTexture = mainTextureId ? runtime.prepared.get(resourceKey(packageId, mainTextureId))?.texture : undefined

  for (const glyph of parsed.glyphs) {
    let texture = glyph.img ? runtime.prepared.get(resourceKey(packageId, glyph.img))?.texture : undefined
    if (!texture && mainTexture && glyph.width > 0 && glyph.height > 0) {
      texture = Laya.Texture.create(mainTexture, glyph.x, glyph.y, glyph.width, glyph.height)
      runtime.ownedTextures.push(texture)
    }
    if (!texture) {
      addDiagnostic("warning", "font_glyph_missing", `font:${key}`, `字体 ${resource.name} 的字符 ${glyph.charId} 缺少图片。`)
      continue
    }
    font.dict[glyph.charId] = {
      x: glyph.xoffset,
      y: glyph.yoffset,
      width: glyph.width || texture.width,
      height: glyph.height || texture.height,
      advance: glyph.xadvance || numberValue(metadata.xAdvance, glyph.width || texture.width),
      texture,
    }
  }
  const fontName = `ui://${packageId}${resourceId}`
  Laya.Text.registerBitmapFont(fontName, font)
  runtime.bitmapFonts.push(fontName)
}

async function buildComponent(packageId: string, resourceId: string, path: string, ancestry: Set<string>): Promise<any> {
  const key = resourceKey(packageId, resourceId)
  const entry = runtime.components.get(key)
  if (!entry) return missingComponent(path, `找不到组件 ${key}`)
  if (ancestry.has(key)) return missingComponent(path, `循环组件引用 ${entry.packageName}/${entry.resource.name}`)
  const nextAncestry = new Set(ancestry).add(key)
  const object = new fgui.GComponent()
  object.name = entry.resource.name
  object.setSize(entry.resource.component.size.width, entry.resource.component.size.height)
  object.opaque = entry.resource.component.properties.opaque
  registerObject(path, object)
  const record: ComponentRecord = {
    path,
    packageId,
    resource: entry.resource,
    object,
    nodes: new Map(),
    controllers: new Map(entry.resource.component.controllers.map((controller) => [controller.name, controller.selectedIndex])),
    previousControllers: new Map(entry.resource.component.controllers.map((controller) => [controller.name, controller.selectedIndex])),
  }
  runtime.records.set(path, record)
  runtime.recordByObject.set(object, record)

  if (entry.resource.component.properties.bgColorEnabled) {
    const background = new fgui.GGraph()
    background.name = "__background"
    background.setSize(object.width, object.height)
    background.drawRect(0, null, entry.resource.component.properties.bgColor || "#000000")
    background.touchable = false
    object.addChild(background)
  }

  for (const node of entry.resource.component.displayList) {
    const nodePath = `${path}/${node.id}`
    const child = await buildNode(record, node, nodePath, nextAncestry)
    record.nodes.set(node.id, child)
    object.addChild(child)
  }
  linkGroupsAndRelations(record)
  applyRecordGears(record)
  applyComponentMask(record)
  if (entry.resource.component.properties.overflow === 1) object.displayObject.scrollRect = new Laya.Rectangle(0, 0, object.width, object.height)
  else if (entry.resource.component.properties.overflow === 2) {
    object.displayObject.scrollRect = new Laya.Rectangle(0, 0, object.width, object.height)
    installScrollArea(path, object, entry.resource.component.properties.scrollType)
  }
  configureComponentControl(record)
  return object
}

async function buildNode(record: ComponentRecord, node: UamDisplayNode, path: string, ancestry: Set<string>) {
  let object: any
  let naturalWidth = 0
  let naturalHeight = 0

  if (node.kind === "component") {
    object = await buildComponent(node.resource.packageId || record.packageId, node.resource.resourceId, path, ancestry)
    naturalWidth = object.width
    naturalHeight = object.height
  } else if (["button", "label", "comboBox", "progressBar", "slider", "scrollBar"].includes(node.kind)) {
    const derived = node as typeof node & { src: string; packageId: string }
    object = derived.src
      ? await buildComponent(derived.packageId || record.packageId, derived.src, path, ancestry)
      : new fgui.GComponent()
    naturalWidth = object.width
    naturalHeight = object.height
  } else if (node.kind === "image") {
    object = new fgui.GImage()
    const prepared = runtime.prepared.get(resourceKey(node.resource.packageId || record.packageId, node.resource.resourceId))
    const resource = prepared?.resource
    if (prepared && resource?.kind === "image") {
      object.image.texture = prepared.texture
      naturalWidth = resource.dimensions?.width || prepared.texture?.width || 0
      naturalHeight = resource.dimensions?.height || prepared.texture?.height || 0
      if (resource.image.scale9Grid) object.image.scale9Grid = new Laya.Rectangle(...resource.image.scale9Grid)
      object.image.scaleByTile = resource.image.scaleOption === 2
      object.image.tileGridIndice = resource.image.tileGridIndice
    } else addDiagnostic("error", "image_missing", path, `图片节点 ${node.name || node.id} 缺少源资源。`)
  } else if (node.kind === "movieClip") {
    object = new fgui.GMovieClip()
    const prepared = runtime.prepared.get(resourceKey(node.resource.packageId || record.packageId, node.resource.resourceId))
    if (prepared?.resource.kind === "movieClip" && object.displayObject instanceof fgui.MovieClip) {
      naturalWidth = prepared.resource.dimensions.width
      naturalHeight = prepared.resource.dimensions.height
      object.displayObject.interval = prepared.resource.movieClip.interval
      object.displayObject.repeatDelay = prepared.resource.movieClip.repeatDelay
      object.displayObject.swing = prepared.resource.movieClip.swing
      object.displayObject.frames = prepared.frames
    } else addDiagnostic("error", "movie_clip_missing", path, `MovieClip 节点 ${node.name || node.id} 缺少 JTA 资源。`)
  } else if (node.kind === "text") object = new fgui.GTextField()
  else if (node.kind === "richText") object = new fgui.GRichTextField()
  else if (node.kind === "textInput") object = new fgui.GTextInput()
  else if (node.kind === "graph") object = new fgui.GGraph()
  else if (node.kind === "group") object = new fgui.GGroup()
  else if (node.kind === "list") object = new fgui.GList()
  else if (node.kind === "tree") object = new fgui.GTree()
  else if (node.kind === "loader") object = await buildLoader(record, node, path, ancestry)
  else {
    object = new fgui.GComponent()
    addDiagnostic("warning", "node_runtime_partial", path, `节点类型 ${node.kind} 暂无对应的 Laya 运行时内容。`)
  }

  registerObject(path, object)
  object.name = node.name || node.id
  applyNodeBase(object, node, naturalWidth, naturalHeight)
  await applyNodeSpecific(record, object, node, path)
  if (node.kind === "component") applyComponentInstanceProperties(object, node, path)
  configureNodeControl(record, object, node, path)
  return object
}

async function buildLoader(record: ComponentRecord, node: Extract<UamDisplayNode, { kind: "loader" }>, path: string, ancestry: Set<string>) {
  const ref = parseFairyUrl(node.url)
  if (ref) {
    const component = runtime.components.get(resourceKey(ref.packageId, ref.resourceId))
    if (component) return buildComponent(ref.packageId, ref.resourceId, path, ancestry)
  }
  const loader = new fgui.GLoader()
  if (!ref) {
    if (node.url) addDiagnostic("warning", "external_loader_unsupported", path, `Loader 外部 URL 不在只读工程依赖中：${node.url}`)
    return loader
  }
  const prepared = runtime.prepared.get(resourceKey(ref.packageId, ref.resourceId))
  if (prepared?.resource.kind === "image") {
    loader.content.texture = prepared.texture
    loader.sourceWidth = prepared.resource.dimensions?.width || prepared.texture?.width || 0
    loader.sourceHeight = prepared.resource.dimensions?.height || prepared.texture?.height || 0
  } else if (prepared?.resource.kind === "movieClip") {
    loader.content.interval = prepared.resource.movieClip.interval
    loader.content.repeatDelay = prepared.resource.movieClip.repeatDelay
    loader.content.swing = prepared.resource.movieClip.swing
    loader.content.frames = prepared.frames
    loader.sourceWidth = prepared.resource.dimensions.width
    loader.sourceHeight = prepared.resource.dimensions.height
  } else addDiagnostic("warning", "loader_resource_missing", path, `Loader 资源不可呈现：${node.url}`)
  return loader
}

function applyNodeBase(object: any, node: UamDisplayNode, naturalWidth: number, naturalHeight: number) {
  object.minWidth = node.minSize.width
  object.minHeight = node.minSize.height
  object.maxWidth = node.maxSize.width
  object.maxHeight = node.maxSize.height
  object.setSize(node.size.width || naturalWidth, node.size.height || naturalHeight)
  object.setXY(node.position.x, node.position.y)
  if (node.pivot) object.setPivot(node.pivot.x, node.pivot.y, node.pivotAsAnchor === true)
  object.setScale(node.scale.x, node.scale.y)
  object.setSkew(node.skew.x, node.skew.y)
  object.visible = node.visible
  object.touchable = node.touchable
  object.grayed = node.grayed
  object.alpha = node.alpha
  object.rotation = node.rotation
  object.tooltips = node.tooltips || null
  if (node.blendMode !== "normal" && node.blendMode !== "none") object.blendMode = node.blendMode
  if (node.filter) addDiagnostic("warning", "filter_runtime_partial", objectPath(object), `滤镜 ${node.filter} 未纳入 Viewer 首版渲染。`)
  const scroll = runtime.scrollAreas.get(objectPath(object))
  if (scroll) applyScroll(scroll, 0, 0)
}

async function applyNodeSpecific(record: ComponentRecord, object: any, node: UamDisplayNode, path: string) {
  if (node.kind === "image") {
    object.color = node.color
    object.flip = node.flip
    object.fillMethod = node.fillMethod
    object.fillOrigin = node.fillOrigin
    object.fillClockwise = node.fillClockwise
    object.fillAmount = normalizeFillAmount(node.fillAmount)
  } else if (node.kind === "movieClip") {
    object.color = node.color
    object.frame = node.frame
    object.playing = node.playing
  } else if (node.kind === "text" || node.kind === "richText" || node.kind === "textInput") {
    applyTextProperties(object, node)
    if (node.kind === "textInput") {
      object.promptText = node.promptText
      object.maxLength = node.maxLength
      object.restrict = node.restrict || null
      object.password = node.password
    }
  } else if (node.kind === "graph") {
    if (node.graphType === 1) object.drawRect(node.lineSize, node.lineColor, node.fillColor, node.cornerRadius)
    else if (node.graphType === 2) object.drawEllipse(node.lineSize, node.lineColor, node.fillColor)
    else if (node.graphType === 3) object.drawPolygon(node.lineSize, node.lineColor, node.fillColor, node.points ?? [])
    else if (node.graphType === 4) object.drawRegularPolygon(node.lineSize, node.lineColor, node.fillColor, node.sides, node.startAngle, node.distances)
  } else if (node.kind === "group") {
    object.layout = node.layout
    object.lineGap = node.lineGap
    object.columnGap = node.columnGap
    object.excludeInvisibles = node.excludeInvisibles
    object.autoSizeDisabled = node.autoSizeDisabled
    object.mainGridIndex = node.mainGridIndex
  } else if (node.kind === "list" || node.kind === "tree") {
    object.layout = node.layout
    object.lineGap = node.lineGap
    object.columnGap = node.columnGap
    object.lineCount = node.lineCount
    object.columnCount = node.columnCount
    object.selectionMode = node.selectionMode
    object.autoResizeItem = node.autoResizeItem
    object.align = horizontalAlign(node.align)
    object.verticalAlign = verticalAlign(node.vAlign)
    await populateList(record, object, node, path)
  } else if (node.kind === "loader") {
    object.fill = node.fill
    object.shrinkOnly = node.shrinkOnly
    object.autoSize = node.autoSize
    object.align = horizontalAlign(node.align)
    object.verticalAlign = verticalAlign(node.vAlign)
    object.playing = node.playing
    object.frame = node.frame
    object.color = node.color
    object.fillMethod = node.fillMethod
    object.fillOrigin = node.fillOrigin
    object.fillClockwise = node.fillClockwise
    object.fillAmount = normalizeFillAmount(node.fillAmount)
    object.updateLayout?.()
  } else if (["button", "label", "comboBox", "progressBar", "slider"].includes(node.kind)) {
    applyDerivedProperties(object, node)
  }
}

async function populateList(record: ComponentRecord, object: any, node: Extract<UamDisplayNode, { kind: "list" | "tree" }>, path: string) {
  for (let index = 0; index < node.listItems.length; index += 1) {
    const item = node.listItems[index]
    const ref = parseFairyUrl(item.url || node.defaultItem)
    if (!ref || !runtime.components.has(resourceKey(ref.packageId, ref.resourceId))) continue
    const child = await buildComponent(ref.packageId, ref.resourceId, `${path}/item:${index}`, new Set([resourceKey(record.packageId, record.resource.id)]))
    if (item.name) child.name = item.name
    setTextTarget(child, item.title)
    setIconTarget(child, item.icon)
    const control = runtime.controls.get(objectPath(child))
    if (control) {
      control.title = item.title || ""
      control.icon = item.icon || ""
    }
    object.addChild(child)
  }
}

function applyTextProperties(object: any, node: UamTextProperties) {
  object.font = node.font || "Arial"
  object.fontSize = node.fontSize
  object.color = node.color
  object.align = horizontalAlign(node.align)
  object.verticalAlign = verticalAlign(node.vAlign)
  object.leading = node.leading
  object.letterSpacing = node.letterSpacing
  object.autoSize = node.autoSize
  object.singleLine = node.singleLine
  object.ubbEnabled = node.ubbEnabled
  object.underline = node.underline
  object.italic = node.italic
  object.bold = node.bold
  object.strokeColor = node.strokeColor || "#000000"
  object.stroke = node.strokeSize
  object.text = node.text
}

function applyDerivedProperties(object: any, node: UamDisplayNode) {
  if (node.kind === "button" || node.kind === "label" || node.kind === "comboBox") {
    setTextTarget(object, node.title)
    setIconTarget(object, node.icon)
    const title = findChildByName(object, "title")
    if (title) {
      if (node.titleColor) title.color = node.titleColor
      if (node.titleFontSize) title.fontSize = node.titleFontSize
    }
  }
  if (node.kind === "progressBar" || node.kind === "slider") setValueTarget(object, node.value, node.min, node.max)
}

function applyComponentInstanceProperties(object: any, node: Extract<UamDisplayNode, { kind: "component" }>, path: string) {
  const properties = node.instanceProperties
  if (!properties) return
  if ("title" in properties) setTextTarget(object, properties.title)
  if ("icon" in properties) setIconTarget(object, properties.icon)
  if (properties.extensionType === "ProgressBar" || properties.extensionType === "Slider") setValueTarget(object, properties.value, properties.min, properties.max)
  for (const override of node.propertyOverrides ?? []) {
    const target = findChildByPath(object, override.target)
    if (target?.setProp) target.setProp(override.propertyId, override.value)
  }
}

function configureComponentControl(record: ComponentRecord) {
  const kind = extensionControlKind(record.resource.component.properties.extensionType)
  if (kind) configureControl(record, record, record.object, kind, record.resource.component.properties)
}

function configureNodeControl(ownerRecord: ComponentRecord, object: any, node: UamDisplayNode, path: string) {
  if (node.kind === "component" && node.instanceProperties) {
    const kind = extensionControlKind(node.instanceProperties.extensionType)
    const record = runtime.recordByObject.get(object) ?? ownerRecord
    if (kind) configureControl(record, ownerRecord, object, kind, node.instanceProperties)
    return
  }
  if (["button", "label", "comboBox", "progressBar", "slider", "scrollBar"].includes(node.kind)) {
    const record = runtime.recordByObject.get(object) ?? ownerRecord
    configureControl(record, ownerRecord, object, node.kind as ViewerControlKind, node)
    return
  }
  if (node.kind === "textInput") {
    configureControl(ownerRecord, ownerRecord, object, "textInput", node)
    return
  }
  if (node.kind === "list" || node.kind === "tree") {
    const control = configureControl(ownerRecord, ownerRecord, object, node.kind, node)
    for (let index = 0; index < object.numChildren; index += 1) {
      const child = object.getChildAt(index)
      const childPath = objectPath(child)
      runtime.listItemOwners.set(childPath, { listPath: path, index })
      child.on(Laya.Event.CLICK, child, () => selectListItem(control, index, true))
    }
    if (node.overflow === 2) {
      object.displayObject.scrollRect = new Laya.Rectangle(0, 0, object.width, object.height)
      installScrollArea(path, object, node.scrollType)
    }
  }
}

function extensionControlKind(extensionType: string): ViewerControlKind | null {
  const normalized = extensionType.trim().toLocaleLowerCase()
  if (normalized === "button") return "button"
  if (normalized === "combobox") return "comboBox"
  if (normalized === "label") return "label"
  if (normalized === "progressbar") return "progressBar"
  if (normalized === "slider") return "slider"
  if (normalized === "scrollbar") return "scrollBar"
  return null
}

function configureControl(record: ComponentRecord, ownerRecord: ComponentRecord, object: any, kind: ViewerControlKind, source: any) {
  const path = objectPath(object)
  if ("opaque" in object) object.opaque = true
  else if (object.displayObject) object.displayObject.hitArea = new Laya.Rectangle(0, 0, object.width, object.height)
  let control = runtime.controls.get(path)
  if (!control) {
    control = {
      path,
      kind,
      object,
      record,
      ownerRecord,
      enabled: object.grayed !== true,
      touchable: object.touchable !== false,
      selected: false,
      value: 0,
      min: 0,
      max: 100,
      selectedIndex: -1,
      visibleItemCount: 10,
      selectionController: "",
      items: [],
      icons: [],
      title: "",
      selectedTitle: "",
      icon: "",
      selectedIcon: "",
      mode: 0,
      downEffect: 0,
      downEffectValue: 0.8,
      wholeNumbers: false,
      titleType: 0,
      relatedController: "",
      relatedPage: "",
      over: false,
      down: false,
      baseAlpha: object.alpha,
      baseScaleX: object.scaleX,
      baseScaleY: object.scaleY,
      visual: null,
      popup: null,
    }
    runtime.controls.set(path, control)
    bindControl(control)
  }
  control.kind = kind
  control.record = record
  control.ownerRecord = ownerRecord
  if (typeof source.checked === "boolean") control.selected = source.checked
  if (typeof source.value === "number") control.value = source.value
  if (typeof source.min === "number") control.min = source.min
  if (typeof source.max === "number") control.max = source.max
  if (typeof source.selectedIndex === "number") control.selectedIndex = source.selectedIndex
  if (typeof source.visibleItemCount === "number") control.visibleItemCount = source.visibleItemCount
  if (typeof source.selectionController === "string") control.selectionController = source.selectionController
  if (Array.isArray(source.items)) control.items = source.items.map(String)
  if (Array.isArray(source.icons)) control.icons = source.icons.map(String)
  if (typeof source.title === "string") control.title = source.title
  if (typeof source.selectedTitle === "string") control.selectedTitle = source.selectedTitle
  if (typeof source.icon === "string") control.icon = source.icon
  if (typeof source.selectedIcon === "string") control.selectedIcon = source.selectedIcon
  if (typeof source.mode === "number") control.mode = source.mode
  else if (typeof source.buttonMode === "number") control.mode = source.buttonMode
  if (typeof source.downEffect === "number") control.downEffect = source.downEffect
  if (typeof source.downEffectValue === "number") control.downEffectValue = source.downEffectValue
  if (typeof source.wholeNumbers === "boolean") control.wholeNumbers = source.wholeNumbers
  if (typeof source.titleType === "number") control.titleType = source.titleType
  if (typeof source.controller === "string") control.relatedController = source.controller
  if (typeof source.page === "string") control.relatedPage = source.page
  control.enabled = typeof source.enabled === "boolean" ? source.enabled : object.grayed !== true
  control.touchable = object.touchable !== false
  control.baseAlpha = object.alpha
  control.baseScaleX = object.scaleX
  control.baseScaleY = object.scaleY
  if (kind === "slider" || kind === "progressBar" || kind === "scrollBar") control.visual = null
  applyControlVisual(control)
  return control
}

function bindControl(control: InteractiveControl) {
  if (control.kind === "button") {
    control.object.on(Laya.Event.ROLL_OVER, control.object, () => {
      control.over = true
      updateButtonState(control)
    })
    control.object.on(Laya.Event.ROLL_OUT, control.object, () => {
      control.over = false
      updateButtonState(control)
    })
    control.object.on(Laya.Event.MOUSE_DOWN, control.object, () => {
      if (!control.enabled) return
      control.down = true
      updateButtonState(control)
      Laya.stage.once(Laya.Event.MOUSE_UP, control.object, () => {
        control.down = false
        updateButtonState(control)
      })
    })
    control.object.on(Laya.Event.CLICK, control.object, () => activateButton(control, true))
  } else if (control.kind === "comboBox") {
    control.object.on(Laya.Event.CLICK, control.object, () => activateComboBox(control, undefined, true))
  } else if (control.kind === "slider" || control.kind === "scrollBar") {
    control.object.on(Laya.Event.MOUSE_DOWN, control.object, (event: any) => beginSliderDrag(control, event))
  } else if (control.kind === "textInput") {
    control.object.on(Laya.Event.INPUT, control.object, () => {
      emitInteraction(control.path, "input", { text: String(control.object.text ?? "") })
    })
  }
}

function applyControlVisual(control: InteractiveControl) {
  control.object.touchable = control.enabled && control.touchable
  control.object.grayed = !control.enabled
  if (control.kind === "button") {
    setTextTarget(control.object, control.selected && control.selectedTitle ? control.selectedTitle : control.title)
    setIconTarget(control.object, control.selected && control.selectedIcon ? control.selectedIcon : control.icon)
    updateButtonState(control)
  } else if (control.kind === "comboBox") {
    const selected = control.items[control.selectedIndex]
    if (selected != null) setTextTarget(control.object, selected)
    const icon = control.icons[control.selectedIndex]
    if (icon) setIconTarget(control.object, icon)
  } else if (control.kind === "slider" || control.kind === "progressBar" || control.kind === "scrollBar") {
    updateValueVisual(control)
  }
}

function updateButtonState(control: InteractiveControl) {
  let state = "up"
  if (!control.enabled) state = control.selected ? "selectedDisabled" : "disabled"
  else if (control.down) state = control.selected ? "selectedOver" : "down"
  else if (control.over) state = control.selected ? "selectedOver" : "over"
  else if (control.selected) state = "down"
  setControllerPage(control.record, "button", state, true)
  const pressed = control.down && control.enabled
  control.object.alpha = control.downEffect === 1 && pressed ? control.baseAlpha * control.downEffectValue : control.baseAlpha
  const scale = control.downEffect === 2 && pressed ? control.downEffectValue : 1
  control.object.setScale(control.baseScaleX * scale, control.baseScaleY * scale)
}

function activateButton(control: InteractiveControl, human: boolean) {
  if (!control.enabled) return
  if (control.mode === 1) control.selected = !control.selected
  else if (control.mode === 2) control.selected = true
  applyControlVisual(control)
  if (control.relatedController && control.relatedPage) setControllerPage(control.ownerRecord, control.relatedController, control.relatedPage, true)
  const listOwner = runtime.listItemOwners.get(control.path)
  if (listOwner) {
    const list = runtime.controls.get(listOwner.listPath)
    if (list) selectListItem(list, listOwner.index, false)
  }
  if (human) emitInteraction(control.path, "click", { selected: control.selected })
}

function activateComboBox(control: InteractiveControl, requestedIndex?: number, human = false) {
  if (!control.enabled || control.items.length === 0) return
  if (requestedIndex == null) {
    if (control.popup) closeComboPopup(control)
    else openComboPopup(control)
    if (human) emitInteraction(control.path, "click", { open: !!control.popup })
    return
  }
  control.selectedIndex = Math.max(0, Math.min(control.items.length - 1, requestedIndex))
  applyControlVisual(control)
  if (control.selectionController) {
    const controller = control.ownerRecord.resource.component.controllers.find(({ name }) => name === control.selectionController)
    const page = controller?.pages[control.selectedIndex]
    if (page) setControllerPage(control.ownerRecord, controller.name, page.id, true)
  }
  if (human) emitInteraction(control.path, "change", { selectedIndex: control.selectedIndex, text: control.items[control.selectedIndex] ?? "" })
}

function openComboPopup(control: InteractiveControl) {
  const rowHeight = Math.max(24, Math.min(48, control.object.height || 28))
  const visibleCount = Math.max(1, Math.min(control.items.length, control.visibleItemCount || 10))
  const popup = new fgui.GComponent()
  popup.name = "__viewer_combo_popup"
  popup.setSize(Math.max(80, control.object.width), rowHeight * visibleCount)
  const background = new fgui.GGraph()
  background.setSize(popup.width, popup.height)
  background.drawRect(1, "#52525b", "#18181b")
  background.touchable = false
  popup.addChild(background)
  for (let index = 0; index < control.items.length; index += 1) {
    const row = new fgui.GComponent()
    row.name = `item:${index}`
    row.setXY(0, index * rowHeight)
    row.setSize(popup.width, rowHeight)
    row.opaque = true
    const label = new fgui.GTextField()
    label.setSize(row.width, row.height)
    label.fontSize = Math.max(12, Math.min(18, rowHeight - 10))
    label.color = index === control.selectedIndex ? "#60a5fa" : "#f4f4f5"
    label.verticalAlign = fgui.VertAlignType.Middle
    label.text = `  ${control.items[index]}`
    label.touchable = false
    row.addChild(label)
    row.on(Laya.Event.CLICK, row, () => {
      closeComboPopup(control)
      activateComboBox(control, index, true)
    })
    popup.addChild(row)
  }
  const globalPoint = control.object.localToGlobal(0, control.object.height)
  const localPoint = fgui.GRoot.inst.globalToLocal(globalPoint.x, globalPoint.y)
  popup.setXY(localPoint.x, localPoint.y)
  fgui.GRoot.inst.addChild(popup)
  control.popup = popup
}

function closeComboPopup(control: InteractiveControl) {
  if (!control.popup) return
  control.popup.removeFromParent?.()
  control.popup.dispose?.()
  control.popup = null
}

function selectListItem(control: InteractiveControl, index: number, human: boolean) {
  if (index < 0 || index >= control.object.numChildren) return
  control.selectedIndex = index
  for (let itemIndex = 0; itemIndex < control.object.numChildren; itemIndex += 1) {
    const itemControl = runtime.controls.get(objectPath(control.object.getChildAt(itemIndex)))
    if (itemControl?.kind === "button") {
      itemControl.selected = itemIndex === index
      applyControlVisual(itemControl)
    }
  }
  const source = control.record.resource.component.displayList.find(({ id }) => `${control.record.path}/${id}` === control.path)
  if ((source?.kind === "list" || source?.kind === "tree") && source.selectionController) {
    const controller = control.ownerRecord.resource.component.controllers.find(({ name }) => name === source.selectionController)
    const page = controller?.pages[index]
    if (page) setControllerPage(control.ownerRecord, controller.name, page.id, true)
  }
  if (human) emitInteraction(control.path, "change", { selectedIndex: index })
}

function beginSliderDrag(control: InteractiveControl, event: any) {
  if (!control.enabled) return
  const update = (input: any) => setSliderFromPointer(control, input)
  const finish = (input: any) => {
    update(input)
    Laya.stage.off(Laya.Event.MOUSE_MOVE, control.object, update)
    emitInteraction(control.path, "change", { value: control.value })
  }
  update(event)
  Laya.stage.on(Laya.Event.MOUSE_MOVE, control.object, update)
  Laya.stage.once(Laya.Event.MOUSE_UP, control.object, finish)
}

function setSliderFromPointer(control: InteractiveControl, event: any) {
  const point = control.object.globalToLocal(numberOr(event?.stageX, 0), numberOr(event?.stageY, 0))
  const vertical = !!findChildByName(control.object, "bar_v") || control.object.height > control.object.width
  const ratio = vertical
    ? 1 - Math.max(0, Math.min(1, point.y / Math.max(1, control.object.height)))
    : Math.max(0, Math.min(1, point.x / Math.max(1, control.object.width)))
  setControlValue(control, control.min + ratio * (control.max - control.min))
}

function setControlValue(control: InteractiveControl, value: number) {
  const clamped = Math.max(control.min, Math.min(control.max, value))
  control.value = control.wholeNumbers ? Math.round(clamped) : clamped
  updateValueVisual(control)
}

function updateValueVisual(control: InteractiveControl) {
  const range = Math.max(0.000001, control.max - control.min)
  const ratio = Math.max(0, Math.min(1, (control.value - control.min) / range))
  if (!control.visual) {
    const barH = findChildByName(control.object, "bar")
    const barV = findChildByName(control.object, "bar_v")
    const grip = findChildByName(control.object, "grip")
    control.visual = {
      barH,
      barV,
      grip,
      barWidth: barH?.width,
      barHeight: barV?.height,
      barY: barV?.y,
      gripX: grip?.x,
      gripY: grip?.y,
    }
  }
  const visual = control.visual
  if (visual.barH && visual.barWidth != null) visual.barH.width = visual.barWidth * ratio
  if (visual.barV && visual.barHeight != null) {
    const height = visual.barHeight * ratio
    visual.barV.y = (visual.barY ?? 0) + visual.barHeight - height
    visual.barV.height = height
  }
  if (visual.grip) {
    if (visual.barV) visual.grip.y = (visual.gripY ?? 0) + (1 - ratio) * Math.max(0, control.object.height - visual.grip.height)
    else visual.grip.x = (visual.gripX ?? 0) + ratio * Math.max(0, control.object.width - visual.grip.width)
  }
  const title = control.titleType === 1
    ? `${formatControlValue(control.value)}/${formatControlValue(control.max)}`
    : control.titleType === 2
      ? formatControlValue(control.value)
      : control.titleType === 3
        ? formatControlValue(control.max)
        : `${Math.round(ratio * 100)}%`
  setTextTarget(control.object, title)
}

function formatControlValue(value: number) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 100) / 100)
}

function installScrollArea(path: string, object: any, scrollType: number) {
  if ("opaque" in object) object.opaque = true
  let contentWidth = object.width
  let contentHeight = object.height
  for (let index = 0; index < Number(object.numChildren ?? 0); index += 1) {
    const child = object.getChildAt(index)
    contentWidth = Math.max(contentWidth, child.x + child.width)
    contentHeight = Math.max(contentHeight, child.y + child.height)
  }
  const state: ScrollState = {
    path,
    object,
    scrollType,
    x: 0,
    y: 0,
    maxX: Math.max(0, contentWidth - object.width),
    maxY: Math.max(0, contentHeight - object.height),
  }
  runtime.scrollAreas.set(path, state)
  object.on(Laya.Event.MOUSE_WHEEL, object, (event: any) => {
    const delta = numberOr(event?.delta, numberOr(event?.deltaY, 0))
    if (state.scrollType === 0) applyScroll(state, -delta * 30, 0)
    else applyScroll(state, 0, -delta * 30)
    emitInteraction(path, "scroll", { x: state.x, y: state.y })
  })
  object.on(Laya.Event.MOUSE_DOWN, object, (event: any) => {
    let previousX = numberOr(event?.stageX, 0)
    let previousY = numberOr(event?.stageY, 0)
    let moved = false
    const move = (input: any) => {
      const nextX = numberOr(input?.stageX, previousX)
      const nextY = numberOr(input?.stageY, previousY)
      const deltaX = previousX - nextX
      const deltaY = previousY - nextY
      moved ||= Math.abs(deltaX) + Math.abs(deltaY) > 1
      previousX = nextX
      previousY = nextY
      applyScroll(state, deltaX, deltaY)
    }
    const finish = () => {
      Laya.stage.off(Laya.Event.MOUSE_MOVE, object, move)
      if (moved) emitInteraction(path, "scroll", { x: state.x, y: state.y })
    }
    Laya.stage.on(Laya.Event.MOUSE_MOVE, object, move)
    Laya.stage.once(Laya.Event.MOUSE_UP, object, finish)
  })
}

function applyScroll(state: ScrollState, deltaX: number, deltaY: number) {
  let contentWidth = state.object.width
  let contentHeight = state.object.height
  for (let index = 0; index < Number(state.object.numChildren ?? 0); index += 1) {
    const child = state.object.getChildAt(index)
    contentWidth = Math.max(contentWidth, child.x + child.width)
    contentHeight = Math.max(contentHeight, child.y + child.height)
  }
  state.maxX = Math.max(0, contentWidth - state.object.width)
  state.maxY = Math.max(0, contentHeight - state.object.height)
  if (state.scrollType === 0 || state.scrollType === 2) state.x = Math.max(0, Math.min(state.maxX, state.x + deltaX))
  if (state.scrollType === 1 || state.scrollType === 2) state.y = Math.max(0, Math.min(state.maxY, state.y + deltaY))
  state.object.displayObject.scrollRect = new Laya.Rectangle(state.x, state.y, state.object.width, state.object.height)
}

function emitInteraction(targetId: string, event: ViewerInteractionEvent["event"], data?: ViewerInteractionEvent["data"]) {
  runtime.interactionSeq += 1
  post({ kind: "interaction", value: { runtimeEventSeq: runtime.interactionSeq, targetId, event, data } })
}

function linkGroupsAndRelations(record: ComponentRecord) {
  for (const node of record.resource.component.displayList) {
    const object = record.nodes.get(node.id)
    if (!object) continue
    if ("group" in node && node.group) {
      const group = record.nodes.get(node.group)
      if (group instanceof fgui.GGroup) object.group = group
    }
    for (const relation of node.relations) {
      const target = relation.targetNodeId ? record.nodes.get(relation.targetNodeId) : record.object
      if (target) object.addRelation(target, relation.type, relation.usePercent)
      else addDiagnostic("warning", "relation_target_missing", `${record.path}/${node.id}`, `Relation target ${relation.targetNodeId} 不存在。`)
    }
  }
}

function applyComponentMask(record: ComponentRecord) {
  const maskId = record.resource.component.properties.mask
  if (!maskId) return
  const mask = record.nodes.get(maskId)
  if (mask) record.object.setMask(mask.displayObject, record.resource.component.properties.reversedMask)
  else addDiagnostic("warning", "mask_target_missing", record.path, `Mask target ${maskId} 不存在。`)
}

function setControllerPage(record: ComponentRecord, controllerName: string, pageIdOrName: string, runActions: boolean, depth = 0) {
  if (depth > 32) {
    addDiagnosticOnce("error", "controller_action_cycle", `${record.path}/controller:${controllerName}`, "Controller action recursion exceeded 32 steps.")
    return false
  }
  const controller = record.resource.component.controllers.find(({ name }) => name === controllerName)
  if (!controller) return false
  const nextIndex = controller.pages.findIndex(({ id, name }) => id === pageIdOrName || name.toLocaleLowerCase() === pageIdOrName.toLocaleLowerCase())
  if (nextIndex < 0) return false
  const previousIndex = record.controllers.get(controller.name) ?? controller.selectedIndex
  if (previousIndex === nextIndex) return true
  record.previousControllers.set(controller.name, previousIndex)
  record.controllers.set(controller.name, nextIndex)
  applyRecordGears(record)
  if (runActions) runControllerActions(record, controller, previousIndex, nextIndex, depth)
  return true
}

function runControllerActions(record: ComponentRecord, controller: ComponentRecord["resource"]["component"]["controllers"][number], previousIndex: number, nextIndex: number, depth: number) {
  const previousPage = controller.pages[previousIndex]
  const nextPage = controller.pages[nextIndex]
  for (const action of controller.actions) {
    const matches = (action.fromPageIds.length === 0 || (!!previousPage && action.fromPageIds.includes(previousPage.id)))
      && (action.toPageIds.length === 0 || (!!nextPage && action.toPageIds.includes(nextPage.id)))
    if (!matches) {
      if (action.actionType === 0 && action.stopOnExit) {
        addDiagnosticOnce("info", "controller_transition_stop_partial", `${record.path}/controller:${controller.name}`, "Controller stopOnExit 在 Viewer 中由下一次场景或 Transition 操作统一清理。")
      }
      continue
    }
    if (action.actionType === 0) {
      const transition = record.resource.component.transitions.find(({ name }) => name === action.transitionName)
      if (!transition) {
        addDiagnosticOnce("warning", "controller_transition_missing", `${record.path}/controller:${controller.name}`, `Controller Transition ${action.transitionName} 不存在。`)
        continue
      }
      schedule(Math.max(0, action.delay), () => playTransition(record, transition, Math.max(1, action.playTimes)))
    } else if (action.actionType === 1 && action.controllerName) {
      const targetObject = action.targetNodeId ? record.nodes.get(action.targetNodeId) : record.object
      const targetRecord = targetObject ? runtime.recordByObject.get(targetObject) ?? record : record
      const targetController = targetRecord.resource.component.controllers.find(({ name }) => name === action.controllerName)
      if (!targetController) continue
      let targetPage = action.targetPage
      if (targetPage === "~1") targetPage = targetController.pages[nextIndex]?.id ?? ""
      else if (targetPage === "~2") targetPage = nextPage?.name ?? ""
      if (targetPage) setControllerPage(targetRecord, targetController.name, targetPage, true, depth + 1)
    }
  }
}

function applyRecordGears(record: ComponentRecord) {
  for (const node of record.resource.component.displayList) {
    const object = record.nodes.get(node.id)
    if (!object) continue
    let visible = node.visible
    for (const gear of node.gears) {
      const controller = record.resource.component.controllers.find(({ name }) => name === gear.controllerName)
      const selectedIndex = controller ? record.controllers.get(controller.name) ?? controller.selectedIndex : -1
      const pageId = controller?.pages[selectedIndex]?.id
      if (!controller) {
        addDiagnosticOnce("warning", "gear_controller_missing", `${record.path}/${node.id}`, `Gear ${gear.kind} 的 Controller ${gear.controllerName} 不存在。`)
        continue
      }
      if (gear.kind === "display" || gear.kind === "display2") {
        visible = visible && (!!pageId && gear.visibleOnPageIds.includes(pageId))
        continue
      }
      if (gear.positionsInPercent) {
        addDiagnosticOnce("warning", "percent_gear_unsupported", `${record.path}/${node.id}`, `Gear ${gear.kind} 的百分比坐标在当前 UAM 中不完整，已保留基础值。`)
        continue
      }
      const value = gear.states.find((state) => state.pageId === pageId)?.value ?? gear.defaultValue
      if (value) applyGearValue(object, gear, value)
    }
    object.visible = visible
  }
}

function applyGearValue(object: any, gear: Exclude<UamGearBinding, { kind: "display" | "display2" }>, value: any) {
  if (gear.kind === "look") {
    object.alpha = value.alpha
    object.rotation = value.rotation
    object.grayed = value.grayed
    object.touchable = value.touchable
  } else if (gear.kind === "xy") object.setXY(value.x, value.y)
  else if (gear.kind === "size") {
    object.setSize(value.width, value.height)
    object.setScale(value.scaleX, value.scaleY)
  } else if (gear.kind === "color") {
    setObjectColor(object, value.color)
    if (value.outlineColor && "strokeColor" in object) object.strokeColor = value.outlineColor
  } else if (gear.kind === "animation") {
    if ("frame" in object) object.frame = value.frame
    if ("playing" in object) object.playing = value.playing
  } else if (gear.kind === "text") setTextTarget(object, value.text)
  else if (gear.kind === "icon") setIconTarget(object, value.icon)
  else if (gear.kind === "fontSize") {
    const target = "fontSize" in object ? object : findChildByName(object, "title")
    if (target) target.fontSize = value.fontSize
  }
}

function playRootTransition(name?: string) {
  const record = runtime.rootRecord
  if (!record) throw new Error("当前组件尚未建立 Transition 上下文。")
  const transition = name
    ? record.resource.component.transitions.find((candidate) => candidate.name === name)
    : record.resource.component.transitions[0]
  if (!transition) throw new Error("当前组件没有可播放的 Transition。")
  killTweeners()
  playTransition(record, transition)
}

function playAutoTransitions() {
  for (const record of runtime.records.values()) {
    for (const transition of record.resource.component.transitions) {
      if (!transition.autoPlay) continue
      const trigger = fgui.GTween.delayedCall(Math.max(0, transition.autoPlayDelay)).onComplete(() => {
        playTransition(record, transition, Math.max(1, transition.autoPlayTimes))
      })
      runtime.tweeners.push(trigger)
    }
  }
}

function playTransition(record: ComponentRecord, transition: UamTransitionModel, times = 1) {
  const fps = Math.max(1, transition.fps || 24)
  const repetitions = Math.max(1, times)
  const duration = transition.items.reduce((max, item) => Math.max(max, item.time + (item.tween ? item.duration : 0)), 0) / fps
  for (let cycle = 0; cycle < repetitions; cycle += 1) {
    for (const item of transition.items) playTransitionItem(record, item, fps, cycle * duration)
  }
}

function playTransitionItem(record: ComponentRecord, item: UamTransitionItem, fps: number, cycleDelay: number) {
  const target = item.targetNodeId ? record.nodes.get(item.targetNodeId) : record.object
  if (!target) {
    addDiagnosticOnce("warning", "transition_target_missing", `${record.path}/transition`, `Transition target ${item.targetNodeId} 不存在。`)
    return
  }
  const delay = cycleDelay + item.time / fps
  const duration = Math.max(0, item.duration / fps)
  if (!item.tween || duration === 0) {
    schedule(delay, () => applyTransitionValue(record, target, item.actionType, item.endValue.length ? item.endValue : item.startValue))
    return
  }

  const start = item.startValue
  const end = item.endValue
  let tweener: any
  const setPair = (setter: (x: number, y: number) => void, fallbackX: number, fallbackY: number, rootOffset = false) => {
    const first = transitionPair(start, fallbackX, fallbackY, record, item.actionType)
    const last = transitionPair(end, first[0], first[1], record, item.actionType)
    const offsetX = rootOffset ? target.x : 0
    const offsetY = rootOffset ? target.y : 0
    tweener = fgui.GTween.to2(first[0] + offsetX, first[1] + offsetY, last[0] + offsetX, last[1] + offsetY, duration)
      .onUpdate((value: any) => setter(value.value.x, value.value.y))
  }
  if (item.actionType === 0) setPair((x, y) => target.setXY(x, y), target.x, target.y, target === record.object)
  else if (item.actionType === 1) setPair((x, y) => target.setSize(x, y), target.width, target.height)
  else if (item.actionType === 2) setPair((x, y) => target.setScale(x, y), target.scaleX, target.scaleY)
  else if (item.actionType === 3) setPair((x, y) => target.setPivot(x, y, target.pivotAsAnchor), target.pivotX, target.pivotY)
  else if (item.actionType === 13) setPair((x, y) => target.setSkew(x, y), target.skewX, target.skewY)
  else if (item.actionType === 4 || item.actionType === 5) {
    const fallback = item.actionType === 4 ? target.alpha : target.rotation
    tweener = fgui.GTween.to(numberOr(start[0], fallback), numberOr(end[0], fallback), duration)
      .onUpdate((value: any) => {
        if (item.actionType === 4) target.alpha = value.value.x
        else target.rotation = value.value.x
      })
  } else if (item.actionType === 6) {
    const fallback = fgui.ToolSet.convertFromHtmlColor("#FFFFFF", false)
    tweener = fgui.GTween.toColor(colorNumber(start[0], fallback), colorNumber(end[0], fallback), duration)
      .onUpdate((value: any) => setObjectColor(target, fgui.ToolSet.convertToHtmlColor(value.value.color, false)))
  } else if (item.actionType === 12) {
    const first = numberTuple(start, 4, [0, 0, 0, 0])
    const last = numberTuple(end, 4, first)
    tweener = fgui.GTween.to4(...first, ...last, duration)
      .onUpdate((value: any) => fgui.ToolSet.setColorFilter(target.displayObject, [value.value.x, value.value.y, value.value.z, value.value.w]))
  } else {
    schedule(delay, () => applyTransitionValue(record, target, item.actionType, end.length ? end : start))
    return
  }
  tweener.setDelay(delay).setEase(item.easeType).setRepeat(item.repeat, item.yoyo)
  runtime.tweeners.push(tweener)
}

function applyTransitionValue(record: ComponentRecord, target: any, actionType: number, values: unknown[]) {
  if (actionType === 0) {
    const [x, y] = transitionPair(values, target.x, target.y, record, actionType)
    target.setXY(target === record.object ? target.x + x : x, target === record.object ? target.y + y : y)
  } else if (actionType === 1) {
    const [x, y] = transitionPair(values, target.width, target.height, record, actionType)
    target.setSize(x, y)
  } else if (actionType === 2) {
    const [x, y] = transitionPair(values, target.scaleX, target.scaleY, record, actionType)
    target.setScale(x, y)
  } else if (actionType === 3) {
    const [x, y] = transitionPair(values, target.pivotX, target.pivotY, record, actionType)
    target.setPivot(x, y, target.pivotAsAnchor)
  } else if (actionType === 4) target.alpha = numberOr(values[0], target.alpha)
  else if (actionType === 5) target.rotation = numberOr(values[0], target.rotation)
  else if (actionType === 6) setObjectColor(target, String(values[0] ?? "#FFFFFF"))
  else if (actionType === 7) {
    if (values[0] !== "-" && "frame" in target) target.frame = numberOr(values[0], target.frame)
    if ("playing" in target) target.playing = values[1] === "p" || values[1] === true || values[1] === "true"
  } else if (actionType === 8) target.visible = values[0] === true || values[0] === "true"
  else if (actionType === 9) playSound(String(values[0] ?? ""), numberOr(values[1], 100) / 100)
  else if (actionType === 10) {
    const nested = runtime.recordByObject.get(target) ?? record
    const transition = nested.resource.component.transitions.find(({ name }) => name === String(values[0] ?? ""))
    if (transition) playTransition(nested, transition, Math.max(1, numberOr(values[1], 1)))
  } else if (actionType === 11) {
    const tweener = fgui.GTween.shake(target.x, target.y, numberOr(values[0], 0), numberOr(values[1], 0))
      .onUpdate((value: any) => target.setXY(value.value.x, value.value.y))
    runtime.tweeners.push(tweener)
  } else if (actionType === 12) fgui.ToolSet.setColorFilter(target.displayObject, numberTuple(values, 4, [0, 0, 0, 0]))
  else if (actionType === 13) {
    const [x, y] = transitionPair(values, target.skewX, target.skewY, record, actionType)
    target.setSkew(x, y)
  } else if (actionType === 14) setTextTarget(target, String(values[0] ?? ""))
  else if (actionType === 15) setIconTarget(target, String(values[0] ?? ""))
}

function transitionPair(values: unknown[], fallbackX: number, fallbackY: number, record: ComponentRecord, actionType: number): [number, number] {
  if (actionType === 0 && values.length >= 4) {
    const hasX = values[0] !== "-"
    const hasY = values[1] !== "-"
    return [hasX ? numberOr(values[2], fallbackX) * record.object.width : fallbackX, hasY ? numberOr(values[3], fallbackY) * record.object.height : fallbackY]
  }
  return [numberOr(values[0], fallbackX), numberOr(values[1], fallbackY)]
}

function applyOperation(operation: ViewerOperation) {
  const target = runtime.objects.get(operation.targetId)
  if (!target) throw new Error(`找不到 Viewer 对象 ID：${operation.targetId}`)
  if (operation.op === "set-controller-page") {
    const record = runtime.recordByObject.get(target)
    if (!record || !setControllerPage(record, operation.controllerName, operation.pageId, true)) {
      throw new Error(`对象 ${operation.targetId} 不存在 Controller page：${operation.controllerName}/${operation.pageId}`)
    }
    return snapshotObject(target)
  }
  if (operation.op === "play-transition") {
    const record = runtime.recordByObject.get(target)
    const transition = record?.resource.component.transitions.find(({ name }) => name === operation.transitionName)
    if (!record || !transition) throw new Error(`对象 ${operation.targetId} 不存在 Transition：${operation.transitionName}`)
    playTransition(record, transition, operation.times ?? 1)
    return snapshotObject(target)
  }
  if (operation.op === "dispatch-event") {
    dispatchSemanticEvent(operation, target)
    return snapshotObject(target)
  }

  const control = runtime.controls.get(operation.targetId)
  if (operation.property === "visible") {
    if (typeof operation.value !== "boolean") throw new Error("visible 必须是 boolean。")
    target.visible = operation.value
  } else if (operation.property === "text") {
    if (typeof operation.value !== "string") throw new Error("text 必须是 string。")
    if (control && ["button", "comboBox", "label"].includes(control.kind)) control.title = operation.value
    setTextTarget(target, operation.value)
  } else if (operation.property === "icon") {
    if (typeof operation.value !== "string" && operation.value !== null) throw new Error("icon 必须是 string 或 null。")
    if (control && ["button", "comboBox", "label"].includes(control.kind)) control.icon = operation.value ?? ""
    setIconTarget(target, operation.value)
  } else if (operation.property === "value") {
    if (typeof operation.value !== "number") throw new Error("value 必须是 number。")
    if (control && ["slider", "progressBar", "scrollBar"].includes(control.kind)) setControlValue(control, operation.value)
    else if ("value" in target) target.value = operation.value
    else throw new Error(`对象 ${operation.targetId} 不支持 value。`)
  } else if (operation.property === "selectedIndex") {
    if (typeof operation.value !== "number" || !Number.isInteger(operation.value)) throw new Error("selectedIndex 必须是 integer。")
    if (control?.kind === "comboBox") activateComboBox(control, operation.value)
    else if (control?.kind === "list" || control?.kind === "tree") selectListItem(control, operation.value, false)
    else if ("selectedIndex" in target) target.selectedIndex = operation.value
    else throw new Error(`对象 ${operation.targetId} 不支持 selectedIndex。`)
  } else if (operation.property === "enabled" || operation.property === "selected") {
    if (typeof operation.value !== "boolean") throw new Error(`${operation.property} 必须是 boolean。`)
    if (control) {
      if (operation.property === "enabled") control.enabled = operation.value
      else control.selected = operation.value
      applyControlVisual(control)
    } else if (operation.property in target) target[operation.property] = operation.value
    else throw new Error(`对象 ${operation.targetId} 不支持 ${operation.property}。`)
  }
  return snapshotObject(target)
}

function dispatchSemanticEvent(operation: ViewerDispatchEventOperation, target: any) {
  const control = runtime.controls.get(operation.targetId)
  if (operation.event === "click") {
    if (control?.kind === "button") activateButton(control, false)
    else if (control?.kind === "comboBox") activateComboBox(control, operation.data?.selectedIndex)
    else if (control?.kind === "list" || control?.kind === "tree") {
      if (operation.data?.selectedIndex == null) throw new Error("List click 需要 selectedIndex。")
      selectListItem(control, operation.data.selectedIndex, false)
    } else {
      const owner = runtime.listItemOwners.get(operation.targetId)
      const list = owner ? runtime.controls.get(owner.listPath) : null
      if (list && owner) selectListItem(list, owner.index, false)
      else throw new Error(`对象 ${operation.targetId} 不支持 click。`)
    }
  } else if (operation.event === "input") {
    if (control?.kind === "textInput") {
      if (typeof operation.data?.text !== "string") throw new Error("TextInput input 需要 text。")
      target.text = operation.data.text
    } else if (control?.kind === "slider") {
      if (typeof operation.data?.value !== "number") throw new Error("Slider input 需要 value。")
      setControlValue(control, operation.data.value)
    } else throw new Error(`对象 ${operation.targetId} 不支持 input。`)
  } else {
    const scroll = runtime.scrollAreas.get(operation.targetId)
    if (!scroll) throw new Error(`对象 ${operation.targetId} 不支持 scroll。`)
    applyScroll(scroll, operation.data?.deltaX ?? 0, operation.data?.deltaY ?? 0)
  }
}

function setTextTarget(object: any, value: string | null) {
  if (typeof object?.text === "string") object.text = value ?? ""
  else {
    const target = findChildByName(object, "title")
    if (target && "text" in target) target.text = value ?? ""
  }
}

function setIconTarget(object: any, value: string | null) {
  const target = (object instanceof fgui.GLoader || object instanceof fgui.GImage) ? object : findChildByName(object, "icon")
  if (!target) return
  if (!value) {
    if (target instanceof fgui.GImage) target.image.texture = null
    else if (target instanceof fgui.GLoader) {
      target.content.texture = null
      target.sourceWidth = 0
      target.sourceHeight = 0
      target.updateLayout?.()
    }
    return
  }
  const ref = parseFairyUrl(value)
  const prepared = ref ? runtime.prepared.get(resourceKey(ref.packageId, ref.resourceId)) : undefined
  if (target instanceof fgui.GImage && prepared?.texture) target.image.texture = prepared.texture
  else if (target instanceof fgui.GLoader && prepared?.texture) {
    target.content.texture = prepared.texture
    target.sourceWidth = prepared.texture.width
    target.sourceHeight = prepared.texture.height
    target.updateLayout?.()
  }
}

function setValueTarget(object: any, value: number, min: number, max: number) {
  if ("min" in object) object.min = min
  if ("max" in object) object.max = max
  if ("value" in object) object.value = value
  const title = findChildByName(object, "title")
  if (title && "text" in title) title.text = `${Math.round(((value - min) / Math.max(1, max - min)) * 100)}%`
}

function setObjectColor(object: any, value: string) {
  if ("color" in object) object.color = value
  else if (object.setProp) object.setProp(fgui.ObjectPropID.Color, value)
}

function playSound(url: string, volume: number) {
  const ref = parseFairyUrl(url)
  const prepared = ref ? runtime.prepared.get(resourceKey(ref.packageId, ref.resourceId)) : undefined
  if (prepared?.url) Laya.SoundManager.playSound(prepared.url, 1, null, 0, 0, Math.max(0, volume))
}

function missingComponent(path: string, message: string) {
  addDiagnostic("error", "component_missing", path, message)
  const object = new fgui.GComponent()
  object.setSize(180, 40)
  const text = new fgui.GTextField()
  text.setSize(180, 40)
  text.color = "#ef4444"
  text.text = message
  object.addChild(text)
  registerObject(path, object)
  return object
}

function registerObject(path: string, object: any) {
  runtime.objects.set(path, object)
  runtime.objectPaths.set(object, path)
}

function objectPath(object: any) {
  return runtime.objectPaths.get(object) ?? "viewer"
}

function snapshotObject(object: any): ViewerObjectSnapshot {
  const path = objectPath(object)
  const control = runtime.controls.get(path)
  const snapshot: ViewerObjectSnapshot = {
    id: path,
    name: String(object?.name ?? ""),
    type: String(object?.constructor?.name ?? "GObject"),
    x: Number(object?.x ?? 0),
    y: Number(object?.y ?? 0),
    width: Number(object?.width ?? 0),
    height: Number(object?.height ?? 0),
    visible: object?.visible !== false,
  }
  if (control) {
    snapshot.controlKind = control.kind
    snapshot.enabled = control.enabled
    if (control.kind === "button") snapshot.selected = control.selected
    if (["slider", "progressBar", "scrollBar"].includes(control.kind)) snapshot.value = control.value
    if (["comboBox", "list", "tree"].includes(control.kind)) snapshot.selectedIndex = control.selectedIndex
  }
  if (typeof object?.text === "string") snapshot.text = object.text
  if (Number(object?.numChildren ?? 0) > 0) snapshot.children = Array.from({ length: object.numChildren }, (_, index) => snapshotObject(object.getChildAt(index)))
  return snapshot
}

function snapshotControllers() {
  return [...runtime.records.values()].flatMap((record) => record.resource.component.controllers.map((controller) => {
    const selectedIndex = record.controllers.get(controller.name) ?? controller.selectedIndex
    const page = controller.pages[selectedIndex]
    return {
      targetId: record.path,
      name: controller.name,
      selectedIndex,
      pageId: page?.id ?? "",
      pageName: page?.name ?? "",
      pages: controller.pages.map(({ id, name }) => ({ id, name })),
    }
  }))
}

function snapshotTransitions(): ViewerObservation["availableTransitions"] {
  return [...runtime.records.values()].flatMap((record) => record.resource.component.transitions.map(({ name }) => ({ targetId: record.path, name })))
}

function createObservation(): ViewerObservation {
  if (!runtime.current) throw new Error("请先渲染一个 FairyGUI 组件。")
  return { objectTree: snapshotObject(runtime.current), controllers: snapshotControllers(), availableTransitions: snapshotTransitions() }
}

function findChildByName(root: any, name: string): any | null {
  if (!root || Number(root.numChildren ?? 0) === 0) return null
  const direct = root.getChild?.(name)
  if (direct) return direct
  for (let index = 0; index < root.numChildren; index += 1) {
    const found = findChildByName(root.getChildAt(index), name)
    if (found) return found
  }
  return null
}

function findChildByPath(root: any, path: string) {
  let current = root
  for (const segment of path.split(/[/.]/).filter(Boolean)) {
    current = current?.getChild?.(segment)
    if (!current) return null
  }
  return current
}

function layoutCurrent() {
  const current = runtime.current
  if (!current) return
  const root = fgui.GRoot.inst
  const width = Math.max(1, Number(current.width || 1))
  const height = Math.max(1, Number(current.height || 1))
  const fit = Math.min((root.width - 48) / width, (root.height - 48) / height, 1)
  const scale = Math.max(0.05, fit * runtime.zoom)
  current.setScale(scale, scale)
  current.setXY(Math.round((root.width - width * scale) / 2), Math.round((root.height - height * scale) / 2))
}

function resize() {
  const width = Math.max(1, innerWidth)
  const height = Math.max(1, innerHeight)
  Laya.stage?.size?.(width, height)
  fgui.GRoot?.inst?.setSize(width, height)
  layoutCurrent()
}

function resetScene() {
  killTweeners()
  for (const control of runtime.controls.values()) closeComboPopup(control)
  fgui.GRoot?.inst?.removeChildren?.(0, -1, false)
  runtime.current?.dispose?.()
  runtime.current = null
  runtime.rootRecord = null
  for (const fontName of runtime.bitmapFonts) Laya.Text.unregisterBitmapFont?.(fontName, true)
  runtime.bitmapFonts = []
  for (const texture of runtime.ownedTextures) {
    try { texture.destroy?.() } catch {}
  }
  runtime.ownedTextures = []
  for (const url of runtime.loaderUrls) {
    try { Laya.loader.clearRes?.(url) } catch {}
  }
  runtime.loaderUrls = []
  for (const url of runtime.blobUrls) URL.revokeObjectURL(url)
  runtime.blobUrls = []
  runtime.scene = null
  runtime.objects.clear()
  runtime.objectPaths = new WeakMap()
  runtime.records.clear()
  runtime.recordByObject = new WeakMap()
  runtime.controls.clear()
  runtime.scrollAreas.clear()
  runtime.listItemOwners.clear()
  runtime.components.clear()
  runtime.assets.clear()
  runtime.prepared.clear()
  runtime.diagnostics = []
}

function killTweeners() {
  for (const tweener of runtime.tweeners) {
    try { tweener.kill?.(false) } catch {}
  }
  runtime.tweeners = []
}

function schedule(delay: number, callback: () => void) {
  if (delay <= 0) {
    callback()
    return
  }
  const tweener = fgui.GTween.delayedCall(delay).onComplete(callback)
  runtime.tweeners.push(tweener)
}

function addDiagnostic(level: ViewerDiagnostic["level"], code: string, path: string, message: string) {
  runtime.diagnostics.push({ level, code, path, message })
}

function addDiagnosticOnce(level: ViewerDiagnostic["level"], code: string, path: string, message: string) {
  if (!runtime.diagnostics.some((item) => item.code === code && item.path === path && item.message === message)) addDiagnostic(level, code, path, message)
}

function createBlobUrl(data: ArrayBuffer, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  runtime.blobUrls.push(url)
  return url
}

function resourceKey(packageId: string, resourceId: string) {
  return `${packageId}/${resourceId}`
}

function splitResourceKey(value: string): [string, string] {
  const index = value.indexOf("/")
  return [value.slice(0, index), value.slice(index + 1)]
}

function parseFairyUrl(value: string | null | undefined) {
  if (!value?.startsWith("ui://") || value.length < 14) return null
  return { packageId: value.slice(5, 13), resourceId: value.slice(13) }
}

function horizontalAlign(value: number) {
  return value === 1 ? "center" : value === 2 ? "right" : "left"
}

function verticalAlign(value: number) {
  return value === 1 ? "middle" : value === 2 ? "bottom" : "top"
}

function normalizeFillAmount(value: number) {
  return value > 1 ? value / 100 : value
}

function numberOr(value: unknown, fallback: number) {
  if (value === "-" || value === "" || value == null) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function numberValue(value: unknown, fallback: number) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

function numberTuple(values: unknown[], length: number, fallback: number[]) {
  return Array.from({ length }, (_, index) => numberOr(values[index], fallback[index] ?? 0)) as [number, number, number, number]
}

function colorNumber(value: unknown, fallback: number) {
  return typeof value === "string" ? fgui.ToolSet.convertFromHtmlColor(value, false) : numberOr(value, fallback)
}

function mimeType(path: string, data?: ArrayBuffer) {
  const bytes = data ? new Uint8Array(data, 0, Math.min(data.byteLength, 12)) : null
  if (/\.png$/i.test(path) || (bytes?.[0] === 0x89 && bytes?.[1] === 0x50)) return "image/png"
  if (/\.jpe?g$/i.test(path) || (bytes?.[0] === 0xff && bytes?.[1] === 0xd8)) return "image/jpeg"
  if (/\.webp$/i.test(path)) return "image/webp"
  if (/\.svg$/i.test(path)) return "image/svg+xml"
  if (/\.mp3$/i.test(path)) return "audio/mpeg"
  if (/\.wav$/i.test(path)) return "audio/wav"
  if (/\.ogg$/i.test(path)) return "audio/ogg"
  if (/\.fnt$/i.test(path)) return "text/plain"
  return "application/octet-stream"
}

type ParsedGlyph = { charId: number; img: string | null; x: number; y: number; xoffset: number; yoffset: number; width: number; height: number; xadvance: number }

function parseFnt(text: string) {
  let hasFace = false
  let fontSize = 0
  let lineHeight = 0
  let resizable = false
  const glyphs: ParsedGlyph[] = []
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().match(/(?:[^\s"]+|"[^"]*")+/g) ?? []
    const attrs = new Map(parts.slice(1).map((part) => {
      const index = part.indexOf("=")
      return [part.slice(0, index), part.slice(index + 1).replace(/^"|"$/g, "")] as const
    }).filter(([key]) => key))
    if (parts[0] === "info") {
      hasFace = attrs.has("face")
      fontSize = numberValue(attrs.get("size"), 0)
      resizable = attrs.get("resizable") === "true"
    } else if (parts[0] === "common") {
      lineHeight = numberValue(attrs.get("lineHeight"), 0)
      if (!fontSize) fontSize = lineHeight
    } else if (parts[0] === "char") {
      const charId = numberValue(attrs.get("id"), 0)
      const img = attrs.get("img") || null
      if (!charId || (!hasFace && !img)) continue
      glyphs.push({
        charId,
        img,
        x: numberValue(attrs.get("x"), 0),
        y: numberValue(attrs.get("y"), 0),
        xoffset: numberValue(attrs.get("xoffset"), 0),
        yoffset: numberValue(attrs.get("yoffset"), 0),
        width: numberValue(attrs.get("width"), 0),
        height: numberValue(attrs.get("height"), 0),
        xadvance: numberValue(attrs.get("xadvance"), 0),
      })
    }
  }
  return { fontSize, lineHeight, resizable, glyphs }
}

function respond(requestId: string, value?: unknown, error?: string) {
  post(error ? { kind: "response", requestId, ok: false, error } : { kind: "response", requestId, ok: true, value })
}

function post(message: ViewerRuntimeMessage) {
  runtime.port?.postMessage(message)
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
