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
import { hash } from "../../src/release/storage.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";
import { activateDual } from "./dual-composition-fixture.js";
import { memberEnabledDataImpact } from "../../src/release/composition.js";

// Seams: Evolution experience/apply + observe; Workspace composition/query/command/read.
// Enable-status candidates share recordMemberEnabledVersion with Workspace public path.

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

function memberEnabledPlan(
  baseVersion: string,
  compositionRevision: number,
): InvestigatedPlan {
  return {
    id: "plan-member-enabled",
    compositionRevision,
    route: { kind: "application" },
    summary: "停用标签插件",
    changes: ["将 tags 成员 enabled 设为 false"],
    outcome: "停用 tags",
    dataImpact: memberEnabledDataImpact,
    baseVersion,
    requestRevision: 1,
    workflowRules: [],
    ruleChanges: [],
    excluded: ["发布事务", "验证器", "恢复入口", "执行策略"],
    evidence: [],
    capabilityChanges: [],
    cases: [
      {
        given: "tags 已启用且任务含 tags 字段",
        when: "应用停用候选",
        then: "贡献退出且字段值保留",
        checker: "host",
      },
    ],
    steps: [
      {
        id: "flip",
        purpose: "记录启用状态变更候选",
        dependsOn: [],
        artifact: "composition-members",
        evidence: "host",
      },
    ],
    writableScope: [],
    compatibility: "保留停用插件字段值",
    rollback: "可撤回上一组合版本",
    preview: "体验摘要标注尚未应用到正式环境",
    application: "精确绑定候选与组合修订后激活",
    restartImpact: "启用状态经发布事务持久化",
    dependencies: [],
    unresolved: [],
  };
}

/** Fixture: dual composition + enable-status candidate already in awaiting-apply. */
async function awaitingMemberEnabledApply(
  t: TestContext,
  pluginId = "tags",
  enabled = false,
) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-member-evo-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  await activateDual(w);
  const before = w.composition();
  const candidateVersion = w.recordMemberEnabledVersion(pluginId, enabled);
  const plan = memberEnabledPlan(before.versionId, before.revision);
  const candidateId = "cand-member-enabled";
  const evidenceHash = hash({
    candidateId,
    versionId: candidateVersion.id,
    cases: plan.cases,
    rules: plan.workflowRules,
  });
  const runId = "run-member-enabled";
  // Bootstrap evolution tables, then seed awaiting-apply (fixtures OK; no Gemini).
  const bootstrap = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  await bootstrap.close();
  w.db
    .prepare(
      "INSERT INTO evolution_runs(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    )
    .run(
      runId,
      JSON.stringify({
        run: {
          id: runId,
          request: "停用标签插件",
          updatedAt: new Date().toISOString(),
          status: "awaiting-apply",
          plan,
          steps: [],
          summary: `${plan.outcome}（候选已验证，尚未应用）`,
          versionId: candidateVersion.id,
        },
        target: {
          kind: "plugin",
          baseVersion: before.versionId,
          payload: { kind: "member-enabled", pluginId, enabled },
        },
        plan,
        versionId: candidateVersion.id,
        history: [],
        calls: 1,
        candidates: 1,
        elapsed: 10,
        eventSequence: 0,
      }),
    );
  w.db
    .prepare("INSERT INTO evolution_candidates(runId,body) VALUES(?,?)")
    .run(
      runId,
      JSON.stringify({
        id: candidateId,
        planId: plan.id,
        baseVersion: before.versionId,
        attempt: 1,
        passed: true,
        evidenceHash,
        versionId: candidateVersion.id,
        sourceHash: hash({ pluginId, enabled }),
      }),
    );
  const e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  const snapshot = await e.observe(runId);
  assert.equal(snapshot.run?.status, "awaiting-apply");
  const candidate = snapshot.candidates?.find((c) => c.id === candidateId);
  assert.ok(candidate?.evidenceHash);
  assert.ok(candidate.versionId);
  return {
    w,
    e,
    before,
    plan,
    runId,
    candidate: candidate!,
    candidateVersion,
    pluginId,
    enabled,
  };
}

