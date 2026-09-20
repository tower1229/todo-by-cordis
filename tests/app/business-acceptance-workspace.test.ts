import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { AppError } from "../../src/shared/contracts.js";
import { PlanningDriver } from "./planning-fixture.js";
import { ExecutionDriver } from "./execution-fixture.js";
import { evolutionWithExperience } from "./evolution-session-fixture.js";
import { activateDual } from "./dual-composition-fixture.js";
import { candidateScope, source } from "./evolution-fixture.js";
import { toolReply } from "./planning-fixture.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";

const positiveIntegerExtensions = {
  actions: [{ id: "setEstimate", label: "估时", from: ["open"] }],
  fields: [{ key: "estimateMinutes", label: "预估分钟", type: "text" }],
  cases: [
    {
      name: "正整数字符串",
      state: "open",
      fields: {},
      action: "setEstimate",
      input: { estimateMinutes: "15" },
      expected: {
        kind: "commit" as const,
        state: "open",
        fields: { estimateMinutes: "15" },
      },
    },
    {
      name: "非正整拒绝",
      state: "open",
      fields: {},
      action: "setEstimate",
      input: { estimateMinutes: "abc" },
      expected: { kind: "reject" as const },
    },
  ],
};

function estimateCandidateFiles(mode: "strict" | "loose") {
  const code = source("default", "轻快完成", 1).replace(
    "export default",
    "const base =",
  );
  const validate =
    mode === "strict"
      ? "if(!/^[1-9]\\d*$/.test(raw))return{kind:'reject',message:'须为正整数字符串'};"
      : "if(!raw)return{kind:'reject',message:'empty'};";
  const entry = `${code}\nexport default { describe() { const d = base.describe(); return {...d, actions:[...d.actions,{id:'setEstimate',label:'估时',from:['open']}], fields:[...d.fields,{key:'estimateMinutes',label:'预估分钟',type:'text'}]}; }, decide(data: Parameters<typeof base.decide>[0]) { if(data.action!=='setEstimate') return base.decide(data); const raw=String(data.input?.estimateMinutes??''); ${validate} return {kind:'commit',state:data.task.state,fields:{...data.task.fields,estimateMinutes:raw}}; } };`;
  return [
    { path: "business/entry.ts", content: entry },
    {
      path: "business/view.ts",
      content:
        'export default { title: "复盘与估时", fields: ["reflection", "estimateMinutes"] };',
    },
    { path: "business/config.json", content: "{}" },
    {
      path: "business/compatibility.json",
      content: '{"preserveUnknownFields":true}',
    },
  ];
}

function estimateDriver(
  planning: PlanningDriver,
  mode: "strict" | "loose",
): Driver {
  const fallback = new ExecutionDriver(planning);
  return {
    async generate(request: ModelRequest, signal) {
      const reply = await fallback.generate(request, signal);
      if (reply.calls[0]?.name !== "submit_candidate") return reply;
      return {
        ...reply,
        calls: [
          {
            name: "submit_candidate",
            args: { files: estimateCandidateFiles(mode) },
          },
        ],
      };
    },
  };
}

// Seams: Evolution public control plane → Workspace composition / command / query.
// Trusted business acceptance must exercise isolated Workspace command→beforeCommit→query,
// not only Runtime decide return values.

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
  const directory = await mkdtemp(join(tmpdir(), "cordis-accept-"));
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

/** Candidate whose decide is correct but beforeCommit corrupts the final fields. */
function corruptBeforeCommitSource(pluginId: string, name: string) {
  return source(pluginId, name).replace(
    "}; export default plugin;",
    `};
plugin.contribute = () => ({ beforeCommit: true });
plugin.beforeCommit = (data) => ({
  kind: "ok",
  fields: { ...data.decision.fields, reflection: "CORRUPTED" },
});
export default plugin;`,
  );
}

