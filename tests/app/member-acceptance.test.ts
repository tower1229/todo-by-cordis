import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import { activateDual } from "./dual-composition-fixture.js";
import { panelPluginCode } from "../fixtures/member-ui.js";
import { source } from "./evolution-fixture.js";
import { parseMemberCases } from "../../src/server/business-verification.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";

// Seam A: Evolution public control plane → isolated Workspace command/query.
// Frozen member cases are the business oracle; smoke matching decide output is not enough.

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

const tagsMemberCases = [
  {
    name: "标签去空格转小写",
    member: "tags",
    state: "open",
    fields: {},
    action: "setTags",
    input: { tags: "  Hello " },
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { tags: "hello" },
    },
  },
  {
    name: "空白标签拒绝",
    member: "tags",
    state: "open",
    fields: {},
    action: "setTags",
    input: { tags: "   " },
    expected: { kind: "reject" as const },
  },
];

const freezeTagsPlan = {
  summary: "冻结标签规范化验收并升级 tags",
  changes: ["升级 tags 辅助成员", "冻结去空格转小写正例与空白拒绝"],
  outcome: "标签保存去空格并转小写，空白标签被拒绝",
  dataImpact: "保留 due 与主工作流精确版本；升级 tags 成员版本",
  memberUpgrades: [{ pluginId: "tags" }],
  memberCases: tagsMemberCases,
  workflowRules: [] as {
    key: string;
    label: string;
    required: boolean;
    minLength: number;
    maxLength: number;
  }[],
};

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
  const directory = await mkdtemp(join(tmpdir(), "cordis-member-accept-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  const { tags, due } = await activateDual(w);
  const before = w.composition();
  const created = await w.command({
    type: "create",
    title: "keep-formal",
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
  };
}

async function asIsTagsSource() {
  return readFile(join(fixtureDir, "tags-plugin.mjs"), "utf8");
}

const normalizedTagsSource = `export default {
  contribute() {
    return {
      fields: [{ key: "tags", label: "标签", type: "text" }],
      commands: [{ id: "setTags", label: "设标签", from: ["open", "done"] }],
    };
  },
  decide(data) {
    const { task, action, input } = data;
    if (action === "setTags") {
      const tags = String(input?.tags ?? "").trim().toLowerCase();
      if (!tags) return { kind: "reject", message: "标签为空" };
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, tags },
      };
    }
    return { kind: "reject", message: "未知动作" };
  },
};`;

function pinnedMemberDriver(
  planning: PlanningDriver,
  workflowSource: () => string,
  members: () => { pluginId: string; source: string }[],
): Driver {
  return {
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
            source: workflowSource(),
            members: members(),
          }),
          history: request.history,
        };
      }
      return planning.generate(request, signal);
    },
  };
}

function typedWorkflowMemberDriver(
  planning: PlanningDriver,
  members: () => { pluginId: string; source: string }[],
): Driver {
  return pinnedMemberDriver(
    planning,
    () => source("aux-workflow", "双贡献组合", 1),
    members,
  );
}