test("enable-status change enters awaiting-apply; experience summarizes and marks not applied", async (t) => {
  const { w, e, before, runId, candidate, pluginId } =
    await awaitingMemberEnabledApply(t);
  await w.command({
    type: "create",
    title: "formal-before-experience",
    compositionRevision: before.revision,
    operationId: randomUUID(),
  });
  assert.equal(w.query().total, 1);

  const experience = {
    type: "experience" as const,
    operationId: "experience-member-1",
    runId,
    candidateId: candidate.id,
  };
  const first = await e.command(experience);
  assert.equal(first.run?.status, "awaiting-apply");
  if (first.run?.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  assert.ok(first.run.experience);
  assert.equal(first.run.experience.candidateId, candidate.id);
  assert.equal(first.run.experience.marked, "not-applied");
  assert.equal(first.run.experience.isolated, true);
  assert.equal(first.run.experience.simulated, true);
  assert.match(first.run.experience.note, /尚未应用|正式环境/);
  assert.ok(
    first.run.experience.checks.some((c) =>
      c.includes(`member.enabled:${pluginId}`),
    ),
  );
  assert.ok(
    first.run.experience.checks.some((c) => /retained\.fields:policy|contribution/i.test(c)),
  );
  assert.match(first.run.experience.note, /未读写正式任务/);
  assert.match(first.run.experience.note, /停用不删除任务字段值/);
  assert.deepEqual(await e.command(experience), first);

  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.composition().revision, before.revision);
  assert.equal(w.query().total, 1);
  assert.equal(
    w.composition().members.find((m) => m.pluginId === pluginId)?.enabled,
    true,
  );
});

test("apply binds candidate evidence and compositionRevision; mismatch leaves formal composition unchanged", async (t) => {
  const { w, e, before, runId, candidate } = await awaitingMemberEnabledApply(t);

  await assert.rejects(
    e.command({
      type: "apply",
      operationId: "apply-member-wrong-hash",
      runId,
      candidateId: candidate.id,
      evidenceHash: "tampered-evidence",
      compositionRevision: before.revision,
    }),
    /证据|候选|不匹配|过期/,
  );
  await assert.rejects(
    e.command({
      type: "apply",
      operationId: "apply-member-wrong-candidate",
      runId,
      candidateId: "missing-candidate",
      evidenceHash: candidate.evidenceHash!,
      compositionRevision: before.revision,
    }),
    /候选|不匹配|过期/,
  );
  await assert.rejects(
    e.command({
      type: "apply",
      operationId: "apply-member-stale-revision",
      runId,
      candidateId: candidate.id,
      evidenceHash: candidate.evidenceHash!,
      compositionRevision: before.revision + 99,
    }),
    /基础版本|流程已变化|重新规划/,
  );
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.composition().revision, before.revision);
  assert.equal(
    w.composition().members.find((m) => m.pluginId === "tags")?.enabled,
    true,
  );
});

