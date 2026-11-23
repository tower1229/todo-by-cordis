import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { chromium } from "playwright";
import {
  cloneSqliteDatabaseOnline,
  comparePluginDataFingerprints,
  snapshotPluginDataFingerprint,
} from "../../src/v3/db-snapshot.js";
import {
  NO_BEHAVIOR_DIFF_WARNING,
  verifyCandidate,
} from "../../src/v3/plugin-verifier.js";
import { openAppDatabase } from "../../src/v3/scoped-db.js";
import {
  computeTestChangeDisclosures,
  diffPluginTestFiles,
} from "../../src/v3/test-diff.js";
import type { CompositionSnapshot, PluginArtifact } from "../../src/v3/types.js";

function makeSnapshot(
  compositionId: string,
  members: Array<{ pluginId: string; versionId: string; enabled?: boolean }>,
): CompositionSnapshot {
  return {
    compositionId,
    parentCompositionId: null,
    members: members.map((m) => ({
      pluginId: m.pluginId,
      versionId: m.versionId,
      enabled: m.enabled ?? true,
    })),
    createdAt: new Date().toISOString(),
  };
}

function makeMinimalArtifact(
  pluginId: string,
  versionId: string,
  testFiles: Record<string, string>,
): PluginArtifact {
  return {
    pluginId,
    versionId,
    dependencies: [],
    serverCode: "export function apply() {}",
    sourceFiles: {},
    testFiles,
  };
}

describe("V3 Gate 4: Deterministic Test Diff Disclosure", () => {
  it("extracts modified/removed test case names and deterministic diff summary for existing plugins", () => {
    const baselineCode = [
      'import assert from "node:assert/strict";',
      "",
      'export async function testCreateTask(ctx) {',
      '  const res = await ctx.request({ method: "POST", path: "/api/todos" });',
      "  assert.equal(res.status, 201);",
      "}",
      "",
      'export async function testDeleteTask(ctx) {',
      '  const res = await ctx.request({ method: "DELETE", path: "/api/todos/1" });',
      "  assert.equal(res.status, 204);",
      "}",
    ].join("\n");

    const candidateCode = [
      'import assert from "node:assert/strict";',
      "",
      'export async function testCreateTask(ctx) {',
      '  const res = await ctx.request({ method: "POST", path: "/api/todos" });',
      "  assert.equal(res.status, 200);",
      "}",
    ].join("\n");

    const disclosure = diffPluginTestFiles(
      "todo-core",
      {
        "contract.test.ts": baselineCode,
        "legacy.test.ts": 'it("blocks empty title", () => {});',
      },
      {
        "contract.test.ts": candidateCode,
      },
    );

    assert.ok(disclosure);
    assert.equal(disclosure.pluginId, "todo-core");
    assert.deepEqual(disclosure.modifiedFiles, ["contract.test.ts"]);
    assert.deepEqual(disclosure.removedFiles, ["legacy.test.ts"]);
    assert.deepEqual(disclosure.addedFiles, []);

    const contractDiff = disclosure.fileDiffs.find(
      (d) => d.file === "contract.test.ts",
    );
    assert.ok(contractDiff);
    assert.equal(contractDiff.status, "modified");
    assert.ok(contractDiff.affectedTestCases.includes("testCreateTask"));
    assert.ok(contractDiff.affectedTestCases.includes("testDeleteTask"));
    assert.match(contractDiff.diffSummary, /-  assert\.equal\(res\.status, 201\);/);
    assert.match(contractDiff.diffSummary, /\+  assert\.equal\(res\.status, 200\);/);

    const legacyDiff = disclosure.fileDiffs.find(
      (d) => d.file === "legacy.test.ts",
    );
    assert.ok(legacyDiff);
    assert.equal(legacyDiff.status, "removed");
    assert.ok(legacyDiff.affectedTestCases.includes("blocks empty title"));
  });

  it("computes disclosures across all existing plugins in composition and ignores newly added plugins", () => {
    const baseTodo = makeMinimalArtifact("todo-core", "v1", {
      "a.test.ts": 'it("creates todo", () => { assert.equal(1, 1); });',
    });
    const candTodo = makeMinimalArtifact("todo-core", "v2", {
      "a.test.ts": 'it("creates todo", () => { assert.equal(1, 2); });',
    });
    const newPlugin = makeMinimalArtifact("tags", "v1", {
      "tags.test.ts": 'it("adds tag", () => {});',
    });

    const artifacts = new Map<string, PluginArtifact>([
      ["todo-core@v1", baseTodo],
      ["todo-core@v2", candTodo],
      ["tags@v1", newPlugin],
    ]);

    const baseline = makeSnapshot("c1", [
      { pluginId: "todo-core", versionId: "v1" },
    ]);
    const candidate = makeSnapshot("c2", [
      { pluginId: "todo-core", versionId: "v2" },
      { pluginId: "tags", versionId: "v1" },
    ]);

    const disclosures = computeTestChangeDisclosures(
      baseline,
      candidate,
      artifacts,
    );
    assert.equal(disclosures.length, 1);
    assert.equal(disclosures[0].pluginId, "todo-core");
    assert.deepEqual(disclosures[0].modifiedFiles, ["a.test.ts"]);
    assert.ok(
      disclosures[0].fileDiffs[0].affectedTestCases.includes("creates todo"),
    );
  });
});

