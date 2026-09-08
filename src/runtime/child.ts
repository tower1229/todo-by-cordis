import { createContext, SourceTextModule, Script } from "node:vm";
import { posix } from "node:path";
import { Context, FiberState } from "cordis";
import { pathToFileURL } from "node:url";
import type { RuntimeTarget } from "../release/types.js";

const target = JSON.parse(process.argv[2]) as RuntimeTarget & {
  modules?: Record<string, string>;
};
let businessInfo: unknown;
async function loadBusiness() {
  if (!target.modules)
    return (await import(pathToFileURL(target.entry).href)).default as unknown;
  // Capability-limited JS realm inside the supervised child; not an OS security sandbox.
  const realm = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  const modules = new Map<string, SourceTextModule>();
  for (const [path, code] of Object.entries(target.modules))
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
        // Only JSON crosses the realm boundary; no host function, process or database is injected.
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
const loaded = await loadBusiness();
if (!loaded || typeof loaded !== "object")
  throw new Error("Invalid service export");
const service = loaded as Record<string, unknown>;
const ctx = new Context();
const provider = ctx.plugin((local) => {
  local.provide(target.service, service);
});
let invoke: (method: string, data: unknown) => unknown = () => {
  throw new Error("Not ready");
};
const consumer = ctx.inject([target.service], (local) => {
  const active = local.get(target.service) as Record<string, unknown>;
  invoke = (method, data) => {
    if (!Object.hasOwn(active, method) || typeof active[method] !== "function")
      throw new Error("Unknown service method");
    return (active[method] as (data: unknown) => unknown).call(active, data);
  };
});
await provider.await();
await consumer.await();
if (
  provider.state !== FiberState.ACTIVE ||
  consumer.state !== FiberState.ACTIVE
)
  throw new Error("Service not active");
process.on("disconnect", () => process.exit(0));
process.on("message", async (raw: unknown) => {
  if (!raw || typeof raw !== "object") return;
  const message = raw as { id: number; method: string; data?: unknown };
  if (message.method === "close") {
    await consumer.dispose();
    await provider.dispose();
    process.exit(0);
  }
  try {
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
