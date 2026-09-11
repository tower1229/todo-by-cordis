import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { createApp } from "../../src/server/app.js";
import { PlanningDriver } from "./planning-fixture.js";
import { ExecutionDriver } from "./execution-fixture.js";
import { parseAssistantCommand } from "../../src/server/assistant.js";

// Seams: public Evolution commands + observe, composition/query, HTTP assistant API.
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

async function awaitingApply(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "cordis-apply-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const before = w.composition();
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
  const snapshot = await e.observe();
  const candidate = snapshot.candidates?.find((c) => c.passed);
  assert.ok(candidate);
  assert.ok(candidate.evidenceHash);
  assert.ok(done.versionId);
  return { w, e, before, ready, done, candidate: candidate! };
}

test("A06: experience probes the candidate in isolation without changing formal tasks or composition", async (t) => {
  const { w, e, before, done, candidate } = await awaitingApply(t);
  await w.command({
    type: "create",
    title: "formal-before-experience",
    compositionRevision: before.revision,
    operationId: "formal-task",
  });
  assert.equal(w.query().total, 1);

  const experience = {
    type: "experience" as const,
    operationId: "experience-1",
    runId: done.id,
    candidateId: candidate.id,
  };
  const first = await e.command(experience);
  assert.equal(first.run?.status, "awaiting-apply");
  if (first.run?.status !== "awaiting-apply") throw new Error("expected awaiting-apply");
  assert.ok(first.run.experience);
  assert.equal(first.run.experience.candidateId, candidate.id);
  assert.equal(first.run.experience.marked, "not-applied");
  assert.equal(first.run.experience.isolated, true);
  assert.equal(first.run.experience.simulated, true);
  assert.match(first.run.experience.note, /尚未应用|模拟/);
  assert.ok(first.run.experience.checks.length > 0);
  assert.deepEqual(await e.command(experience), first);

  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.query().total, 1);
  assert.equal(w.query().tasks[0]?.title, "formal-before-experience");
});

test("A07: apply binds candidate evidence and base composition; mismatch and replay stay safe", async (t) => {
  const { w, e, before, done, candidate } = await awaitingApply(t);
  const app = createApp(w, e);

  await assert.rejects(
    e.command({
      type: "apply",
      operationId: "apply-wrong-hash",
      runId: done.id,
      candidateId: candidate.id,
      evidenceHash: "tampered-evidence",
      compositionRevision: before.revision,
    }),
    /证据|候选|不匹配|过期/,
  );
  await assert.rejects(
    e.command({
      type: "apply",
      operationId: "apply-wrong-candidate",
      runId: done.id,
      candidateId: "missing-candidate",
      evidenceHash: candidate.evidenceHash!,
      compositionRevision: before.revision,
    }),
    /候选|不匹配|过期/,
  );
  await assert.rejects(
    e.command({
      type: "apply",
      operationId: "apply-stale-revision",
      runId: done.id,
      candidateId: candidate.id,
      evidenceHash: candidate.evidenceHash!,
      compositionRevision: before.revision + 99,
    }),
    /基础版本|流程已变化|重新规划/,
  );
  assert.equal(w.composition().versionId, before.versionId);

  const apply = {
    type: "apply" as const,
    operationId: "apply-1",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  };
  const started = await e.command(apply);
  assert.ok(
    started.run &&
      (started.run.status === "applying" || started.run.status === "succeeded"),
  );
  if (started.run?.status === "applying")
    assert.deepEqual(await e.command(apply), started);
  await assert.rejects(
    e.command({ ...apply, evidenceHash: "other" }),
    /操作标识已用于其他请求/,
  );

  const succeeded = await settle(e, "succeeded");
  assert.equal(succeeded.status, "succeeded");
  if (succeeded.status !== "succeeded") throw new Error("expected succeeded");
  assert.equal(w.composition().versionId, done.versionId);
  assert.ok(w.composition().revision > before.revision);
  assert.match(succeeded.summary, /已应用|正式/);
  assert.equal(succeeded.versionId, done.versionId);

  const replayed = await e.command(apply);
  assert.equal(replayed.run?.status, "succeeded");
  assert.equal(replayed.run?.versionId, done.versionId);

  const lost = await app.request("/api/assistant/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(apply),
  });
  assert.equal(lost.status, 200);
  assert.equal((await lost.json()).run.status, "succeeded");

  const parsed = parseAssistantCommand(apply);
  assert.equal(parsed.type, "apply");
});

