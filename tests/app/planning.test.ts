import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { createApp } from "../../src/server/app.js";
import type { Driver } from "../../src/evolution/driver.js";
import { describeBlockers } from "../../src/shared/assistant.js";

test("describeBlockers maps maintainer capability gaps to a short user message", () => {
  const described = describeBlockers([
    "因不能真实调用外部 IO 及系统缺少定时提醒调度基础环境，到时间提醒将被报告为技术阻塞",
  ]);
  assert.equal(described.blockReason, "maintainer-capability");
  assert.match(described.userMessage, /系统级能力/);
  assert.ok(!described.userMessage.includes("business/"));
});

const reply = (name: string, args: Record<string, unknown>) => ({
  text: "",
  history: [],
  calls: [{ name, args }],
  usage: null,
  raw: { fixture: true },
});
test("A01: ordinary requests are redirected without task or version writes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const driver: Driver = {
    async generate() {
      return reply("redirect_request", { message: "请在任务列表中新增任务。" });
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const app = createApp(w, e);
  const before = w.composition();
  await app.request("/api/assistant/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "request",
      operationId: "request",
      text: "帮我新增一个买菜任务",
    }),
  });
  let snapshot;
  for (let i = 0; i < 100; i++) {
    snapshot = await (await app.request("/api/assistant")).json();
    if (snapshot.run.status !== "planning") break;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(snapshot.run.status, "dismissed");
  assert.match(snapshot.run.message, /任务列表/);
  assert.equal(w.query().total, 0);
  assert.deepEqual(w.composition(), before);
  assert.equal(w.release.all().length, 2);
});

import { PlanningDriver } from "./planning-fixture.js";
test("A02: investigated plan is ready, revision history survives public observation and restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const driver = new PlanningDriver();
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
  for (
    let i = 0;
    i < 100 && (await e.observe()).run?.status === "planning";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  const run = (await e.observe()).run!;
  assert.equal(run.status, "ready", JSON.stringify(run));
  assert.equal(w.composition().revision, 1);
  assert.equal(w.release.all().length, 2);
  assert.equal(w.query().total, 0);
  await e.close();
  e = new Evolution(w.db, driver, new EvolutionDomain(w));
  assert.deepEqual((await e.observe()).run, run);
});