test("业务要求未实现的标签候选即使冒烟可能通过，冻结案例也使验证失败且正式组合与任务不变", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const membersBefore = memberSnapshot(ctx.before);
  const asIs = await asIsTagsSource();
  const workflowSource = ctx.w.activeVersion().source;
  const planning = new PlanningDriver(freezeTagsPlan);
  const e = new Evolution(
    ctx.w.db,
    pinnedMemberDriver(
      planning,
      () => workflowSource,
      () => [{ pluginId: "tags", source: asIs }],
    ),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "标签保存去空格并转小写，空白拒绝",
    operationId: "plan-frozen-tags",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  assert.ok(
    ready.plan.memberCases?.some((c) => c.name === "标签去空格转小写"),
    JSON.stringify(ready.plan.memberCases),
  );
  assert.ok(
    ready.plan.memberCases?.some(
      (c) => c.name === "空白标签拒绝" && c.expected.kind === "reject",
    ),
  );
  await e.command({
    type: "start",
    operationId: "start-as-is-tags",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const finished = await settle(e);
  assert.notEqual(finished.status, "awaiting-apply");
  assert.notEqual(finished.status, "succeeded");
  const snapshot = await e.observe();
  assert.ok(
    snapshot.candidates?.some((c) => c.passed === false),
    snapshot.candidates?.map((c) => c.diagnostic).join("\n"),
  );
  assert.match(
    snapshot.candidates?.find((c) => c.diagnostic)?.diagnostic ?? "",
    /workspace:member:tags:标签去空格转小写|hello/,
  );
  assert.equal(ctx.w.composition().versionId, ctx.before.versionId);
  assert.equal(ctx.w.composition().revision, ctx.before.revision);
  assert.deepEqual(memberSnapshot(ctx.w.composition()), membersBefore);
  assert.equal(
    ctx.w.query().tasks.find((task) => task.id === ctx.taskId)?.fields.tags,
    "inherit-me",
  );
  assert.equal(ctx.w.query().total, 1);
});

test("成员级正例与拒绝案例在无关后续迭代中继续参与验收，不因省略而丢失", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const dueSource = await readFile(join(fixtureDir, "due-plugin.mjs"), "utf8");
  const asIs = await asIsTagsSource();
  const planning = new PlanningDriver(freezeTagsPlan);
  let submitted = [{ pluginId: "tags", source: normalizedTagsSource }];
  const e = new Evolution(
    ctx.w.db,
    pinnedMemberDriver(
      planning,
      () => ctx.w.activeVersion().source,
      () => submitted,
    ),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });
  const publish = async (text: string, operation: string) => {
    await e.command({
      type: "request",
      text,
      operationId: `${operation}-plan`,
    });
    const ready = await settle(e, "ready");
    assert.equal(ready.status, "ready", JSON.stringify(ready));
    if (ready.status !== "ready") throw new Error("expected ready");
    await e.command({
      type: "start",
      operationId: `${operation}-start`,
      runId: ready.id,
      planId: ready.plan.id,
    });
    const done = await settle(e, "awaiting-apply");
    assert.equal(done.status, "awaiting-apply", JSON.stringify(done));
    const candidate = (await e.observe()).candidates?.find((c) => c.passed);
    assert.ok(candidate?.evidenceHash);
    await e.command({
      type: "apply",
      operationId: `${operation}-apply`,
      runId: ready.id,
      candidateId: candidate!.id,
      evidenceHash: candidate!.evidenceHash!,
      compositionRevision: ctx.w.composition().revision,
    });
    const succeeded = await settle(e, "succeeded");
    assert.equal(succeeded.status, "succeeded");
    return { ready, candidate: candidate! };
  };

  const first = await publish("标签保存去空格并转小写", "freeze-tags");
  assert.ok(
    first.ready.plan.memberCases?.some((c) => c.name === "标签去空格转小写"),
  );
  const firstEvidence = ctx.w.release.get(ctx.w.composition().versionId)
    .evidence as { checks?: string[]; memberCases?: unknown };
  assert.ok(
    firstEvidence.checks?.includes("workspace:member:tags:标签去空格转小写"),
    firstEvidence.checks?.join("\n"),
  );
  assert.ok(
    firstEvidence.checks?.includes("workspace:member:tags:空白标签拒绝"),
  );

  planning.finish = {
    summary: "只升级截止日期辅助成员",
    changes: ["升级 due 辅助成员"],
    outcome: "截止日期仍按成员命令可用",
    dataImpact: "保留 tags 精确版本与冻结验收；升级 due 成员版本",
    memberUpgrades: [{ pluginId: "due" }],
    workflowRules: [],
  };
  submitted = [{ pluginId: "due", source: dueSource }];
  await e.command({
    type: "continue",
    operationId: "continue-due",
    runId: first.ready.id,
    baseVersion: ctx.w.composition().versionId,
    text: "只升级截止日期插件",
  });
  const dueReady = await settle(e, "ready");
  assert.equal(dueReady.status, "ready", JSON.stringify(dueReady));
  if (dueReady.status !== "ready") throw new Error("expected ready");
  assert.ok(
    dueReady.plan.memberCases?.some((c) => c.name === "标签去空格转小写"),
    JSON.stringify(dueReady.plan.memberCases),
  );
  await e.command({
    type: "start",
    operationId: "start-due",
    runId: dueReady.id,
    planId: dueReady.plan.id,
  });
  const dueDone = await settle(e, "awaiting-apply");
  assert.equal(dueDone.status, "awaiting-apply");
  const dueCandidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(dueCandidate?.versionId);
  const dueEvidence = ctx.w.release.get(dueCandidate!.versionId!).evidence as {
    checks?: string[];
    memberCases?: { name: string }[];
  };
  assert.ok(
    dueEvidence.checks?.includes("workspace:member:tags:标签去空格转小写"),
    dueEvidence.checks?.join("\n"),
  );
  assert.ok(dueEvidence.memberCases?.some((c) => c.name === "标签去空格转小写"));

  await e.command({
    type: "apply",
    operationId: "apply-due",
    runId: dueReady.id,
    candidateId: dueCandidate!.id,
    evidenceHash: dueCandidate!.evidenceHash!,
    compositionRevision: ctx.w.composition().revision,
  });
  assert.equal((await settle(e, "succeeded")).status, "succeeded");

  planning.finish = {
    summary: "再次升级 tags",
    changes: ["升级 tags 辅助成员"],
    outcome: "标签成员更新",
    dataImpact: "保留 due 与主工作流精确版本；升级 tags",
    memberUpgrades: [{ pluginId: "tags" }],
    workflowRules: [],
  };
  submitted = [{ pluginId: "tags", source: asIs }];
  await e.command({
    type: "continue",
    operationId: "continue-as-is",
    runId: dueReady.id,
    baseVersion: ctx.w.composition().versionId,
    text: "再改标签实现",
  });
  const asIsReady = await settle(e, "ready");
  assert.equal(asIsReady.status, "ready");
  if (asIsReady.status !== "ready") throw new Error("expected ready");
  assert.ok(
    asIsReady.plan.memberCases?.some((c) => c.name === "标签去空格转小写"),
  );
  await e.command({
    type: "start",
    operationId: "start-as-is-again",
    runId: asIsReady.id,
    planId: asIsReady.plan.id,
  });
  const asIsFinished = await settle(e);
  assert.notEqual(asIsFinished.status, "awaiting-apply");
  const failed = (await e.observe()).candidates?.find((c) => c.diagnostic);
  assert.match(
    failed?.diagnostic ?? "",
    /workspace:member:tags:标签去空格转小写|hello/,
  );
  assert.equal(
    ctx.w.query().tasks.find((task) => task.id === ctx.taskId)?.fields.tags,
    "inherit-me",
  );
});

