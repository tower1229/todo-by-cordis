import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { Context, symbols, type Fiber, type Plugin } from "cordis";
import { HttpRouteRegistry } from "./http-router.js";
import { SchedulerEngine } from "./scheduler.js";
import { createScopedDb, openAppDatabase } from "./scoped-db.js";
import { computeHotSwapPlan, type MountedEntryMeta } from "../../contracts/topology.js";
import type {
  AppResponse,
  CompositionTopology,
  FiberStateName,
  HttpDispatchInput,
  PluginTopologyEntry,
  ScopedDb,
} from "../../contracts/types.js";

// Resolve bare specifiers ("cordis", "@host/server-sdk") for content-addressed
// plugin modules loaded from arbitrary release directories outside node_modules.
const cordisUrl = import.meta.resolve("cordis");
const serverSdkUrl = new URL(
  import.meta.url.endsWith(".ts")
    ? "../../contracts/server-sdk.ts"
    : "../../contracts/server-sdk.js",
  import.meta.url,
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cordis") {
      return { url: cordisUrl, shortCircuit: true };
    }
    if (specifier === "@host/server-sdk") {
      return { url: serverSdkUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const hostContextPluginId = new WeakMap<object, string>();
const FIBER_STATE_ACTIVE = 2;

if (
  typeof (process as unknown as { getBuiltinModule?: unknown })
    .getBuiltinModule === "function"
) {
  Object.defineProperty(process, "getBuiltinModule", {
    value: () => {
      throw new Error("process.getBuiltinModule is forbidden in plugin worker");
    },
    writable: false,
    configurable: false,
  });
}

function fiberStateName(state: number): FiberStateName {
  switch (state) {
    case 0:
      return "PENDING";
    case 1:
      return "LOADING";
    case 2:
      return "ACTIVE";
    case 3:
      return "FAILED";
    case 4:
      return "DISPOSED";
    case 5:
      return "UNLOADING";
    default:
      return "FAILED";
  }
}

interface ApplyMemberPayload {
  readonly pluginId: string;
  readonly versionId: string;
  readonly enabled: boolean;
  readonly dependencies: readonly string[];
  readonly contractTypes: string;
  readonly entryPath?: string;
}

interface ApplyCompositionPayload {
  readonly compositionId: string;
  readonly allMembers: readonly ApplyMemberPayload[];
  readonly orderedEnabled: readonly ApplyMemberPayload[];
}

interface WorkerRequestMessage {
  readonly id?: number;
  readonly method: "applyComposition" | "introspect" | "http" | "close";
  readonly payload?: unknown;
}

interface MountedPluginRecord {
  readonly pluginId: string;
  readonly versionId: string;
  readonly dependencies: readonly string[];
  readonly fiber: Fiber;
}

const dbPath = process.argv[2];
if (!dbPath) {
  process.stderr.write("worker requires dbPath as argv[2]\n");
  process.exit(1);
}

const db = openAppDatabase(dbPath);
const rootCtx = new Context();
const routeRegistry = new HttpRouteRegistry();
const scheduler = new SchedulerEngine();
const scopedDbCache = new Map<string, ScopedDb>();

function lookupHostPluginId(ctx: unknown): string | undefined {
  let cur: object | null =
    ctx && typeof ctx === "object" ? (ctx as object) : null;
  while (cur) {
    const found = hostContextPluginId.get(cur);
    if (found) return found;
    cur = Object.getPrototypeOf(cur) as object | null;
  }
  return undefined;
}

function resolveOwnerContext(ctx: Context): { pluginId: string; fiber: Fiber } {
  const ctxRecord = ctx as unknown as Record<PropertyKey, unknown>;
  const shadow = ctxRecord[symbols.shadow] as
    | (Context & Record<PropertyKey, unknown>)
    | undefined;
  const origin = shadow ?? (ctx as unknown as Context & Record<PropertyKey, unknown>);
  const pluginId = lookupHostPluginId(origin);
  if (typeof pluginId !== "string" || pluginId.length === 0) {
    throw new Error(
      "Host plugin identity is missing; root services cannot be accessed without host-injected plugin identity",
    );
  }
  return {
    pluginId,
    fiber: origin.fiber,
  };
}

function getOrCreateScopedDb(pluginId: string): ScopedDb {
  let scoped = scopedDbCache.get(pluginId);
  if (!scoped) {
    scoped = createScopedDb(db, pluginId);
    scopedDbCache.set(pluginId, scoped);
  }
  return scoped;
}

rootCtx.accessor("db", {
  get() {
    const { pluginId } = resolveOwnerContext(this);
    return getOrCreateScopedDb(pluginId);
  },
});

rootCtx.accessor("http", {
  get() {
    const { pluginId, fiber } = resolveOwnerContext(this);
    return routeRegistry.createScopedRouter(pluginId, fiber);
  },
});

rootCtx.accessor("schedule", {
  get() {
    const { pluginId, fiber } = resolveOwnerContext(this);
    return scheduler.createScopedScheduler(pluginId, fiber);
  },
});

let currentCompositionId: string | null = null;
let currentAllMembers: readonly ApplyMemberPayload[] = [];
let mountedOrdered: MountedPluginRecord[] = [];
const mountedById = new Map<string, MountedPluginRecord>();

function extractPluginExport(mod: Record<string, unknown>, pluginId: string): Plugin {
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
    `Plugin "${pluginId}" server module must export a default Cordis plugin or named apply(ctx) function`,
  );
}

async function applyComposition(payload: ApplyCompositionPayload): Promise<{
  compositionId: string;
  activePlugins: string[];
}> {
  const currentMeta: MountedEntryMeta[] = mountedOrdered.map((m) => ({
    pluginId: m.pluginId,
    versionId: m.versionId,
    dependencies: m.dependencies,
  }));
  const targetMeta: MountedEntryMeta[] = payload.orderedEnabled.map((m) => ({
    pluginId: m.pluginId,
    versionId: m.versionId,
    dependencies: m.dependencies,
  }));

  const plan = computeHotSwapPlan(currentMeta, targetMeta);

  // 1. Dispose removed/disabled/upgraded/dependent plugins in reverse topological order
  for (const pluginId of plan.toDispose) {
    const record = mountedById.get(pluginId);
    if (!record) continue;
    await record.fiber.dispose();
    mountedById.delete(pluginId);
  }
  mountedOrdered = mountedOrdered.filter((m) => mountedById.has(m.pluginId));

  // 2. Mount newly added/upgraded/reloaded plugins in forward topological order
  const targetById = new Map(payload.orderedEnabled.map((m) => [m.pluginId, m]));
  for (const item of plan.toMount) {
    const meta = targetById.get(item.pluginId)!;
    const pluginCtx = rootCtx.extend();
    hostContextPluginId.set(pluginCtx, meta.pluginId);

    let pluginExport: Plugin;
    if (meta.entryPath) {
      const mod = (await import(pathToFileURL(meta.entryPath).href)) as Record<
        string,
        unknown
      >;
      pluginExport = extractPluginExport(mod, meta.pluginId);
    } else {
      pluginExport = () => {};
    }

    const fiber = pluginCtx.plugin(pluginExport);
    await fiber;

    if (fiber.state !== FIBER_STATE_ACTIVE) {
      const stateLabel = fiberStateName(fiber.state);
      try {
        await fiber.dispose();
      } catch {
        // Ignore secondary cleanup error
      }
      throw new Error(
        `Plugin "${meta.pluginId}@${meta.versionId}" failed to enter ACTIVE state (actual: ${stateLabel})`,
      );
    }

    mountedById.set(meta.pluginId, {
      pluginId: meta.pluginId,
      versionId: meta.versionId,
      dependencies: meta.dependencies,
      fiber,
    });
  }

  // Rebuild ordered mounted list matching target topological order and verify all ACTIVE
  const nextOrdered: MountedPluginRecord[] = [];
  for (const meta of payload.orderedEnabled) {
    const record = mountedById.get(meta.pluginId);
    if (!record || record.fiber.state !== FIBER_STATE_ACTIVE) {
      const stateLabel = record ? fiberStateName(record.fiber.state) : "MISSING";
      throw new Error(
        `Enabled plugin "${meta.pluginId}" is not ACTIVE after composition switch (actual: ${stateLabel})`,
      );
    }
    nextOrdered.push(record);
  }

  mountedOrdered = nextOrdered;
  currentCompositionId = payload.compositionId;
  currentAllMembers = payload.allMembers;

  return {
    compositionId: payload.compositionId,
    activePlugins: mountedOrdered.map((m) => m.pluginId),
  };
}

function collectServicesByPlugin(): {
  allServices: string[];
  byPlugin: Map<string, string[]>;
} {
  const store = rootCtx.reflect.store as unknown as Record<
    PropertyKey,
    { name?: string; fiber?: Fiber } | undefined
  >;
  const allServices: string[] = [];
  const byPlugin = new Map<string, string[]>();

  for (const key of Reflect.ownKeys(store)) {
    const impl = store[key];
    if (!impl || typeof impl.name !== "string") continue;
    const ownerId = lookupHostPluginId(impl.fiber?.ctx);
    if (typeof ownerId !== "string") continue;
    if (!allServices.includes(impl.name)) {
      allServices.push(impl.name);
    }
    const list = byPlugin.get(ownerId) ?? [];
    if (!list.includes(impl.name)) {
      list.push(impl.name);
      byPlugin.set(ownerId, list);
    }
  }

  return { allServices, byPlugin };
}

function introspect(): CompositionTopology {
  const { allServices, byPlugin } = collectServicesByPlugin();
  const routes = routeRegistry.listRoutes();

  const plugins: PluginTopologyEntry[] = currentAllMembers.map((member) => {
    const mounted = mountedById.get(member.pluginId);
    const pluginRoutes = routeRegistry
      .listRoutes(member.pluginId)
      .map((r) => ({ method: r.method, path: r.path }));
    return {
      pluginId: member.pluginId,
      versionId: member.versionId,
      enabled: member.enabled,
      state: mounted ? fiberStateName(mounted.fiber.state) : "DISPOSED",
      dependencies: member.dependencies,
      routes: pluginRoutes,
      providedServices: byPlugin.get(member.pluginId) ?? [],
      activeTimers: scheduler.activeTimerCount(member.pluginId),
      contractTypes: member.contractTypes,
    };
  });

  return {
    compositionId: currentCompositionId,
    workerPid: process.pid,
    plugins,
    services: allServices,
    routes,
  };
}

async function shutdown(): Promise<void> {
  for (const record of [...mountedOrdered].reverse()) {
    try {
      await record.fiber.dispose();
    } catch {
      // Ignore errors during shutdown
    }
  }
  mountedOrdered = [];
  mountedById.clear();
  try {
    db.close();
  } catch {
    // Ignore close error
  }
  process.exit(0);
}

process.on("message", async (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const message = raw as WorkerRequestMessage;
  if (message.method === "close") {
    await shutdown();
    return;
  }

  const id = message.id;
  if (typeof id !== "number") return;

  try {
    let value: unknown;
    switch (message.method) {
      case "applyComposition":
        value = await applyComposition(message.payload as ApplyCompositionPayload);
        break;
      case "introspect":
        value = introspect();
        break;
      case "http":
        value = (await routeRegistry.dispatch(
          message.payload as HttpDispatchInput,
        )) as AppResponse;
        break;
      default:
        throw new Error(`Unknown worker method: ${String(message.method)}`);
    }
    process.send?.({ id, value });
  } catch (error) {
    const err = error as Error;
    process.send?.({
      id,
      error: err?.message ?? String(error),
    });
  }
});

process.send?.({ ready: true, pid: process.pid });