for (const [label, finish, message] of [
  ["missing dependency", { dependencies: ["uninstalled-notifier"] }, "依赖"],
  [
    "protected control",
    { writableScope: ["src/evolution/evolution.ts"] },
    "保护",
  ],
  [
    "unknown checker",
    {
      summary: "离线提醒",
      acceptance: [
        {
          given: "离线",
          when: "到期",
          then: "通知",
          checker: "notification/1",
        },
      ],
    },
    "检查器",
  ],
  ["unresolved decision", { unresolved: ["需要确认通知渠道"] }, "通知渠道"],
  [
    "forged evidence",
    { evidence: [{ ref: "active-source", hash: "forged" }] },
    "证据",
  ],
  [
    "unread consumer",
    {
      capabilityChanges: [
        {
          capability: "workflow",
          provider: "active-source",
          consumers: ["src/server/workspace.ts"],
          change: "增加业务接口",
        },
      ],
    },
    "消费方",
  ],
] as const)
  test(`A03 blocks ${label} and retains the goal`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
    const w = await Workspace.open(join(dir, "workspace.db"));
    const e = new Evolution(
      w.db,
      new PlanningDriver(finish),
      new EvolutionDomain(w),
    );
    t.after(async () => {
      await e.close();
      await w.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await e.command({
      type: "request",
      text: "保持原目标",
      operationId: "request",
    });
    for (
      let i = 0;
      i < 100 && (await e.observe()).run?.status === "planning";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const run = (await e.observe()).run!;
    assert.equal(run.status, "blocked");
    if (run.status === "blocked") {
      assert.ok(run.message.includes(message), run.message);
      assert.ok(run.userMessage.length > 0, run.userMessage);
      assert.ok(run.blockReason);
    }
    assert.equal(run.request, "保持原目标");
    assert.equal(w.composition().revision, 1);
    assert.equal(w.release.all().length, 2);
  });

test("clarification and revision keep one run, retained plans and remaining budget", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const fixture = new PlanningDriver();
  let clarify = true;
  const driver: Driver = {
    async generate(request) {
      if (
        clarify &&
        JSON.stringify(request.history).includes("inspect_application")
      )
        return reply("request_clarification", {
          question: "复盘是必填还是选填？",
        });
      return fixture.generate(request);
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  const app = createApp(w, e);
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const send = async (body: Record<string, unknown>) => {
    const response = await app.request("/api/assistant/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const settled = async () => {
    for (let i = 0; i < 100; i++) {
      const s = await (await app.request("/api/assistant")).json();
      if (s.run.status !== "planning") return s.run;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw Error("timeout");
  };
  await send({ type: "request", text: "完成前复盘", operationId: "one" });
  const first = await settled();
  assert.equal(first.status, "awaiting-input");
  clarify = false;
  const command = {
    type: "answer",
    runId: first.id,
    text: "必填",
    operationId: "two",
  };
  await send(command);
  await send(command);
  const ready = await settled();
  assert.equal(ready.status, "ready");
  assert.equal(ready.id, first.id);
  assert.equal(ready.requestRevision, 2);
  assert.equal(ready.budget.callsUsed, 5);
  const calls = fixture.requests.length;
  const exact = await (
    await app.request(`/api/assistant?runId=${first.id}`)
  ).json();
  assert.deepEqual(exact.run, ready);
  assert.equal(fixture.requests.length, calls);
  await send({
    type: "revise",
    runId: first.id,
    text: "完成前写一段复盘",
    operationId: "three",
  });
  const revised = await settled();
  assert.equal(revised.status, "ready");
  assert.equal(revised.plans.length, 2);
  assert.equal(revised.revisions.length, 3);
  assert.equal(revised.budget.callsUsed, 8);
  const rejected = await app.request("/api/assistant/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "confirm",
      operationId: "old-confirm",
      runId: first.id,
      planId: ready.plan.id,
      compositionRevision: 1,
    }),
  });
  assert.equal(rejected.status, 400);
  assert.equal(w.release.all().length, 2);
});

test("bounded planning, cancellation and model errors never publish or silently retry", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  let calls = 0;
  const driver: Driver = {
    async generate() {
      calls++;
      return reply("inspect_application", {});
    },
  };
  let e = new Evolution(w.db, driver, new EvolutionDomain(w), {
    calls: 2,
    candidates: 3,
    milliseconds: 60000,
  });
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await e.command({ type: "request", text: "改进", operationId: "bounded" });
  await e.close();
  assert.equal(w.composition().revision, 1);
  e = new Evolution(w.db, driver, new EvolutionDomain(w), {
    calls: 2,
    candidates: 3,
    milliseconds: 60000,
  });
  await e.command({ type: "request", text: "改进", operationId: "bounded2" });
  for (
    let i = 0;
    i < 100 && (await e.observe()).run?.status === "planning";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal((await e.observe()).run?.status, "failed");
  assert.equal((await e.observe()).run?.budget?.callsUsed, 2);
  await e.close();
  let entered!: () => void;
  const entering = new Promise<void>((r) => {
    entered = r;
  });
  e = new Evolution(
    w.db,
    {
      async generate(_r, signal) {
        entered();
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
        throw Error("cancelled");
      },
    },
    new EvolutionDomain(w),
  );
  await e.command({ type: "request", text: "改进", operationId: "cancel" });
  await entering;
  const id = (await e.observe()).run!.id;
  await assert.rejects(
    e.command({
      type: "revise",
      runId: id,
      text: "change",
      operationId: "locked",
    }),
    /完成或取消/,
  );
  await e.command({ type: "cancel", runId: id, operationId: "stop" });
  await e.close();
  assert.equal((await e.observe()).run?.status, "cancelled");
  e = new Evolution(
    w.db,
    {
      async generate() {
        throw Error("model disconnected");
      },
    },
    new EvolutionDomain(w),
  );
  await e.command({ type: "request", text: "改进", operationId: "error" });
  for (
    let i = 0;
    i < 100 && (await e.observe()).run?.status === "planning";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  const run = (await e.observe()).run!;
  assert.equal(run.status, "failed");
  if (run.status === "failed") assert.equal(run.message, "model disconnected");
  assert.equal(run.budget?.callsUsed, 1);
  assert.equal(w.composition().revision, 1);
});

test("checker name cannot certify an unsupported notification assertion", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const e = new Evolution(
    w.db,
    new PlanningDriver({
      acceptance: [
        {
          given: "用户关闭网页",
          when: "任务到期",
          then: "手机收到系统推送",
          checker: "workflow/1",
        },
      ],
    }),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: "关闭页面后提醒",
    operationId: "request",
  });
  for (
    let i = 0;
    i < 100 && (await e.observe()).run?.status === "planning";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal((await e.observe()).run?.status, "blocked");
});

for (const name of ["active-contract", "active-acceptance"])
  test(`ready requires ${name} evidence`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
    const w = await Workspace.open(join(dir, "workspace.db"));
    const fixture = new PlanningDriver();
    const driver: Driver = {
      async generate(request) {
        const result = await fixture.generate(request);
        const call = result.calls[0];
        if (call.name === "propose_plan")
          call.args.evidence = (call.args.evidence as { ref: string }[]).filter(
            (e) => e.ref !== name,
          );
        return result;
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
      text: "修改当前行为",
      operationId: "request",
    });
    for (
      let i = 0;
      i < 100 && (await e.observe()).run?.status === "planning";
      i++
    )
      await new Promise((r) => setTimeout(r, 10));
    const run = (await e.observe()).run!;
    assert.equal(run.status, "blocked");
    if (run.status === "blocked") {
      assert.ok(run.message.includes(name));
      assert.ok(run.userMessage);
      assert.ok(run.blockReason);
    }
    await e.command({ type: "cancel", runId: run.id, operationId: "cancel" });
    assert.equal((await e.observe()).run?.status, "cancelled");
  });

test("host time budget bounds even a driver that ignores cancellation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const e = new Evolution(
    w.db,
    { generate: () => new Promise(() => {}) },
    new EvolutionDomain(w),
    { calls: 12, candidates: 3, milliseconds: 20 },
  );
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await e.command({ type: "request", text: "改进", operationId: "request" });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await e.observe()).run?.status, "failed");
  assert.equal(w.composition().revision, 1);
});