test("已发布未规范化标签可被 repair 的 reproduce 用同源冻结案例发现，新候选走同一检查器", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const membersBefore = memberSnapshot(ctx.before);
  const planning = new PlanningDriver({ ...freezeTagsPlan, intent: "repair" });
  const e = new Evolution(
    ctx.w.db,
    pinnedMemberDriver(
      planning,
      () => ctx.w.activeVersion().source,
      () => [{ pluginId: "tags", source: normalizedTagsSource }],
    ),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "修复标签未去空格转小写",
    operationId: "repair-tags",
    intent: "repair",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  if (ready.status !== "ready") throw new Error("expected ready");
  assert.equal(ready.plan.repairEvidence?.baseVersion, ctx.before.versionId);
  assert.match(
    ready.plan.repairEvidence?.diagnostic ?? "",
    /workspace:member:tags:标签去空格转小写|hello/,
  );
  await e.command({
    type: "start",
    operationId: "start-repair-tags",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.equal(done.status, "awaiting-apply", JSON.stringify(done));
  const candidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(candidate?.versionId);
  const evidence = ctx.w.release.get(candidate!.versionId!).evidence as {
    checks?: string[];
    verifier?: string;
    repairEvidence?: unknown;
    definitionHash?: string;
  };
  assert.equal(evidence.verifier, "workspace/1");
  assert.equal(
    evidence.definitionHash,
    ready.plan.repairEvidence!.definitionHash,
  );
  assert.ok(
    evidence.checks?.includes("workspace:member:tags:标签去空格转小写"),
    evidence.checks?.join("\n"),
  );
  assert.deepEqual(evidence.repairEvidence, ready.plan.repairEvidence);
  assert.equal(ctx.w.composition().versionId, ctx.before.versionId);
  assert.deepEqual(memberSnapshot(ctx.w.composition()), membersBefore);
  assert.equal(
    ctx.w.query().tasks.find((task) => task.id === ctx.taskId)?.fields.tags,
    "inherit-me",
  );
});

test("停用后升级错误实现仍被冻结案例拦住；规范化升级并可再启用", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const asIs = await asIsTagsSource();
  const planning = new PlanningDriver(freezeTagsPlan);
  let submitted = [{ pluginId: "tags", source: normalizedTagsSource }];
  const e = new Evolution(
    ctx.w.db,
    pinnedMemberDriver(
      planning,
      () => ctx.w.activeVersion().source,
      () => submitted,
    ),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "标签保存去空格并转小写",
    operationId: "freeze-before-disable",
  });
  const freezeReady = await settle(e, "ready");
  assert.equal(freezeReady.status, "ready");
  if (freezeReady.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-freeze-before-disable",
    runId: freezeReady.id,
    planId: freezeReady.plan.id,
  });
  const freezeDone = await settle(e, "awaiting-apply");
  assert.equal(freezeDone.status, "awaiting-apply");
  const freezeCandidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(freezeCandidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: "apply-freeze-before-disable",
    runId: freezeReady.id,
    candidateId: freezeCandidate!.id,
    evidenceHash: freezeCandidate!.evidenceHash!,
    compositionRevision: ctx.w.composition().revision,
  });
  assert.equal((await settle(e, "succeeded")).status, "succeeded");
  const tagsAfterFreeze = ctx.w
    .composition()
    .members.find((m) => m.pluginId === "tags")!.versionId;

  await ctx.w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: ctx.w.composition().revision,
    versionId: ctx.w.composition().versionId,
    pluginId: "tags",
    enabled: false,
  });
  const disabled = ctx.w.composition();
  assert.equal(
    disabled.members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );

  planning.finish = {
    summary: "升级已停用的标签插件",
    changes: ["升级 tags 辅助成员"],
    outcome: "标签成员更新",
    dataImpact: "保留 due 与主工作流精确版本；升级 tags",
    memberUpgrades: [{ pluginId: "tags" }],
    workflowRules: [],
  };
  submitted = [{ pluginId: "tags", source: asIs }];
  await e.command({
    type: "request",
    text: "升级已停用的标签为原样保存",
    operationId: "request-disabled-as-is",
  });
  const asIsReady = await settle(e, "ready");
  assert.equal(asIsReady.status, "ready", JSON.stringify(asIsReady));
  if (asIsReady.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-disabled-as-is",
    runId: asIsReady.id,
    planId: asIsReady.plan.id,
  });
  const asIsFinished = await settle(e);
  assert.notEqual(asIsFinished.status, "awaiting-apply");
  assert.match(
    (await e.observe()).candidates?.find((c) => c.diagnostic)?.diagnostic ?? "",
    /workspace:member:tags:标签去空格转小写|hello/,
  );
  assert.equal(ctx.w.composition().versionId, disabled.versionId);
  assert.equal(
    ctx.w.composition().members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );
  assert.equal(
    ctx.w.composition().members.find((m) => m.pluginId === "tags")?.versionId,
    tagsAfterFreeze,
  );

  planning.finish = {
    summary: "升级已停用的标签为规范化",
    changes: ["升级 tags 辅助成员"],
    outcome: "标签保存去空格并转小写",
    dataImpact: "保留 due 与主工作流精确版本；升级 tags",
    memberUpgrades: [{ pluginId: "tags" }],
    workflowRules: [],
  };
  submitted = [{ pluginId: "tags", source: normalizedTagsSource }];
  await e.command({
    type: "request",
    text: "升级已停用的标签为规范化",
    operationId: "request-disabled-normalized",
  });
  const okReady = await settle(e, "ready");
  assert.equal(okReady.status, "ready", JSON.stringify(okReady));
  if (okReady.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-disabled-normalized",
    runId: okReady.id,
    planId: okReady.plan.id,
  });
  const okDone = await settle(e, "awaiting-apply");
  assert.equal(okDone.status, "awaiting-apply");
  const okCandidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(okCandidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: "apply-disabled-normalized",
    runId: okReady.id,
    candidateId: okCandidate!.id,
    evidenceHash: okCandidate!.evidenceHash!,
    compositionRevision: ctx.w.composition().revision,
  });
  assert.equal((await settle(e, "succeeded")).status, "succeeded");
  assert.equal(
    ctx.w.composition().members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );
  await ctx.w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: ctx.w.composition().revision,
    versionId: ctx.w.composition().versionId,
    pluginId: "tags",
    enabled: true,
  });
  const retagged = await ctx.w.command({
    type: "action",
    taskId: ctx.taskId,
    actionId: "setTags",
    expectedRevision: ctx.w.read(ctx.taskId).revision,
    input: { tags: "  Hello " },
    operationId: randomUUID(),
    compositionRevision: ctx.w.composition().revision,
  });
  assert.equal(retagged.task?.fields.tags, "hello");
});

