import { useVirtualizer } from "@tanstack/react-virtual"
import { ChevronDown, ChevronRight, Play } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import type { RenderSessionClient } from "@/lib/render-session"
import type { ViewerCatalogPackage, ViewerComponent, ViewerOperation, ViewerRendered, RenderSessionState } from "../../viewer-protocol"

type ViewerListRow =
  | { kind: "package"; key: string; packageId: string; packageName: string; count: number }
  | { kind: "component"; key: string; packageId: string; component: ViewerComponent }

export function ViewerComponentList({ packages, selected, onSelect, collapsedPackages, onCollapsedPackagesChange }: {
  packages: ViewerCatalogPackage[]
  selected: { packageId: string; componentId: string } | null
  onSelect: (value: { packageId: string; componentId: string }) => void
  collapsedPackages: Set<string>
  onCollapsedPackagesChange: (value: Set<string>) => void
}) {
  const parentRef = useRef<HTMLDivElement>(null)
  const rows = useMemo<ViewerListRow[]>(() => packages.flatMap((pkg) => [
    { kind: "package", key: `package:${pkg.packageId}`, packageId: pkg.packageId, packageName: pkg.packageName, count: pkg.components.length },
    ...(collapsedPackages.has(pkg.packageId) ? [] : pkg.components.map((component) => ({ kind: "component" as const, key: `${pkg.packageId}:${component.id}`, packageId: pkg.packageId, component }))),
  ]), [collapsedPackages, packages])
  const virtualizer = useVirtualizer({ count: rows.length, getScrollElement: () => parentRef.current, estimateSize: () => 34, overscan: 12 })

  if (rows.length === 0) return <div className="grid flex-1 place-items-center p-6 text-center text-sm text-muted-foreground">没有匹配的组件</div>

  return (
    <div ref={parentRef} className="min-h-0 flex-1 overflow-auto" role="tree" aria-label="FairyGUI 组件">
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index]
          return (
            <div key={row.key} className="absolute left-0 top-0 w-full" style={{ height: item.size, transform: `translateY(${item.start}px)` }}>
              {row.kind === "package" ? (
                <button type="button" className="flex h-full w-full items-center gap-2 border-b bg-muted/40 px-3 text-left text-xs font-semibold text-muted-foreground hover:bg-muted/70" role="treeitem" aria-expanded={!collapsedPackages.has(row.packageId)} onClick={() => {
                  const next = new Set(collapsedPackages)
                  if (next.has(row.packageId)) next.delete(row.packageId)
                  else next.add(row.packageId)
                  onCollapsedPackagesChange(next)
                }}>
                  {collapsedPackages.has(row.packageId) ? <ChevronRight className="size-3.5 shrink-0" /> : <ChevronDown className="size-3.5 shrink-0" />}
                  <span className="truncate">{row.packageName}</span><Badge variant="outline" className="ml-auto h-5 px-1.5 text-[10px]">{row.count}</Badge>
                </button>
              ) : (
                <button type="button" role="treeitem" aria-selected={selected?.packageId === row.packageId && selected.componentId === row.component.id} onClick={() => onSelect({ packageId: row.packageId, componentId: row.component.id })} className={`flex h-full w-full items-center px-4 text-left text-sm hover:bg-accent ${selected?.packageId === row.packageId && selected.componentId === row.component.id ? "bg-accent font-medium text-accent-foreground" : "text-muted-foreground"}`}>
                  <span className="truncate">{row.component.name}</span><code className="ml-auto pl-2 text-[10px] opacity-50">{row.component.id}</code>
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function brokerRendered(state: RenderSessionState | null): ViewerRendered | null {
  if (!state?.rendered) return null
  return { ...state.rendered, ...(state.observation ?? { controllers: [], availableTransitions: [] }) }
}

export function RenderCommandStatus({ state, error, dismiss }: { state: RenderSessionState | null; error: string; dismiss(): void }) {
  return <div className="text-xs text-muted-foreground">
    {state ? <span aria-label="Broker 状态版本">Semantic {state.semanticStateVersion} · View {state.viewStateVersion}</span> : null}
    {error ? <div role="alert" className="mt-2 flex items-center gap-3 rounded-md border border-amber-500/40 p-3"><span className="flex-1">{error}</span><Button size="sm" variant="outline" onClick={dismiss}>知道了</Button></div> : null}
  </div>
}

export function RenderStateControls({ rendered, session, onError }: {
  rendered: ViewerRendered | null
  session: RenderSessionClient | null
  onError: (message: string) => void
}) {
  const [controllerIndex, setControllerIndex] = useState("0")
  const [transitionIndex, setTransitionIndex] = useState("0")
  const [busy, setBusy] = useState(false)
  const targetId = rendered?.objectTree.id
  const controllers = rendered?.controllers.filter((item) => item.targetId === targetId) ?? []
  const transitions = rendered?.availableTransitions.filter((item) => item.targetId === targetId) ?? []
  useEffect(() => {
    setControllerIndex("0")
    setTransitionIndex("0")
  }, [rendered?.packageId, rendered?.componentId])
  if (!rendered || !session || (controllers.length === 0 && transitions.length === 0)) return null

  const apply = async (operation: ViewerOperation) => {
    setBusy(true)
    try {
      await session.applyOperations([operation])
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  const controller = controllers[Number(controllerIndex)] ?? controllers[0]
  const transition = transitions[Number(transitionIndex)] ?? transitions[0]

  return (
    <>
      {controller ? <>
        <label className="grid w-44 gap-1">
          <span className="text-[11px] text-muted-foreground">Controller</span>
          <select value={controllerIndex} onChange={(event) => setControllerIndex(event.target.value)} disabled={busy} aria-label="选择 Controller" className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {controllers.map((item, index) => <option key={`${item.targetId}:${item.name}`} value={index}>{item.name} · {item.targetId}</option>)}
          </select>
        </label>
        <label className="grid w-32 gap-1">
          <span className="text-[11px] text-muted-foreground">Page</span>
          <select value={controller.pageId} onChange={(event) => void apply({ op: "set-controller-page", targetId: controller.targetId, controllerName: controller.name, pageId: event.target.value })} disabled={busy || controller.pages.length < 2} aria-label={`切换 Controller ${controller.name} Page`} className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
            {controller.pages.map((page) => <option key={page.id} value={page.id}>{page.name || page.id}</option>)}
          </select>
        </label>
      </> : null}
      {transitions.length > 0 ? (
        <div className="flex items-end gap-2">
          <label className="grid w-44 gap-1">
            <span className="text-[11px] text-muted-foreground">Transition</span>
            <select value={transitionIndex} onChange={(event) => setTransitionIndex(event.target.value)} disabled={busy} aria-label="选择 Transition" className="h-9 w-full min-w-0 rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {transitions.map((item, index) => <option key={`${item.targetId}:${item.name}`} value={index}>{item.name} · {item.targetId}</option>)}
            </select>
          </label>
          <Button variant="outline" size="sm" onClick={() => transition && void apply({ op: "play-transition", targetId: transition.targetId, transitionName: transition.name })} disabled={busy || !transition}><Play />播放</Button>
        </div>
      ) : null}
    </>
  )
}