test("old pending confirmation is interrupted without replay and historical run remains queryable", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  // Seed a legacy database, as an external migration fixture rather than assert private storage.
  w.db.exec(
    "CREATE TABLE evolution_runs(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE evolution_operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,runId TEXT NOT NULL);",
  );
  w.db.prepare("INSERT INTO evolution_runs VALUES(?,?)").run(
    "legacy",
    JSON.stringify({
      run: {
        id: "legacy",
        request: "旧需求",
        updatedAt: "2026-01-01",
        status: "awaiting-confirmation",
        plan: { id: "old-plan", summary: "旧方案" },
      },
      history: [],
      calls: 1,
      candidates: 0,
      elapsed: 0,
    }),
  );
  const publishedRun = {
    id: "legacy-published",
    request: "历史已发布需求",
    updatedAt: "2026-01-01",
    status: "succeeded",
    summary: "历史发布成功",
    steps: [],
    versionId: w.activeVersion().id,
  };
  w.db.prepare("INSERT INTO evolution_runs VALUES(?,?)").run(
    publishedRun.id,
    JSON.stringify({
      run: publishedRun,
      history: [],
      calls: 4,
      candidates: 1,
      elapsed: 100,
    }),
  );
  const driver = new PlanningDriver();
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.deepEqual((await e.observe(publishedRun.id)).run, publishedRun);
  const snapshot = await e.observe("legacy");
  assert.equal(snapshot.run?.status, "interrupted");
  assert.equal(snapshot.run?.request, "旧需求");
  assert.equal(snapshot.run?.historicalPlan?.id, "old-plan");
  assert.equal(driver.requests.length, 0);
  const app = createApp(w, e);
  for (const type of ["confirm", "task"]) {
    const rejected = await app.request("/api/assistant/commands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type,
        runId: "legacy",
        planId: "old-plan",
        compositionRevision: 1,
        operationId: `legacy-${type}`,
      }),
    });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, "INVALID_INPUT");
  }
  await assert.rejects(
    e.command({
      type: "start",
      runId: "legacy",
      planId: "old-plan",
      operationId: "legacy-start",
    }),
  );
  await assert.rejects(
    e.command({
      type: "apply",
      runId: "legacy",
      candidateId: "old-plan",
      evidenceHash: "old",
      compositionRevision: 1,
      operationId: "legacy-apply",
    }),
  );
  assert.equal(w.composition().revision, 1);
});

test("investigation never sends task data and operation retries return the original receipt", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const driver = new PlanningDriver();
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await w.command({
    type: "create",
    title: "synthetic-private-marker-4928",
    compositionRevision: 1,
    operationId: "task",
  });
  const cmd = {
    type: "request" as const,
    text: "完成前复盘",
    operationId: "plan",
  };
  const receipt = await e.command(cmd);
  for (
    let i = 0;
    i < 100 && (await e.observe()).run?.status === "planning";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  assert.equal((await e.observe()).run?.status, "ready");
  assert.deepEqual(await e.command(cmd), receipt);
  await assert.rejects(
    e.command({ ...cmd, text: "different" }),
    /操作标识已用于其他请求/,
  );
  assert.equal(
    JSON.stringify(driver.requests).includes("synthetic-private-marker-4928"),
    false,
  );
  assert.equal(w.query().total, 1);
});

