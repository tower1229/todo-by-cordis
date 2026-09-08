import test, { type TestContext } from "node:test";
import type { Version } from "../../src/release/types.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { once } from "node:events";
import { Workspace } from "../../src/server/workspace.js";
import { Runtime } from "../../src/runtime/runtime.js";
import { createApp } from "../../src/server/app.js";
import type { Command } from "../../src/shared/contracts.js";

async function setup(t: TestContext, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-m1-"));
  const filename = join(directory, "tasks.db");
  let workspace = await Workspace.open(filename, options);
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    filename,
    get w() {
      return workspace;
    },
    async reopen() {
      await workspace.close();
      workspace = await Workspace.open(filename, options);
    },
  };
}
const create = (revision = 1): Command => ({
  type: "create",
  title: "值得留下的任务",
  description: "描述",
  operationId: randomUUID(),
  compositionRevision: revision,
});
test("idempotency, conflicts, input validation, delete and restore", async (t) => {
  const { w } = await setup(t);
  const command = create();
  const result = await w.command(command);
  assert.deepEqual(await w.command(command), result);
  assert.equal(w.query().total, 1);
  await assert.rejects(
    w.command({ ...command, title: "different" }),
    /重新提交/,
  );
  await assert.rejects(w.command({ ...create(), title: "  " }), /标题必填/);
  const task = result.task!;
  const edit = {
    ...create(),
    type: "edit" as const,
    taskId: task.id,
    expectedRevision: task.revision,
    title: "新的标题",
  };
  await w.command(edit);
  await assert.rejects(
    w.command({ ...edit, operationId: randomUUID() }),
    /别处修改/,
  );
  const deleted = await w.command({
    ...create(),
    type: "delete",
    taskId: task.id,
    expectedRevision: 2,
  });
  assert.equal(w.query().total, 0);
  await w.command({
    ...create(),
    type: "restore",
    taskId: task.id,
    expectedRevision: deleted.task!.revision,
  });
  assert.equal(w.query().total, 1);
});
test("workflow input, cancellation, release retry, retained values and restart", async (t) => {
  const f = await setup(t);
  const task = (await f.w.command(create())).task!;
  const release = {
    workflowId: "review" as const,
    compositionRevision: 1,
    operationId: randomUUID(),
  };
  assert.deepEqual(await f.w.activate(release), await f.w.activate(release));
  const action: Command = {
    type: "action",
    taskId: task.id,
    expectedRevision: 1,
    compositionRevision: 2,
    operationId: randomUUID(),
    actionId: "complete",
  };
  assert.equal((await f.w.command(action)).decision!.kind, "input-required");
  assert.equal(f.w.read(task.id).state, "open");
  await f.w.command({
    ...action,
    operationId: randomUUID(),
    input: { review: "真实收获" },
  });
  await f.w.activate({
    workflowId: "default",
    compositionRevision: 2,
    operationId: randomUUID(),
  });
  await f.reopen();
  assert.equal(f.w.read(task.id).fields.review, "真实收获");
  assert.equal(f.w.read(task.id).state, "done");
  await assert.rejects(
    f.w.command({ ...create(), compositionRevision: 1 }),
    /流程已变化/,
  );
});
test("candidate failure and stale publication keep old active version", async (t) => {
  const { w } = await setup(t, {
    launch: async (id: Version) => {
      if (id.pluginId === "review") throw new Error("candidate failed");
      return Runtime.start(id);
    },
  });
  await assert.rejects(
    w.activate({
      workflowId: "review",
      compositionRevision: 1,
      operationId: randomUUID(),
    }),
    /candidate failed/,
  );
  assert.equal(w.composition().workflow.id, "default");
  await assert.rejects(
    w.activate({
      workflowId: "default",
      compositionRevision: 0,
      operationId: randomUUID(),
    }),
    /流程已变化/,
  );
  assert.equal(w.composition().revision, 1);
});
test("100-row pagination, literal search, and HTTP response replay", async (t) => {
  const { w } = await setup(t);
  for (let i = 0; i < 105; i++)
    await w.command({ ...create(), title: `task ${i}` });
  await w.command({ ...create(), title: "100% 真诚" });
  assert.equal(w.query("", "all").tasks.length, 100);
  assert.equal(w.query("", "all", 100).tasks.length, 6);
  assert.equal(w.query("%").total, 1);
  const app = createApp(w);
  const command = create();
  await app.request("/api/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  const response = await app.request(`/api/operations/${command.operationId}`);
  const result = await response.json();
  assert.ok(result.task.id);
  const repeat = await app.request("/api/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
  assert.deepEqual(await repeat.json(), result);
});
test("20 switches release every old process", { timeout: 30000 }, async (t) => {
  const runtimes: Runtime[] = [];
  const { w } = await setup(t, {
    launch: async (id: Version) => {
      const r = await Runtime.start(id);
      runtimes.push(r);
      return r;
    },
  });
  for (let i = 0; i < 20; i++)
    await w.activate({
      workflowId: i % 2 ? "default" : "review",
      compositionRevision: i + 1,
      operationId: randomUUID(),
    });
  for (let attempt = 0; attempt < 100; attempt++) {
    const alive = runtimes.slice(0, -1).some((r) => {
      try {
        process.kill(r.pid!, 0);
        return true;
      } catch {
        return false;
      }
    });
    if (!alive) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  for (const r of runtimes.slice(0, -1))
    assert.throws(() => process.kill(r.pid!, 0));
  assert.equal(w.composition().history.length, 20);
});
test(
  "one automatic restart, repeated crash requires manual retry",
  { timeout: 15000 },
  async (t) => {
    const runtimes: Runtime[] = [];
    const { w } = await setup(t, {
      launch: async (id: Version) => {
        const r = await Runtime.start(id);
        runtimes.push(r);
        return r;
      },
    });
    const wait = async (predicate: () => boolean) => {
      for (let i = 0; i < 200 && !predicate(); i++)
        await new Promise((r) => setTimeout(r, 10));
      assert.ok(predicate());
    };
    process.kill(runtimes[0].pid!, "SIGKILL");
    await wait(
      () => runtimes.length === 2 && w.composition().status === "ready",
    );
    process.kill(runtimes[1].pid!, "SIGKILL");
    await wait(() => w.composition().status === "unavailable");
    assert.equal(runtimes.length, 2);
    await w.restart();
    assert.equal(runtimes.length, 3);
  },
);
for (const stage of ["prepared", "transaction", "switched"]) {
  test(`M1 actual process crash at ${stage}`, { timeout: 15000 }, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "cordis-m1-crash-"));
    const filename = join(directory, "tasks.db");
    let w = await Workspace.open(filename);
    const task = (await w.command(create())).task!;
    await w.close();
    const child = fork(
      new URL("./crash-fixture.ts", import.meta.url),
      [filename, stage],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        ...{ windowsHide: true },
      },
    );
    const [code] = await once(child, "exit");
    assert.equal(code, 17);
    w = await Workspace.open(filename);
    t.after(async () => {
      await w.close();
      await rm(directory, { recursive: true, force: true });
    });
    assert.equal(
      w.composition().workflow.id,
      stage === "switched" ? "review" : "default",
    );
    assert.equal(w.read(task.id).title, task.title);
  });
}
test(
  "production Runtime terminates infinite JS and closes pending calls",
  { timeout: 10000 },
  async () => {
    const runtime = await Runtime.start(
      { entry: "unused", service: "workflow", pluginId: "default" },
      500,
      new URL("./loop-fixture.mjs", import.meta.url),
    );
    await assert.rejects(runtime.invoke("loop"), /超时/);
    await runtime.close();
    await assert.rejects(runtime.invoke("describe"), /不可用/);
  },
);