test("改已有成员案例须 acceptanceReason 并经 confirm-acceptance", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const planning = new PlanningDriver(freezeTagsPlan);
  const e = new Evolution(
    ctx.w.db,
    pinnedMemberDriver(
      planning,
      () => ctx.w.activeVersion().source,
      () => [{ pluginId: "tags", source: normalizedTagsSource }],
    ),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "标签保存去空格并转小写",
    operationId: "freeze-for-revise",
  });
  const freezeReady = await settle(e, "ready");
  assert.equal(freezeReady.status, "ready");
  if (freezeReady.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-freeze-for-revise",
    runId: freezeReady.id,
    planId: freezeReady.plan.id,
  });
  const freezeDone = await settle(e, "awaiting-apply");
  const freezeCandidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(freezeCandidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: "apply-freeze-for-revise",
    runId: freezeReady.id,
    candidateId: freezeCandidate!.id,
    evidenceHash: freezeCandidate!.evidenceHash!,
    compositionRevision: ctx.w.composition().revision,
  });
  assert.equal((await settle(e, "succeeded")).status, "succeeded");

  const revisedCases = [
    {
      ...tagsMemberCases[0],
      expected: {
        kind: "commit" as const,
        state: "open",
        fields: { tags: "world" },
      },
    },
    tagsMemberCases[1],
  ];
  planning.finish = {
    summary: "收紧标签验收期望",
    changes: ["修订标签冻结案例"],
    outcome: "标签案例期望改为 world",
    dataImpact: "保留成员精确版本；修订冻结验收",
    memberUpgrades: [{ pluginId: "tags" }],
    memberCases: revisedCases,
    workflowRules: [],
  };
  await e.command({
    type: "continue",
    operationId: "continue-revise-no-reason",
    runId: freezeReady.id,
    baseVersion: ctx.w.composition().versionId,
    text: "把标签正例期望改为 world",
  });
  const blocked = await settle(e);
  assert.notEqual(blocked.status, "ready");
  assert.notEqual(blocked.status, "awaiting-acceptance");

  planning.finish = {
    ...planning.finish,
    acceptanceReason: "用户要求正例期望改为 world",
  };
  await e.command({
    type: "continue",
    operationId: "continue-revise-with-reason",
    runId: freezeReady.id,
    baseVersion: ctx.w.composition().versionId,
    text: "把标签正例期望改为 world 并说明原因",
  });
  const pending = await settle(e, "awaiting-acceptance");
  assert.equal(pending.status, "awaiting-acceptance", JSON.stringify(pending));
  if (pending.status !== "awaiting-acceptance")
    throw new Error("expected awaiting-acceptance");
  assert.ok(pending.plan.acceptanceChanges?.some((c) => c.rule === "标签去空格转小写"));
  await assert.rejects(
    e.command({
      type: "start",
      operationId: "premature-start-revise",
      runId: pending.id,
      planId: pending.plan.id,
    }),
    (error: unknown) =>
      error instanceof Error &&
      (/确认|验收|锁定|不能|尚未/.test(error.message) ||
        ("status" in error && (error as { status?: number }).status === 409)),
  );
  const confirm = await e.command({
    type: "confirm-acceptance",
    operationId: "confirm-member-case",
    runId: pending.id,
    planId: pending.plan.id,
    revisionId: pending.acceptanceRevision!.id,
  });
  assert.equal(confirm.run?.status, "ready");
});

