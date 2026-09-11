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
import { source, candidateSource } from "./evolution-fixture.js";
import { toolReply } from "./planning-fixture.js";
import { panelPluginCode } from "../fixtures/member-ui.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import { contract } from "../../src/server/evolution-domain.js";

// Seams: Evolution public control plane (request/start/experience/apply/observe)
// → Workspace composition/query/command. Real candidate generation only; no awaiting-apply seed.

const addPanelPlan = {
  summary: "叠加备注面板辅助成员",
  changes: ["新增 panel 辅助成员", "保留 tags 与 due 精确版本", "完成前要求填写复盘"],
  outcome: "既有标签与截止日期仍可用，并可打备注标记",
  dataImpact: "保留既有成员精确版本与字段；新增 panel 成员",
  memberAdditions: [{ pluginId: "panel", name: "备注面板插件" }],
};

const upgradeTagsPlan = {
  summary: "只升级标签辅助成员",
  changes: ["升级 tags 辅助成员", "保留 due 与主工作流契约", "完成前要求填写复盘"],
  outcome: "标签写入会规范化小写；截止日期仍按原版本可用",
  dataImpact: "保留 due 精确版本与字段；升级 tags 成员版本；保留未改成员启用状态",
  memberUpgrades: [{ pluginId: "tags" }],
};

