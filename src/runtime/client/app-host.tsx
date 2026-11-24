import { useClientRoutes, useCurrentPath } from "../../contracts/client-sdk.js";
import {
  PluginErrorBoundary,
  useClientRuntimeBridge,
  useClientRuntimeSnapshot,
} from "./runtime-bridge.js";

export function AppHost() {
  const routes = useClientRoutes();
  const currentPath = useCurrentPath();
  const snapshot = useClientRuntimeSnapshot();
  const bridge = useClientRuntimeBridge();

  const activeRoute =
    routes.find((route) => route.path === currentPath) ??
    routes.find((route) => route.path === "/") ??
    routes[0] ??
    null;

  if (!activeRoute) {
    return (
      <div
        data-app-empty-state="true"
        className="flex flex-1 items-center justify-center p-8 text-sm text-muted"
      >
        {snapshot.reconciling || snapshot.connectionState === "connecting"
          ? "正在加载应用组合…"
          : "当前激活组合未注册页面视图"}
      </div>
    );
  }

  const PageComponent = activeRoute.component;

  return (
    <div
      data-app-route={activeRoute.path}
      data-app-plugin={activeRoute.pluginId}
      className="flex min-h-0 flex-1 flex-col"
    >
      <PluginErrorBoundary
        key={`${activeRoute.pluginId}@${activeRoute.versionId}:${activeRoute.path}`}
        pluginId={activeRoute.pluginId}
        versionId={activeRoute.versionId}
        routePath={activeRoute.path}
        onError={bridge.reportDiagnostic}
      >
        <PageComponent />
      </PluginErrorBoundary>
    </div>
  );
}
