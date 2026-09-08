import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
import {
  OnlineScheduler,
  resolveFireTime,
} from "../../src/server/extensions/scheduler.js";
import { EXTENSIONS_CONTRACT } from "../../src/server/business/contracts.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));
const hookedFixturePath = join(fixtureDir, "../fixtures/hooked-plugin.mjs");

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
  events?: string[];
}): RuntimeLike {
  const life = options.lifecycle ?? [];
  const events = options.events ?? [];
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
        return { annotations: ["life:activate"] };
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
        return { kind: "ok", annotations: ["beforeCommit:ok"] };
      }
      if (method === "onTaskEvent") {
        const event = data as { kind: string; task: { id: string } };
        events.push(event.kind);
        if (flags.eventThrows) throw new Error("observer failed");
        return { annotations: [`event:${event.kind}`] };
      }
      if (method === "decide") {
        const body = data as {
          task: { state: string; fields: Record<string, string> };
          action: string;
          input?: Record<string, string>;
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
        if (body.action === "setDue")
          return {
            kind: "commit",
            state: body.task.state,
            fields: {
              ...body.task.fields,
              dueAt: body.input?.dueAt ?? "",
            },
          } satisfies WorkflowDecision;
        return { kind: "reject", message: "未知动作" };
      }
      throw new Error("Unknown service method");
    },
    async close() {},
  };
}

test("registry rejects duplicate fields, workflow collisions, and dual primary sorts", () => {
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
      registry.install(
        "p",
        { fields: [{ key: "reflection", label: "复盘", type: "text" }] },
        [{ key: "reflection", label: "复盘", type: "text" }],
      ),
    /流程定义冲突/,
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
  registry.install(
    "p",
    {
      fields: [{ key: "dueAt", label: "截止", type: "text" }],
      commands: [{ id: "ping", label: "轻触" }],
    },
    definition.fields,
  );
  assert.ok(
    registry.mergedFields(definition).some((f) => f.key === "dueAt"),
  );
  assert.ok(
    registry.mergedActions(definition).some((a) => a.id === "ping"),
  );
});

test("resolveFireTime handles offset ISO and timezone wall clock", () => {
  const zoned = resolveFireTime("2026-01-15T12:00:00", "UTC");
  assert.equal(zoned, Date.parse("2026-01-15T12:00:00Z"));
  const offset = resolveFireTime("2026-01-15T12:00:00+08:00");
  assert.equal(offset, Date.parse("2026-01-15T12:00:00+08:00"));
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
  const created = await w.command({
    type: "create",
    title: "普通任务",
    operationId: randomUUID(),
    compositionRevision: 1,
  });
  assert.equal(created.task?.title, "普通任务");
});

test("real Runtime fixture: merge, beforeCommit, events, field schedule, switch clears jobs", async (t) => {
  const code = await readFile(hookedFixturePath, "utf8");
  const directory = await mkdtemp(join(tmpdir(), "cordis-ext-real-"));
  const filename = join(directory, "tasks.db");
  const w = await Workspace.open(filename);
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const hooked = w.release.record({
    pluginId: "hooked",
    name: "钩子夹具",
    service: "workflow",
    contractVersion: "workflow/1",
    source: code,
    code,
    definition,
    evidence: { passed: true, origin: "test" },
  });
  await w.activate(
    {
      versionId: hooked.id,
      compositionRevision: 1,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  assert.equal(w.composition().extensions.contractVersion, EXTENSIONS_CONTRACT);
  assert.ok(
    w.composition().workflow.fields.some((f) => f.key === "dueAt"),
  );
  assert.ok(
    w.composition().workflow.actions.some((a) => a.id === "ping"),
  );
  assert.ok(
    w.composition().retainedFields.some((f) => f.key === "dueAt"),
  );
  assert.ok(w.diagnostics().some((n) => n.includes("life:activate")));

  const created = await w.command({
    type: "create",
    title: "真实钩子任务",
    operationId: randomUUID(),
    compositionRevision: 2,
  });
  assert.ok(
    w.diagnostics().some((n) => n.includes(`event:task.created:${created.task!.id}`)),
  );

  await assert.rejects(
    w.command({
      type: "action",
      taskId: created.task!.id,
      actionId: "complete",
      expectedRevision: created.task!.revision,
      input: { block: "1" },
      operationId: randomUUID(),
      compositionRevision: 2,
    }),
    /钩子拒绝提交/,
  );
  assert.equal(w.read(created.task!.id).state, "open");

  await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setDue",
    expectedRevision: created.task!.revision,
    input: { dueAt: new Date(Date.now() + 70).toISOString() },
    operationId: randomUUID(),
    compositionRevision: 2,
  });
  assert.equal(w.schedulerState().armed, 1);
  await new Promise((r) => setTimeout(r, 140));
  assert.equal(w.read(created.task!.id).state, "done");

  await w.activate({
    workflowId: "default",
    compositionRevision: 2,
    operationId: randomUUID(),
  });
  assert.equal(w.schedulerState().armed, 0);
});

