import { Context, FiberState } from "cordis";
import { catalog, isWorkflowId } from "./catalog.js";
import type { Workflow, Task } from "../shared/contracts.js";

const id = process.argv[2];
if (!isWorkflowId(id)) throw new Error("Unknown workflow");
const ctx = new Context();
const provider = ctx.plugin((local) => {
  local.provide("workflow", catalog[id]);
});
let invoke: (
  method: string,
  data: { task: Task; action: string; input: Record<string, string> },
) => unknown;
const consumer = ctx.inject(["workflow"], (local) => {
  const workflow = local.get("workflow") as Workflow;
  invoke = (method, data) =>
    method === "describe"
      ? workflow.definition
      : workflow.decide(data.task, data.action, data.input);
});
await provider.await();
await consumer.await();
if (
  provider.state !== FiberState.ACTIVE ||
  consumer.state !== FiberState.ACTIVE
)
  throw new Error("Workflow not active");
process.on("disconnect", () => process.exit(0));
process.on("message", async (raw: unknown) => {
  const message = raw as { id: number; method: string; data: any };
  if (message.method === "close") {
    await consumer.dispose();
    await provider.dispose();
    process.exit(0);
  }
  try {
    process.send?.({
      id: message.id,
      value: invoke(message.method, message.data),
    });
  } catch (error) {
    process.send?.({
      id: message.id,
      error: error instanceof Error ? error.message : "插件执行失败",
    });
  }
});
process.send?.({ ready: true });
