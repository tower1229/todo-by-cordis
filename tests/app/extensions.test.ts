import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Runtime } from "../../src/runtime/runtime.js";
import type { Version, RuntimeLike } from "../../src/release/types.js";
import type {
  ExtensionContribution,
  WorkflowDefinition,
  WorkflowDecision,
} from "../../src/shared/contracts.js";
import { ExtensionRegistry } from "../../src/server/extensions/registry.js";
import { OnlineScheduler } from "../../src/server/extensions/scheduler.js";
import { EXTENSIONS_CONTRACT } from "../../src/server/business/contracts.js";

const definition: WorkflowDefinition = {
  id: "hooked",
  name: "钩子夹具",
  version: "1.0.0",
  initialState: "open",
  states: {
    open: { label: "未完成", category: "open" },
    done: { label: "已完成", category: "done" },
  },
  actions: [
    { id: "complete", label: "完成", from: ["open"] },
    { id: "reopen", label: "重新打开", from: ["done"] },
  ],
  fields: [],
};

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-ext-"));
  const filename = join(directory, "tasks.db");
  const workspace = await Workspace.open(filename);
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  return workspace;
}

function hookedRuntime(options: {
  contribution: () => ExtensionContribution;
  flags?: { beforeCommitReject: boolean; eventThrows: boolean };
  lifecycle?: string[];
}): RuntimeLike {
  const life = options.lifecycle ?? [];
  const flags = options.flags ?? {
    beforeCommitReject: false,
    eventThrows: false,
  };
  return {
    async invoke(method, data) {
      if (method === "describe") return definition;
      if (method === "contribute") return options.contribution();
      if (method === "lifecycleActivate") {
        life.push("activate");
        return;
      }
      if (method === "lifecycleReady") {
        life.push("ready");
        return;
      }
      if (method === "lifecycleQuiesce") {
        life.push("quiesce");
        return;
      }
      if (method === "lifecycleDispose") {
        life.push("dispose");
        return;
      }
      if (method === "beforeCommit") {
        if (flags.beforeCommitReject)
          return { kind: "reject", message: "钩子拒绝提交" };
        return { kind: "ok" };
      }
      if (method === "onTaskEvent") {
        if (flags.eventThrows) throw new Error("observer failed");
        return;
      }
      if (method === "decide") {
        const body = data as {
          task: { state: string; fields: Record<string, string> };
          action: string;
        };
        if (body.action === "complete")
          return {
            kind: "commit",
            state: "done",
            fields: body.task.fields,
          } satisfies WorkflowDecision;
        if (body.action === "reopen")
          return {
            kind: "commit",
            state: "open",
            fields: body.task.fields,
          } satisfies WorkflowDecision;
        return { kind: "reject", message: "未知动作" };
      }
      throw new Error("Unknown service method");
    },
    async close() {},
  };
}

test("registry rejects duplicate fields, commands, and dual primary sorts", () => {
  const registry = new ExtensionRegistry();
  assert.throws(
    () =>
      registry.install("p", {
        fields: [
          { key: "a", label: "A", type: "text" },
          { key: "a", label: "B", type: "text" },
        ],
      }),
    /字段重复/,
  );
  assert.throws(
    () =>
      registry.install("p", {
        commands: [
          { id: "x", label: "X" },
          { id: "x", label: "Y" },
        ],
      }),
    /命令重复/,
  );
  assert.throws(
    () =>
      registry.install("p", {
        querySorts: [
          { id: "a", label: "A", primary: true },
          { id: "b", label: "B", primary: true },
        ],
      }),
    /主排序/,
  );
});