test("rejected proposal returns diagnostics so the same bounded investigation can correct its plan", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const fixture = new PlanningDriver();
  let proposed = 0;
  const driver: Driver = {
    async generate(request) {
      const result = await fixture.generate(request);
      const call = result.calls[0];
      if (call.name === "propose_plan" && proposed++ === 0) {
        call.args.evidence = (call.args.evidence as { ref: string }[]).filter(
          (e) => e.ref === "active-source",
        );
        call.args.writableScope = [
          "active-source",
          "active-contract",
          "active-acceptance",
        ];
      }
      return result;
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
    operationId: "request",
  });
  for (
    let i = 0;
    i < 100 && (await e.observe()).run?.status === "planning";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  const run = (await e.observe()).run!;
  assert.equal(run.status, "ready");
  assert.equal(run.budget?.callsUsed, 4);
  assert.equal(run.plans?.length, 2);
  assert.equal(w.composition().revision, 1);
  assert.equal(w.release.all().length, 2);
  assert.ok(JSON.stringify(fixture.requests).includes("缺少调查证据"));
});

test("mixed conclusion tools are retried internally instead of failing the run", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const fixture = new PlanningDriver();
  let mixed = false;
  const driver: Driver = {
    async generate(request) {
      const result = await fixture.generate(request);
      if (result.calls[0].name === "propose_plan" && !mixed) {
        mixed = true;
        return {
          ...result,
          calls: [
            { name: "read_source", args: { ref: "active-source" } },
            result.calls[0],
          ],
        };
      }
      return result;
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
    operationId: "request",
  });
  for (
    let i = 0;
    i < 100 && (await e.observe()).run?.status === "planning";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  const run = (await e.observe()).run!;
  assert.equal(run.status, "ready");
  assert.equal(mixed, true);
  assert.ok(JSON.stringify(fixture.requests).includes("调查结论须单独提交"));
});

test("unavailable catalog source is a diagnostic, never read evidence or a crashed investigation", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-plan-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const fixture = new PlanningDriver();
  let attempted = false;
  const driver: Driver = {
    async generate(request) {
      const result = await fixture.generate(request);
      if (result.calls[0].name === "propose_plan" && !attempted) {
        attempted = true;
        return {
          ...result,
          calls: [{ name: "read_source", args: { ref: "../../.env" } }],
        };
      }
      return result;
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
    text: "完成前复盘",
    operationId: "request",
  });
  for (
    let i = 0;
    i < 100 && (await e.observe()).run?.status === "planning";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  const run = (await e.observe()).run!;
  assert.equal(run.status, "ready");
  assert.equal(
    run.evidence?.some((e) => e.ref === "../../.env"),
    false,
  );
  assert.equal(w.composition().revision, 1);
});

test("empty extension declaration permits a workflow-only plan", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-empty-extensions-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const e = new Evolution(
    w.db,
    new PlanningDriver({
      extensions: { actions: [], fields: [], cases: [] },
    }),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    operationId: "empty-extensions",
    text: "完成前填写复盘",
  });
  for (
    let i = 0;
    i < 100 && (await e.observe()).run?.status === "planning";
    i++
  )
    await new Promise((r) => setTimeout(r, 10));
  const run = (await e.observe()).run;
  assert.equal(run?.status, "ready", JSON.stringify(run));
  if (run?.status !== "ready") throw new Error("expected ready");
  assert.equal(run.plan.extensions, undefined);
  assert.equal(w.composition().revision, 1);
});

