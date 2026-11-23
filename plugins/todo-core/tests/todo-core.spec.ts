import assert from "node:assert/strict";
import type { PluginTestContext } from "@host/server-sdk";

export default async function (ctx: PluginTestContext): Promise<void> {
  const created = await ctx.request({
    method: "POST",
    path: "/api/app/todo-core/tasks",
    body: { title: "Contract Core Task" },
  });
  assert.equal(created.status, 201);
  const taskId = (created.body as { task: { id: string } }).task.id;

  const done = await ctx.request({
    method: "POST",
    path: `/api/app/todo-core/tasks/${taskId}/transition`,
    body: { nextState: "done" },
  });
  assert.equal(done.status, 200);
  assert.equal((done.body as { task: { state: string } }).task.state, "done");
}
