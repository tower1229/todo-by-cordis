import {
  Component,
  createContext,
  createElement,
  useCallback,
  useContext,
  useSyncExternalStore,
  type ComponentType,
  type ErrorInfo,
  type ReactNode,
} from "react";
import type { Context } from "cordis";
import type { ClientDiagnostic } from "../../contracts/types.js";

export interface RegisteredClientPage {
  readonly pluginId: string;
  readonly versionId: string;
  readonly path: string;
  readonly navLabel?: string;
  readonly order: number;
  readonly seq: number;
  readonly component: ComponentType;
}

export interface RegisteredSlotEntry {
  readonly id: string;
  readonly pluginId: string;
  readonly versionId: string;
  readonly slotName: string;
  readonly order: number;
  readonly seq: number;
  readonly component: ComponentType<Record<string, unknown>>;
}

export type ClientConnectionState = "connecting" | "connected" | "reconnecting";

export interface MountedClientPluginSummary {
  readonly pluginId: string;
  readonly versionId: string;
  readonly dependencies: readonly string[];
  readonly state: "ACTIVE" | "FAILED";
  readonly hasClientEntry: boolean;
  readonly hasStyleCss: boolean;
}

export interface ClientRuntimeSnapshot {
  readonly compositionId: string;
  readonly connectionState: ClientConnectionState;
  readonly reconciling: boolean;
  readonly mountedPlugins: readonly MountedClientPluginSummary[];
  readonly lastReconciledAt: string | null;
}

export interface ClientRuntimeBridge {
  readonly rootCtx: Context;
  getRuntimeSnapshot(): ClientRuntimeSnapshot;
  subscribeRuntime(listener: () => void): () => void;
  getRoutes(): readonly RegisteredClientPage[];
  subscribeRoutes(listener: () => void): () => void;
  getCurrentPath(): string;
  subscribePath(listener: () => void): () => void;
  navigate(path: string): void;
  getSlotEntries(slotName: string): readonly RegisteredSlotEntry[];
  subscribeSlot(slotName: string, listener: () => void): () => void;
  getDiagnostics(): readonly ClientDiagnostic[];
  subscribeDiagnostics(listener: () => void): () => void;
  reportDiagnostic(input: Omit<ClientDiagnostic, "id" | "timestamp">): void;
  clearDiagnostics(): void;
}

const ClientRuntimeReactContext = createContext<ClientRuntimeBridge | null>(null);

export function ClientRuntimeProvider({
  runtime,
  children,
}: {
  readonly runtime: ClientRuntimeBridge;
  readonly children: ReactNode;
}) {
  return createElement(
    ClientRuntimeReactContext.Provider,
    { value: runtime },
    children,
  );
}

export function useClientRuntimeBridge(): ClientRuntimeBridge {
  const bridge = useContext(ClientRuntimeReactContext);
  if (!bridge) {
    throw new Error(
      "ClientRuntimeProvider is missing in the React component tree",
    );
  }
  return bridge;
}

export function useClientRuntimeSnapshot(): ClientRuntimeSnapshot {
  const bridge = useClientRuntimeBridge();
  return useSyncExternalStore(
    bridge.subscribeRuntime,
    bridge.getRuntimeSnapshot,
    bridge.getRuntimeSnapshot,
  );
}

export function useSlotEntries(slotName: string): readonly RegisteredSlotEntry[] {
  const bridge = useClientRuntimeBridge();
  const subscribe = useCallback(
    (listener: () => void) => bridge.subscribeSlot(slotName, listener),
    [bridge, slotName],
  );
  const getSnapshot = useCallback(
    () => bridge.getSlotEntries(slotName),
    [bridge, slotName],
  );
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useClientDiagnostics(): readonly ClientDiagnostic[] {
  const bridge = useClientRuntimeBridge();
  return useSyncExternalStore(
    bridge.subscribeDiagnostics,
    bridge.getDiagnostics,
    bridge.getDiagnostics,
  );
}

export interface PluginErrorBoundaryProps {
  readonly pluginId: string;
  readonly versionId?: string;
  readonly slotName?: string;
  readonly routePath?: string;
  readonly onError?: (
    diagnostic: Omit<ClientDiagnostic, "id" | "timestamp">,
  ) => void;
  readonly children?: ReactNode;
}

interface PluginErrorBoundaryState {
  readonly hasError: boolean;
  readonly message: string;
}

export class PluginErrorBoundary extends Component<
  PluginErrorBoundaryProps,
  PluginErrorBoundaryState
> {
  override state: PluginErrorBoundaryState = {
    hasError: false,
    message: "",
  };

  static getDerivedStateFromError(error: unknown): PluginErrorBoundaryState {
    const message =
      error instanceof Error ? error.message : String(error ?? "Unknown error");
    return { hasError: true, message };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.({
      pluginId: this.props.pluginId,
      ...(this.props.versionId ? { versionId: this.props.versionId } : {}),
      kind: "render-error",
      ...(this.props.slotName ? { slotName: this.props.slotName } : {}),
      ...(this.props.routePath ? { routePath: this.props.routePath } : {}),
      message: error?.message ?? String(error),
      stack: [error?.stack, info?.componentStack].filter(Boolean).join("\n"),
    });
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return createElement(
        "div",
        {
          role: "alert",
          "data-plugin-error-boundary": this.props.pluginId,
          ...(this.props.slotName
            ? { "data-plugin-error-slot": this.props.slotName }
            : {}),
          ...(this.props.routePath
            ? { "data-plugin-error-route": this.props.routePath }
            : {}),
          className:
            "inline-flex max-w-full flex-wrap items-center gap-1.5 rounded-md border border-danger/25 bg-danger/5 px-2.5 py-1.5 text-xs leading-5 text-danger",
        },
        createElement(
          "span",
          { className: "font-medium" },
          `插件 ${this.props.pluginId} 渲染异常`,
        ),
        createElement(
          "span",
          { className: "truncate opacity-80" },
          this.state.message,
        ),
      );
    }
    return this.props.children;
  }
}
