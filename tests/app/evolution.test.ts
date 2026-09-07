import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { FixtureDriver, proposal, source } from "./evolution-fixture.js";
import type { Driver } from "../../src/evolution/driver.js";
async function setup(t: TestContext, driver: Driver = new FixtureDriver()) {
  const dir = mkdtempSync(join(tmpdir(), "cordis-m2-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const domain = new EvolutionDomain(w);
  const e = new Evolution(w.db, driver, domain);
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { w, e, domain, dir };
}
export async function wait(e: Evolution) {
  for (let i = 0; i < 2000; i++) {
    const run = (await e.observe()).run!;
    if (!["planning", "executing"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
}
async function plan(e: Evolution) {
  await e.command({
    type: "request",
    text: "test fixture request",
    operationId: randomUUID(),
  });
  const run = await wait(e);
  assert.equal(run.status, "awaiting-confirmation");
  if (run.status !== "awaiting-confirmation") throw new Error("no plan");
  return {
    type: "confirm" as const,
    runId: run.id,
    planId: run.plan.id,
    compositionRevision: run.plan.compositionRevision,
    operationId: randomUUID(),
  };
}
test(
  "generated versions evolve in place; confirmation, restart and restore preserve data",
  { timeout: 30000 },
  async (t) => {
    const driver = new FixtureDriver();
    const { w, e } = await setup(t, driver);
    const task = (
      await w.command({
        type: "create",
        title: "existing",
        compositionRevision: 1,
        operationId: randomUUID(),
      })
    ).task!;
    const confirm = await plan(e);
    assert.equal(w.composition().revision, 1);
    assert.equal(w.release.all().length, 2);
    await assert.rejects(e.command({ ...confirm, planId: "wrong" }), /不一致/);
    await e.command(confirm);
    await e.command(confirm);
    await e.command({ ...confirm, operationId: randomUUID() });
    assert.equal((await wait(e)).status, "succeeded");
    const first = w.activeVersion();
    assert.equal(w.composition().revision, 2);
    const action = (input?: Record<string, string>, actionId = "complete") =>
      w.command({
        type: "action",
        taskId: task.id,
        expectedRevision: w.read(task.id).revision,
        compositionRevision: w.composition().revision,
        operationId: randomUUID(),
        actionId,
        input,
      });
    assert.equal((await action()).decision?.kind, "input-required");
    assert.equal(w.read(task.id).revision, 1);
    await action({ reflection: "短文" });
    await action(undefined, "reopen");
    driver.planning = proposal(true, first.pluginId, 10);
    await e.command(await plan(e));
    assert.equal((await wait(e)).status, "succeeded");
    const second = w.activeVersion();
    assert.equal(second.parentId, first.id);
    assert.equal(second.pluginId, first.pluginId);
    assert.notEqual(second.source, first.source);
    await assert.rejects(action({ reflection: "太短" }), /字数/);
    await action({ reflection: "今天已经完成了全部的任务" });
    await w.activate({
      versionId: first.id,
      compositionRevision: 3,
      operationId: randomUUID(),
    });
    await w.restart();
    assert.equal(w.read(task.id).fields.reflection, "今天已经完成了全部的任务");
    assert.equal(w.activeVersion().id, first.id);
    assert.equal(
      w.db.prepare("SELECT count(*) AS n FROM evolution_calls").get()!.n,
      4,
    );
    assert.equal(readFileSync(first.entry, "utf8"), first.code);
  },
);
test("task routing uses commands, clarification creates no artifact, stale confirmation is rejected", async (t) => {
  const driver = new FixtureDriver({
    ...proposal(),
    route: "task",
    command: { type: "create", title: "model task" },
  });
  const { w, e } = await setup(t, driver);
  await e.command(await plan(e));
  assert.equal((await wait(e)).status, "succeeded");
  assert.equal(w.query().total, 1);
  assert.equal(w.release.all().length, 2);
  driver.planning = { route: "clarify", question: "哪一条任务？" };
  await e.command({
    type: "request",
    text: "改一下",
    operationId: randomUUID(),
  });
  assert.equal((await wait(e)).status, "awaiting-input");
  await e.command({
    type: "cancel",
    runId: (await e.observe()).run!.id,
    operationId: randomUUID(),
  });
  driver.planning = proposal();
  const confirm = await plan(e);
  await w.activate({
    workflowId: "default",
    compositionRevision: 1,
    operationId: randomUUID(),
  });
  await assert.rejects(e.command(confirm), /基础版本已变化/);
  assert.equal(w.composition().revision, 2);
});
for (const [name, generate] of [
  ["build", () => "export default this is broken"],
  [
    "behavior",
    (id: string, name: string) =>
      source(id, name).replace("length<1", "length<99"),
  ],
  [
    "loop",
    (id: string, name: string) =>
      source(id, name).replace(
        "const value=input",
        "while(true){}; const value=input",
      ),
  ],
] as const)
  test(
    `candidate ${name} failure keeps old runtime`,
    { timeout: 20000 },
    async (t) => {
      const { w, e } = await setup(t, new FixtureDriver(proposal(), generate));
      await e.command(await plan(e));
      const run = await wait(e);
      assert.equal(run.status, "failed");
      assert.equal(w.composition().revision, 1);
      assert.equal(w.composition().status, "ready");
      assert.ok(
        w.db.prepare("SELECT * FROM evolution_candidates").all().length,
      );
    },
  );
test("disconnect, cancellation and interruption never publish or replay model calls", async (t) => {
  let calls = 0;
  const driver: Driver = {
    async generate(_request, signal) {
      calls++;
      await new Promise<void>((_r, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      throw new Error("disconnected");
    },
  };
  const { w, e, domain } = await setup(t, driver);
  const request = {
    type: "request" as const,
    text: "change",
    operationId: randomUUID(),
  };
  await e.command(request);
  await e.command(request);
  await new Promise((r) => setTimeout(r, 20));
  await e.command({
    type: "cancel",
    runId: (await e.observe()).run!.id,
    operationId: randomUUID(),
  });
  await e.close();
  assert.equal((await e.observe()).run!.status, "cancelled");
  assert.equal(calls, 1);
  assert.equal(w.composition().revision, 1);
  // Persist an interrupted phase exactly as an abrupt exit would leave it.
  const row = w.db.prepare("SELECT id,body FROM evolution_runs").get()!;
  const record = JSON.parse(String(row.body));
  record.run.status = "executing";
  w.db
    .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
    .run(JSON.stringify(record), row.id);
  const restarted = new Evolution(w.db, driver, domain);
  assert.equal((await restarted.observe()).run!.status, "failed");
  assert.equal(calls, 1);
  await restarted.close();
  const disconnected = new Evolution(
    w.db,
    {
      async generate() {
        throw new Error("model disconnected");
      },
    },
    domain,
  );
  await disconnected.command({ ...request, operationId: randomUUID() });
  assert.equal((await wait(disconnected)).status, "failed");
  assert.equal(w.composition().revision, 1);
  await disconnected.close();
});

for (const stage of ["prepared", "transaction", "switched"])
  test(
    `M2 real host crash at ${stage} reconciles committed run and version`,
    { timeout: 20000 },
    async (t) => {
      const { fork } = await import("node:child_process");
      const { once } = await import("node:events");
      const dir = mkdtempSync(join(tmpdir(), "cordis-m2-crash-"));
      const file = join(dir, "workspace.db");
      let w = await Workspace.open(file);
      const task = (
        await w.command({
          type: "create",
          title: "survives crash",
          compositionRevision: 1,
          operationId: randomUUID(),
        })
      ).task!;
      await w.close();
      const child = fork(
        new URL("./evolution-crash-fixture.ts", import.meta.url),
        [file, stage],
        {
          execArgv: ["--import", "tsx"],
          stdio: ["ignore", "ignore", "ignore", "ipc"],
        },
      );
      const [code] = await once(child, "exit");
      assert.equal(code, 17);
      w = await Workspace.open(file);
      const driver = new FixtureDriver();
      const e = new Evolution(w.db, driver, new EvolutionDomain(w));
      t.after(async () => {
        await e.close();
        await w.close();
        rmSync(dir, { recursive: true, force: true });
      });
      assert.equal(w.composition().revision, stage === "switched" ? 2 : 1);
      assert.equal(
        (await e.observe()).run!.status,
        stage === "switched" ? "succeeded" : "failed",
      );
      assert.equal(w.read(task.id).title, task.title);
      assert.equal(driver.requests.length, 0);
    },
  );

test("run bounds cap candidates and model calls; cancelling a pending plan issues no call", async (t) => {
  const { w, e, domain } = await setup(t);
  const confirm = await plan(e);
  await e.command({
    type: "cancel",
    runId: confirm.runId,
    operationId: randomUUID(),
  });
  await assert.rejects(e.command(confirm), /失效/);
  let count = 0;
  const fixture = new FixtureDriver();
  const driver: Driver = {
    async generate(request, signal) {
      count++;
      if (request.schema) return fixture.generate(request, signal);
      return {
        text: "",
        history: [],
        calls: [{ name: "read_contract", args: {} }],
        usage: null,
        raw: { fixture: true },
      };
    },
  };
  const bounded = new Evolution(w.db, driver, domain, {
    calls: 3,
    candidates: 3,
    milliseconds: 60000,
  });
  await bounded.command(await plan(bounded));
  assert.equal((await wait(bounded)).status, "failed");
  assert.equal(count, 3);
  await bounded.close();
  let attempts = 0;
  const bad: Driver = {
    async generate(request, signal) {
      if (request.schema) return fixture.generate(request, signal);
      attempts++;
      return {
        text: "",
        history: [],
        calls: [{ name: "submit_candidate", args: { source: "broken" } }],
        usage: null,
        raw: { fixture: true },
      };
    },
  };
  const candidates = new Evolution(w.db, bad, domain);
  await candidates.command(await plan(candidates));
  assert.equal((await wait(candidates)).status, "failed");
  assert.equal(attempts, 3);
  assert.equal(w.composition().revision, 1);
  await candidates.close();
});

test("cancellation during generation and stale application cannot switch versions", async (t) => {
  const fixture = new FixtureDriver();
  let generating!: () => void;
  const entered = new Promise<void>((r) => {
    generating = r;
  });
  const driver: Driver = {
    async generate(request, signal) {
      if (request.schema) return fixture.generate(request, signal);
      generating();
      await new Promise<void>((_r, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        }),
      );
      throw new Error("cancelled");
    },
  };
  const { w, e, domain } = await setup(t, driver);
  const confirm = await plan(e);
  await e.command(confirm);
  await entered;
  await e.command({
    type: "cancel",
    runId: confirm.runId,
    operationId: randomUUID(),
  });
  await e.close();
  assert.equal(w.composition().revision, 1);
  const parsed = domain.parse(proposal());
  assert.ok("target" in parsed);
  if (!("target" in parsed)) return;
  const target = parsed.target;
  const goal = target.payload as { pluginId: string; name: string };
  const id = await domain.candidate(
    source(goal.pluginId, goal.name),
    target,
    new AbortController().signal,
    () => {},
  );
  await w.activate({
    workflowId: "default",
    compositionRevision: 1,
    operationId: randomUUID(),
  });
  await assert.rejects(
    domain.apply(
      id,
      target,
      1,
      randomUUID(),
      () => {},
      new AbortController().signal,
    ),
    /基础版本已变化/,
  );
  assert.equal(w.composition().workflow.id, "default");
});

test("M1 database migration preserves tasks, field data and operation receipts", async (t) => {
  const { DatabaseSync } = await import("node:sqlite");
  const { operationHash } = await import("../../src/release/storage.js");
  const dir = mkdtempSync(join(tmpdir(), "cordis-legacy-"));
  const file = join(dir, "workspace.db");
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE workspace(id INTEGER PRIMARY KEY,revision INTEGER,workflowId TEXT,buildHash TEXT); INSERT INTO workspace VALUES(1,7,'review','old');
    CREATE TABLE releases(id INTEGER PRIMARY KEY,workflowId TEXT,createdAt TEXT,pausedMs REAL,preparationMs REAL,buildHash TEXT); INSERT INTO releases VALUES(7,'review','2026-01-01',0,1,'old');
    CREATE TABLE tasks(id TEXT PRIMARY KEY,title TEXT,description TEXT,state TEXT,revision INTEGER,createdAt TEXT,updatedAt TEXT,deletedAt TEXT,fields TEXT);
    INSERT INTO tasks VALUES('legacy','Legacy','','done',2,'2026-01-01','2026-01-01',NULL,'{"review":"历史文本"}');
    CREATE TABLE operations(id TEXT PRIMARY KEY,hash TEXT,result TEXT);`);
  const command = {
    type: "create" as const,
    title: "Old",
    operationId: "legacy-op",
    compositionRevision: 1,
  };
  db.prepare("INSERT INTO operations VALUES(?,?,?)").run(
    command.operationId,
    operationHash(command),
    '{"task":{"id":"receipt"}}',
  );
  db.close();
  const w = await Workspace.open(file);
  t.after(async () => {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(w.composition().revision, 7);
  assert.equal(w.read("legacy").fields.review, "历史文本");
  assert.equal((await w.command(command)).task!.id, "receipt");
  await w.activate({
    versionId: w.previousVersionId(),
    compositionRevision: 7,
    operationId: randomUUID(),
  });
  assert.equal(w.read("legacy").fields.review, "历史文本");
});

test("clarifications continue the same run and retain its model-call budget", async (t) => {
  const driver = new FixtureDriver({ route: "clarify", question: "哪一项？" });
  const { w, e } = await setup(t, driver);
  await e.command({ type: "request", text: "修改", operationId: randomUUID() });
  const first = await wait(e);
  assert.equal(first.status, "awaiting-input");
  driver.planning = proposal();
  await e.command({
    type: "request",
    text: "完成前复盘",
    runId: first.id,
    operationId: randomUUID(),
  });
  const continued = await wait(e);
  assert.equal(continued.id, first.id);
  assert.equal(continued.status, "awaiting-confirmation");
  assert.equal(
    w.db.prepare("SELECT count(*) AS n FROM evolution_runs").get()!.n,
    1,
  );
  assert.equal(
    JSON.parse(
      String(w.db.prepare("SELECT body FROM evolution_runs").get()!.body),
    ).calls,
    2,
  );
});