test("self-iteration apply disable exits contributions and retains fields like Workspace path", async (t) => {
  const { w, e, before, runId, candidate } = await awaitingMemberEnabledApply(t);
  const created = await w.command({
    type: "create",
    title: "自迭代停用保留",
    compositionRevision: before.revision,
    operationId: randomUUID(),
  });
  const tagged = await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setTags",
    expectedRevision: created.task!.revision,
    input: { tags: "keep-via-evolution" },
    operationId: randomUUID(),
    compositionRevision: before.revision,
  });
  await w.command({
    type: "action",
    taskId: tagged.task!.id,
    actionId: "setDue",
    expectedRevision: tagged.task!.revision,
    input: { dueAt: "2026-09-20T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: before.revision,
  });

  const apply = {
    type: "apply" as const,
    operationId: "apply-member-disable",
    runId,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  };
  await e.command(apply);
  const succeeded = await settle(e, "succeeded");
  assert.equal(succeeded.status, "succeeded");

  const after = w.composition();
  assert.notEqual(after.versionId, before.versionId);
  assert.ok(after.revision > before.revision);
  assert.equal(
    after.members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );
  assert.equal(after.members.find((m) => m.pluginId === "due")?.enabled, true);
  assert.equal(
    after.workflow.fields.some((f) => f.key === "tags"),
    false,
  );
  assert.ok(after.workflow.fields.some((f) => f.key === "dueAt"));
  assert.ok(after.retainedFields.some((f) => f.key === "tags"));

  const stored = w.read(created.task!.id);
  assert.equal(stored.fields.tags, "keep-via-evolution");
  assert.equal(stored.fields.dueAt, "2026-09-20T00:00:00Z");

  await assert.rejects(
    w.command({
      type: "action",
      taskId: stored.id,
      actionId: "setTags",
      expectedRevision: stored.revision,
      input: { tags: "nope" },
      operationId: randomUUID(),
      compositionRevision: after.revision,
    }),
    /不可用|无效/,
  );
  assert.equal(w.read(stored.id).fields.tags, "keep-via-evolution");

  const dueAgain = await w.command({
    type: "action",
    taskId: stored.id,
    actionId: "setDue",
    expectedRevision: stored.revision,
    input: { dueAt: "2026-09-21T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(dueAgain.task?.fields.dueAt, "2026-09-21T00:00:00Z");
});

test("self-iteration apply re-enable restores contributions with retained field values", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-member-re-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  await activateDual(w);
  const dual = w.composition();
  const created = await w.command({
    type: "create",
    title: "再启用保留",
    compositionRevision: dual.revision,
    operationId: randomUUID(),
  });
  await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setTags",
    expectedRevision: created.task!.revision,
    input: { tags: "survive-disable" },
    operationId: randomUUID(),
    compositionRevision: dual.revision,
  });
  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
    versionId: w.composition().versionId,
    pluginId: "tags",
    enabled: false,
  });
  assert.equal(
    w.composition().members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );
  assert.equal(w.read(created.task!.id).fields.tags, "survive-disable");

  const before = w.composition();
  const candidateVersion = w.recordMemberEnabledVersion("tags", true);
  const plan = memberEnabledPlan(before.versionId, before.revision);
  plan.summary = "再启用标签插件";
  plan.outcome = "启用 tags";
  plan.changes = ["将 tags 成员 enabled 设为 true"];
  const candidateId = "cand-member-reenable";
  const evidenceHash = hash({
    candidateId,
    versionId: candidateVersion.id,
    cases: plan.cases,
    rules: plan.workflowRules,
  });
  const runId = "run-member-reenable";
  const bootstrap = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  await bootstrap.close();
  w.db
    .prepare(
      "INSERT INTO evolution_runs(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    )
    .run(
      runId,
      JSON.stringify({
        run: {
          id: runId,
          request: "再启用标签插件",
          updatedAt: new Date().toISOString(),
          status: "awaiting-apply",
          plan,
          steps: [],
          summary: `${plan.outcome}（候选已验证，尚未应用）`,
          versionId: candidateVersion.id,
        },
        target: {
          kind: "plugin",
          baseVersion: before.versionId,
          payload: { kind: "member-enabled", pluginId: "tags", enabled: true },
        },
        plan,
        versionId: candidateVersion.id,
        history: [],
        calls: 1,
        candidates: 1,
        elapsed: 10,
        eventSequence: 0,
      }),
    );
  w.db
    .prepare("INSERT INTO evolution_candidates(runId,body) VALUES(?,?)")
    .run(
      runId,
      JSON.stringify({
        id: candidateId,
        planId: plan.id,
        baseVersion: before.versionId,
        attempt: 1,
        passed: true,
        evidenceHash,
        versionId: candidateVersion.id,
        sourceHash: hash({ pluginId: "tags", enabled: true }),
      }),
    );
  const e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });

  const experienced = await e.command({
    type: "experience",
    operationId: "experience-reenable",
    runId,
    candidateId,
  });
  assert.equal(experienced.run?.status, "awaiting-apply");
  if (experienced.run?.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  assert.equal(experienced.run.experience?.marked, "not-applied");
  assert.ok(
    experienced.run.experience?.checks.some((c) =>
      c.includes("member.enabled:tags:false->true"),
    ),
  );
  assert.equal(w.composition().versionId, before.versionId);

  await e.command({
    type: "apply",
    operationId: "apply-member-reenable",
    runId,
    candidateId,
    evidenceHash,
    compositionRevision: before.revision,
  });
  await settle(e, "succeeded");
  const after = w.composition();
  assert.equal(after.members.find((m) => m.pluginId === "tags")?.enabled, true);
  assert.ok(after.workflow.fields.some((f) => f.key === "tags"));
  assert.ok(after.workflow.actions.some((a) => a.id === "setTags"));
  const stored = w.read(created.task!.id);
  assert.equal(stored.fields.tags, "survive-disable");
  const updated = await w.command({
    type: "action",
    taskId: stored.id,
    actionId: "setTags",
    expectedRevision: stored.revision,
    input: { tags: "writable-again" },
    operationId: randomUUID(),
    compositionRevision: after.revision,
  });
  assert.equal(updated.task?.fields.tags, "writable-again");
});