test("invalid plan step dependencies return bounded diagnostics before ready", async (t) => {
  for (const repeated of [false, true])
    await t.test(
      repeated ? "repeated rejection stops" : "model corrects the dependency",
      async (t) => {
        const dir = mkdtempSync(join(tmpdir(), "cordis-plan-dependency-"));
        const w = await Workspace.open(join(dir, "workspace.db"));
        const planning = new PlanningDriver();
        let proposals = 0;
        const e = new Evolution(
          w.db,
          {
            async generate(request) {
              const response = await planning.generate(request);
              if (response.calls[0]?.name === "propose_plan") {
                proposals++;
                if (proposals === 1 || repeated)
                  response.calls[0].args.steps = [
                    {
                      id: "workflow",
                      purpose: "修改工作流",
                      dependsOn: ["active-source"],
                      artifact: "业务产物",
                      evidence: "业务验收",
                    },
                  ];
              }
              return response;
            },
          },
          new EvolutionDomain(w),
        );
        t.after(async () => {
          await e.close();
          await w.close();
          rmSync(dir, { recursive: true, force: true });
        });
        await e.command({
          type: "request",
          operationId: "dependencies",
          text: "完成前填写复盘",
        });
        for (
          let i = 0;
          i < 100 && (await e.observe()).run?.status === "planning";
          i++
        )
          await new Promise((r) => setTimeout(r, 10));
        const run = (await e.observe()).run;
        assert.equal(
          run?.status,
          repeated ? "blocked" : "ready",
          JSON.stringify(run),
        );
        assert.equal(run.budget?.callsUsed, 4);
        assert.equal(run.plans?.length, 2);
        assert.equal(run.plans?.[0].steps[0].dependsOn[0], "active-source");
        assert.ok(
          JSON.stringify(planning.requests).includes("计划步骤依赖无效"),
        );
        assert.equal(w.composition().revision, 1);
      },
    );
});

test("misplaced supported action cases can be corrected with consumer investigation", async (t) => {
  for (const mode of ["correct", "repeat", "unknown"] as const)
    await t.test(mode, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "cordis-plan-action-placement-"));
      const w = await Workspace.open(join(dir, "workspace.db"));
      const planning = new PlanningDriver({
        extensions: {
          actions: [{ id: "increment", label: "增加", from: ["open"] }],
          fields: [],
          cases: [
            {
              name: "已有计数累加",
              state: "open",
              fields: { count: "7" },
              action: "increment",
              input: {},
              expected: {
                kind: "commit",
                state: "open",
                fields: { count: "8" },
              },
            },
            {
              name: "完成状态拒绝累加",
              state: "done",
              fields: { count: "7" },
              action: "increment",
              input: {},
              expected: { kind: "reject" },
            },
          ],
        },
        capabilityChanges: [
          {
            capability: "workflow",
            provider: "active-source",
            consumers: ["src/web/TaskEditor.tsx"],
            change: "增加计数动作",
          },
        ],
      });
      let proposals = 0;
      let supplemented = false;
      const e = new Evolution(
        w.db,
        {
          async generate(request) {
            if (mode === "correct" && proposals === 1 && !supplemented) {
              supplemented = true;
              return {
                text: "",
                history: request.history,
                calls: [
                  {
                    name: "read_source",
                    args: { ref: "src/web/TaskEditor.tsx" },
                  },
                ],
                usage: null,
                raw: { fixture: true },
              };
            }
            const response = await planning.generate(request);
            const proposal = response.calls.find(
              (c) => c.name === "propose_plan",
            );
            if (proposal && (++proposals === 1 || mode !== "correct")) {
              proposal.args.acceptance = [
                ...(proposal.args.acceptance as unknown[]),
                {
                  given: "open, count=7",
                  when: "increment",
                  then: "commit, count=8",
                  checker:
                    mode === "unknown"
                      ? "notification/1"
                      : "business-actions/1",
                },
              ];
            }
            return response;
          },
        },
        new EvolutionDomain(w),
      );
      t.after(async () => {
        await e.close();
        await w.close();
        rmSync(dir, { recursive: true, force: true });
      });
      await e.command({
        type: "request",
        operationId: "action-placement",
        text: "保留复盘，增加独立计数动作",
      });
      for (
        let i = 0;
        i < 100 && (await e.observe()).run?.status === "planning";
        i++
      )
        await new Promise((r) => setTimeout(r, 10));
      const snapshot = await e.observe();
      const run = snapshot.run!;
      assert.equal(
        run.status,
        mode === "correct" ? "ready" : "blocked",
        JSON.stringify(run),
      );
      assert.equal(
        run.budget?.callsUsed,
        mode === "correct" ? 5 : mode === "repeat" ? 4 : 3,
      );
      assert.equal(run.plans?.length, mode === "unknown" ? 1 : 2);
      if (mode === "correct") {
        assert.equal(run.status, "ready");
        if (run.status !== "ready") throw new Error("expected ready");
        assert.ok(run.evidence.some((e) => e.ref === "src/web/TaskEditor.tsx"));
        assert.equal(run.plan.extensions?.cases.length, 2);
        const history = JSON.stringify(planning.requests);
        assert.match(history, /extensions.cases/);
        assert.match(history, /src\/web\/TaskEditor.tsx/);
      }
      assert.equal(snapshot.candidates.length, 0);
      assert.equal(w.composition().revision, 1);
    });
});
