import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import {
  source,
  candidateSource,
  candidateScope,
} from "./evolution-fixture.js";
// Release regression remains at the public candidate/activation boundary; old
// Agent confirm-and-auto-apply is intentionally no longer a supported path.
async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "cordis-release-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const domain = new EvolutionDomain(w);
  t.after(async () => {
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { w, domain };
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
test("generated versions evolve in place; restart and restore preserve current data", async (t) => {
  const { w, domain } = await setup(t);
  const task = (
    await w.command({
      type: "create",
      title: "existing",
      compositionRevision: 1,
      operationId: randomUUID(),
    })
  ).task!;
  const first = await domain.candidate(
    candidateSource(source("reflection")),
    target(w),
    new AbortController().signal,
    () => {},
  );
  await w.activate(
    { versionId: first, compositionRevision: 1, operationId: randomUUID() },
    () => {},
  );
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
  await action({ reflection: "短文" });
  await action(undefined, "reopen");
  const second = await domain.candidate(
    candidateSource(source("reflection", "Reflection", 10)),
    target(w, 10),
    new AbortController().signal,
    () => {},
  );
  await w.activate(
    { versionId: second, compositionRevision: 2, operationId: randomUUID() },
    () => {},
  );
  assert.equal(w.activeVersion().parentId, first);
  await assert.rejects(action({ reflection: "太短" }), /字数/);
  await action({ reflection: "今天已经完成了全部的任务" });
  await w.activate({
    versionId: first,
    compositionRevision: 3,
    operationId: randomUUID(),
  });
  await w.restart();
  assert.equal(w.read(task.id).fields.reflection, "今天已经完成了全部的任务");
  assert.equal(w.activeVersion().id, first);
});
for (const [name, code] of [
  ["build", "export default broken source"],
  ["behavior", source("reflection").replace("length<1", "length<99")],
  [
    "loop",
    source("reflection").replace(
      "const value=input",
      "while(true){}; const value=input",
    ),
  ],
])
  test(`candidate ${name} failure retains active version`, async (t) => {
    const { w, domain } = await setup(t);
    await assert.rejects(
      domain.candidate(
        candidateSource(code),
        target(w),
        new AbortController().signal,
        () => {},
      ),
    );
    assert.equal(w.composition().revision, 1);
    assert.equal(w.composition().status, "ready");
  });
for (const stage of ["prepared", "transaction", "switched"])
  test(`release crash at ${stage} reconciles committed version`, async (t) => {
    const { fork } = await import("node:child_process");
    const { once } = await import("node:events");
    const dir = mkdtempSync(join(tmpdir(), "cordis-crash-"));
    const file = join(dir, "workspace.db");
    let w = await Workspace.open(file);
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
    t.after(async () => {
      await w.close();
      rmSync(dir, { recursive: true, force: true });
    });
    assert.equal(w.composition().revision, stage === "switched" ? 2 : 1);
    assert.equal(w.composition().status, "ready");
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