test("mock hooks: annotations, created/deleted events, switch dispose", async (t) => {
  const life: string[] = [];
  const events: string[] = [];
  const contribution = (): ExtensionContribution => ({
    beforeCommit: true,
    events: ["task.created", "task.updated", "task.deleted"],
    diagnostics: true,
    lifecycle: {
      activate: true,
      ready: true,
      quiesce: true,
      dispose: true,
    },
    fields: [{ key: "dueAt", label: "截止", type: "text" }],
    commands: [
      { id: "complete", label: "完成", from: ["open"] },
      { id: "setDue", label: "设截止", from: ["open"] },
    ],
  });
  const directory = await mkdtemp(join(tmpdir(), "cordis-ext-hook-"));
  const filename = join(directory, "tasks.db");
  const flags = { beforeCommitReject: false, eventThrows: false };
  const w = await Workspace.open(filename, {
    launch: async (version: Version) => {
      if (version.pluginId !== "hooked") return Runtime.start(version);
      return hookedRuntime({
        contribution,
        flags,
        lifecycle: life,
        events,
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
  await w.activate(
    {
      versionId: hooked.id,
      compositionRevision: 1,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  assert.deepEqual(life.slice(0, 2), ["activate", "ready"]);
  assert.ok(w.diagnostics().some((n) => n.includes("life:activate")));

  const created = await w.command({
    type: "create",
    title: "事件任务",
    operationId: randomUUID(),
    compositionRevision: 2,
  });
  assert.ok(events.includes("task.created"));
  assert.ok(w.diagnostics().some((n) => n.includes("event:task.created")));

  const deleted = await w.command({
    type: "delete",
    taskId: created.task!.id,
    expectedRevision: created.task!.revision,
    operationId: randomUUID(),
    compositionRevision: 2,
  });
  assert.ok(events.includes("task.deleted"));
  assert.equal(deleted.task?.deletedAt != null, true);

  flags.eventThrows = true;
  const other = await w.command({
    type: "create",
    title: "失败观察者",
    operationId: randomUUID(),
    compositionRevision: 2,
  });
  assert.equal(other.task?.title, "失败观察者");
  assert.ok(w.diagnostics().some((n) => /observer failed/.test(n)));

  await w.activate({
    workflowId: "default",
    compositionRevision: 2,
    operationId: randomUUID(),
  });
  assert.ok(life.includes("quiesce"));
  assert.ok(life.includes("dispose"));
  assert.equal(w.schedulerState().armed, 0);
});

test("field schedule arms from task field via mock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-ext-field-"));
  const filename = join(directory, "tasks.db");
  const w = await Workspace.open(filename, {
    launch: async (version: Version) => {
      if (version.pluginId !== "hooked") return Runtime.start(version);
      return hookedRuntime({
        contribution: () => ({
          events: ["task.updated"],
          commands: [{ id: "setDue", label: "设截止", from: ["open"] }],
          schedules: [
            {
              id: "due",
              at: "dueAt",
              atKind: "field",
              dedupeKey: "due",
              onFire: { type: "action", commandId: "complete" },
              missPolicy: "skip",
            },
          ],
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
    title: "字段调度",
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
  await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setDue",
    expectedRevision: created.task!.revision,
    input: { dueAt: new Date(Date.now() + 60).toISOString() },
    operationId: randomUUID(),
    compositionRevision: 2,
  });
  assert.equal(w.schedulerState().armed, 1);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(w.read(created.task!.id).state, "done");
});
