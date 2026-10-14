import { useQuery } from "@tanstack/react-query"
import { Link, Outlet } from "@tanstack/react-router"
import { Boxes, CircleGauge, Eye, FileInput, FolderKanban, Play } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { statusQuery } from "@/lib/queries"

export function WorkbenchLayout() {
  const status = useQuery(statusQuery)
  return (
    <ResizablePanelGroup orientation="horizontal" className="min-h-screen bg-background text-foreground">
      <ResizablePanel id="navigation" defaultSize="18" minSize={220} maxSize={360} className="min-w-0 bg-sidebar">
        <aside className="flex h-full min-h-screen flex-col border-r border-sidebar-border p-4">
          <div className="mb-7 flex items-center gap-3 px-2">
            <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Boxes className="size-5" />
            </div>
            <div>
              <div className="font-heading font-semibold">FairyGUI Maker</div>
              <div className="text-xs text-muted-foreground">Workbench</div>
            </div>
          </div>
          <nav aria-label="Maker Workbench 模块" className="space-y-1">
            <NavLink to="/" icon={<CircleGauge />} label="Dashboard" exact />
            <NavLink to="/viewer" icon={<Eye />} label="Viewer" />
            <NavLink to="/player" icon={<Play />} label="Player" />
            <NavLink to="/asset-manager" icon={<FolderKanban />} label="Asset Manager" />
            <NavLink to="/design-import" icon={<FileInput />} label="Design Import" />
          </nav>
          <div className="mt-auto rounded-xl border bg-background/60 p-3 text-xs text-muted-foreground">
            <div className="mb-2 flex items-center justify-between">
              <span>Maker Host</span>
              <Badge variant={status.data ? "secondary" : "outline"}>{status.data ? "RUNNING" : "CONNECTING"}</Badge>
            </div>
            <code className="block truncate text-[11px]">{status.data?.host.origin ?? "127.0.0.1"}</code>
          </div>
        </aside>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel id="content" defaultSize="82" minSize={480} className="min-w-0">
        <div className="min-h-screen bg-[radial-gradient(circle_at_top_right,oklch(0.28_0.05_260/0.32),transparent_35rem)]">
          <header className="flex h-16 items-center justify-between border-b bg-background/80 px-6 backdrop-blur">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">Local control plane</p>
              <p className="text-sm font-medium">工程、MCP 与浏览器工具链</p>
            </div>
            <Badge variant="outline" className="gap-1.5"><span className="size-1.5 rounded-full bg-emerald-500" />Local only</Badge>
          </header>
          <main className="mx-auto w-full max-w-[1500px] p-6 lg:p-8"><Outlet /></main>
        </div>
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

function NavLink({ to, icon, label, exact = false }: { to: "/" | "/viewer" | "/player" | "/asset-manager" | "/design-import"; icon: React.ReactNode; label: string; exact?: boolean }) {
  return (
    <Link
      to={to}
      activeOptions={{ exact }}
      className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
      activeProps={{ className: "bg-sidebar-accent text-sidebar-accent-foreground font-medium" }}
    >
      <span className="[&_svg]:size-4">{icon}</span>{label}
    </Link>
  )
}

export function FeatureRouteError() {
  return <Card role="alert" className="border-destructive/40"><CardContent className="grid min-h-52 place-content-center gap-4 text-center"><h1 className="font-semibold">此功能页面发生错误</h1><p className="text-sm text-muted-foreground">可继续使用侧栏切换其他功能；重新加载将清除当前页面的未保存状态。</p><div className="flex justify-center gap-2"><Button variant="outline" onClick={() => window.location.reload()}>重新加载页面</Button><Button asChild><Link to="/">返回概览</Link></Button></div></CardContent></Card>
}