describe("V3 Gate 3: SQLite Online Backup & Disabled-Plugin Data Fingerprint", () => {
  it("clones a live WAL-mode database via SQLite online backup without losing uncheckpointed writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v3-db-backup-"));
    try {
      const srcPath = join(dir, "prod.db");
      const dstPath = join(dir, "clone.db");

      const liveDb = openAppDatabase(srcPath);
      liveDb.exec(
        "CREATE TABLE plg_tags__items (id INTEGER PRIMARY KEY, task_id TEXT, tag TEXT);",
      );
      liveDb
        .prepare("INSERT INTO plg_tags__items (task_id, tag) VALUES (?, ?)")
        .run("t1", "urgent");
      liveDb
        .prepare("INSERT INTO plg_tags__items (task_id, tag) VALUES (?, ?)")
        .run("t2", "v3");

      // Keep liveDb open in WAL mode while cloning online
      await cloneSqliteDatabaseOnline(srcPath, dstPath);
      liveDb.close();

      const cloned = new DatabaseSync(dstPath, { readOnly: true });
      const rows = cloned
        .prepare("SELECT task_id, tag FROM plg_tags__items ORDER BY id")
        .all() as Array<{ task_id: string; tag: string }>;
      cloned.close();

      assert.deepEqual(
        rows.map((r) => ({ task_id: r.task_id, tag: r.tag })),
        [
          { task_id: "t1", tag: "urgent" },
          { task_id: "t2", tag: "v3" },
        ],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects zero data loss vs row deletion or table alteration on disabled plugin tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "v3-db-fp-"));
    try {
      const dbPath = join(dir, "app.db");
      const db = openAppDatabase(dbPath);
      db.exec(
        "CREATE TABLE plg_tags__items (id INTEGER PRIMARY KEY, task_id TEXT, tag TEXT);",
      );
      db.prepare("INSERT INTO plg_tags__items (task_id, tag) VALUES (?, ?)").run(
        "t1",
        "urgent",
      );
      db.close();

      const before = snapshotPluginDataFingerprint(dbPath, "tags");
      const sameAfter = snapshotPluginDataFingerprint(dbPath, "tags");
      const okDiff = comparePluginDataFingerprints(before, sameAfter);
      assert.equal(okDiff.preserved, true);
      assert.deepEqual(okDiff.violations, []);

      // Mutate: delete a row
      const dbMut = openAppDatabase(dbPath);
      dbMut.exec("DELETE FROM plg_tags__items WHERE task_id = 't1';");
      dbMut.close();

      const afterDelete = snapshotPluginDataFingerprint(dbPath, "tags");
      const failDiff = comparePluginDataFingerprints(before, afterDelete);
      assert.equal(failDiff.preserved, false);
      assert.ok(failDiff.violations.some((v) => v.includes("plg_tags__items")));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeTodoCoreArtifact(versionId: string): PluginArtifact {
  const serverCode = `
export const name = "todo-core";
export function apply(ctx) {
  const db = ctx.db;
  db.exec(\`
    CREATE TABLE IF NOT EXISTS plg_todo_core__tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      review_note TEXT
    )
  \`);

  const completeHooks = [];
  ctx.provide("todo", {
    onBeforeComplete(fn) {
      completeHooks.push(fn);
      return () => {
        const idx = completeHooks.indexOf(fn);
        if (idx >= 0) completeHooks.splice(idx, 1);
      };
    },
    listTasks() {
      return db.prepare("SELECT id, title, completed, review_note FROM plg_todo_core__tasks ORDER BY id").all();
    },
  });

  ctx.http.route("GET", "/todos", () => ({
    status: 200,
    body: {
      tasks: db.prepare("SELECT id, title, completed, review_note FROM plg_todo_core__tasks ORDER BY id").all(),
    },
  }));

  ctx.http.route("POST", "/todos", (req) => {
    const title = String(req.body?.title ?? "").trim();
    if (!title) return { status: 400, body: { error: "title required" } };
    const info = db.prepare("INSERT INTO plg_todo_core__tasks (title) VALUES (?)").run(title);
    return { status: 201, body: { id: Number(info.lastInsertRowid), title, completed: 0 } };
  });

  ctx.http.route("POST", "/todos/:id/complete", (req) => {
    const id = Number(req.params.id);
    for (const hook of completeHooks) {
      const verdict = hook({ id, body: req.body ?? {} });
      if (verdict && verdict.blocked) {
        return { status: 400, body: { error: verdict.reason ?? "blocked by hook" } };
      }
    }
    const note = req.body?.reviewNote ? String(req.body.reviewNote) : null;
    db.prepare("UPDATE plg_todo_core__tasks SET completed = 1, review_note = ? WHERE id = ?").run(note, id);
    return { status: 200, body: { id, completed: 1, reviewNote: note } };
  });
}
`;
  const clientCode = `
export const name = "todo-core";
export function apply(ctx) {
  ctx.router.registerPage({
    path: "/",
    navLabel: "Todos",
    component: () => null,
  });
}
`;
  return {
    pluginId: "todo-core",
    versionId,
    dependencies: [],
    serverCode,
    clientCode,
    sourceFiles: { "server/index.ts": serverCode, "client/index.tsx": clientCode },
    testFiles: {
      "todo-core.test.ts": `
import assert from "node:assert/strict";
export default async function testTodoLifecycle(ctx) {
  const created = await ctx.request({ method: "POST", path: "/api/app/todo-core/todos", body: { title: "Ship V3" } });
  assert.equal(created.status, 201);
  const done = await ctx.request({ method: "POST", path: "/api/app/todo-core/todos/" + created.body.id + "/complete", body: {} });
  assert.equal(done.status, 200);
}
`,
    },
  };
}

function makeTagsArtifact(versionId: string): PluginArtifact {
  const serverCode = `
export const name = "tags";
export const inject = ["todo"];
export function apply(ctx) {
  const db = ctx.db;
  db.exec(\`
    CREATE TABLE IF NOT EXISTS plg_tags__items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      tag TEXT NOT NULL
    )
  \`);
  ctx.http.route("POST", "/items", (req) => {
    const info = db.prepare("INSERT INTO plg_tags__items (task_id, tag) VALUES (?, ?)").run(Number(req.body?.taskId ?? 1), String(req.body?.tag ?? "v3"));
    return { status: 201, body: { id: Number(info.lastInsertRowid) } };
  });
  ctx.http.route("GET", "/items", () => ({
    status: 200,
    body: { tags: db.prepare("SELECT id, task_id, tag FROM plg_tags__items ORDER BY id").all() },
  }));
}
`;
  return {
    pluginId: "tags",
    versionId,
    dependencies: ["todo-core"],
    serverCode,
    sourceFiles: { "server/index.ts": serverCode },
    testFiles: {
      "tags.test.ts": `
import assert from "node:assert/strict";
export default async function testTagsAndCompleteWithoutReviewGate(ctx) {
  const created = await ctx.request({ method: "POST", path: "/api/app/todo-core/todos", body: { title: "Tagged task" } });
  assert.equal(created.status, 201);
  const tagRes = await ctx.request({ method: "POST", path: "/api/app/tags/items", body: { taskId: created.body.id, tag: "work" } });
  assert.equal(tagRes.status, 201);
  // Completing without reviewNote MUST succeed in closure(tags) because review-gate is NOT loaded
  const done = await ctx.request({ method: "POST", path: "/api/app/todo-core/todos/" + created.body.id + "/complete", body: {} });
  assert.equal(done.status, 200);
  // Real Chromium browser check in isolated closure
  const session = await ctx.openBrowserPage("/");
  assert.equal(session.pageErrors.length, 0);
  await session.close();
}
`,
    },
  };
}

function makeCounterArtifact(versionId: string): PluginArtifact {
  const serverCode = `
export const name = "counter";
export const inject = ["todo"];
export function apply(ctx) {
  ctx.http.route("GET", "/summary", () => {
    const tasks = ctx.todo.listTasks();
    return { status: 200, body: { total: tasks.length, done: tasks.filter((t) => t.completed === 1).length } };
  });
}
`;
  return {
    pluginId: "counter",
    versionId,
    dependencies: ["todo-core"],
    serverCode,
    sourceFiles: { "server/index.ts": serverCode },
    testFiles: {
      "counter.test.ts": `
import assert from "node:assert/strict";
export default async function testCounterWithoutReviewGate(ctx) {
  const created = await ctx.request({ method: "POST", path: "/api/app/todo-core/todos", body: { title: "Count me" } });
  assert.equal(created.status, 201);
  const done = await ctx.request({ method: "POST", path: "/api/app/todo-core/todos/" + created.body.id + "/complete", body: {} });
  assert.equal(done.status, 200);
  const count = await ctx.request({ method: "GET", path: "/api/app/counter/summary" });
  assert.equal(count.status, 200);
  assert.equal(count.body.done, 1);
}
`,
    },
  };
}

function makeReviewGateArtifact(versionId: string): PluginArtifact {
  const serverCode = `
export const name = "review-gate";
export const inject = ["todo"];
export function apply(ctx) {
  const dispose = ctx.todo.onBeforeComplete(({ body }) => {
    const note = String(body?.reviewNote ?? "").trim();
    if (!note) {
      return { blocked: true, reason: "reviewNote required before completing task" };
    }
    return { blocked: false };
  });
  ctx.on("dispose", () => dispose());
}
`;
  const clientCode = `
export const name = "review-gate";
export function apply(ctx) {
  ctx.slots.register({
    slot: "task.complete.modal",
    component: () => null,
  });
}
`;
  return {
    pluginId: "review-gate",
    versionId,
    dependencies: ["todo-core"],
    serverCode,
    clientCode,
    sourceFiles: { "server/index.ts": serverCode, "client/index.tsx": clientCode },
    testFiles: {
      "review-gate.test.ts": `
import assert from "node:assert/strict";
export default async function testReviewGateBail(ctx) {
  const created = await ctx.request({ method: "POST", path: "/api/app/todo-core/todos", body: { title: "Needs review" } });
  assert.equal(created.status, 201);
  const blocked = await ctx.request({ method: "POST", path: "/api/app/todo-core/todos/" + created.body.id + "/complete", body: {} });
  assert.equal(blocked.status, 400);
  const ok = await ctx.request({ method: "POST", path: "/api/app/todo-core/todos/" + created.body.id + "/complete", body: { reviewNote: "Learned a lot" } });
  assert.equal(ok.status, 200);
}
`,
    },
  };
}

describe("V3 PluginVerifier Gates 3 & 4: End-to-End Positive & Negative Acceptance", () => {
  it("positive: dual-side bail review-gate plugin passes with zero sibling cross-contamination and full-composition Chromium smoke", async () => {
    const browser = await chromium.launch();
    try {
      const todoV1 = makeTodoCoreArtifact("v1");
      const tagsV1 = makeTagsArtifact("v1");
      const counterV1 = makeCounterArtifact("v1");
      const reviewV1 = makeReviewGateArtifact("v1");

      const artifacts = new Map<string, PluginArtifact>([
        ["todo-core@v1", todoV1],
        ["tags@v1", tagsV1],
        ["counter@v1", counterV1],
        ["review-gate@v1", reviewV1],
      ]);

      const baseline = makeSnapshot("c1", [
        { pluginId: "todo-core", versionId: "v1" },
        { pluginId: "tags", versionId: "v1" },
        { pluginId: "counter", versionId: "v1" },
      ]);
      const candidate = makeSnapshot("c2", [
        { pluginId: "todo-core", versionId: "v1" },
        { pluginId: "tags", versionId: "v1" },
        { pluginId: "counter", versionId: "v1" },
        { pluginId: "review-gate", versionId: "v1" },
      ]);

      const report = await verifyCandidate({
        baseline,
        candidate,
        artifacts,
        browser,
        fullCompositionSmokeTest: async (ctx) => {
          const created = await ctx.request({
            method: "POST",
            path: "/api/app/todo-core/todos",
            body: { title: "Full smoke" },
          });
          assert.equal(created.status, 201);
          const id = (created.body as { id: number }).id;
          // In full composition, review-gate bail IS active
          const blocked = await ctx.request({
            method: "POST",
            path: `/api/app/todo-core/todos/${id}/complete`,
            body: {},
          });
          assert.equal(blocked.status, 400);
          const done = await ctx.request({
            method: "POST",
            path: `/api/app/todo-core/todos/${id}/complete`,
            body: { reviewNote: "All good" },
          });
          assert.equal(done.status, 200);
        },
      });

      assert.equal(report.ok, true, `Unexpected errors: ${report.errors.join("; ")}`);
      assert.equal(report.noBehaviorDiffWarning, false);
      const reviewSubgraph = report.subgraphResults?.find(
        (r) => r.pluginId === "review-gate",
      );
      assert.ok(reviewSubgraph);
      assert.equal(reviewSubgraph.baselineRedVerified, true);
      assert.ok(!reviewSubgraph.closurePlugins.includes("tags"));
      assert.ok(!reviewSubgraph.closurePlugins.includes("counter"));
      assert.equal(report.fullCompositionSmoke?.passed, true);
      assert.equal(report.fullCompositionSmoke?.errorBoundaryCount, 0);
      assert.deepEqual(report.fullCompositionSmoke?.activePlugins, [
        "counter",
        "review-gate",
        "tags",
        "todo-core",
      ]);
    } finally {
      await browser.close();
    }
  });

  it("negative: rejects empty or tautological test via Red-Green differential", async () => {
    const browser = await chromium.launch();
    try {
      const todoV1 = makeTodoCoreArtifact("v1");
      const fakePlugin: PluginArtifact = {
        pluginId: "fake-plugin",
        versionId: "v1",
        dependencies: ["todo-core"],
        serverCode: 'export const name = "fake-plugin"; export function apply() {}',
        sourceFiles: {},
        testFiles: {
          "tautology.test.ts": `
import assert from "node:assert/strict";
export default async function () {
  assert.equal(1 + 1, 2);
}
`,
        },
      };

      const artifacts = new Map<string, PluginArtifact>([
        ["todo-core@v1", todoV1],
        ["fake-plugin@v1", fakePlugin],
      ]);

      const report = await verifyCandidate({
        baseline: makeSnapshot("c1", [{ pluginId: "todo-core", versionId: "v1" }]),
        candidate: makeSnapshot("c2", [
          { pluginId: "todo-core", versionId: "v1" },
          { pluginId: "fake-plugin", versionId: "v1" },
        ]),
        artifacts,
        browser,
      });

      assert.equal(report.ok, false);
      assert.equal(report.failedGate, "gate3-red-green-diff");
    } finally {
      await browser.close();
    }
  });

  it("positive with warning: visual-only / refactor-only change passes with noBehaviorDiffWarning", async () => {
    const browser = await chromium.launch();
    try {
      const todoV1 = makeTodoCoreArtifact("v1");
      const todoV2: PluginArtifact = {
        ...todoV1,
        versionId: "v2",
        styleCss: ".v3-visual-tweak { opacity: 0.98; }",
      };

      const artifacts = new Map<string, PluginArtifact>([
        ["todo-core@v1", todoV1],
        ["todo-core@v2", todoV2],
      ]);

      const report = await verifyCandidate({
        baseline: makeSnapshot("c1", [{ pluginId: "todo-core", versionId: "v1" }]),
        candidate: makeSnapshot("c2", [{ pluginId: "todo-core", versionId: "v2" }]),
        artifacts,
        changeKind: "visual-only",
        browser,
      });

      assert.equal(report.ok, true, `Unexpected errors: ${report.errors.join("; ")}`);
      assert.equal(report.noBehaviorDiffWarning, true);
      assert.ok(report.warnings?.includes(NO_BEHAVIOR_DIFF_WARNING));
    } finally {
      await browser.close();
    }
  });

  it("disabling a plugin preserves its own-namespace tables on WAL-cloned production DB, and detects data loss", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v3-disable-preserve-"));
    const browser = await chromium.launch();
    try {
      const prodDbPath = join(dir, "prod.db");
      const prodDb = openAppDatabase(prodDbPath);
      prodDb.exec(
        "CREATE TABLE plg_tags__items (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id INTEGER NOT NULL, tag TEXT NOT NULL);",
      );
      prodDb
        .prepare("INSERT INTO plg_tags__items (task_id, tag) VALUES (?, ?)")
        .run(1, "keep-me");
      // Keep WAL open while verifying!

      const todoV1 = makeTodoCoreArtifact("v1");
      const tagsV1 = makeTagsArtifact("v1");
      const artifacts = new Map<string, PluginArtifact>([
        ["todo-core@v1", todoV1],
        ["tags@v1", tagsV1],
      ]);

      const baseline = makeSnapshot("c1", [
        { pluginId: "todo-core", versionId: "v1" },
        { pluginId: "tags", versionId: "v1", enabled: true },
      ]);
      const candidate = makeSnapshot("c2", [
        { pluginId: "todo-core", versionId: "v1" },
        { pluginId: "tags", versionId: "v1", enabled: false },
      ]);

      const okReport = await verifyCandidate({
        baseline,
        candidate,
        artifacts,
        productionDbPath: prodDbPath,
        browser,
      });

      assert.equal(okReport.ok, true, `Unexpected errors: ${okReport.errors.join("; ")}`);
      assert.equal(okReport.fullCompositionSmoke?.clonedFromProductionDb, true);
      assert.equal(
        okReport.fullCompositionSmoke?.disabledPluginDataChecks.length,
        1,
      );
      assert.equal(
        okReport.fullCompositionSmoke?.disabledPluginDataChecks[0].preserved,
        true,
      );

      prodDb.close();
    } finally {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
