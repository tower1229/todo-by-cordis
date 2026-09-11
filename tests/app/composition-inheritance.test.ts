import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver } from "./planning-fixture.js";
import { ExecutionDriver } from "./execution-fixture.js";
import { activateDual } from "./dual-composition-fixture.js";
import { source } from "./evolution-fixture.js";
import { toolReply } from "./planning-fixture.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";

// Seams: Evolution public control plane (request/start/experience/apply/observe)
// → Workspace composition/query/command. Real candidate generation only; no awaiting-apply seed.

async function settle(e: Evolution, status?: string) {
  for (let i = 0; i < 200; i++) {
    const run = (await e.observe()).run;
    if (!run) throw new Error("missing run");
    if (
      status
        ? run.status === status
        : !["planning", "executing", "applying"].includes(run.status)
    )
      return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout: ${JSON.stringify((await e.observe()).run)}`);
}

function memberSnapshot(composition: ReturnType<Workspace["composition"]>) {
  return composition.members
    .map((m) => ({
      pluginId: m.pluginId,
      versionId: m.versionId,
      enabled: m.enabled,
      role: m.role,
    }))
    .sort((a, b) => a.pluginId.localeCompare(b.pluginId));
}

async function dualWithTaggedTask(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-inherit-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  const { tags, due } = await activateDual(w);
  const before = w.composition();
  const created = await w.command({
    type: "create",
    title: "keep-b-fields",
    compositionRevision: before.revision,
    operationId: randomUUID(),
  });
  const tagged = await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setTags",
    expectedRevision: created.task!.revision,
    input: { tags: "inherit-me" },
    operationId: randomUUID(),
    compositionRevision: before.revision,
  });
  assert.equal(tagged.task?.fields.tags, "inherit-me");
  return {
    w,
    before: w.composition(),
    tags,
    due,
    taskId: created.task!.id,
    directory,
  };
}

/** Real plan → start → candidate generation to awaiting-apply on dual composition. */
async function realAwaitingApply(t: TestContext) {
  const ctx = await dualWithTaggedTask(t);
  const e = new Evolution(
    ctx.w.db,
    new ExecutionDriver(new PlanningDriver(), "aux-workflow", "双贡献组合"),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "plan",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.equal(done.status, "awaiting-apply");
  if (done.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  const snapshot = await e.observe();
  const candidate = snapshot.candidates?.find((c) => c.passed);
  assert.ok(candidate, "real generation must produce a passed candidate");
  assert.ok(candidate.evidenceHash);
  assert.ok(done.versionId);
  return { ...ctx, e, ready, done, candidate };
}

test("只改工作流 A 并应用确认后，辅助成员 B 的身份版本启用角色与字段命令仍完整", async (t) => {
  const { w, before, tags, due, taskId, e, done, candidate } =
    await realAwaitingApply(t);

  const tagsBefore = before.members.find((m) => m.pluginId === "tags");
  const dueBefore = before.members.find((m) => m.pluginId === "due");
  assert.ok(tagsBefore);
  assert.ok(dueBefore);
  assert.equal(tagsBefore.versionId, tags.id);
  assert.equal(dueBefore.versionId, due.id);

  const experience = await e.command({
    type: "experience",
    operationId: "experience-1",
    runId: done.id,
    candidateId: candidate.id,
  });
  assert.equal(experience.run?.status, "awaiting-apply");
  if (experience.run?.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  assert.equal(experience.run.experience?.marked, "not-applied");
  assert.equal(experience.run.experience?.isolated, true);
  assert.match(experience.run.experience?.note ?? "", /尚未应用|模拟/);
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.query().tasks.find((task) => task.id === taskId)?.fields.tags, "inherit-me");

  const apply = {
    type: "apply" as const,
    operationId: "apply-1",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  };
  await e.command(apply);
  const succeeded = await settle(e, "succeeded");
  assert.equal(succeeded.status, "succeeded");
  assert.equal(w.composition().versionId, done.versionId);
  assert.notEqual(w.composition().versionId, before.versionId);

  const after = w.composition();
  const tagsAfter = after.members.find((m) => m.pluginId === "tags");
  const dueAfter = after.members.find((m) => m.pluginId === "due");
  assert.deepEqual(
    {
      pluginId: tagsAfter?.pluginId,
      versionId: tagsAfter?.versionId,
      enabled: tagsAfter?.enabled,
      role: tagsAfter?.role,
    },
    {
      pluginId: "tags",
      versionId: tags.id,
      enabled: true,
      role: "auxiliary",
    },
  );
  assert.deepEqual(
    {
      pluginId: dueAfter?.pluginId,
      versionId: dueAfter?.versionId,
      enabled: dueAfter?.enabled,
      role: dueAfter?.role,
    },
    {
      pluginId: "due",
      versionId: due.id,
      enabled: true,
      role: "auxiliary",
    },
  );

  const listed = w.query();
  assert.equal(listed.tasks.find((task) => task.id === taskId)?.fields.tags, "inherit-me");
  const task = w.read(taskId);
  const retagged = await w.command({
    type: "action",
    taskId,
    actionId: "setTags",
    expectedRevision: task.revision,
    input: { tags: "still-works" },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(retagged.task?.fields.tags, "still-works");
});

test("真实候选业务验收失败时正式组合与任务相对开始前不变", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const membersBefore = memberSnapshot(ctx.before);
  const planning = new PlanningDriver();
  const fallback = new ExecutionDriver(planning, "aux-workflow", "双贡献组合");
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      const reply = await fallback.generate(request, signal);
      if (reply.calls[0]?.name !== "submit_candidate") return reply;
      return {
        ...toolReply("submit_candidate", {
          source: source("aux-workflow", "双贡献组合").replace(
            "return {kind:'commit',state:'done',fields:{...task.fields,reflection:value}};",
            "return {kind:'reject',message:'故意验收失败'};",
          ),
        }),
        history: request.history,
      };
    },
  };
  const e = new Evolution(ctx.w.db, driver, new EvolutionDomain(ctx.w));
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "plan",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-fail",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const finished = await settle(e);
  assert.notEqual(finished.status, "awaiting-apply");
  assert.notEqual(finished.status, "succeeded");
  assert.equal(ctx.w.composition().versionId, ctx.before.versionId);
  assert.equal(ctx.w.composition().revision, ctx.before.revision);
  assert.deepEqual(memberSnapshot(ctx.w.composition()), membersBefore);
  assert.equal(
    ctx.w.query().tasks.find((task) => task.id === ctx.taskId)?.fields.tags,
    "inherit-me",
  );
});
