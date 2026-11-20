import { useRef, useState } from "react";
import { Button, Dialog } from "@base-ui/react";
import { AlertTriangle, Layers, Wifi, WifiOff, X } from "lucide-react";
import {
  useClientDiagnostics,
  useClientRuntimeBridge,
  useClientRuntimeSnapshot,
} from "../client-sdk.js";

/**
 * Zero-business thin Supervisor Shell root.
 * Mounted outside `#app-root` so plugin render errors never block or obscure host controls.
 */
export function SupervisorShell() {
  const snapshot = useClientRuntimeSnapshot();
  const diagnostics = useClientDiagnostics();
  const bridge = useClientRuntimeBridge();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const connectionLabel =
    snapshot.connectionState === "connected"
      ? "实时同步"
      : snapshot.connectionState === "reconnecting"
        ? "重连中"
        : "连接中";

  const isOnline = snapshot.connectionState === "connected";

  const openDrawer = (trigger: HTMLElement | null) => {
    returnFocusRef.current = trigger;
    setDrawerOpen(true);
  };

  return (
    <header
      data-supervisor-shell="true"
      className="relative z-50 border-b border-line bg-surface/95 text-ink backdrop-blur-xs"
    >
      <div className="mx-auto flex h-11 w-full items-center justify-between gap-3 px-4 text-xs">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="font-semibold tracking-tight text-ink">
            Cordis Supervisor
          </span>
          <span
            data-supervisor-connection={snapshot.connectionState}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
              isOnline
                ? "bg-accent-soft text-accent"
                : "bg-danger/10 text-danger"
            }`}
          >
            {isOnline ? (
              <Wifi className="size-3" aria-hidden="true" />
            ) : (
              <WifiOff className="size-3" aria-hidden="true" />
            )}
            <span>{connectionLabel}</span>
          </span>
          <span
            data-supervisor-composition={snapshot.compositionId || "none"}
            className="hidden truncate text-muted sm:inline"
          >
            组合: {snapshot.compositionId || "待同步"} ·{" "}
            {snapshot.mountedPlugins.length} 个活跃插件
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {diagnostics.length > 0 && (
            <Button
              type="button"
              data-supervisor-diagnostics-badge={diagnostics.length}
              onClick={(e) => openDrawer(e.currentTarget)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger/25 bg-danger/5 px-2.5 font-medium text-danger transition-colors hover:bg-danger/10"
            >
              <AlertTriangle className="size-3.5" aria-hidden="true" />
              <span>{diagnostics.length} 项局部异常</span>
            </Button>
          )}
          <Button
            type="button"
            data-supervisor-toggle-drawer="true"
            onClick={(e) =>
              drawerOpen ? setDrawerOpen(false) : openDrawer(e.currentTarget)
            }
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 font-medium text-ink transition-colors hover:bg-canvas"
          >
            <Layers className="size-3.5 text-muted" aria-hidden="true" />
            <span>组合状态</span>
          </Button>
        </div>
      </div>

      <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen} modal={false}>
        <Dialog.Portal>
          <Dialog.Popup
            data-supervisor-drawer="true"
            aria-label="运行组合与诊断"
            finalFocus={() =>
              returnFocusRef.current?.isConnected
                ? returnFocusRef.current
                : false
            }
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l border-line bg-surface shadow-xl outline-none"
          >
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
              <Dialog.Title className="text-sm font-semibold text-ink">
                运行组合与诊断
              </Dialog.Title>
              <Dialog.Close
                aria-label="关闭组合状态面板"
                className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-canvas hover:text-ink"
              >
                <X className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-4 text-xs">
              <section className="space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  当前权威组合
                </div>
                <div className="rounded-lg border border-line bg-canvas p-3">
                  <div className="font-mono text-xs text-ink">
                    {snapshot.compositionId || "(空)"}
                  </div>
                  <div className="mt-1 text-muted">
                    连接状态：{connectionLabel} · 活跃插件：
                    {snapshot.mountedPlugins.length}
                  </div>
                </div>
              </section>

              <section className="space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  客户端插件 Fiber
                </div>
                {snapshot.mountedPlugins.length === 0 ? (
                  <p className="text-muted">当前无已挂载插件</p>
                ) : (
                  <ul className="space-y-2">
                    {snapshot.mountedPlugins.map((plugin) => (
                      <li
                        key={`${plugin.pluginId}@${plugin.versionId}`}
                        className="rounded-lg border border-line bg-surface p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-ink">
                            {plugin.pluginId}
                          </span>
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] text-accent">
                            {plugin.state}
                          </span>
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-muted">
                          v:{plugin.versionId}
                          {plugin.hasStyleCss ? " · css" : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    局部渲染与加载诊断 ({diagnostics.length})
                  </span>
                  {diagnostics.length > 0 && (
                    <button
                      type="button"
                      onClick={() => bridge.clearDiagnostics()}
                      className="text-accent hover:underline"
                    >
                      清空
                    </button>
                  )}
                </div>
                {diagnostics.length === 0 ? (
                  <p className="text-muted">无异常记录</p>
                ) : (
                  <ul className="space-y-2">
                    {diagnostics.map((diag) => (
                      <li
                        key={diag.id}
                        data-supervisor-diagnostic-plugin={diag.pluginId}
                        className="rounded-lg border border-danger/25 bg-danger/5 p-2.5 text-danger"
                      >
                        <div className="font-medium">
                          {diag.pluginId} ({diag.kind})
                          {diag.slotName ? ` · slot:${diag.slotName}` : ""}
                        </div>
                        <div className="mt-0.5 break-words opacity-90">
                          {diag.message}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </header>
  );
}
