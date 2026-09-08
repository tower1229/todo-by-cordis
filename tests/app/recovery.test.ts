import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { createApp } from "../../src/server/app.js";
import { PlanningDriver } from "./planning-fixture.js";
import { ExecutionDriver } from "./execution-fixture.js";
import {
  source,
  candidateSource,
  candidateScope,
} from "./evolution-fixture.js";

// Seams (issue #7 / parent A12·A13): Workspace activate/composition/command,
// Evolution command/observe, HTTP /api/runtime/restore and /api/composition.
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

async function setup(t: TestContext, options?: Parameters<typeof Workspace.open>[1]) {
  const dir = mkdtempSync(join(tmpdir(), "cordis-recovery-"));
  const w = await Workspace.open(join(dir, "workspace.db"), options);
  t.after(async () => {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { w, dir };
}

function target(w: Workspace, minimum = 1) {
  return {
    kind: "plugin" as const,
    baseVersion: w.activeVersion().id,
    payload: {
      scope: candidateScope,
      pluginId: "reflection",
      name: "Reflection",
      fields: [
        {
          key: "reflection",
          label: "复盘",
          required: true,
          minLength: minimum,
          maxLength: 5000,
        },
      ],
    },
  };
}

test("boundary: commit-before failure keeps the old composition", async (t) => {
  const { w } = await setup(t);
  const before = w.composition();
  const domain = new EvolutionDomain(w);
  const versionId = await domain.candidate(
    candidateSource(source("reflection")),
    target(w),
    new AbortController().signal,
    () => {},
  );
  await assert.rejects(
    w.activate(
      {
        versionId,
        compositionRevision: before.revision,
        operationId: "pre-commit-fail",
      },
      () => {
        throw new Error("提交前就绪检查失败");
      },
    ),
    /提交前就绪检查失败/,
  );
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.composition().revision, before.revision);
  assert.equal(w.composition().status, "ready");
  const task = (
    await w.command({
      type: "create",
      title: "still-writable",
      compositionRevision: before.revision,
      operationId: randomUUID(),
    })
  ).task!;
  assert.equal(task.title, "still-writable");
});

test("boundary: post-commit readiness failure compensates to the prior composition", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-recovery-"));
  const file = join(dir, "workspace.db");
  let w = await Workspace.open(file, {
    checkpoint(stage) {
      if (stage === "ready-check") throw new Error("提交后就绪探针失败");
    },
  });
  t.after(async () => {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const before = w.composition();
  const domain = new EvolutionDomain(w);
  const versionId = await domain.candidate(
    candidateSource(source("reflection")),
    target(w),
    new AbortController().signal,
    () => {},
  );
  await assert.rejects(
    w.activate(
      {
        versionId,
        compositionRevision: before.revision,
        operationId: "post-commit-fail",
      },
      () => {},
    ),
    /提交后就绪探针失败|补偿/,
  );
  const after = w.composition();
  assert.equal(after.versionId, before.versionId);
  assert.equal(after.status, "ready");
  assert.ok(after.revision > before.revision);
  assert.ok(after.recovery);
  assert.equal(after.recovery?.attemptedVersionId, versionId);
  assert.equal(after.recovery?.restoredVersionId, before.versionId);
  const receipt = w.operation("post-commit-fail");
  assert.ok(receipt);
  assert.equal(
    (receipt as { compensated?: boolean; versionId?: string }).compensated,
    true,
  );
  assert.equal(
    (receipt as { versionId?: string }).versionId,
    before.versionId,
  );
  assert.equal(w.activeVersion().id, before.versionId);
  const task = (
    await w.command({
      type: "create",
      title: "after-compensate",
      compositionRevision: after.revision,
      operationId: randomUUID(),
    })
  ).task!;
  assert.equal(w.read(task.id).title, "after-compensate");
  await w.close();
  w = await Workspace.open(file);
  assert.ok(w.composition().recovery);
  assert.equal(w.composition().recovery?.attemptedVersionId, versionId);
  assert.equal(w.composition().versionId, before.versionId);
});

test("A13: rollback after accepted writes keeps new tasks and fields", async (t) => {
  const { w } = await setup(t);
  const domain = new EvolutionDomain(w);
  const first = await domain.candidate(
    candidateSource(source("reflection")),
    target(w),
    new AbortController().signal,
    () => {},
  );
  const baseline = w.composition().versionId;
  await w.activate(
    {
      versionId: first,
      compositionRevision: 1,
      operationId: randomUUID(),
    },
    () => {},
  );
  assert.equal(w.composition().versionId, first);
  const created = (
    await w.command({
      type: "create",
      title: "post-apply-task",
      compositionRevision: 2,
      operationId: randomUUID(),
    })
  ).task!;
  await w.command({
    type: "action",
    taskId: created.id,
    expectedRevision: created.revision,
    compositionRevision: 2,
    operationId: randomUUID(),
    actionId: "complete",
    input: { reflection: "发布后新增字段值" },
  });
  const app = createApp(w);
  const restored = await app.request("/api/runtime/restore", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      operationId: randomUUID(),
      compositionRevision: 2,
    }),
  });
  assert.equal(restored.status, 200);
  const body = (await restored.json()) as { revision: number };
  assert.equal(w.composition().versionId, baseline);
  assert.notEqual(w.composition().versionId, first);
  assert.equal(w.read(created.id).title, "post-apply-task");
  assert.equal(w.read(created.id).fields.reflection, "发布后新增字段值");
  assert.equal(w.read(created.id).state, "done");
  assert.equal(w.composition().status, "ready");
  assert.ok(body.revision >= 3);
  const still = (
    await w.command({
      type: "create",
      title: "after-rollback",
      compositionRevision: w.composition().revision,
      operationId: randomUUID(),
    })
  ).task!;
  assert.equal(still.title, "after-rollback");
});

