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
    if (run.status === "blocked")
      assert.ok(run.message.includes(message), run.message);
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
  assert.equal(rejected.status, 409);
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
    if (run.status === "blocked") assert.ok(run.message.includes(name));
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
  const driver = new PlanningDriver();
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const snapshot = await e.observe("legacy");
  assert.equal(snapshot.run?.status, "interrupted");
  assert.equal(snapshot.run?.request, "旧需求");
  assert.equal(driver.requests.length, 0);
  await assert.rejects(
    e.command({
      type: "confirm",
      runId: "legacy",
      planId: "old-plan",
      compositionRevision: 1,
      operationId: "legacy-confirm",
    }),
    /仅支持需求调查/,
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
