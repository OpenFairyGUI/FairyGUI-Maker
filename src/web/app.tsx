import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from "@tanstack/react-router"

import { ArtifactPlayerPage, PlayerPage } from "@/artifact-player"
import { AssetManagerPage, ProjectAssetManagerPage } from "@/asset-manager"
import { ViewerLoading } from "@/components/workbench"
import { DashboardPage } from "@/dashboard"
import { FeatureRouteError, WorkbenchLayout } from "@/layout"
import { ProjectViewer, ProjectViewerPage, ViewerPage } from "@/project-viewer"

const DesignImportPage = lazyRouteComponent(() => import("@/design-import"), "DesignImportPage")
const ImportDraftPage = lazyRouteComponent(() => import("@/design-import"), "ImportDraftPage")

const rootRoute = createRootRoute({ component: WorkbenchLayout })
const dashboardRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: DashboardPage })
const viewerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/viewer", component: ViewerPage })
const playerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/player", component: PlayerPage })
const assetManagerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/asset-manager", component: AssetManagerPage })
const designImportRoute = createRoute({ getParentRoute: () => rootRoute, path: "/design-import", component: DesignImportPage })
const artifactPlayerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/artifacts/$artifactId/player", component: ArtifactPlayerPage })
const projectViewerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId/viewer", component: ProjectViewerPage })
const projectAssetManagerRoute = createRoute({ getParentRoute: () => rootRoute, path: "/projects/$projectId/assets", component: ProjectAssetManagerPage })
const importDraftRoute = createRoute({ getParentRoute: () => rootRoute, path: "/imports/$draftId", component: ImportDraftRoutePage })
const routeTree = rootRoute.addChildren([dashboardRoute, viewerRoute, playerRoute, assetManagerRoute, designImportRoute, artifactPlayerRoute, projectViewerRoute, projectAssetManagerRoute, importDraftRoute])

function ImportDraftRoutePage() {
  const { draftId } = importDraftRoute.useParams()
  return <ImportDraftPage draftId={draftId} renderPreview={(project, onCapture) => <ProjectViewer project={project} compact onCapture={onCapture} />} />
}

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingComponent: () => <ViewerLoading message="正在加载功能页面…" />,
  defaultErrorComponent: FeatureRouteError,
})

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}
