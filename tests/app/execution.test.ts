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
import { source } from "./evolution-fixture.js";

async function settle(e: Evolution, status?: string) {
  for (let i = 0; i < 200; i++) {
    const run = (await e.observe()).run;
    if (!run) throw new Error("missing run");
    if (status ? run.status === status : !["planning", "executing"].includes(run.status))
      return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout: ${JSON.stringify((await e.observe()).run)}`);
}

test("A04: start freezes the plan, is idempotent, and rejects revise during execution", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-exec-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const driver = new ExecutionDriver(new PlanningDriver());
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createApp(w, e);
  const before = w.composition();
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "plan",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  const frozen = structuredClone(ready.plan);
  const start = {
    type: "start" as const,
    operationId: "start-1",
    runId: ready.id,
    planId: ready.plan.id,
  };
  const first = await e.command(start);
  assert.equal(first.run?.status, "executing");
  assert.deepEqual(
    first.run && "plan" in first.run ? first.run.plan : null,
    frozen,
  );
  assert.deepEqual(await e.command(start), first);
  await assert.rejects(
    e.command({ ...start, planId: "other-plan" }),
    /操作标识已用于其他请求/,
  );
  await assert.rejects(
    e.command({
      type: "revise",
      runId: ready.id,
      text: "改成选填",
      operationId: "revise-locked",
    }),
    /锁定|完成或取消/,
  );
  const rejected = await app.request("/api/assistant/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "confirm",
      operationId: "old-confirm",
      runId: ready.id,
      planId: ready.plan.id,
      compositionRevision: ready.plan.compositionRevision,
    }),
  });
  assert.equal(rejected.status, 409);
  assert.match((await rejected.json()).message, /旧确认不能授予/);
  const done = await settle(e);
  assert.equal(done.status, "awaiting-apply");
  if (done.status !== "awaiting-apply") throw new Error("expected awaiting-apply");
  assert.equal(done.plan.id, frozen.id);
  assert.deepEqual(done.plan.workflowRules, frozen.workflowRules);
  assert.ok(done.versionId);
  assert.equal(w.composition().revision, before.revision);
  assert.equal(w.composition().versionId, before.versionId);
  assert.ok(w.release.all().length > 2);
  const observed = await e.observe(ready.id, 0);
  assert.ok((observed.events?.length ?? 0) > 0);
  assert.ok(observed.events?.some((event) => event.tool === "read_contract"));
  assert.ok(
    observed.events?.some((event) => event.tool === "submit_candidate"),
  );
  assert.ok((observed.eventCursor ?? 0) >= (observed.events?.length ?? 0));
  assert.ok(done.steps.some((s) => s.status === "succeeded"));
  assert.equal(done.budget?.candidatesRemaining, 2);
});

test("A11: observe by runId and event cursor restores the same execution without replaying model calls", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-exec-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const driver = new ExecutionDriver(new PlanningDriver());
  let e = new Evolution(w.db, driver, new EvolutionDomain(w));
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
  await e.command({
    type: "start",
    operationId: "start",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  const calls = driver.requests.length;
  const full = await e.observe(ready.id, 0);
  assert.equal(full.run?.id, ready.id);
  assert.ok((full.events?.length ?? 0) > 1);
  const mid = full.events![Math.floor(full.events!.length / 2)].sequence;
  const delta = await e.observe(ready.id, mid);
  assert.equal(delta.run?.status, "awaiting-apply");
  assert.ok(delta.events!.every((event) => event.sequence > mid));
  await e.close();
  e = new Evolution(w.db, driver, new EvolutionDomain(w));
  const restored = await e.observe(ready.id);
  assert.equal(restored.run?.status, "awaiting-apply");
  assert.equal(restored.run?.versionId, done.versionId);
  assert.equal(driver.requests.length, calls);
});

test("cancel during candidate build stops work and late results cannot apply", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-exec-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  let releaseBuild!: () => void;
  const building = new Promise<void>((resolve) => {
    releaseBuild = resolve;
  });
  const planning = new PlanningDriver();
  const driver: import("../../src/evolution/driver.js").Driver = {
    async generate(request) {
      if (!request.tools?.some((t) => t.name === "submit_candidate"))
        return planning.generate(request);
      const content = JSON.stringify(request.history);
      if (!content.includes("read_contract"))
        return {
          text: "",
          history: request.history,
          calls: [{ name: "read_contract", args: {} }],
          usage: null,
          raw: {},
        };
      if (!content.includes("read_current_source"))
        return {
          text: "",
          history: request.history,
          calls: [{ name: "read_current_source", args: {} }],
          usage: null,
          raw: {},
        };
      await building;
      return {
        text: "",
        history: request.history,
        calls: [
          {
            name: "submit_candidate",
            args: {
              source: source(
                w.activeVersion().pluginId,
                w.activeVersion().name,
              ),
            },
          },
        ],
        usage: null,
        raw: {},
      };
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
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
  for (let i = 0; i < 100; i++) {
    const run = (await e.observe()).run;
    if (run?.status === "executing" && driver) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  await e.command({
    type: "cancel",
    runId: ready.id,
    operationId: "stop",
  });
  releaseBuild();
  await e.close();
  assert.equal((await e.observe()).run?.status, "cancelled");
  assert.deepEqual(w.composition(), before);
});

test("late candidate success after cancel cannot enter awaiting-apply", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-exec-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  let releaseCandidate!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseCandidate = resolve;
  });
  let enteredCandidate = false;
  const base = new EvolutionDomain(w);
  const domain = {
    context: () => base.context(),
    planningInstruction: base.planningInstruction,
    planningTools: base.planningTools,
    read: base.read.bind(base),
    parse: base.parse.bind(base),
    target: base.target.bind(base),
    check: base.check.bind(base),
    generation: base.generation.bind(base),
    async candidate(
      sourceText: string,
      target: Parameters<EvolutionDomain["candidate"]>[1],
      signal: AbortSignal,
      stage: (label: string) => void,
    ) {
      enteredCandidate = true;
      stage("构建候选");
      await held;
      signal.throwIfAborted();
      return base.candidate(sourceText, target, signal, stage);
    },
  };
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
  for (let i = 0; i < 200; i++) {
    if (enteredCandidate) break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(enteredCandidate, true);
  await e.command({
    type: "cancel",
    runId: ready.id,
    operationId: "stop-late",
  });
  releaseCandidate();
  await e.close();
  const run = (await e.observe(ready.id)).run;
  assert.equal(run?.status, "cancelled");
  assert.notEqual(run?.status, "awaiting-apply");
  assert.equal(w.composition().versionId, before.versionId);
});

test("A10: execution rejects unknown tools, apply tools and unauthorized patch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-exec-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const planning = new PlanningDriver();
  let mode: "unknown" | "path" = "unknown";
  const driver: import("../../src/evolution/driver.js").Driver = {
    async generate(request) {
      if (!request.tools?.some((t) => t.name === "submit_candidate"))
        return planning.generate(request);
      assert.equal(
        request.tools?.some((t) => t.name === "apply_release"),
        false,
      );
      assert.equal(
        request.tools?.some((t) => t.name === "patch_candidate"),
        false,
      );
      if (mode === "unknown")
        return {
          text: "",
          history: request.history,
          calls: [{ name: "apply_release", args: {} }],
          usage: null,
          raw: {},
        };
      return {
        text: "",
        history: request.history,
        calls: [
          {
            name: "patch_candidate",
            args: { path: "src/evolution/evolution.ts", content: "hack" },
          },
        ],
        usage: null,
        raw: {},
      };
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
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
  await e.command({
    type: "start",
    operationId: "start-unknown",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const failed = await settle(e);
  assert.equal(failed.status, "failed");
  if (failed.status === "failed") assert.match(failed.message, /未授权|工具/);
  assert.equal(w.composition().revision, 1);

  const e2 = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e2.close();
  });
  mode = "path";
  await e2.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "plan2",
  });
  const ready2 = await settle(e2, "ready");
  if (ready2.status !== "ready") throw new Error("expected ready");
  await e2.command({
    type: "start",
    operationId: "start-path",
    runId: ready2.id,
    planId: ready2.plan.id,
  });
  const failed2 = await settle(e2);
  assert.equal(failed2.status, "failed");
  if (failed2.status === "failed") assert.match(failed2.message, /未授权/);
});

test("Todo commands remain available while a candidate is generating", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-exec-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const planning = new PlanningDriver();
  const driver: import("../../src/evolution/driver.js").Driver = {
    async generate(request) {
      if (!request.tools?.some((t) => t.name === "submit_candidate"))
        return planning.generate(request);
      await hold;
      return {
        text: "",
        history: request.history,
        calls: [
          {
            name: "submit_candidate",
            args: {
              source: source(
                w.activeVersion().pluginId,
                w.activeVersion().name,
              ),
            },
          },
        ],
        usage: null,
        raw: {},
      };
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    release();
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
  await e.command({
    type: "start",
    operationId: "start",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const created = await w.command({
    type: "create",
    title: "during-exec",
    compositionRevision: 1,
    operationId: "todo",
  });
  assert.equal(created.task?.title, "during-exec");
  release();
  await settle(e, "awaiting-apply");
  assert.equal(w.query().total, 1);
});

test("A12: restart interrupts executing without apply and keeps awaiting-apply evidence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-exec-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const driver = new ExecutionDriver(new PlanningDriver());
  let e = new Evolution(w.db, driver, new EvolutionDomain(w));
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
    operationId: "start-run",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.ok(done.versionId);
  assert.equal(w.composition().versionId, before.versionId);
  await e.close();
  e = new Evolution(w.db, driver, new EvolutionDomain(w));
  const kept = await e.observe(ready.id);
  assert.equal(kept.run?.status, "awaiting-apply");
  assert.equal(kept.run?.versionId, done.versionId);
  assert.equal(w.composition().versionId, before.versionId);

  await e.command({ type: "cancel", runId: ready.id, operationId: "drop" });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "plan2",
  });
  const ready2 = await settle(e, "ready");
  if (ready2.status !== "ready") throw new Error("expected ready");
  let release!: () => void;
  const hold = new Promise<void>((r) => {
    release = r;
  });
  const held: import("../../src/evolution/driver.js").Driver = {
    async generate(request) {
      if (!request.tools?.some((tool) => tool.name === "submit_candidate"))
        return driver.generate(request);
      await hold;
      return driver.generate(request);
    },
  };
  await e.close();
  e = new Evolution(w.db, held, new EvolutionDomain(w));
  await e.command({
    type: "start",
    operationId: "start-interrupt",
    runId: ready2.id,
    planId: ready2.plan.id,
  });
  for (let i = 0; i < 50; i++) {
    if ((await e.observe()).run?.status === "executing") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal((await e.observe()).run?.status, "executing");
  await e.close();
  release();
  e = new Evolution(w.db, held, new EvolutionDomain(w));
  const interrupted = await e.observe(ready2.id);
  assert.equal(interrupted.run?.status, "interrupted");
  assert.equal(w.composition().versionId, before.versionId);
});

test("A12: persisted executing run is interrupted on host reopen without applying", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-exec-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const before = w.composition();
  let bootstrap = new Evolution(
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
      "crash-exec",
      JSON.stringify({
        run: {
          id: "crash-exec",
          request: "完成前填写复盘",
          updatedAt: "2026-01-01",
          status: "executing",
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
          steps: [
            { id: "s1", label: "生成候选", status: "running", attempt: 1 },
          ],
        },
        history: [],
        calls: 3,
        candidates: 0,
        elapsed: 10,
        eventSequence: 0,
      }),
    );
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
  const run = (await e.observe("crash-exec")).run;
  assert.equal(run?.status, "interrupted");
  assert.equal(w.composition().versionId, before.versionId);
});