test("新增辅助成员可冻结正反例；错误实现验证失败", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const panelSource = await panelPluginCode();
  const brokenPanel = `export default {
  contribute() {
    return {
      fields: [{ key: "noteMark", label: "备注标记", type: "text" }],
      commands: [{ id: "markNote", label: "打备注标记", from: ["open"] }],
    };
  },
  decide(data) {
    const { task, action } = data;
    if (action === "markNote")
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, noteMark: "wrong" },
      };
    return { kind: "reject", message: "未知动作" };
  },
};`;
  const panelCases = [
    {
      name: "打备注标记成功",
      member: "panel",
      state: "open",
      fields: {},
      action: "markNote",
      input: {},
      expected: {
        kind: "commit" as const,
        state: "open",
        fields: { noteMark: "ok" },
      },
    },
    {
      name: "已完成不可打备注",
      member: "panel",
      state: "done",
      fields: {},
      action: "markNote",
      input: {},
      expected: { kind: "reject" as const },
    },
  ];
  const planning = new PlanningDriver({
    summary: "叠加备注面板并冻结验收",
    changes: ["新增 panel 辅助成员", "冻结 markNote 正反例"],
    outcome: "可打备注标记，已完成任务拒绝",
    dataImpact: "保留既有成员精确版本；新增 panel",
    memberAdditions: [{ pluginId: "panel", name: "备注面板插件" }],
    memberCases: panelCases,
  });
  let submitted = [{ pluginId: "panel", source: brokenPanel }];
  const e = new Evolution(
    ctx.w.db,
    typedWorkflowMemberDriver(planning, () => submitted),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "增加备注面板并冻结验收",
    operationId: "plan-add-panel-cases",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-add-panel-broken",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const failed = await settle(e);
  assert.notEqual(failed.status, "awaiting-apply");
  assert.match(
    (await e.observe()).candidates?.find((c) => c.diagnostic)?.diagnostic ?? "",
    /workspace:member:panel:打备注标记成功|noteMark|wrong|ok/,
  );
  assert.equal(ctx.w.composition().versionId, ctx.before.versionId);

  submitted = [{ pluginId: "panel", source: panelSource }];
  await e.command({
    type: "request",
    text: "提交正确的备注面板",
    operationId: "request-add-panel-ok",
  });
  const okReady = await settle(e, "ready");
  assert.equal(okReady.status, "ready", JSON.stringify(okReady));
  if (okReady.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-add-panel-ok",
    runId: okReady.id,
    planId: okReady.plan.id,
  });
  const okDone = await settle(e, "awaiting-apply");
  assert.equal(okDone.status, "awaiting-apply");
  const candidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(candidate?.versionId);
  const evidence = ctx.w.release.get(candidate!.versionId!).evidence as {
    checks?: string[];
  };
  assert.ok(
    evidence.checks?.includes("workspace:member:panel:打备注标记成功"),
    evidence.checks?.join("\n"),
  );
  assert.ok(
    evidence.checks?.includes("workspace:member:panel:已完成不可打备注"),
  );
});

