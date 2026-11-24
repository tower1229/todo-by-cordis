import { Context, FiberState, symbols, type Fiber, type Plugin } from "cordis";
import type { ComponentType } from "react";
import { computeHotSwapPlan, type MountedEntryMeta } from "../../contracts/topology.js";
import type {
  ActiveClientComposition,
  ClientDiagnostic,
  ClientPageRegistration,
  ClientRouter,
  SlotRegistrationOptions,
  SlotRegistry,
} from "../../contracts/client-sdk.js";
import type {
  ClientConnectionState,
  ClientRuntimeBridge,
  ClientRuntimeSnapshot,
  MountedClientPluginSummary,
  RegisteredClientPage,
  RegisteredSlotEntry,
} from "./runtime-bridge.js";

const HOST_PLUGIN_ID = Symbol("host.client.pluginId");
const HOST_PLUGIN_VERSION = Symbol("host.client.pluginVersion");
const EMPTY_SLOT_ENTRIES: readonly RegisteredSlotEntry[] = Object.freeze([]);

interface MountedClientPluginRecord {
  readonly pluginId: string;
  readonly versionId: string;
  readonly dependencies: readonly string[];
  readonly hasClientEntry: boolean;
  readonly hasStyleCss: boolean;
  readonly fiber: Fiber;
}

export interface ClientCordisRuntimeOptions {
  readonly sseUrl?: string;
  readonly diagnosticsUrl?: string;
  readonly moduleImporter?: (url: string) => Promise<Record<string, unknown>>;
}

function normalizePath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.replace(/\/+$/, "") || "/";
}

function extractClientPluginExport(
  mod: Record<string, unknown>,
  pluginId: string,
): Plugin {
  const candidate = mod.default;
  if (
    typeof candidate === "function" ||
    (candidate &&
      typeof candidate === "object" &&
      typeof (candidate as { apply?: unknown }).apply === "function")
  ) {
    return candidate as Plugin;
  }
  if (typeof mod.apply === "function") {
    return mod as unknown as Plugin;
  }
  throw new Error(
    `Plugin "${pluginId}" client module must export a default Cordis plugin or named apply(ctx) function`,
  );
}

function sameCompositionTarget(
  currentCompositionId: string,
  currentMounted: readonly MountedClientPluginRecord[],
  target: ActiveClientComposition,
): boolean {
  if (currentCompositionId !== target.compositionId) return false;
  if (currentMounted.length !== target.plugins.length) return false;
  for (let i = 0; i < currentMounted.length; i += 1) {
    const a = currentMounted[i]!;
    const b = target.plugins[i]!;
    if (
      a.pluginId !== b.pluginId ||
      a.versionId !== b.versionId ||
      a.dependencies.join(",") !== b.dependencies.join(",")
    ) {
      return false;
    }
  }
  return true;
}

export class ClientCordisRuntime implements ClientRuntimeBridge {
  readonly rootCtx = new Context();

  private readonly sseUrl: string;
  private readonly diagnosticsUrl: string;
  private readonly moduleImporter: (
    url: string,
  ) => Promise<Record<string, unknown>>;

  private mountedOrdered: MountedClientPluginRecord[] = [];
  private readonly mountedById = new Map<string, MountedClientPluginRecord>();
  private currentCompositionId = "";
  private connectionState: ClientConnectionState = "connecting";
  private reconciling = false;
  private lastReconciledAt: string | null = null;
  private pendingSnapshot: ActiveClientComposition | null = null;
  private activeReconcilePromise: Promise<void> | null = null;
  private eventSource: EventSource | null = null;
  private closed = false;

  // Routes store
  private routeSeq = 0;
  private readonly routesByPath = new Map<string, RegisteredClientPage>();
  private routesSnapshot: readonly RegisteredClientPage[] = [];
  private readonly routeListeners = new Set<() => void>();