test("apply failure before commit keeps the old composition and returns to awaiting-apply", async (t) => {
  const { w, before, done, candidate } = await awaitingApply(t);
  const domain = new EvolutionDomain(w);
  const broken = new Evolution(w.db, new ExecutionDriver(new PlanningDriver()), {
    context: () => domain.context(),
    planningInstruction: domain.planningInstruction,
    planningTools: domain.planningTools,
    read: domain.read.bind(domain),
    parse: domain.parse.bind(domain),
    target: domain.target.bind(domain),
    check: domain.check.bind(domain),
    isActiveVersion: domain.isActiveVersion.bind(domain),
    isReadyVersion: domain.isReadyVersion.bind(domain),
    acceptanceEvidence: domain.acceptanceEvidence.bind(domain),
    generation: domain.generation.bind(domain),
    candidate: domain.candidate.bind(domain),
    experience: domain.experience.bind(domain),
    apply: async () => {
      throw new Error("预启动就绪检查失败");
    },
  });
  t.after(async () => {
    await broken.close();
  });
  const started = await broken.command({
    type: "apply",
    operationId: "apply-fail",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  assert.ok(
    started.run &&
      ["applying", "awaiting-apply", "failed"].includes(started.run.status),
  );
  const run = await settle(broken);
  assert.equal(run.status, "awaiting-apply");
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.composition().revision, before.revision);
  const replay = await broken.command({
    type: "apply",
    operationId: "apply-fail",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  assert.equal(replay.run?.status, "awaiting-apply");
  assert.equal(w.composition().versionId, before.versionId);
});

test("cancel during apply after commit keeps succeeded by publish fact", async (t) => {
  const { w, before, done, candidate } = await awaitingApply(t);
  const domain = new EvolutionDomain(w);
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let committed = false;
  const e = new Evolution(w.db, new ExecutionDriver(new PlanningDriver()), {
    context: () => domain.context(),
    planningInstruction: domain.planningInstruction,
    planningTools: domain.planningTools,
    read: domain.read.bind(domain),
    parse: domain.parse.bind(domain),
    target: domain.target.bind(domain),
    check: domain.check.bind(domain),
    isActiveVersion: domain.isActiveVersion.bind(domain),
    isReadyVersion: domain.isReadyVersion.bind(domain),
    acceptanceEvidence: domain.acceptanceEvidence.bind(domain),
    generation: domain.generation.bind(domain),
    candidate: domain.candidate.bind(domain),
    experience: domain.experience.bind(domain),
    apply: async (versionId, target, revision, operationId, complete, signal) => {
      await domain.apply(versionId, target, revision, operationId, complete, signal);
      committed = true;
      await gate;
      signal.throwIfAborted();
    },
  });
  t.after(async () => {
    releaseGate();
    await e.close();
  });
  await e.command({
    type: "apply",
    operationId: "apply-hold",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  for (let i = 0; i < 200; i++) {
    if (committed) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(committed, true);
  assert.equal(w.composition().versionId, done.versionId);
  const cancelled = await e.command({
    type: "cancel",
    operationId: "cancel-after-commit",
    runId: done.id,
  });
  assert.equal(cancelled.run?.status, "succeeded");
  releaseGate();
  const settled = await settle(e, "succeeded");
  assert.equal(settled.status, "succeeded");
  assert.equal(w.composition().versionId, done.versionId);
  const replay = await e.command({
    type: "apply",
    operationId: "apply-hold",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  assert.equal(replay.run?.status, "succeeded");
});

test("cancel during apply before commit leaves cancelled and old composition", async (t) => {
  const { w, before, done, candidate } = await awaitingApply(t);
  const domain = new EvolutionDomain(w);
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let entered = false;
  const e = new Evolution(w.db, new ExecutionDriver(new PlanningDriver()), {
    context: () => domain.context(),
    planningInstruction: domain.planningInstruction,
    planningTools: domain.planningTools,
    read: domain.read.bind(domain),
    parse: domain.parse.bind(domain),
    target: domain.target.bind(domain),
    check: domain.check.bind(domain),
    isActiveVersion: domain.isActiveVersion.bind(domain),
    isReadyVersion: domain.isReadyVersion.bind(domain),
    acceptanceEvidence: domain.acceptanceEvidence.bind(domain),
    generation: domain.generation.bind(domain),
    candidate: domain.candidate.bind(domain),
    experience: domain.experience.bind(domain),
    apply: async (versionId, target, revision, operationId, complete, signal) => {
      entered = true;
      await gate;
      signal.throwIfAborted();
      await domain.apply(versionId, target, revision, operationId, complete, signal);
    },
  });
  t.after(async () => {
    releaseGate();
    await e.close();
  });
  await e.command({
    type: "apply",
    operationId: "apply-pre-cancel",
    runId: done.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: before.revision,
  });
  for (let i = 0; i < 200; i++) {
    if (entered) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(entered, true);
  const cancelled = await e.command({
    type: "cancel",
    operationId: "cancel-before-commit",
    runId: done.id,
  });
  assert.equal(cancelled.run?.status, "cancelled");
  releaseGate();
  await e.close();
  assert.equal((await e.observe(done.id)).run?.status, "cancelled");
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.composition().revision, before.revision);
});
