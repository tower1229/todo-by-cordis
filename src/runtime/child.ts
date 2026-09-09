import { createContext, SourceTextModule, Script } from "node:vm";
import { posix } from "node:path";
import { Context, FiberState } from "cordis";
import { pathToFileURL } from "node:url";
import type { RuntimePluginTarget } from "../release/types.js";

type ChildPlugin = RuntimePluginTarget & {
  modules?: Record<string, string>;
};

const payload = JSON.parse(process.argv[2]) as {
  plugins?: ChildPlugin[];
  entry?: string;
  modules?: Record<string, string>;
  service?: string;
  pluginId?: string;
};

const plugins: ChildPlugin[] = payload.plugins?.length
  ? payload.plugins
  : [
      {
        pluginId: payload.pluginId!,
        entry: payload.entry!,
        service: payload.service!,
        modules: payload.modules,
        role: "workflow",
      },
    ];

let businessInfo: unknown;

async function loadPlugin(plugin: ChildPlugin) {
  if (!plugin.modules)
    return (await import(pathToFileURL(plugin.entry).href)).default as unknown;
  const realm = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  const modules = new Map<string, SourceTextModule>();
  for (const [path, code] of Object.entries(plugin.modules))
    modules.set(
      path,
      new SourceTextModule(code, { context: realm, identifier: path }),
    );
  const entry = modules.get("business/entry.js");
  if (!entry) throw new Error("业务入口缺失");
  const link = (specifier: string, parent: { identifier: string }) => {
    if (!specifier.startsWith("./") || !specifier.endsWith(".js"))
      throw new Error("未授权依赖");
    const module = modules.get(
      posix.join(posix.dirname(parent.identifier), specifier),
    );
    if (!module) throw new Error("业务依赖缺失");
    return module;
  };
  await entry.link(link);
  await entry.evaluate({ timeout: 1000 });
  const view = modules.get("business/view.js");
  if (!view) throw new Error("业务前端资源缺失");
  if (view.status === "unlinked") await view.link(link);
  if (view.status === "linked") await view.evaluate({ timeout: 1000 });
  realm.view = (view.namespace as { default: unknown }).default;
  const presentation = JSON.parse(
    new Script("JSON.stringify(view)").runInContext(realm, {
      timeout: 1000,
    }) as string,
  ) as unknown;
  if (plugin.role === "workflow")
    businessInfo = {
      presentation,
      modules: [...modules].map(([path, module]) => ({
        path,
        status: module.status,
        exports:
          module.status === "evaluated" ? Object.keys(module.namespace) : [],
      })),
    };
  realm.service = (entry.namespace as { default: unknown }).default;
  const methods = JSON.parse(
    new Script(
      "JSON.stringify(Object.keys(service).filter((key) => typeof service[key] === 'function'))",
    ).runInContext(realm, { timeout: 1000 }) as string,
  ) as string[];
  return Object.fromEntries(
    methods.map((method) => [
      method,
      (data: unknown) => {
        realm.request = JSON.stringify({ method, data });
        const result = new Script(`(() => {
        const {method, data} = JSON.parse(request);
        if (!Object.hasOwn(service, method) || typeof service[method] !== "function") throw new Error("Unknown service method");
        return JSON.stringify(service[method](data));
      })()`).runInContext(realm, { timeout: 1000 }) as string;
        return result === undefined
          ? undefined
          : (JSON.parse(result) as unknown);
      },
    ]),
  );
}

const loadedServices = new Map<string, Record<string, unknown>>();
const workflowPlugin =
  plugins.find((p) => p.role === "workflow") ?? plugins[0]!;

for (const plugin of plugins) {
  const loaded = await loadPlugin(plugin);
  if (!loaded || typeof loaded !== "object")
    throw new Error("Invalid service export");
  loadedServices.set(plugin.pluginId, loaded as Record<string, unknown>);
}

const ctx = new Context();
type Fiber = ReturnType<Context["plugin"]>;
const providers: Fiber[] = [];
for (const plugin of plugins) {
  const service = loadedServices.get(plugin.pluginId)!;
  providers.push(
    ctx.plugin((local) => {
      local.provide(plugin.service, service);
    }),
  );
}
const invokers = new Map<string, (method: string, data: unknown) => unknown>();
const consumers: Fiber[] = [];
for (const plugin of plugins) {
  consumers.push(
    ctx.inject([plugin.service], (local) => {
      const active = local.get(plugin.service) as Record<string, unknown>;
      invokers.set(plugin.pluginId, (method, data) => {
        if (
          !Object.hasOwn(active, method) ||
          typeof active[method] !== "function"
        )
          throw new Error("Unknown service method");
        return (active[method] as (data: unknown) => unknown).call(
          active,
          data,
        );
      });
    }),
  );
}
for (const provider of providers) await provider.await();
for (const consumer of consumers) await consumer.await();
if (
  providers.some((p) => p.state !== FiberState.ACTIVE) ||
  consumers.some((c) => c.state !== FiberState.ACTIVE)
)
  throw new Error("Service not active");

process.on("disconnect", () => process.exit(0));
process.on("message", async (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const message = raw as {
    id: number;
    method: string;
    data?: unknown;
    pluginId?: string;
  };
  if (message.method === "close") {
    for (const consumer of consumers) await consumer.dispose();
    for (const provider of providers) await provider.dispose();
    process.exit(0);
  }
  try {
    const targetId = message.pluginId ?? workflowPlugin.pluginId;
    const invoke = invokers.get(targetId);
    if (!invoke) throw new Error(`Unknown plugin: ${targetId}`);
    process.send?.({
      id: message.id,
      value:
        message.method === "__business_info"
          ? businessInfo
          : await invoke(message.method, message.data),
    });
  } catch (error) {
    process.send?.({
      id: message.id,
      error: error instanceof Error ? error.message : "Service failed",
    });
  }
});
process.send?.({ ready: true });