test("assistant stays unavailable without a provider and never changes workspace", async (t) => {
  const { w } = await setup(t);
  await w.command(create());
  const app = createApp(w);
  const before = w.composition();
  assert.deepEqual(await (await app.request("/api/assistant")).json(), {
    availability: "unconfigured",
    run: null,
  });
  for (const command of [
    { type: "request", operationId: randomUUID(), text: "创建一个复盘插件" },
    {
      type: "confirm",
      operationId: randomUUID(),
      runId: "run",
      planId: "plan",
      compositionRevision: 1,
    },
  ]) {
    const response = await app.request("/api/assistant/commands", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(command),
    });
    assert.equal(response.status, 503);
  }
  const invalid = await app.request("/api/assistant/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "confirm", operationId: "test" }),
  });
  assert.equal(invalid.status, 400);
  assert.deepEqual(w.composition(), before);
  assert.equal(w.query().total, 1);
});

test("public demonstration installer is removed; recovery retains legacy task fields", async (t) => {
  const { w } = await setup(t);
  const task = (await w.command(create())).task!;
  await w.activate({
    workflowId: "review",
    operationId: randomUUID(),
    compositionRevision: 1,
  });
  await w.command({
    type: "action",
    taskId: task.id,
    expectedRevision: task.revision,
    compositionRevision: 2,
    operationId: randomUUID(),
    actionId: "complete",
    input: { review: "保留旧工作区的数据" },
  });
  const app = createApp(w);
  const removed = await app.request("/api/releases", { method: "POST" });
  assert.equal(removed.status, 404);
  const restored = await app.request("/api/runtime/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: randomUUID(),
      compositionRevision: 2,
    }),
  });
  assert.equal(restored.status, 200);
  assert.equal(w.composition().workflow.id, "default");
  assert.equal(w.read(task.id).fields.review, "保留旧工作区的数据");
  assert.equal(w.read(task.id).state, "done");
});