  // Navigation path store
  private currentPath: string =
    typeof window !== "undefined" ? normalizePath(window.location.pathname) : "/";
  private readonly pathListeners = new Set<() => void>();
  private readonly onPopState: () => void;

  // Slots store
  private slotSeq = 0;
  private readonly slotRecords = new Map<string, RegisteredSlotEntry[]>();
  private readonly slotSnapshots = new Map<
    string,
    readonly RegisteredSlotEntry[]
  >();
  private readonly slotListeners = new Map<string, Set<() => void>>();

  // Runtime & diagnostics stores
  private runtimeSnapshot: ClientRuntimeSnapshot;
  private readonly runtimeListeners = new Set<() => void>();
  private diagnosticSeq = 0;
  private diagnosticsSnapshot: readonly ClientDiagnostic[] = [];
  private readonly diagnosticListeners = new Set<() => void>();

  constructor(options?: ClientCordisRuntimeOptions) {
    this.sseUrl = options?.sseUrl ?? "/api/host/client/events";
    this.diagnosticsUrl =
      options?.diagnosticsUrl ?? "/api/host/client-diagnostics";
    this.moduleImporter =
      options?.moduleImporter ??
      ((url: string) =>
        import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>);

    this.runtimeSnapshot = this.buildRuntimeSnapshot();
    this.installRootAccessors();

    this.onPopState = () => {
      const next = normalizePath(window.location.pathname);
      if (next !== this.currentPath) {
        this.currentPath = next;
        this.notify(this.pathListeners);
      }
    };
    if (typeof window !== "undefined") {
      window.addEventListener("popstate", this.onPopState);
    }
  }

  private resolveOwnerContext(ctx: Context): {
    pluginId: string;
    versionId: string;
    fiber: Fiber;
  } {
    const ctxRecord = ctx as unknown as Record<PropertyKey, unknown>;
    const shadow = ctxRecord[symbols.shadow] as
      | (Context & Record<PropertyKey, unknown>)
      | undefined;
    const origin =
      shadow ?? (ctx as unknown as Context & Record<PropertyKey, unknown>);
    const pluginId = origin[HOST_PLUGIN_ID];
    const versionId = origin[HOST_PLUGIN_VERSION];
    if (typeof pluginId !== "string" || pluginId.length === 0) {
      throw new Error(
        "Host client plugin identity is missing; client root services require host-injected plugin identity",
      );
    }
    return {
      pluginId,
      versionId: typeof versionId === "string" ? versionId : "unknown",
      fiber: origin.fiber,
    };
  }

  private installRootAccessors(): void {
    const self = this;

    this.rootCtx.accessor("router", {
      get(): ClientRouter {
        const { pluginId, versionId, fiber } = self.resolveOwnerContext(this);
        return {
          registerPage: (page: ClientPageRegistration) =>
            self.registerPageForPlugin(pluginId, versionId, fiber, page),
        };
      },
    });

    this.rootCtx.accessor("slots", {
      get(): SlotRegistry {
        const { pluginId, versionId, fiber } = self.resolveOwnerContext(this);
        return {
          register: (
            slotName: string,
            component: ComponentType<any>,
            options?: SlotRegistrationOptions,
          ) =>
            self.registerSlotForPlugin(
              pluginId,
              versionId,
              fiber,
              slotName,
              component as ComponentType<Record<string, unknown>>,
              options,
            ),
        };
      },
    });
  }

  private registerPageForPlugin(
    pluginId: string,
    versionId: string,
    fiber: Fiber,
    page: ClientPageRegistration,
  ): () => void {
    const path = normalizePath(page.path);
    const existing = this.routesByPath.get(path);
    if (existing) {
      throw new Error(
        `Client route conflict for "${path}": already registered by "${existing.pluginId}"`,
      );
    }

    const record: RegisteredClientPage = {
      pluginId,
      versionId,
      path,
      ...(page.navLabel !== undefined ? { navLabel: page.navLabel } : {}),
      order: page.order ?? 0,
      seq: ++this.routeSeq,
      component: page.component,
    };

    this.routesByPath.set(path, record);
    this.rebuildRoutesSnapshot();

    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      if (this.routesByPath.get(path) === record) {
        this.routesByPath.delete(path);
        this.rebuildRoutesSnapshot();
      }
    };

