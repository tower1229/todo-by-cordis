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
  assert.ok(candidate, "must produce a passed candidate via workspace acceptance");
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
  assert.equal(experience.run.experience?.marked, "not-applied");
  assert.equal(experience.run.experience?.isolated, true);
  assert.equal(experience.run.experience?.simulated, true);
  assert.match(experience.run.experience?.note ?? "", /尚未应用|模拟/);
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