test("ordinary self-iteration enable-status path does not alter system protection constraints", async (t) => {
  const { w, e, before, runId, candidate, candidateVersion, plan } =
    await awaitingMemberEnabledApply(t);
  assert.ok(plan.excluded.some((item) => /发布|验证|恢复|执行策略/.test(item)));
  assert.deepEqual(plan.writableScope, []);
  const base = w.release.get(before.versionId);
  assert.equal(hash(candidateVersion.evidence), hash(base.evidence));
  assert.equal(candidateVersion.source, base.source);
  assert.equal(candidateVersion.code, base.code);

  await e.command({
    type: "apply",
    operationId: "apply-member-protect",
    runId,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  await settle(e, "succeeded");

  // Restore / previous-version surface remains usable after enable-status apply.
  const previous = w.previousVersionId();
  assert.equal(previous, before.versionId);
  const after = w.composition();
  await w.activate(
    {
      versionId: previous!,
      compositionRevision: after.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(
    w.composition().members.find((m) => m.pluginId === "tags")?.enabled,
    true,
  );
});

test("experience rejects when formal composition drifted from candidate parent", async (t) => {
  const { w, e, before, runId, candidate } = await awaitingMemberEnabledApply(t);
  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: before.revision,
    versionId: before.versionId,
    pluginId: "due",
    enabled: false,
  });
  const drifted = w.composition();
  assert.notEqual(drifted.versionId, before.versionId);

  await assert.rejects(
    e.command({
      type: "experience",
      operationId: "experience-stale-parent",
      runId,
      candidateId: candidate.id,
    }),
    /基础版本|重新规划/,
  );
  assert.equal(w.composition().versionId, drifted.versionId);
  assert.equal(w.composition().revision, drifted.revision);
  assert.equal(
    w.composition().members.find((m) => m.pluginId === "tags")?.enabled,
    true,
  );
  assert.equal(
    w.composition().members.find((m) => m.pluginId === "due")?.enabled,
    false,
  );
});

test("impure enable-status candidate does not take member-enabled experience shortcut", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-member-impure-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  await activateDual(w);
  const before = w.composition();
  const pure = w.recordMemberEnabledVersion("tags", false);
  const base = w.release.get(before.versionId);
  const impure = w.release.record({
    pluginId: base.pluginId,
    name: `${base.name}（杂质候选）`,
    parentId: base.id,
    service: base.service,
    contractVersion: base.contractVersion,
    source: `${base.source}\n// impure-marker`,
    code: base.code,
    definition: base.definition,
    evidence: { ...(base.evidence as object), forgedReport: true, passed: true },
    ...(base.bundle ? { bundle: base.bundle } : {}),
    members: pure.members!,
  });
  const plan = memberEnabledPlan(before.versionId, before.revision);
  const candidateId = "cand-member-impure";
  const evidenceHash = hash({
    candidateId,
    versionId: impure.id,
    cases: plan.cases,
    rules: plan.workflowRules,
  });
  const runId = "run-member-impure";
  const bootstrap = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  await bootstrap.close();
  w.db
    .prepare(
      "INSERT INTO evolution_runs(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    )
    .run(
      runId,
      JSON.stringify({
        run: {
          id: runId,
          request: "杂质启用态候选",
          updatedAt: new Date().toISOString(),
          status: "awaiting-apply",
          plan,
          steps: [],
          summary: `${plan.outcome}（候选已验证，尚未应用）`,
          versionId: impure.id,
        },
        target: {
          kind: "plugin",
          baseVersion: before.versionId,
          payload: { kind: "member-enabled", pluginId: "tags", enabled: false },
        },
        plan,
        versionId: impure.id,
        history: [],
        calls: 1,
        candidates: 1,
        elapsed: 10,
        eventSequence: 0,
      }),
    );
  w.db
    .prepare("INSERT INTO evolution_candidates(runId,body) VALUES(?,?)")
    .run(
      runId,
      JSON.stringify({
        id: candidateId,
        planId: plan.id,
        baseVersion: before.versionId,
        attempt: 1,
        passed: true,
        evidenceHash,
        versionId: impure.id,
        sourceHash: hash({ impure: true }),
      }),
    );
  const e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });

  const experienced = await e.command({
    type: "experience",
    operationId: "experience-impure",
    runId,
    candidateId,
  });
  assert.equal(experienced.run?.status, "awaiting-apply");
  if (experienced.run?.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  assert.equal(experienced.run.experience?.marked, "not-applied");
  assert.equal(
    experienced.run.experience?.checks.some((c) => c.includes("member.enabled:")),
    false,
  );
  assert.ok(
    experienced.run.experience?.checks.some((c) => c.startsWith("describe:")),
  );
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.composition().revision, before.revision);
});