    const detachEffect = fiber.effect(() => cleanup);
    return () => {
      detachEffect();
      cleanup();
    };
  }

  private rebuildRoutesSnapshot(): void {
    this.routesSnapshot = [...this.routesByPath.values()].sort((a, b) =>
      a.order !== b.order ? a.order - b.order : a.seq - b.seq,
    );
    this.notify(this.routeListeners);
  }

  private registerSlotForPlugin(
    pluginId: string,
    versionId: string,
    fiber: Fiber,
    slotName: string,
    component: ComponentType<Record<string, unknown>>,
    options?: SlotRegistrationOptions,
  ): () => void {
    const seq = ++this.slotSeq;
    const id = options?.id ?? `${pluginId}-${seq}`;
    const entry: RegisteredSlotEntry = {
      id,
      pluginId,
      versionId,
      slotName,
      order: options?.order ?? 0,
      seq,
      component,
    };

    let list = this.slotRecords.get(slotName);
    if (!list) {
      list = [];
      this.slotRecords.set(slotName, list);
    }
    list.push(entry);
    this.rebuildSlotSnapshot(slotName);

    let disposed = false;
    const cleanup = () => {
      if (disposed) return;
      disposed = true;
      const current = this.slotRecords.get(slotName);
      if (!current) return;
      const idx = current.indexOf(entry);
      if (idx !== -1) {
        current.splice(idx, 1);
        if (current.length === 0) {
          this.slotRecords.delete(slotName);
        }
        this.rebuildSlotSnapshot(slotName);
      }
    };

    const detachEffect = fiber.effect(() => cleanup);
    return () => {
      detachEffect();
      cleanup();
    };
  }

  private rebuildSlotSnapshot(slotName: string): void {
    const list = this.slotRecords.get(slotName);
    if (!list || list.length === 0) {
      this.slotSnapshots.delete(slotName);
    } else {
      const sorted = [...list].sort((a, b) =>
        a.order !== b.order ? a.order - b.order : a.seq - b.seq,
      );
      this.slotSnapshots.set(slotName, sorted);
    }
    const listeners = this.slotListeners.get(slotName);
    if (listeners) {
      this.notify(listeners);
    }
  }

  private buildRuntimeSnapshot(): ClientRuntimeSnapshot {
    const mountedPlugins: MountedClientPluginSummary[] = this.mountedOrdered.map(
      (record) => ({
        pluginId: record.pluginId,
        versionId: record.versionId,
        dependencies: record.dependencies,
        state:
          record.fiber.state === FiberState.ACTIVE ? "ACTIVE" : "FAILED",
        hasClientEntry: record.hasClientEntry,
        hasStyleCss: record.hasStyleCss,
      }),
    );

    return {
      compositionId: this.currentCompositionId,
      connectionState: this.connectionState,
      reconciling: this.reconciling,
      mountedPlugins,
      lastReconciledAt: this.lastReconciledAt,
    };
  }

  private updateRuntimeSnapshot(): void {
    this.runtimeSnapshot = this.buildRuntimeSnapshot();
    this.notify(this.runtimeListeners);
  }

  private notify(listeners: ReadonlySet<() => void>): void {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // Isolate subscriber failures
      }
    }
  }

  // ---- ClientRuntimeBridge implementation ----

  readonly getRuntimeSnapshot = (): ClientRuntimeSnapshot =>
    this.runtimeSnapshot;

  readonly subscribeRuntime = (listener: () => void): (() => void) => {
    this.runtimeListeners.add(listener);
    return () => {
      this.runtimeListeners.delete(listener);
    };
  };

  readonly getRoutes = (): readonly RegisteredClientPage[] =>
    this.routesSnapshot;

  readonly subscribeRoutes = (listener: () => void): (() => void) => {
    this.routeListeners.add(listener);
    return () => {
      this.routeListeners.delete(listener);
    };
  };

  readonly getCurrentPath = (): string => this.currentPath;

  readonly subscribePath = (listener: () => void): (() => void) => {
    this.pathListeners.add(listener);
    return () => {
      this.pathListeners.delete(listener);
    };
  };

  readonly navigate = (path: string): void => {
    const next = normalizePath(path);
    if (next === this.currentPath) return;
    this.currentPath = next;
    if (typeof window !== "undefined") {
      try {
        window.history.pushState({}, "", next);
      } catch {
        // Ignore history push errors in constrained environments
      }
    }
    this.notify(this.pathListeners);
  };

  readonly getSlotEntries = (
    slotName: string,
  ): readonly RegisteredSlotEntry[] =>
    this.slotSnapshots.get(slotName) ?? EMPTY_SLOT_ENTRIES;

  readonly subscribeSlot = (
    slotName: string,
    listener: () => void,
  ): (() => void) => {
    let set = this.slotListeners.get(slotName);
    if (!set) {
      set = new Set();
      this.slotListeners.set(slotName, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
      if (set && set.size === 0) {
        this.slotListeners.delete(slotName);
      }
    };
  };

  readonly getDiagnostics = (): readonly ClientDiagnostic[] =>
    this.diagnosticsSnapshot;

  readonly subscribeDiagnostics = (listener: () => void): (() => void) => {
    this.diagnosticListeners.add(listener);
    return () => {
      this.diagnosticListeners.delete(listener);
    };
  };

  readonly reportDiagnostic = (
    input: Omit<ClientDiagnostic, "id" | "timestamp">,
  ): void => {
    const diagnostic: ClientDiagnostic = {
      ...input,
      id: `diag-${++this.diagnosticSeq}`,
      timestamp: new Date().toISOString(),
    };
    this.diagnosticsSnapshot = [
      diagnostic,
      ...this.diagnosticsSnapshot.slice(0, 49),
    ];
    this.notify(this.diagnosticListeners);

    // Best-effort non-blocking report to supervisor server
    if (typeof fetch === "function" && this.diagnosticsUrl) {
      void fetch(this.diagnosticsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(diagnostic),
      }).catch(() => {});
    }
  };

  readonly clearDiagnostics = (): void => {
    if (this.diagnosticsSnapshot.length === 0) return;
    this.diagnosticsSnapshot = [];
    this.notify(this.diagnosticListeners);
  };

  // ---- Reconcile & SSE synchronization ----

  reconcile(snapshot: ActiveClientComposition): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.pendingSnapshot = snapshot;
    if (!this.activeReconcilePromise) {
      this.activeReconcilePromise = this.drainReconcileQueue().finally(() => {
        this.activeReconcilePromise = null;
      });
    }
    return this.activeReconcilePromise;
  }

  private async drainReconcileQueue(): Promise<void> {
    while (!this.closed && this.pendingSnapshot) {
      const target = this.pendingSnapshot;
      this.pendingSnapshot = null;

      if (
        sameCompositionTarget(
          this.currentCompositionId,
          this.mountedOrdered,
          target,
        )
      ) {
        continue;
      }

      this.reconciling = true;
      this.updateRuntimeSnapshot();

      try {
        await this.applyClientSnapshot(target);
      } finally {
        this.reconciling = false;
        this.lastReconciledAt = new Date().toISOString();
        this.updateRuntimeSnapshot();
      }
    }
  }

  private async applyClientSnapshot(
    target: ActiveClientComposition,
  ): Promise<void> {
    const currentMeta: MountedEntryMeta[] = this.mountedOrdered.map((m) => ({
      pluginId: m.pluginId,
      versionId: m.versionId,
      dependencies: m.dependencies,
    }));
    const targetMeta: MountedEntryMeta[] = target.plugins.map((p) => ({
      pluginId: p.pluginId,
      versionId: p.versionId,
      dependencies: p.dependencies,
    }));

    const plan = computeHotSwapPlan(currentMeta, targetMeta);

    // Defensive check: if any currently mounted plugin depends on an upstream that
    // is NOT currently mounted (e.g. recovering after an earlier upstream load failure),
    // dispose and remount that dependent so upstream always mounts before downstream.
    const toDisposeSet = new Set<string>(plan.toDispose);
    const toMountIds = new Set<string>(plan.toMount.map((m) => m.pluginId));
    let propagated = true;
    while (propagated) {
      propagated = false;
      for (const cur of this.mountedOrdered) {
        if (toDisposeSet.has(cur.pluginId)) continue;
        const hasUnmountedOrRemountingDep = cur.dependencies.some(
          (dep) =>
            !this.mountedById.has(dep) ||
            toDisposeSet.has(dep) ||
            toMountIds.has(dep),
        );
        if (hasUnmountedOrRemountingDep) {
          toDisposeSet.add(cur.pluginId);
          propagated = true;
        }
      }
    }

    const orderedDispose = [...this.mountedOrdered]
      .reverse()
      .filter((entry) => toDisposeSet.has(entry.pluginId))
      .map((entry) => entry.pluginId);

    // 1. Dispose removed/disabled/upgraded/dependent client Fibers in reverse topological order
    for (const pluginId of orderedDispose) {
      const record = this.mountedById.get(pluginId);
      if (!record) continue;
      try {
        await record.fiber.dispose();
      } catch (error) {
        this.reportDiagnostic({
          pluginId: record.pluginId,
          versionId: record.versionId,
          kind: "reconcile-error",
          message:
            error instanceof Error
              ? `Dispose failed: ${error.message}`
              : `Dispose failed: ${String(error)}`,
        });
      }
      this.mountedById.delete(pluginId);
    }
    this.mountedOrdered = this.mountedOrdered.filter((m) =>
      this.mountedById.has(m.pluginId),
    );

    // 2. Dynamically load & mount added/upgraded client Fibers in forward topological order.
    // Never mount a downstream plugin when any of its upstream dependencies failed to activate.
    const failedPlugins = new Set<string>();
    const orderedToMount = target.plugins.filter(
      (meta) => !this.mountedById.has(meta.pluginId),
    );

    for (const meta of orderedToMount) {
      const missingDep = meta.dependencies.find(
        (dep) => failedPlugins.has(dep) || !this.mountedById.has(dep),
      );
      if (missingDep) {
        failedPlugins.add(meta.pluginId);
        this.reportDiagnostic({
          pluginId: meta.pluginId,
          versionId: meta.versionId,
          kind: "load-error",
          message: `Skipped mounting "${meta.pluginId}" because dependency "${missingDep}" is not active`,
        });
        continue;
      }

      let loadedPluginExport: Plugin | null = null;
      if (meta.clientEntryUrl) {
        try {
          const mod = await this.moduleImporter(meta.clientEntryUrl);
          if (this.closed) return;
          loadedPluginExport = extractClientPluginExport(mod, meta.pluginId);
        } catch (error) {
          failedPlugins.add(meta.pluginId);
          this.reportDiagnostic({
            pluginId: meta.pluginId,
            versionId: meta.versionId,
            kind: "load-error",
            message:
              error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack
              ? { stack: error.stack }
              : {}),
          });
          continue;
        }
      }

      const pluginCtx = this.rootCtx.extend({
        [HOST_PLUGIN_ID]: meta.pluginId,
        [HOST_PLUGIN_VERSION]: meta.versionId,
      });

      const styleCss = meta.styleCss?.trim() ?? "";
      const wrapperPlugin: Plugin = async (ctx) => {
        if (styleCss.length > 0 && typeof document !== "undefined") {
          ctx.effect(() => {
            const styleEl = document.createElement("style");
            styleEl.setAttribute(
              "data-cordis-plugin",
              `${meta.pluginId}@${meta.versionId}`,
            );
            styleEl.setAttribute("data-cordis-plugin-id", meta.pluginId);
            styleEl.textContent = styleCss;
            document.head.appendChild(styleEl);
            return () => {
              styleEl.remove();
            };
          });
        }
        if (loadedPluginExport) {
          const childFiber = ctx.plugin(loadedPluginExport);
          await childFiber;
          if (childFiber.state !== FiberState.ACTIVE) {
            throw new Error(
              `Client plugin "${meta.pluginId}@${meta.versionId}" did not enter ACTIVE state (state=${childFiber.state})`,
            );
          }
        }
      };

      const fiber = pluginCtx.plugin(wrapperPlugin);
      try {
        await fiber;
        if (this.closed) {
          await fiber.dispose();
          return;
        }
        if (fiber.state !== FiberState.ACTIVE) {
          throw new Error(
            `Client plugin "${meta.pluginId}@${meta.versionId}" did not enter ACTIVE state (state=${fiber.state})`,
          );
        }
        this.mountedById.set(meta.pluginId, {
          pluginId: meta.pluginId,
          versionId: meta.versionId,
          dependencies: [...meta.dependencies],
          hasClientEntry: Boolean(meta.clientEntryUrl),
          hasStyleCss: styleCss.length > 0,
          fiber,
        });
      } catch (error) {
        failedPlugins.add(meta.pluginId);
        try {
          await fiber.dispose();
        } catch {
          // Ignore secondary cleanup errors
        }
        this.reportDiagnostic({
          pluginId: meta.pluginId,
          versionId: meta.versionId,
          kind: "load-error",
          message:
            error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack
            ? { stack: error.stack }
            : {}),
        });
      }
    }

    // 3. Rebuild mountedOrdered in authoritative target topological order
    const nextOrdered: MountedClientPluginRecord[] = [];
    for (const meta of target.plugins) {
      const record = this.mountedById.get(meta.pluginId);
      if (record) {
        nextOrdered.push(record);
      }
    }
    this.mountedOrdered = nextOrdered;
    this.currentCompositionId = target.compositionId;
  }

  connectSse(): void {
    if (this.closed || this.eventSource || typeof EventSource === "undefined") {
      return;
    }

    this.connectionState = "connecting";
    this.updateRuntimeSnapshot();

    const es = new EventSource(this.sseUrl);
    this.eventSource = es;

    es.onopen = () => {
      this.connectionState = "connected";
      this.updateRuntimeSnapshot();
    };

    es.addEventListener("composition", (event: MessageEvent) => {
      try {
        const snapshot = JSON.parse(
          String(event.data),
        ) as ActiveClientComposition;
        if (this.connectionState !== "connected") {
          this.connectionState = "connected";
          this.updateRuntimeSnapshot();
        }
        void this.reconcile(snapshot);
      } catch (error) {
        this.reportDiagnostic({
          pluginId: "client-runtime",
          kind: "reconcile-error",
          message:
            error instanceof Error
              ? `Invalid SSE composition payload: ${error.message}`
              : `Invalid SSE composition payload: ${String(error)}`,
        });
      }
    });

    es.onerror = () => {
      if (this.closed) return;
      this.connectionState = "reconnecting";
      this.updateRuntimeSnapshot();
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("popstate", this.onPopState);
    }

    for (const record of [...this.mountedOrdered].reverse()) {
      try {
        await record.fiber.dispose();
      } catch {
        // Ignore dispose errors during close
      }
    }
    this.mountedOrdered = [];
    this.mountedById.clear();
  }
}
