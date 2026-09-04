import type { UamAssetResource, UamComponentResource } from "@openfairygui/core"
import type { PlayerRenderSource } from "./artifact-protocol"

export const VIEWER_PROTOCOL_VERSION = 4

export type ViewerComponent = {
  id: string
  name: string
}

export type ViewerCatalogPackage = {
  packageId: string
  packageName: string
  components: ViewerComponent[]
}

export type ViewerProjectCatalog = {
  schemaVersion: 1
  source: { projectId: string }
  packages: ViewerCatalogPackage[]
}

export type ViewerDiagnostic = {
  level: "info" | "warning" | "error"
  code: string
  path: string
  message: string
}

export type ViewerSceneComponent = {
  packageId: string
  packageName: string
  resource: UamComponentResource
}

export type ViewerSceneAsset = {
  packageId: string
  packageName: string
  resource: Omit<UamAssetResource, "sourceBytes">
  data: ArrayBuffer
}

export type ViewerScene = {
  schemaVersion: 1
  sourceRevision: string
  projectId: string
  root: { packageId: string; resourceId: string }
  components: ViewerSceneComponent[]
  assets: ViewerSceneAsset[]
  diagnostics: ViewerDiagnostic[]
}

export type ViewerConnectMessage = {
  type: "fairygui.viewer.connect"
  protocolVersion: typeof VIEWER_PROTOCOL_VERSION
  sourceRevision: string
}

export type ViewerCommand =
  | { kind: "render"; requestId: string; scene: ViewerScene }
  | { kind: "render-artifact"; requestId: string; source: PlayerRenderSource }
  | { kind: "capture"; requestId: string }
  | { kind: "observe"; requestId: string }
  | { kind: "set-view"; requestId: string; zoom: number; background: string }
  | { kind: "play-transition"; requestId: string; transitionName?: string }
  | { kind: "apply-operations"; requestId: string; operations: ViewerOperation[] }

export type ViewerRendered = {
  packageId: string
  componentId: string
  packageName: string
  componentName: string
  width: number
  height: number
  transitions: string[]
  diagnostics: ViewerDiagnostic[]
  objectTree: ViewerObjectSnapshot
  controllers: ViewerControllerSnapshot[]
  availableTransitions: ViewerTransitionSnapshot[]
}

export type ViewerObjectSnapshot = {
  id: string
  name: string
  type: string
  x: number
  y: number
  width: number
  height: number
  visible: boolean
  controlKind?: ViewerControlKind
  enabled?: boolean
  selected?: boolean
  value?: number
  selectedIndex?: number
  text?: string
  children?: ViewerObjectSnapshot[]
}

export type ViewerControlKind = "button" | "comboBox" | "label" | "list" | "tree" | "progressBar" | "slider" | "scrollBar" | "textInput"

export type ViewerControllerSnapshot = {
  targetId: string
  name: string
  selectedIndex: number
  pageId: string
  pageName: string
  pages: Array<{ id: string; name: string }>
}

export type ViewerTransitionSnapshot = {
  targetId: string
  name: string
}

export type ViewerObservation = {
  objectTree: ViewerObjectSnapshot
  controllers: ViewerControllerSnapshot[]
  availableTransitions: ViewerTransitionSnapshot[]
}

export type ViewerSetPropertyOperation = {
  op: "set-property"
  targetId: string
  property: "text" | "visible" | "enabled" | "selected" | "value" | "selectedIndex" | "icon"
  value: string | number | boolean | null
}

export type ViewerSetControllerPageOperation = {
  op: "set-controller-page"
  targetId: string
  controllerName: string
  pageId: string
}

export type ViewerPlayTransitionOperation = {
  op: "play-transition"
  targetId: string
  transitionName: string
  times?: number
}

export type ViewerDispatchEventOperation = {
  op: "dispatch-event"
  targetId: string
  event: "click" | "input" | "scroll"
  data?: { text?: string; value?: number; selectedIndex?: number; deltaX?: number; deltaY?: number }
}

export type ViewerOperation =
  | ViewerSetPropertyOperation
  | ViewerSetControllerPageOperation
  | ViewerPlayTransitionOperation
  | ViewerDispatchEventOperation

export type ViewerInteractionEvent = {
  runtimeEventSeq: number
  targetId: string
  event: "click" | "input" | "change" | "scroll"
  data?: Record<string, string | number | boolean | null>
}

export type ViewerBrokerCommand = {
  commandSeq: number
  requestId: string
  kind: "render" | "capture" | "observe" | "update"
  payload: Record<string, unknown>
}

export type ViewerRuntimeMessage =
  | { kind: "ready"; sourceRevision: string }
  | { kind: "fatal"; error: string }
  | { kind: "rendered"; value: ViewerRendered }
  | { kind: "interaction"; value: ViewerInteractionEvent }
  | { kind: "response"; requestId: string; ok: true; value?: unknown }
  | { kind: "response"; requestId: string; ok: false; error: string }

export function isViewerConnectMessage(value: unknown): value is ViewerConnectMessage {
  const message = value as Partial<ViewerConnectMessage> | null
  return message?.type === "fairygui.viewer.connect"
    && message.protocolVersion === VIEWER_PROTOCOL_VERSION
    && typeof message.sourceRevision === "string"
}