/** Upgraded tags: trim + lowercase; same field/command identity. */
const upgradedTagsSource = `export default {
  contribute() {
    return {
      fields: [{ key: "tags", label: "标签", type: "text" }],
      commands: [{ id: "setTags", label: "设标签", from: ["open", "done"] }],
    };
  },
  decide(data) {
    const { task, action, input } = data;
    if (action === "setTags")
      return {
        kind: "commit",
        state: task.state,
        fields: {
          ...task.fields,
          tags: String(input?.tags ?? "").trim().toLowerCase(),
        },
      };
    return { kind: "reject", message: "未知动作" };
  },
};`;

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
  const dated = await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setDue",
    expectedRevision: tagged.task!.revision,
    input: { dueAt: "2026-09-20T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: before.revision,
  });
  assert.equal(dated.task?.fields.dueAt, "2026-09-20T00:00:00Z");
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
  const kept = listed.tasks.find((task) => task.id === taskId);
  assert.equal(kept?.fields.tags, "inherit-me");
  assert.equal(kept?.fields.dueAt, "2026-09-20T00:00:00Z");
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
  const redated = await w.command({
    type: "action",
    taskId,
    actionId: "setDue",
    expectedRevision: retagged.task!.revision,
    input: { dueAt: "2026-09-21T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(redated.task?.fields.dueAt, "2026-09-21T00:00:00Z");
  assert.equal(redated.task?.fields.tags, "still-works");
});

test("先停用 tags 再只改工作流，应用后 tags 仍为停用且字段保留、due 仍可用", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const { w, tags, due, taskId } = ctx;
  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: ctx.before.revision,
    versionId: ctx.before.versionId,
    pluginId: "tags",
    enabled: false,
  });
  const before = w.composition();
  const tagsBefore = before.members.find((m) => m.pluginId === "tags");
  const dueBefore = before.members.find((m) => m.pluginId === "due");
  assert.ok(tagsBefore);
  assert.ok(dueBefore);
  assert.equal(tagsBefore.enabled, false);
  assert.equal(tagsBefore.versionId, tags.id);
  assert.equal(dueBefore.enabled, true);
  assert.equal(dueBefore.versionId, due.id);
  assert.equal(w.read(taskId).fields.tags, "inherit-me");

  const activeName = w.activeVersion().name;
  const e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver(), "aux-workflow", activeName),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "plan-disabled",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-disabled",
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

  await e.command({
    type: "apply",
    operationId: "apply-disabled",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  const succeeded = await settle(e, "succeeded");
  assert.equal(succeeded.status, "succeeded");

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
      enabled: false,
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

  const task = w.read(taskId);
  assert.equal(task.fields.tags, "inherit-me");
  assert.equal(
    w.query().tasks.find((row) => row.id === taskId)?.fields.tags,
    "inherit-me",
  );
  await assert.rejects(
    w.command({
      type: "action",
      taskId,
      actionId: "setTags",
      expectedRevision: task.revision,
      input: { tags: "nope" },
      operationId: randomUUID(),
      compositionRevision: after.revision,
    }),
    /不可用|无效/,
  );
  assert.equal(w.read(taskId).fields.tags, "inherit-me");

  const redated = await w.command({
    type: "action",
    taskId,
    actionId: "setDue",
    expectedRevision: task.revision,
    input: { dueAt: "2026-09-22T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(redated.task?.fields.dueAt, "2026-09-22T00:00:00Z");
  assert.equal(redated.task?.fields.tags, "inherit-me");
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

/** Real plan → start → candidate that adds an auxiliary member on dual composition. */
async function realAwaitingApplyAddMember(t: TestContext) {
  const ctx = await dualWithTaggedTask(t);
  const panelSource = await panelPluginCode();
  const e = new Evolution(
    ctx.w.db,
    new ExecutionDriver(
      new PlanningDriver(addPanelPlan),
      "aux-workflow",
      "双贡献组合",
      1,
      [{ pluginId: "panel", source: panelSource }],
    ),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "增加备注面板辅助能力",
    operationId: "plan-add-member",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-add-member",
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

test("经正常候选新增辅助成员后，应用前正式组合不变；应用后既有成员精确保留且新成员命令可用", async (t) => {
  const { w, before, tags, due, taskId, e, done, candidate } =
    await realAwaitingApplyAddMember(t);

  assert.equal(w.composition().versionId, before.versionId);
  assert.deepEqual(memberSnapshot(w.composition()), memberSnapshot(before));
  assert.equal(
    before.members.find((m) => m.pluginId === "panel"),
    undefined,
  );

  const experience = await e.command({
    type: "experience",
    operationId: "experience-add",
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
  assert.deepEqual(memberSnapshot(w.composition()), memberSnapshot(before));

  await e.command({
    type: "apply",
    operationId: "apply-add",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  const succeeded = await settle(e, "succeeded");
  assert.equal(succeeded.status, "succeeded");
  assert.equal(w.composition().versionId, done.versionId);
  assert.notEqual(w.composition().versionId, before.versionId);

  const after = w.composition();
  const tagsAfter = after.members.find((m) => m.pluginId === "tags");
  const dueAfter = after.members.find((m) => m.pluginId === "due");
  const panelAfter = after.members.find((m) => m.pluginId === "panel");
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
  assert.ok(panelAfter);
  assert.equal(panelAfter.enabled, true);
  assert.equal(panelAfter.role, "auxiliary");
  assert.ok(panelAfter.versionId);
  assert.notEqual(panelAfter.versionId, after.versionId);

  const kept = w.query().tasks.find((task) => task.id === taskId);
  assert.equal(kept?.fields.tags, "inherit-me");
  assert.equal(kept?.fields.dueAt, "2026-09-20T00:00:00Z");

  const task = w.read(taskId);
  const retagged = await w.command({
    type: "action",
    taskId,
    actionId: "setTags",
    expectedRevision: task.revision,
    input: { tags: "still-after-add" },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(retagged.task?.fields.tags, "still-after-add");
  const redated = await w.command({
    type: "action",
    taskId,
    actionId: "setDue",
    expectedRevision: retagged.task!.revision,
    input: { dueAt: "2026-09-23T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(redated.task?.fields.dueAt, "2026-09-23T00:00:00Z");
  assert.equal(redated.task?.fields.tags, "still-after-add");
  const noted = await w.command({
    type: "action",
    taskId,
    actionId: "markNote",
    expectedRevision: redated.task!.revision,
    input: {},
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(noted.task?.fields.noteMark, "ok");
  assert.equal(noted.task?.fields.tags, "still-after-add");
  assert.equal(noted.task?.fields.dueAt, "2026-09-23T00:00:00Z");
  assert.ok(
    after.uiContributions.some(
      (c) => c.id === "note-panel" && c.providerId === "panel",
    ),
  );
});

test("先停用 tags 再经正常候选新增辅助成员，应用后 tags 仍停用且新成员可用", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const { w, tags, due, taskId } = ctx;
  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: ctx.before.revision,
    versionId: ctx.before.versionId,
    pluginId: "tags",
    enabled: false,
  });
  const before = w.composition();
  assert.equal(
    before.members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );

  const panelSource = await panelPluginCode();
  const activeName = w.activeVersion().name;
  const e = new Evolution(
    w.db,
    new ExecutionDriver(
      new PlanningDriver(addPanelPlan),
      "aux-workflow",
      activeName,
      1,
      [{ pluginId: "panel", source: panelSource }],
    ),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "增加备注面板辅助能力",
    operationId: "plan-add-disabled",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-add-disabled",
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

  await e.command({
    type: "apply",
    operationId: "apply-add-disabled",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  const succeeded = await settle(e, "succeeded");
  assert.equal(succeeded.status, "succeeded");

  const after = w.composition();
  assert.deepEqual(
    {
      pluginId: after.members.find((m) => m.pluginId === "tags")?.pluginId,
      versionId: after.members.find((m) => m.pluginId === "tags")?.versionId,
      enabled: after.members.find((m) => m.pluginId === "tags")?.enabled,
      role: after.members.find((m) => m.pluginId === "tags")?.role,
    },
    {
      pluginId: "tags",
      versionId: tags.id,
      enabled: false,
      role: "auxiliary",
    },
  );
  assert.deepEqual(
    {
      pluginId: after.members.find((m) => m.pluginId === "due")?.pluginId,
      versionId: after.members.find((m) => m.pluginId === "due")?.versionId,
      enabled: after.members.find((m) => m.pluginId === "due")?.enabled,
      role: after.members.find((m) => m.pluginId === "due")?.role,
    },
    {
      pluginId: "due",
      versionId: due.id,
      enabled: true,
      role: "auxiliary",
    },
  );
  const panelAfter = after.members.find((m) => m.pluginId === "panel");
  assert.ok(panelAfter?.enabled && panelAfter.role === "auxiliary");

  const task = w.read(taskId);
  assert.equal(task.fields.tags, "inherit-me");
  await assert.rejects(
    w.command({
      type: "action",
      taskId,
      actionId: "setTags",
      expectedRevision: task.revision,
      input: { tags: "nope" },
      operationId: randomUUID(),
      compositionRevision: after.revision,
    }),
    /不可用|无效/,
  );
  const noted = await w.command({
    type: "action",
    taskId,
    actionId: "markNote",
    expectedRevision: task.revision,
    input: {},
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(noted.task?.fields.noteMark, "ok");
  assert.equal(noted.task?.fields.tags, "inherit-me");
});

test("新增辅助成员候选业务验收失败时正式组合与任务相对开始前不变", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const membersBefore = memberSnapshot(ctx.before);
  const panelSource = await panelPluginCode();
  const planning = new PlanningDriver(addPanelPlan);
  const fallback = new ExecutionDriver(
    planning,
    "aux-workflow",
    "双贡献组合",
    1,
    [{ pluginId: "panel", source: panelSource }],
  );
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      const reply = await fallback.generate(request, signal);
      if (reply.calls[0]?.name !== "submit_candidate") return reply;
      const args = reply.calls[0].args as {
        source: string;
        members: { pluginId: string; source: string }[];
      };
      return {
        ...toolReply("submit_candidate", {
          source: args.source.replace(
            "return {kind:'commit',state:'done',fields:{...task.fields,reflection:value}};",
            "return {kind:'reject',message:'故意验收失败'};",
          ),
          members: args.members,
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
    text: "增加备注面板辅助能力",
    operationId: "plan-add-fail",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-add-fail",
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
  assert.equal(
    ctx.w.composition().members.find((m) => m.pluginId === "panel"),
    undefined,
  );
  const panelVersions = ctx.w.release
    .all()
    .filter((version) => version.pluginId === "panel");
  assert.ok(panelVersions.length >= 1, "failure may leave draft auxiliary versions");
  assert.ok(
    panelVersions.every(
      (version) => !(version.evidence as { passed?: boolean }).passed,
    ),
    "failed candidate must not leave passed auxiliary versions",
  );
  await assert.rejects(
    e.command({
      type: "experience",
      operationId: "experience-add-fail",
      runId: finished.id,
      candidateId: "missing",
    }),
    /没有可体验的候选/,
  );
  await assert.rejects(
    e.command({
      type: "apply",
      operationId: "apply-add-fail",
      runId: finished.id,
      candidateId: "missing",
      evidenceHash: "none",
      compositionRevision: ctx.before.revision,
    }),
    /没有可应用的候选/,
  );
});

test("只升级已有辅助成员 tags 并应用后，due 精确版本保留且 tags 新行为生效", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const { w, before, tags, due, taskId } = ctx;
  const e = new Evolution(
    w.db,
    new ExecutionDriver(
      new PlanningDriver(upgradeTagsPlan),
      "aux-workflow",
      "双贡献组合",
      1,
      [{ pluginId: "tags", source: upgradedTagsSource }],
    ),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "升级标签写入为小写规范化",
    operationId: "plan-upgrade-tags",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  assert.deepEqual(ready.plan.memberUpgrades, [{ pluginId: "tags" }]);
  assert.deepEqual(ready.plan.compositionIntent, {
    upgrade: ["tags"],
    add: [],
    retain: ["aux-workflow", "due"],
  });
  assert.match(ready.plan.dataImpact, /保留/);
  await e.command({
    type: "start",
    operationId: "start-upgrade-tags",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const executing = await settle(e, "awaiting-apply");
  assert.equal(executing.status, "awaiting-apply");
  if (executing.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  const progress = await e.observe();
  assert.ok(
    progress.events?.some(
      (event) =>
        /生成候选|修正候选/.test(event.label) && /升级 tags/.test(event.label),
    ) ||
      (progress.run &&
        "steps" in progress.run &&
        (progress.run as { steps?: { label: string }[] }).steps?.some((s) =>
          /升级 tags/.test(s.label),
        )),
    "execution progress should reflect composition intent",
  );
  const done = executing;
  const candidate = progress.candidates?.find((c) => c.passed);
  assert.ok(candidate, "real generation must produce a passed candidate");
  assert.ok(candidate.evidenceHash);
  assert.equal(w.composition().versionId, before.versionId);

  await e.command({
    type: "apply",
    operationId: "apply-upgrade-tags",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  const succeeded = await settle(e, "succeeded");
  assert.equal(succeeded.status, "succeeded");

  const after = w.composition();
  const workflowAfter = after.members.find((m) => m.role === "workflow");
  assert.ok(workflowAfter);
  assert.equal(workflowAfter.versionId, after.versionId);
  assert.notEqual(
    workflowAfter.versionId,
    before.versionId,
    "upgrade+workflow change must advance workflow member version",
  );
  const tagsAfter = after.members.find((m) => m.pluginId === "tags");
  const dueAfter = after.members.find((m) => m.pluginId === "due");
  assert.ok(tagsAfter);
  assert.ok(dueAfter);
  assert.notEqual(tagsAfter.versionId, tags.id, "upgraded member must bind new version");
  assert.equal(dueAfter.versionId, due.id, "unmodified member keeps exact versionId");
  assert.deepEqual(
    {
      enabled: tagsAfter.enabled,
      role: tagsAfter.role,
      dueEnabled: dueAfter.enabled,
      dueRole: dueAfter.role,
    },
    { enabled: true, role: "auxiliary", dueEnabled: true, dueRole: "auxiliary" },
  );

  const kept = w.query().tasks.find((task) => task.id === taskId);
  assert.equal(kept?.fields.tags, "inherit-me");
  assert.equal(kept?.fields.dueAt, "2026-09-20T00:00:00Z");

  const task = w.read(taskId);
  const retagged = await w.command({
    type: "action",
    taskId,
    actionId: "setTags",
    expectedRevision: task.revision,
    input: { tags: "  Keep-Case  " },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(retagged.task?.fields.tags, "keep-case");
  const redated = await w.command({
    type: "action",
    taskId,
    actionId: "setDue",
    expectedRevision: retagged.task!.revision,
    input: { dueAt: "2026-09-25T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(redated.task?.fields.dueAt, "2026-09-25T00:00:00Z");
  assert.equal(redated.task?.fields.tags, "keep-case");
});

test("升级辅助成员候选业务验收失败时正式组合与任务相对开始前不变", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const membersBefore = memberSnapshot(ctx.before);
  const planning = new PlanningDriver(upgradeTagsPlan);
  const fallback = new ExecutionDriver(
    planning,
    "aux-workflow",
    "双贡献组合",
    1,
    [{ pluginId: "tags", source: upgradedTagsSource }],
  );
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      const reply = await fallback.generate(request, signal);
      if (reply.calls[0]?.name !== "submit_candidate") return reply;
      const args = reply.calls[0].args as {
        source: string;
        members: { pluginId: string; source: string }[];
      };
      return {
        ...toolReply("submit_candidate", {
          source: args.source.replace(
            "return {kind:'commit',state:'done',fields:{...task.fields,reflection:value}};",
            "return {kind:'reject',message:'故意验收失败'};",
          ),
          members: args.members,
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
    text: "升级标签写入为小写规范化",
    operationId: "plan-upgrade-fail",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-upgrade-fail",
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
  const tagsVersions = ctx.w.release
    .all()
    .filter((version) => version.pluginId === "tags");
  assert.ok(
    tagsVersions.some(
      (version) => !(version.evidence as { passed?: boolean }).passed,
    ),
    "failure may leave draft upgrade versions",
  );
  assert.ok(
    tagsVersions
      .filter(
        (version) =>
          (version.evidence as { origin?: string }).origin ===
          "evolution-member-upgrade",
      )
      .every((version) => !(version.evidence as { passed?: boolean }).passed),
    "failed candidate must not leave passed upgrade versions",
  );
});

const pureUpgradeTagsPlan = {
  summary: "只升级标签辅助成员",
  changes: ["升级 tags 辅助成员"],
  outcome: "标签写入会规范化小写；截止日期与主工作流仍按原版本可用",
  dataImpact: "保留主工作流与 due 精确版本与字段；升级 tags 成员版本",
  memberUpgrades: [{ pluginId: "tags" }],
  workflowRules: [] as {
    key: string;
    label: string;
    required: boolean;
    minLength: number;
    maxLength: number;
  }[],
};

test("纯升级辅助成员且工作流未变时，主成员 versionId 精确保留", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const { w, before, tags, due, taskId } = ctx;
  const workflowSource = w.activeVersion().source;
  const planning = new PlanningDriver(pureUpgradeTagsPlan);
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      if (
        request.tools?.some((tool) => tool.name === "submit_candidate") ||
        request.tools?.some((tool) => tool.name === "build_candidate")
      ) {
        const content = JSON.stringify(request.history);
        if (!content.includes("read_contract"))
          return { ...toolReply("read_contract", {}), history: request.history };
        if (!content.includes("read_current_source"))
          return {
            ...toolReply("read_current_source", {}),
            history: request.history,
          };
        return {
          ...toolReply("submit_candidate", {
            source: workflowSource,
            members: [{ pluginId: "tags", source: upgradedTagsSource }],
          }),
          history: request.history,
        };
      }
      return planning.generate(request, signal);
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "只升级标签规范化",
    operationId: "plan-pure-upgrade",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  assert.deepEqual(ready.plan.compositionIntent?.upgrade, ["tags"]);
  assert.ok(ready.plan.compositionIntent?.retain.includes("due"));
  assert.ok(ready.plan.compositionIntent?.retain.includes("aux-workflow"));
  await e.command({
    type: "start",
    operationId: "start-pure-upgrade",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.equal(done.status, "awaiting-apply");
  if (done.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  const snapshot = await e.observe();
  const candidate = snapshot.candidates?.find((c) => c.passed);
  assert.ok(candidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: "apply-pure-upgrade",
    runId: done.id,
    candidateId: candidate!.id,
    evidenceHash: candidate!.evidenceHash!,
    compositionRevision: before.revision,
  });
  const succeeded = await settle(e, "succeeded");
  assert.equal(succeeded.status, "succeeded");
  const after = w.composition();
  const workflowAfter = after.members.find((m) => m.role === "workflow");
  assert.equal(
    workflowAfter?.versionId,
    before.versionId,
    "unchanged workflow must keep exact versionId when only upgrading auxiliary",
  );
  assert.notEqual(after.members.find((m) => m.pluginId === "tags")?.versionId, tags.id);
  assert.equal(after.members.find((m) => m.pluginId === "due")?.versionId, due.id);
  const task = w.read(taskId);
  const retagged = await w.command({
    type: "action",
    taskId,
    actionId: "setTags",
    expectedRevision: task.revision,
    input: { tags: "  Pin-Case  " },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(retagged.task?.fields.tags, "pin-case");
});

test("先停用 tags 再升级后仍保持停用且 due 精确可用", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const { w, tags, due, taskId } = ctx;
  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: ctx.before.revision,
    versionId: ctx.before.versionId,
    pluginId: "tags",
    enabled: false,
  });
  const before = w.composition();
  const e = new Evolution(
    w.db,
    new ExecutionDriver(
      new PlanningDriver(upgradeTagsPlan),
      "aux-workflow",
      w.activeVersion().name,
      1,
      [{ pluginId: "tags", source: upgradedTagsSource }],
    ),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "升级已停用的标签插件",
    operationId: "plan-upgrade-disabled",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-upgrade-disabled",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.equal(done.status, "awaiting-apply");
  if (done.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  const candidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(candidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: "apply-upgrade-disabled",
    runId: done.id,
    candidateId: candidate!.id,
    evidenceHash: candidate!.evidenceHash!,
    compositionRevision: before.revision,
  });
  const succeeded = await settle(e, "succeeded");
  assert.equal(succeeded.status, "succeeded");
  const after = w.composition();
  const tagsAfter = after.members.find((m) => m.pluginId === "tags");
  assert.equal(tagsAfter?.enabled, false);
  assert.notEqual(tagsAfter?.versionId, tags.id);
  assert.equal(after.members.find((m) => m.pluginId === "due")?.versionId, due.id);
  assert.equal(w.read(taskId).fields.tags, "inherit-me");
  await assert.rejects(
    w.command({
      type: "action",
      taskId,
      actionId: "setTags",
      expectedRevision: w.read(taskId).revision,
      input: { tags: "nope" },
      operationId: randomUUID(),
      compositionRevision: after.revision,
    }),
    /不可用|无效/,
  );
  const dated = await w.command({
    type: "action",
    taskId,
    actionId: "setDue",
    expectedRevision: w.read(taskId).revision,
    input: { dueAt: "2026-09-26T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(dated.task?.fields.dueAt, "2026-09-26T00:00:00Z");
});

test("双组合上首次候选失败再修正成功后辅助成员仍完整", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const { w, before, tags, due } = ctx;
  let attempts = 0;
  const planning = new PlanningDriver();
  const fallback = new ExecutionDriver(
    planning,
    "aux-workflow",
    "双贡献组合",
  );
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      const reply = await fallback.generate(request, signal);
      if (reply.calls[0]?.name !== "submit_candidate") return reply;
      attempts++;
      const args = reply.calls[0].args as { source: string };
      if (attempts === 1)
        return {
          ...toolReply("submit_candidate", {
            source: args.source.replace(
              "return {kind:'commit',state:'done',fields:{...task.fields,reflection:value}};",
              "return {kind:'reject',message:'故意第一次失败'};",
            ),
          }),
          history: request.history,
        };
      return reply;
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "plan-correct",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-correct",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.equal(done.status, "awaiting-apply");
  assert.ok(attempts >= 2, "correction round must retry submit_candidate");
  if (done.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  const candidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(candidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: "apply-correct",
    runId: done.id,
    candidateId: candidate!.id,
    evidenceHash: candidate!.evidenceHash!,
    compositionRevision: before.revision,
  });
  await settle(e, "succeeded");
  const after = w.composition();
  assert.equal(after.members.find((m) => m.pluginId === "tags")?.versionId, tags.id);
  assert.equal(after.members.find((m) => m.pluginId === "due")?.versionId, due.id);
});

test("双组合上 repair 应用后辅助成员精确版本仍完整", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const { w, tags, due } = ctx;
  const rules = [
    {
      key: "reflection",
      label: "复盘",
      required: true,
      minLength: 1,
      maxLength: 5000,
    },
  ];
  const brokenSource = source("aux-workflow", "双贡献组合").replaceAll(
    "[...value].length",
    "value.length",
  );
  const files = Object.fromEntries(
    (
      JSON.parse(candidateSource(brokenSource)) as {
        files: { path: string; content: string }[];
      }
    ).files.map((f) => [f.path, f.content]),
  );
  const bundle = await w.release.buildBundle(
    files,
    contract,
    AbortSignal.timeout(15000),
  );
  const old = w.activeVersion();
  const faulty = w.release.record({
    pluginId: old.pluginId,
    name: old.name,
    service: "workflow",
    contractVersion: "workflow/1",
    parentId: old.id,
    source: JSON.stringify({
      files: Object.entries(files).map(([path, content]) => ({
        path,
        content,
      })),
    }),
    code: bundle.outputs["business/entry.js"],
    bundle,
    definition: {
      ...(old.definition as object),
      fields: [
        { key: "reflection", label: "复盘", type: "text", required: true },
      ],
    },
    evidence: { passed: true, rules, origin: "historical-fault-fixture" },
    members: [
      { pluginId: "aux-workflow", enabled: true, role: "workflow" },
      { pluginId: "tags", versionId: tags.id, enabled: true, role: "auxiliary" },
      { pluginId: "due", versionId: due.id, enabled: true, role: "auxiliary" },
    ],
  });
  await w.activate(
    {
      versionId: faulty.id,
      compositionRevision: w.composition().revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const before = w.composition();
  const planning = new PlanningDriver({
    workflowRules: rules,
    writableScope: [
      "business/entry.ts",
      "business/view.ts",
      "business/config.json",
      "business/compatibility.json",
    ],
    intent: "repair",
  });
  const fallback = new ExecutionDriver(planning, "aux-workflow", "双贡献组合");
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      const reply = await fallback.generate(request, signal);
      if (
        reply.calls[0]?.name === "submit_candidate" &&
        w.activeVersion().bundle
      ) {
        reply.calls[0].args = JSON.parse(
          candidateSource(String(reply.calls[0].args.source)),
        ) as { files: unknown };
      }
      return reply;
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "修复表情字符长度误判",
    operationId: "plan-repair-dual",
    intent: "repair",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-repair-dual",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.equal(done.status, "awaiting-apply");
  if (done.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  const candidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(candidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: "apply-repair-dual",
    runId: done.id,
    candidateId: candidate!.id,
    evidenceHash: candidate!.evidenceHash!,
    compositionRevision: before.revision,
  });
  await settle(e, "succeeded");
  const after = w.composition();
  assert.equal(after.members.find((m) => m.pluginId === "tags")?.versionId, tags.id);
  assert.equal(after.members.find((m) => m.pluginId === "due")?.versionId, due.id);
});
