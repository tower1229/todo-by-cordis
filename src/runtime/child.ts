import { Context, FiberState } from "cordis";
import { pathToFileURL } from "node:url";
import type { RuntimeTarget } from "../release/types.js";

const target = JSON.parse(process.argv[2]) as RuntimeTarget;
const loaded: unknown = (await import(pathToFileURL(target.entry).href))
  .default;
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
      value: await invoke(message.method, message.data),
    });
  } catch (error) {
    process.send?.({
      id: message.id,
      error: error instanceof Error ? error.message : "Service failed",
    });
  }
});
process.send?.({ ready: true });
