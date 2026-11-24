import {
  createElement,
  useSyncExternalStore,
  type ComponentType,
  type ReactElement,
} from "react";
import type { Context } from "cordis";
import {
  PluginErrorBoundary,
  useClientRuntimeBridge,
  useSlotEntries,
  type RegisteredClientPage,
} from "../runtime/client/runtime-bridge.js";

export type { ActiveClientComposition, ClientDiagnostic } from "./types.js";
export type { RegisteredClientPage } from "../runtime/client/runtime-bridge.js";

/**
 * Extensible slot props map augmented by plugins via `declare module "@host/client-sdk"`.
 * Kept intentionally empty in the zero-business host.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SlotPropsMap {}

export type SlotPropsFor<K extends string> = K extends keyof SlotPropsMap
  ? SlotPropsMap[K]
  : Record<string, unknown>;

export interface ClientPageRegistration {
  readonly path: string;
  readonly navLabel?: string;
  readonly order?: number;
  readonly component: ComponentType;
}

export interface ClientRouter {
  registerPage(page: ClientPageRegistration): () => void;
}

export interface SlotRegistrationOptions {
  readonly order?: number;
  readonly id?: string;
}

export interface SlotRegistry {
  register<K extends string>(
    slotName: K,
    component: ComponentType<SlotPropsFor<K>>,
    options?: SlotRegistrationOptions,
  ): () => void;
}

declare module "cordis" {
  interface Context {
    readonly router: ClientRouter;
    readonly slots: SlotRegistry;
  }
}

export function useClientContext(): Context {
  return useClientRuntimeBridge().rootCtx;
}

export function useClientRoutes(): readonly RegisteredClientPage[] {
  const bridge = useClientRuntimeBridge();
  return useSyncExternalStore(
    bridge.subscribeRoutes,
    bridge.getRoutes,
    bridge.getRoutes,
  );
}

export function useCurrentPath(): string {
  const bridge = useClientRuntimeBridge();
  return useSyncExternalStore(
    bridge.subscribePath,
    bridge.getCurrentPath,
    bridge.getCurrentPath,
  );
}

export function useNavigate(): (path: string) => void {
  return useClientRuntimeBridge().navigate;
}

/**
 * Execute an asynchronous client-side bail hook via Cordis's public `events.dispatch` API.
 * Respects Cordis scope filtering and priority ordering; returns `false` or a non-empty
 * string when a listener blocks the action.
 */
export async function dispatchClientBail<TPayload>(
  ctx: Context,
  eventName: string,
  payload: TPayload,
): Promise<void | false | string> {
  const events = (
    ctx as unknown as {
      events?: {
        dispatch(
          type: string,
          args: unknown[],
        ): Array<
          (
            payload: TPayload,
          ) => Promise<void | false | string> | void | false | string
        >;
      };
    }
  ).events;
  const callbacks = events?.dispatch("serial", [eventName]) ?? [];
  for (const callback of callbacks) {
    const verdict = await callback(payload);
    if (verdict === false) return false;
    if (typeof verdict === "string" && verdict.length > 0) return verdict;
  }
}

export function Slot<K extends string>({
  name,
  props,
  className,
}: {
  readonly name: K;
  readonly props?: SlotPropsFor<K>;
  readonly className?: string;
}): ReactElement | null {
  const bridge = useClientRuntimeBridge();
  const entries = useSlotEntries(name);

  if (entries.length === 0) {
    return null;
  }

  const items = entries.map((entry) => {
    const EntryComponent = entry.component;
    const entryProps = (props ?? {}) as Record<string, unknown>;
    return createElement(
      PluginErrorBoundary,
      {
        key: `${entry.pluginId}@${entry.versionId}:${entry.id}`,
        pluginId: entry.pluginId,
        versionId: entry.versionId,
        slotName: name,
        onError: bridge.reportDiagnostic,
      },
      createElement(EntryComponent, entryProps),
    );
  });

  if (className) {
    return createElement(
      "div",
      {
        className,
        "data-slot": name,
      },
      ...items,
    );
  }

  return createElement(
    "div",
    {
      className: "contents",
      "data-slot": name,
    },
    ...items,
  );
}
