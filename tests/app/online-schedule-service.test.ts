import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import {
  createControllableClock,
} from "../../src/server/host/clock.js";
import {
  ONLINE_SCHEDULER_SERVICE_ID,
  OnlineScheduleService,
} from "../../src/server/host/online-schedule-service.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";
import { ExperienceSessionHost } from "../../src/server/experience-session.js";

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

test("controllable clock advances timers without wall sleep", async () => {
  const clock = createControllableClock(1_000);
  const fired: number[] = [];
  clock.setTimeout(() => fired.push(clock.now()), 500);
  clock.setTimeout(() => fired.push(clock.now()), 200);
  assert.deepEqual(fired, []);
  await clock.advance(200);
  assert.deepEqual(fired, [1_200]);
  await clock.advance(300);
  assert.deepEqual(fired, [1_200, 1_500]);
});

test("online schedule service lifecycle is host-owned and distinct from members", async () => {
  const clock = createControllableClock(0);
  const service = new OnlineScheduleService(clock);
  assert.equal(service.id, ONLINE_SCHEDULER_SERVICE_ID);
  assert.equal(service.lifecycle(), "created");
  assert.equal(service.summary().kind, "host-base");
  assert.equal(service.summary().interfaceId, "schedule.runtime");

  const fired: string[] = [];
  service.bind(
    [
      {
        id: "soon",
        at: new Date(1_000).toISOString(),
        dedupeKey: "soon",
        onFire: { type: "action", commandId: "complete", taskId: "t1" },
        missPolicy: "skip",
      },
    ],
    {
      fire: async (job) => {
        fired.push(job.dedupeKey);
      },
    },
  );
  assert.equal(service.lifecycle(), "bound");
  assert.equal(service.armedCount(), 1);
  assert.equal(service.summary().status, "active");

  service.stop();
  assert.equal(service.lifecycle(), "stopped");
  assert.equal(service.armedCount(), 0);
  assert.equal(service.summary().status, "stopped");
  await clock.advance(2_000);
  assert.deepEqual(fired, []);

  service.release();
  assert.equal(service.lifecycle(), "released");
  assert.throws(() => service.bind([], { fire: async () => undefined }), /released/);
});

test("workspace injects clock and surfaces host base schedule service", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-sched-clock-"));
  const clock = createControllableClock(Date.parse("2026-09-22T00:00:00.000Z"));
  const w = await Workspace.open(join(directory, "tasks.db"), { clock });
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });

  const base = w.composition().baseServices;
  assert.ok(base);
  assert.ok(
    base.some(
      (s) =>
        s.id === ONLINE_SCHEDULER_SERVICE_ID &&
        s.kind === "host-base" &&
        s.interfaceId === "schedule.runtime",
    ),
  );
  assert.ok(
    !w.composition().members.some((m) => m.pluginId === ONLINE_SCHEDULER_SERVICE_ID),
  );

  const code = await readFile(hookedFixturePath, "utf8");
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
      compositionRevision: w.composition().revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );

  const created = await w.command({
    type: "create",
    title: "时钟触发",
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
  });
  await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setDue",
    expectedRevision: created.task!.revision,
    input: { dueAt: new Date(clock.now() + 5_000).toISOString() },
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
  });
  assert.equal(w.schedulerState().armed, 1);
  assert.equal(w.read(created.task!.id).state, "open");

  await clock.advance(5_000);
  assert.equal(w.read(created.task!.id).state, "done");
  assert.equal(
    w.composition().baseServices?.find((s) => s.id === ONLINE_SCHEDULER_SERVICE_ID)
      ?.status,
    "active",
  );
});

test("clearing due cancels schedule so clock advance does not fire", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-sched-cancel-"));
  const clock = createControllableClock(Date.parse("2026-09-22T01:00:00.000Z"));
  const w = await Workspace.open(join(directory, "tasks.db"), { clock });
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const code = await readFile(hookedFixturePath, "utf8");
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
      compositionRevision: w.composition().revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const created = await w.command({
    type: "create",
    title: "取消调度",
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
  });
  const dated = await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setDue",
    expectedRevision: created.task!.revision,
    input: { dueAt: new Date(clock.now() + 10_000).toISOString() },
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
  });
  assert.equal(w.schedulerState().armed, 1);
  await w.command({
    type: "action",
    taskId: dated.task!.id,
    actionId: "setDue",
    expectedRevision: dated.task!.revision,
    input: { dueAt: "" },
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
  });
  assert.equal(w.schedulerState().armed, 0);
  await clock.advance(20_000);
  assert.equal(w.read(created.task!.id).state, "open");
});

test("closing workspace releases schedule service; production default uses system clock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-sched-close-"));
  const clock = createControllableClock(0);
  const w = await Workspace.open(join(directory, "tasks.db"), { clock });
  const harness = w.testHarness();
  assert.ok(harness);
  assert.equal(harness.scheduleService.lifecycle(), "bound");
  assert.equal(harness.clock, clock);
  await w.close();
  assert.equal(harness.scheduleService.lifecycle(), "released");
  await rm(directory, { recursive: true, force: true });

  const directory2 = await mkdtemp(join(tmpdir(), "cordis-sched-sys-"));
  const w2 = await Workspace.open(join(directory2, "tasks.db"));
  t.after(async () => {
    await w2.close();
    await rm(directory2, { recursive: true, force: true });
  });
  assert.equal(w2.testHarness(), undefined);
});

test("formal and experience session schedules stay isolated through experience end", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-sched-iso-"));
  const formalClock = createControllableClock(
    Date.parse("2026-09-22T02:00:00.000Z"),
  );
  const w = await Workspace.open(join(directory, "workspace.db"), {
    clock: formalClock,
  });
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });

  const code = await readFile(hookedFixturePath, "utf8");
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
      compositionRevision: w.composition().revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );

  const formalTask = await w.command({
    type: "create",
    title: "formal-due",
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
  });
  await w.command({
    type: "action",
    taskId: formalTask.task!.id,
    actionId: "setDue",
    expectedRevision: formalTask.task!.revision,
    input: { dueAt: new Date(formalClock.now() + 60_000).toISOString() },
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
  });
  assert.equal(w.schedulerState().armed, 1);

  const sessions = new ExperienceSessionHost(w);
  t.after(async () => {
    await sessions.close();
  });
  const snapshot = await sessions.start({
    runId: "sched-iso",
    candidateId: "candidate",
    versionId: hooked.id,
    evidenceHash: "test",
    compositionRevision: w.composition().revision,
  });
  const experience = sessions.workspaceFor(snapshot.id);
  const expTask = experience.read(snapshot.taskId);
  await sessions.command(snapshot.id, {
    type: "action",
    taskId: expTask.id,
    actionId: "setDue",
    expectedRevision: expTask.revision,
    input: { dueAt: new Date(Date.now() + 80).toISOString() },
    operationId: randomUUID(),
  });
  assert.equal(experience.schedulerState().armed, 1);
  await new Promise((r) => setTimeout(r, 160));
  assert.equal(experience.read(snapshot.taskId).state, "done");
  assert.equal(w.read(formalTask.task!.id).state, "open");
  assert.equal(w.schedulerState().armed, 1);

  await sessions.end(snapshot.id);
  assert.equal(w.schedulerState().armed, 1);
  assert.equal(w.read(formalTask.task!.id).state, "open");
  await formalClock.advance(60_000);
  assert.equal(w.read(formalTask.task!.id).state, "done");
});