test("online scheduler respects missPolicy and cancels timers", async () => {
  const fired: string[] = [];
  const scheduler = new OnlineScheduler();
  const now = Date.now();
  scheduler.arm(
    [
      {
        id: "past-skip",
        at: new Date(now - 1000).toISOString(),
        dedupeKey: "skip",
        onFire: {
          type: "action",
          commandId: "complete",
          taskId: "t1",
        },
        missPolicy: "skip",
      },
      {
        id: "past-run",
        at: new Date(now - 1000).toISOString(),
        dedupeKey: "run",
        onFire: {
          type: "action",
          commandId: "complete",
          taskId: "t1",
        },
        missPolicy: "run-once",
      },
      {
        id: "future",
        at: new Date(now + 50).toISOString(),
        dedupeKey: "future",
        onFire: {
          type: "action",
          commandId: "complete",
          taskId: "t1",
        },
        missPolicy: "skip",
      },
    ],
    {
      now,
      fire: async (job) => {
        fired.push(job.dedupeKey);
      },
    },
  );
  assert.deepEqual(fired, ["run"]);
  assert.equal(scheduler.armedCount(), 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(fired.includes("future"));
  scheduler.cancelAll();
  assert.equal(scheduler.armedCount(), 0);
});

test("builtin plugin without contribute stays compatible", async (t) => {
  const w = await setup(t);
  const summary = w.composition().extensions;
  assert.equal(summary.contractVersion, null);
  assert.ok(
    summary.capabilities.some(
      (c) => c.interfaceId === "workflow.provide" && c.status === "active",
    ),
  );
  assert.ok(
    summary.capabilities.some((c) => c.interfaceId === "schedule.register"),
  );
  const created = await w.command({
    type: "create",
    title: "普通任务",
    operationId: randomUUID(),
    compositionRevision: 1,
  });
  assert.equal(created.task?.title, "普通任务");
});

test("hooks: beforeCommit reject, event failure keeps commit, stubs visible", async (t) => {
  const life: string[] = [];
  const contribution = (): ExtensionContribution => ({
    beforeCommit: true,
    events: ["task.updated"],
    lifecycle: {
      activate: true,
      ready: true,
      quiesce: true,
      dispose: true,
    },
    fields: [{ key: "dueAt", label: "截止", type: "text" }],
    commands: [{ id: "complete", label: "完成", from: ["open"] }],
    uiSlots: [{ id: "due-badge", slot: "task-row" }],
    queryFilters: [{ id: "overdue", label: "已过期" }],
    querySorts: [{ id: "due", label: "截止时间", primary: true }],
    diagnostics: true,
    services: [{ id: "reminder", version: "1" }],
  });
  const directory = await mkdtemp(join(tmpdir(), "cordis-ext-hook-"));
  const filename = join(directory, "tasks.db");
  const flags = { beforeCommitReject: false, eventThrows: true };
  const w = await Workspace.open(filename, {
    launch: async (version: Version) => {
      if (version.pluginId !== "hooked") return Runtime.start(version);
      return hookedRuntime({
        contribution,
        flags,
        lifecycle: life,
      });
    },
  });
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const hooked = w.release.record({
    pluginId: "hooked",
    name: "钩子夹具",
    service: "workflow",
    contractVersion: "workflow/1",
    source: "// fixture",
    code: "export default {}",
    definition,
    evidence: { passed: true, origin: "test" },
  });
  const created = await w.command({
    type: "create",
    title: "待完成",
    operationId: randomUUID(),
    compositionRevision: 1,
  });
  await w.activate(
    {
      versionId: hooked.id,
      compositionRevision: 1,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  assert.deepEqual(life.slice(0, 2), ["activate", "ready"]);
  const summary = w.composition().extensions;
  assert.equal(summary.contractVersion, EXTENSIONS_CONTRACT);
  assert.ok(
    summary.capabilities.some(
      (c) => c.interfaceId === "ui.slot" && c.status === "stub" && c.count === 1,
    ),
  );
  assert.ok(
    summary.capabilities.some(
      (c) =>
        c.interfaceId === "task.beforeCommit" && c.status === "active",
    ),
  );

  const task = created.task!;
  flags.beforeCommitReject = true;
  await assert.rejects(
    w.command({
      type: "action",
      taskId: task.id,
      actionId: "complete",
      expectedRevision: task.revision,
      operationId: randomUUID(),
      compositionRevision: 2,
    }),
    /钩子拒绝提交/,
  );
  assert.equal(w.read(task.id).state, "open");

  flags.beforeCommitReject = false;
  flags.eventThrows = true;
  const done = await w.command({
    type: "action",
    taskId: task.id,
    actionId: "complete",
    expectedRevision: task.revision,
    operationId: randomUUID(),
    compositionRevision: 2,
  });
  assert.equal(done.task?.state, "done");
  assert.ok(w.diagnostics().some((n) => /observer failed/.test(n)));

  await w.activate({
    workflowId: "default",
    compositionRevision: 2,
    operationId: randomUUID(),
  });
  assert.ok(life.includes("quiesce"));
  assert.ok(life.includes("dispose"));
});

test("online schedule fires registered action command", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-ext-sched-"));
  const filename = join(directory, "tasks.db");
  const ctx = { taskId: "", at: "" };
  const w = await Workspace.open(filename, {
    launch: async (version: Version) => {
      if (version.pluginId !== "hooked") return Runtime.start(version);
      return hookedRuntime({
        contribution: () => ({
          schedules: ctx.taskId
            ? [
                {
                  id: "due",
                  at: ctx.at,
                  dedupeKey: `due:${ctx.taskId}`,
                  onFire: {
                    type: "action",
                    commandId: "complete",
                    taskId: ctx.taskId,
                  },
                  missPolicy: "skip",
                },
              ]
            : [],
        }),
      });
    },
  });
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const hooked = w.release.record({
    pluginId: "hooked",
    name: "钩子夹具",
    service: "workflow",
    contractVersion: "workflow/1",
    source: "// fixture",
    code: "export default {}",
    definition,
    evidence: { passed: true, origin: "test" },
  });
  const created = await w.command({
    type: "create",
    title: "定时完成",
    operationId: randomUUID(),
    compositionRevision: 1,
  });
  ctx.taskId = created.task!.id;
  ctx.at = new Date(Date.now() + 60).toISOString();
  await w.activate(
    {
      versionId: hooked.id,
      compositionRevision: 1,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  assert.equal(w.schedulerState().armed, 1);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(w.read(ctx.taskId).state, "done");
});