async function realAwaitingApply(t: TestContext) {
  const ctx = await dualWithTaggedTask(t);
  const { evolution: e, sessions } = evolutionWithExperience(
    ctx.w,
    new ExecutionDriver(new PlanningDriver(), "aux-workflow", "双贡献组合"),
  );
  t.after(async () => {
    await e.close();
    await sessions.close();
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
  assert.ok(
    candidate,
    "must produce a passed candidate via workspace acceptance",
  );
  assert.ok(candidate.evidenceHash);
  assert.ok(done.versionId);
  return { ...ctx, e, ready, done, candidate };
}

test("decide 正确但 beforeCommit 破坏最终字段时，候选验证失败且正式组合与任务不变", async (t) => {
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
          source: corruptBeforeCommitSource("aux-workflow", "双贡献组合"),
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
    operationId: "start-beforecommit",
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
    /CORRUPTED|业务验收失败|workspace:complete-final-fields/,
  );
  const failedVersion = snapshot.candidates?.find(
    (c) => !c.passed && c.versionId,
  )?.versionId;
  assert.ok(failedVersion);
  const failedEvidence = ctx.w.release.get(failedVersion).evidence as {
    workspaceCases?: {
      status: string;
      actual: { fields?: Record<string, string> };
      diagnostic: string;
    }[];
  };
  assert.ok(
    failedEvidence.workspaceCases?.some(
      (c) =>
        c.status === "failed" &&
        c.actual.fields?.reflection === "CORRUPTED" &&
        c.diagnostic.includes("业务验收失败"),
    ),
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

test("完整组合继承候选的隔离 Workspace 验收绑定整组合，体验仍未应用且需显式应用确认", async (t) => {
  const { w, before, tags, due, taskId, e, done, candidate } =
    await realAwaitingApply(t);
  const version = w.release.get(done.versionId!);
  const evidence = version.evidence as {
    checks?: string[];
    members?: Array<{ pluginId: string; versionId?: string; enabled: boolean }>;
    verifier?: string;
  };
  const receipts = (
    version.evidence as {
      workspaceCases?: {
        name: string;
        member: string;
        memberVersionId: string;
        input: Record<string, string>;
        expected: unknown;
        actual: unknown;
        diagnostic: string;
        status: string;
      }[];
    }
  ).workspaceCases;
  assert.ok(receipts?.length);
  assert.ok(
    receipts.every(
      (c) =>
        c.status === "passed" &&
        c.member &&
        c.memberVersionId &&
        c.input &&
        c.expected &&
        c.actual &&
        c.diagnostic,
    ),
  );
  assert.equal(evidence.verifier, "workspace/1");
  assert.ok(evidence.checks?.includes("workspace:complete-final-fields"));
  assert.ok(evidence.checks?.includes("workspace:reflection:missing-input"));
  assert.ok(
    evidence.checks?.some(
      (check) =>
        check.startsWith("workspace:composition:") &&
        check.includes("tags") &&
        check.includes("due") &&
        check.includes("aux-workflow"),
    ),
    evidence.checks?.join("\n"),
  );
  assert.ok(evidence.members?.some((m) => m.pluginId === "tags"));
  assert.ok(evidence.members?.some((m) => m.pluginId === "due"));
  assert.deepEqual(
    version.members
      ?.filter((m) => m.pluginId === "tags" || m.pluginId === "due")
      .map((m) => ({
        pluginId: m.pluginId,
        versionId: m.versionId,
        enabled: m.enabled,
        role: m.role,
      }))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
    [
      {
        pluginId: "due",
        versionId: due.id,
        enabled: true,
        role: "auxiliary",
      },
      {
        pluginId: "tags",
        versionId: tags.id,
        enabled: true,
        role: "auxiliary",
      },
    ],
  );

  const experience = await e.command({
    type: "experience",
    operationId: "experience-workspace",
    runId: done.id,
    candidateId: candidate.id,
  });
  assert.equal(experience.run?.status, "awaiting-apply");
  if (experience.run?.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  assert.equal(experience.run.experienceSession?.candidateId, candidate.id);
  assert.equal(experience.run.experienceSession?.status, "active");
  assert.match(experience.run.experienceSession?.note ?? "", /隔离库|尚未应用/);
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(
    w.query().tasks.find((task) => task.id === taskId)?.fields.tags,
    "inherit-me",
  );

  await e.command({
    type: "apply",
    operationId: "apply-workspace",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  const succeeded = await settle(e, "succeeded");
  assert.equal(succeeded.status, "succeeded");
  assert.equal(w.composition().versionId, done.versionId);
  assert.equal(
    w.query().tasks.find((task) => task.id === taskId)?.fields.tags,
    "inherit-me",
  );
});

for (const caseName of ["正整数字符串", "长".repeat(180)]) {
  test(`冻结严格输入及保护证据：${caseName.length} 字案例名`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "cordis-pos-int-"));
    const w = await Workspace.open(join(directory, "workspace.db"));
    t.after(async () => {
      await w.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    });
    const extensions = structuredClone(positiveIntegerExtensions);
    extensions.cases[0]!.name = caseName;
    const original = structuredClone(extensions);
    const planning = new PlanningDriver({
      writableScope: [...candidateScope],
      extensions,
    });
    const e = new Evolution(
      w.db,
      estimateDriver(planning, "strict"),
      new EvolutionDomain(w),
    );
    t.after(async () => {
      await e.close();
    });
    await e.command({
      type: "request",
      text: "未完成任务可填写正整数字符串预估分钟",
      operationId: "plan-estimate-int",
    });
    const ready = await settle(e, "ready");
    assert.equal(ready.status, "ready", JSON.stringify(ready));
    if (ready.status !== "ready") throw new Error("expected ready");
    await e.command({
      type: "start",
      operationId: "start-estimate-int",
      runId: ready.id,
      planId: ready.plan.id,
    });
    const done = await settle(e, "awaiting-apply");
    assert.equal(done.status, "awaiting-apply", JSON.stringify(done));
    const evidence = w.release.get(done.versionId!).evidence as {
      checks?: string[];
      workspaceCases: import("../../src/server/workspace-acceptance.js").WorkspaceCaseEvidence[];
    };
    assert.ok(
      evidence.checks?.includes(`workspace:${caseName}`),
      evidence.checks?.join("\n"),
    );
    assert.ok(evidence.checks?.includes("workspace:非正整拒绝"));
    assert.ok(
      evidence.checks?.filter((check) => check === `workspace:${caseName}`)
        .length === 1,
    );
    assert.ok(
      evidence.checks?.filter((check) => check === "workspace:非正整拒绝")
        .length === 1,
    );
    const business = evidence.workspaceCases.find(
      (c) => c.name === `workspace:${caseName}`,
    );
    assert.ok(business);
    assert.equal(business.kind, "frozen-business");
    assert.deepEqual(business.initial.fields, {});
    assert.deepEqual(business.input, { estimateMinutes: "15" });
    const protection = evidence.workspaceCases.find(
      (c) => c.protectionOf === `workspace:${caseName}`,
    );
    assert.ok(protection);
    assert.equal(protection.kind, "system-protection");
    assert.deepEqual(protection.input, business.input);
    assert.equal(protection.initial.fields.host_retained, "preserve");
    assert.equal(protection.actual.fields?.host_retained, "preserve");
    assert.deepEqual(extensions, original);
  });
}

test("非正整仍被写入的实现无法靠 decide 层蒙混，隔离 Workspace 冻结案例拒绝", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-pos-int-bad-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  const before = w.composition();
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  const planning = new PlanningDriver({
    writableScope: [...candidateScope],
    extensions: positiveIntegerExtensions,
  });
  const e = new Evolution(
    w.db,
    estimateDriver(planning, "loose"),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "未完成任务可填写正整数字符串预估分钟",
    operationId: "plan-estimate-loose",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-estimate-loose",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const finished = await settle(e);
  assert.notEqual(finished.status, "awaiting-apply");
  const diagnostic =
    (await e.observe()).candidates?.find((c) => c.diagnostic)?.diagnostic ?? "";
  assert.match(diagnostic, /非正整拒绝|abc|业务验收失败/);
  assert.equal(w.composition().versionId, before.versionId);
});

test("正式 Workspace 拒绝 activateForAcceptance 与 seedAcceptanceTask", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-accept-gate-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  const versionId = w.composition().versionId;
  await assert.rejects(
    () => w.activateForAcceptance(versionId),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
  const created = await w.command({
    type: "create",
    title: "gate",
    compositionRevision: w.composition().revision,
    operationId: randomUUID(),
  });
  assert.throws(
    () =>
      w.seedAcceptanceTask(
        created.task!.id,
        "done",
        {},
        created.task!.revision + 1,
      ),
    (error: unknown) => error instanceof AppError && error.code === "FORBIDDEN",
  );
});