test("A13: apply that compensates after commit does not leave a half upgrade", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-recovery-"));
  const w = await Workspace.open(join(dir, "workspace.db"), {
    checkpoint(stage) {
      if (stage === "ready-check") throw new Error("提交后就绪探针失败");
    },
  });
  const domain = new EvolutionDomain(w);
  const e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    domain,
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
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const awaiting = await settle(e, "awaiting-apply");
  if (awaiting.status !== "awaiting-apply") throw new Error("expected awaiting-apply");
  const snapshot = await e.observe();
  const candidate = snapshot.candidates?.find((c) => c.passed);
  assert.ok(candidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: "apply-compensate",
    runId: awaiting.id,
    candidateId: candidate!.id,
    evidenceHash: candidate!.evidenceHash!,
    compositionRevision: before.revision,
  });
  const run = await settle(e);
  assert.equal(run.status, "awaiting-apply");
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.composition().status, "ready");
  assert.equal(
    (await w.release.start(w.activeVersion()).then(async (runtime) => {
      try {
        return (await runtime.invoke<{ id: string }>("describe")).id;
      } finally {
        await runtime.close();
      }
    })),
    w.activeVersion().pluginId,
  );
  assert.ok(w.composition().recovery);
});

test("A12: ready and awaiting-apply survive reopen; start/apply recheck base version", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-recovery-"));
  const file = join(dir, "workspace.db");
  let w = await Workspace.open(file);
  let e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "plan",
  });
  const ready = await settle(e, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.close();
  await w.close();
  w = await Workspace.open(file);
  e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  const keptReady = await e.observe(ready.id);
  assert.equal(keptReady.run?.status, "ready");
  await e.command({
    type: "start",
    operationId: "start",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const awaiting = await settle(e, "awaiting-apply");
  if (awaiting.status !== "awaiting-apply") throw new Error("expected awaiting-apply");
  const versionId = awaiting.versionId!;
  await e.close();
  await w.close();
  w = await Workspace.open(file);
  e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  const kept = await e.observe(ready.id);
  assert.equal(kept.run?.status, "awaiting-apply");
  assert.equal(kept.run?.versionId, versionId);
  const other = await new EvolutionDomain(w).candidate(
    candidateSource(source("reflection", "Reflection", 2)),
    target(w, 2),
    new AbortController().signal,
    () => {},
  );
  await w.activate(
    {
      versionId: other,
      compositionRevision: w.composition().revision,
      operationId: randomUUID(),
    },
    () => {},
  );
  const candidate = kept.candidates?.find((c) => c.passed);
  assert.ok(candidate?.evidenceHash);
  await assert.rejects(
    e.command({
      type: "apply",
      operationId: "stale-apply",
      runId: ready.id,
      candidateId: candidate!.id,
      evidenceHash: candidate!.evidenceHash!,
      compositionRevision: ready.plan.compositionRevision,
    }),
    /基础版本|流程已变化|重新规划/,
  );
  assert.equal(w.composition().versionId, other);
});

test("cancel after commit before openWrites keeps the published version", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-recovery-"));
  let releaseGate!: () => void;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let held = false;
  const w = await Workspace.open(join(dir, "workspace.db"), {
    beforeOpenWrites: async () => {
      held = true;
      await gate;
    },
  });
  const domain = new EvolutionDomain(w);
  const e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    domain,
  );
  t.after(async () => {
    releaseGate();
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
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const awaiting = await settle(e, "awaiting-apply");
  if (awaiting.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  const snapshot = await e.observe();
  const candidate = snapshot.candidates?.find((c) => c.passed);
  assert.ok(candidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: "apply-hold-open",
    runId: awaiting.id,
    candidateId: candidate!.id,
    evidenceHash: candidate!.evidenceHash!,
    compositionRevision: before.revision,
  });
  for (let i = 0; i < 200; i++) {
    if (held) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(held, true);
  assert.equal(w.composition().versionId, awaiting.versionId);
  assert.equal(w.composition().activationPending, true);
  const cancelled = await e.command({
    type: "cancel",
    operationId: "cancel-mid-open",
    runId: awaiting.id,
  });
  assert.equal(cancelled.run?.status, "applying");
  releaseGate();
  const settled = await settle(e, "succeeded");
  assert.equal(settled.status, "succeeded");
  assert.equal(w.composition().versionId, awaiting.versionId);
  assert.equal(w.composition().status, "ready");
  assert.equal(w.composition().activationPending, undefined);
  const receipt = w.operation("apply-hold-open");
  assert.equal(
    (receipt as { compensated?: boolean } | null)?.compensated,
    undefined,
  );
});

test("restart compensates when activationPending and the new version fails to start", async (t) => {
  const { Runtime } = await import("../../src/runtime/runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "cordis-recovery-"));
  const file = join(dir, "workspace.db");
  let w = await Workspace.open(file);
  const domain = new EvolutionDomain(w);
  const baseline = w.composition().versionId;
  const versionId = await domain.candidate(
    candidateSource(source("reflection")),
    target(w),
    new AbortController().signal,
    () => {},
  );
  await w.activate(
    {
      versionId,
      compositionRevision: 1,
      operationId: "publish-pending",
    },
    () => {},
  );
  assert.equal(w.composition().versionId, versionId);
  w.db.prepare("UPDATE workspace SET activationPending=1 WHERE id=1").run();
  await w.close();
  w = await Workspace.open(file, {
    launch: async (version) => {
      if (version.id === versionId) throw new Error("提交后启动失败");
      return Runtime.start(version);
    },
  });
  t.after(async () => {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(w.composition().versionId, baseline);
  assert.equal(w.composition().status, "ready");
  assert.ok(w.composition().recovery);
  assert.equal(w.composition().recovery?.attemptedVersionId, versionId);
  assert.equal(w.composition().recovery?.restoredVersionId, baseline);
  assert.equal(w.composition().activationPending, undefined);
});

test("A12: applying run becomes succeeded when reopen finds the version ready", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-recovery-"));
  const file = join(dir, "workspace.db");
  let w = await Workspace.open(file);
  const bootstrap = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  await bootstrap.close();
  const domain = new EvolutionDomain(w);
  const versionId = await domain.candidate(
    candidateSource(source("reflection")),
    target(w),
    new AbortController().signal,
    () => {},
  );
  await w.activate(
    {
      versionId,
      compositionRevision: 1,
      operationId: randomUUID(),
    },
    () => {},
  );
  w.db
    .prepare(
      "INSERT INTO evolution_runs(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    )
    .run(
      "apply-reopen",
      JSON.stringify({
        run: {
          id: "apply-reopen",
          request: "完成前填写复盘",
          updatedAt: "2026-01-01",
          status: "applying",
          versionId,
          plan: {
            id: "p1",
            compositionRevision: 1,
            route: { kind: "application" },
            summary: "复盘",
            changes: [],
            outcome: "复盘",
            dataImpact: "无",
            requestRevision: 1,
            workflowRules: [],
            ruleChanges: [],
            excluded: [],
            evidence: [],
            capabilityChanges: [],
            cases: [],
            steps: [],
            writableScope: ["active-source"],
            compatibility: "",
            rollback: "",
            preview: "",
            application: "",
            restartImpact: "",
            dependencies: [],
            unresolved: [],
          },
          steps: [{ id: "s1", label: "应用候选", status: "running" }],
          summary: "正在应用",
        },
        versionId,
        history: [],
        calls: 1,
        candidates: 1,
        elapsed: 10,
        eventSequence: 0,
      }),
    );
  await w.close();
  w = await Workspace.open(file);
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
  assert.equal((await e.observe("apply-reopen")).run?.status, "succeeded");
  assert.equal(w.composition().versionId, versionId);
});

test("A12: applying run becomes awaiting-apply when reopen compensates pending activation", async (t) => {
  const { Runtime } = await import("../../src/runtime/runtime.js");
  const dir = mkdtempSync(join(tmpdir(), "cordis-recovery-"));
  const file = join(dir, "workspace.db");
  let w = await Workspace.open(file);
  const bootstrap = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver()),
    new EvolutionDomain(w),
  );
  await bootstrap.close();
  const domain = new EvolutionDomain(w);
  const baseline = w.composition().versionId;
  const versionId = await domain.candidate(
    candidateSource(source("reflection")),
    target(w),
    new AbortController().signal,
    () => {},
  );
  await w.activate(
    {
      versionId,
      compositionRevision: 1,
      operationId: randomUUID(),
    },
    () => {},
  );
  w.db.prepare("UPDATE workspace SET activationPending=1 WHERE id=1").run();
  w.db
    .prepare(
      "INSERT INTO evolution_runs(id,body) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
    )
    .run(
      "apply-compensated",
      JSON.stringify({
        run: {
          id: "apply-compensated",
          request: "完成前填写复盘",
          updatedAt: "2026-01-01",
          status: "applying",
          versionId,
          plan: {
            id: "p2",
            compositionRevision: 1,
            route: { kind: "application" },
            summary: "复盘",
            changes: [],
            outcome: "复盘",
            dataImpact: "无",
            requestRevision: 1,
            workflowRules: [],
            ruleChanges: [],
            excluded: [],
            evidence: [],
            capabilityChanges: [],
            cases: [],
            steps: [],
            writableScope: ["active-source"],
            compatibility: "",
            rollback: "",
            preview: "",
            application: "",
            restartImpact: "",
            dependencies: [],
            unresolved: [],
          },
          steps: [{ id: "s1", label: "应用候选", status: "running" }],
          summary: "正在应用",
        },
        versionId,
        history: [],
        calls: 1,
        candidates: 1,
        elapsed: 10,
        eventSequence: 0,
      }),
    );
  await w.close();
  w = await Workspace.open(file, {
    launch: async (version) => {
      if (version.id === versionId) throw new Error("提交后启动失败");
      return Runtime.start(version);
    },
  });
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
  assert.equal(w.composition().versionId, baseline);
  assert.ok(w.composition().recovery);
  assert.equal(
    (await e.observe("apply-compensated")).run?.status,
    "awaiting-apply",
  );
});