test("parseMemberCases 要求每个成员动作有正例和反例", () => {
  assert.throws(
    () =>
      parseMemberCases(
        [
          {
            name: "仅正例",
            member: "tags",
            state: "open",
            fields: {},
            action: "setTags",
            input: { tags: "a" },
            expected: {
              kind: "commit",
              state: "open",
              fields: { tags: "a" },
            },
          },
        ],
        undefined,
        new Set(["tags"]),
        { open: {}, done: {} },
      ),
    /每个成员动作必须有正例和反例/,
  );
});

const unauthorizedTagsSource = `import fs from 'node:fs';
export default {
  contribute() {
    return {
      fields: [{ key: "tags", label: "标签", type: "text" }],
      commands: [{ id: "setTags", label: "设标签", from: ["open", "done"] }],
    };
  },
  decide(data) {
    fs.writeFileSync('/tmp/x', 'leak');
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

test("辅助成员提交未授权依赖时正式候选路径拒绝且正式组合不变", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const membersBefore = memberSnapshot(ctx.before);
  const workflowSource = ctx.w.activeVersion().source;
  const planning = new PlanningDriver(freezeTagsPlan);
  const e = new Evolution(
    ctx.w.db,
    pinnedMemberDriver(
      planning,
      () => workflowSource,
      () => [{ pluginId: "tags", source: unauthorizedTagsSource }],
    ),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "标签保存去空格并转小写，空白拒绝",
    operationId: "plan-unauthorized-tags",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-unauthorized-tags",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const finished = await settle(e);
  assert.notEqual(finished.status, "awaiting-apply");
  assert.notEqual(finished.status, "succeeded");
  const snapshot = await e.observe();
  assert.ok(
    snapshot.candidates?.some((c) => c.passed === false),
    snapshot.candidates?.map((c) => c.diagnostic).join("\n"),
  );
  assert.match(
    snapshot.candidates?.find((c) => c.diagnostic)?.diagnostic ??
      finished.message ??
      "",
    /未授权|依赖|运行能力|node:fs/,
  );
  assert.equal(ctx.w.composition().versionId, ctx.before.versionId);
  assert.deepEqual(memberSnapshot(ctx.w.composition()), membersBefore);
});

test("通过验证的辅助成员记版含可信 bundle，不以提交字符串作原生执行产物", async (t) => {
  const ctx = await dualWithTaggedTask(t);
  const workflowSource = ctx.w.activeVersion().source;
  const planning = new PlanningDriver(freezeTagsPlan);
  const e = new Evolution(
    ctx.w.db,
    pinnedMemberDriver(
      planning,
      () => workflowSource,
      () => [{ pluginId: "tags", source: normalizedTagsSource }],
    ),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "标签保存去空格并转小写，空白拒绝",
    operationId: "plan-trusted-bundle",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-trusted-bundle",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.equal(done.status, "awaiting-apply");
  const candidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(candidate?.versionId);
  const composition = ctx.w.release.get(candidate!.versionId!);
  const tagsMember = composition.members?.find((m) => m.pluginId === "tags");
  assert.ok(tagsMember?.versionId);
  const tagsVersion = ctx.w.release.get(tagsMember!.versionId!);
  assert.ok(tagsVersion.bundle?.outputs["business/entry.js"]);
  assert.equal(
    tagsVersion.code,
    tagsVersion.bundle!.outputs["business/entry.js"],
    "execution code must be trusted build output",
  );
  assert.equal(tagsVersion.bundle?.builder, "member-strip/1");
  assert.equal(tagsVersion.source, normalizedTagsSource);
  assert.equal(
    (tagsVersion.evidence as { generated?: boolean }).generated,
    true,
  );
});

test("旧 evolution 辅成员无 bundle 时激活可合成并回写，命令仍可用", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-legacy-member-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  const { due } = await activateDual(w);
  const legacySource = await asIsTagsSource();
  const legacy = w.release.record({
    pluginId: "tags",
    name: "标签插件",
    service: "plugin:tags",
    contractVersion: "extensions/1",
    source: legacySource,
    code: legacySource,
    definition: { id: "tags" },
    evidence: {
      passed: true,
      origin: "evolution-member-upgrade",
    },
  });
  assert.equal(legacy.bundle, undefined);
  const composition = w.release.record({
    pluginId: "aux-workflow",
    name: "双贡献组合",
    service: "workflow",
    contractVersion: "workflow/1",
    source: w.activeVersion().source,
    code: w.activeVersion().code,
    definition: w.activeVersion().definition,
    evidence: { passed: true, origin: "test" },
    members: [
      { pluginId: "aux-workflow", enabled: true, role: "workflow" },
      {
        pluginId: "tags",
        versionId: legacy.id,
        enabled: true,
        role: "auxiliary",
      },
      {
        pluginId: "due",
        versionId: due.id,
        enabled: true,
        role: "auxiliary",
      },
    ],
  });
  await w.activate(
    {
      versionId: composition.id,
      compositionRevision: w.composition().revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const created = await w.command({
    type: "create",
    title: "legacy-tags",
    compositionRevision: w.composition().revision,
    operationId: randomUUID(),
  });
  const tagged = await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setTags",
    expectedRevision: created.task!.revision,
    input: { tags: "  Keep  " },
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
  });
  assert.equal(tagged.task?.fields.tags, "  Keep  ");
  const persisted = w.release.get(legacy.id);
  assert.ok(
    persisted.bundle?.outputs["business/entry.js"],
    "legacy synthesize must attachBundle",
  );
});

test("Seam B: generated 成员禁止无 modules 的原生 import", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-seam-b-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  await activateDual(w);
  const entry = w.activeVersion().entry;
  const { Runtime } = await import("../../src/runtime/runtime.js");
  await assert.rejects(
    Runtime.start({
      entry,
      service: "workflow",
      pluginId: "aux-workflow",
      plugins: [
        {
          pluginId: "tags",
          entry,
          service: "plugin:tags",
          role: "auxiliary",
          allowNativeImport: false,
        },
      ],
    }),
    /可信构建产物|原生模块加载/,
  );
});

