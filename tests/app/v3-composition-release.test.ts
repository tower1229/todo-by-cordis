import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import {
  CompositionRelease,
  ReleaseConflictError,
  ReleaseError,
} from "../../src/v3/composition-release.js";
import { ControlStore } from "../../src/v3/control-store.js";
import { PreviewSessionHost } from "../../src/v3/preview-session.js";
import type { VerificationReport } from "../../src/v3/plugin-verifier.js";
import type { CompositionSnapshot, PluginArtifact } from "../../src/v3/types.js";

function makeTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeArtifact(pluginId: string, versionId: string): PluginArtifact {
  return {
    pluginId,
    versionId,
    name: pluginId,
    dependencies: [],
    contractTypes: "",
    serverCode: `export const name = ${JSON.stringify(pluginId)}; export function apply() {}`,
    sourceFiles: { "server.ts": "export function apply() {}" },
    testFiles: {},
  };
}

describe("V3 ControlStore (control.db)", () => {
  it("persists immutable artifacts, composition history, active pointer, and enforces optimistic lock across reopen", () => {
    const dir = makeTempDir("v3-control-store-");
    const controlDbPath = join(dir, "control.db");

    try {
      const store = new ControlStore(controlDbPath);
      const art1 = makeArtifact("todo-core", "v1");
      const art2 = makeArtifact("todo-core", "v2");
      store.saveArtifact(art1);
      store.saveArtifact(art2);
      // Idempotent save of identical artifact
      store.saveArtifact(art1);

      const comp1: CompositionSnapshot = {
        compositionId: "comp-1",
        parentCompositionId: null,
        members: [{ pluginId: "todo-core", versionId: "v1", enabled: true }],
        createdAt: "2026-11-23T00:00:00.000Z",
      };
      const comp2: CompositionSnapshot = {
        compositionId: "comp-2",
        parentCompositionId: "comp-1",
        members: [{ pluginId: "todo-core", versionId: "v2", enabled: true }],
        createdAt: "2026-11-23T00:01:00.000Z",
      };

      const initOk = store.compareAndSetActiveComposition(null, {
        ...comp1,
        kind: "initial",
      });
      assert.equal(initOk.committed, true);
      assert.equal(store.getActiveCompositionId(), "comp-1");

      // Stale expected base fails optimistic lock
      const staleResult = store.compareAndSetActiveComposition("comp-wrong", {
        ...comp2,
        kind: "apply",
      });
      assert.equal(staleResult.committed, false);
      assert.equal(staleResult.actualActiveCompositionId, "comp-1");
      assert.equal(store.getActiveCompositionId(), "comp-1");

      // Matching expected base succeeds
      const applyOk = store.compareAndSetActiveComposition("comp-1", {
        ...comp2,
        kind: "apply",
      });
      assert.equal(applyOk.committed, true);
      assert.equal(store.getActiveCompositionId(), "comp-2");
      store.close();

      // Reopen from disk to verify persistence
      const reopened = new ControlStore(controlDbPath);
      assert.equal(reopened.getActiveCompositionId(), "comp-2");
      assert.deepEqual(
        reopened.getActiveComposition()?.members,
        comp2.members,
      );
      assert.equal(reopened.listCompositions().length, 2);
      assert.equal(reopened.getArtifact("todo-core", "v1")?.versionId, "v1");
      assert.equal(reopened.getArtifact("todo-core", "v2")?.versionId, "v2");
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function makeTaskPluginArtifact(
  versionId: string,
  bannerText: string,
): PluginArtifact {
  const serverCode = `
export const name = "todo-core";
export function apply(ctx) {
  const db = ctx.db;
  db.exec(\`
    CREATE TABLE IF NOT EXISTS plg_todo_core__tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL
    );
  \`);
  ctx.http.route("GET", "/tasks", () => {
    const rows = db.prepare("SELECT id, title FROM plg_todo_core__tasks ORDER BY id ASC").all();
    return { status: 200, body: { version: ${JSON.stringify(versionId)}, banner: ${JSON.stringify(bannerText)}, tasks: rows } };
  });
  ctx.http.route("POST", "/tasks", (req) => {
    const title = req.body && typeof req.body.title === "string" ? req.body.title : "untitled";
    const info = db.prepare("INSERT INTO plg_todo_core__tasks (title) VALUES (?)").run(title);
    return { status: 201, body: { id: Number(info.lastInsertRowid), title } };
  });
}
`;
  return {
    pluginId: "todo-core",
    versionId,
    name: "todo-core",
    dependencies: [],
    contractTypes: "",
    serverCode,
    sourceFiles: { "server.ts": serverCode },
    testFiles: {},
  };
}

function makePassingReport(overrides?: Partial<VerificationReport>): VerificationReport {
  return {
    ok: true,
    errors: [],
    staticViolations: [],
    dagViolations: [],
    probedPlugins: ["todo-core"],
    ablationResults: [],
    testChangeDisclosures: [],
    ...overrides,
  };
}

describe("V3 CompositionRelease lifecycle", () => {
  it("isolates preview DB from production, enforces optimistic lock, hot-swaps on apply, preserves data on rollback, and recovers on restart", async () => {
    const dir = makeTempDir("v3-release-lifecycle-");
    const controlDbPath = join(dir, "control.db");
    const businessDbPath = join(dir, "business.db");
    const workDir = join(dir, "work");

    const artV1 = makeTaskPluginArtifact("v1", "V1 Banner");
    const artV2 = makeTaskPluginArtifact("v2", "V2 Banner");

    const compV1: CompositionSnapshot = {
      compositionId: "comp-v1",
      parentCompositionId: null,
      members: [{ pluginId: "todo-core", versionId: "v1", enabled: true }],
      createdAt: "2026-11-23T00:00:00.000Z",
    };

    const compV2: CompositionSnapshot = {
      compositionId: "comp-v2",
      parentCompositionId: "comp-v1",
      members: [{ pluginId: "todo-core", versionId: "v2", enabled: true }],
      createdAt: "2026-11-23T00:05:00.000Z",
    };

    let release: CompositionRelease | null = new CompositionRelease({
      controlDbPath,
      businessDbPath,
      workDir,
      enablePreviewClientHost: false,
    });

    try {
      await release.bootstrap({
        composition: compV1,
        artifacts: [artV1],
        summary: "初始 V1 组合",
      });

      // Seed production task in business.db
      const seedRes = await release.runtime.handleHttpRequest({
        method: "POST",
        path: "/api/app/todo-core/tasks",
        body: { title: "Production Task 1" },
      });
      assert.equal(seedRes.status, 201);

      // Register unverified candidate -> preview & apply must reject
      const badReceipt = release.registerVerifiedCandidate({
        candidateId: "cand-bad",
        baseCompositionId: "comp-v1",
        candidateComposition: compV2,
        artifacts: [artV2],
        verificationReport: makePassingReport({ ok: false, errors: ["gate failed"] }),
      });
      assert.equal(badReceipt.status, "rejected");
      await assert.rejects(
        () => release!.openPreview("cand-bad"),
        (err: unknown) => err instanceof ReleaseError && err.statusCode === 400,
      );
      await assert.rejects(
        () =>
          release!.apply({
            candidateId: "cand-bad",
            expectedBaseCompositionId: "comp-v1",
          }),
        (err: unknown) => err instanceof ReleaseError && err.statusCode === 400,
      );

      // Register verified candidate
      const receipt = release.registerVerifiedCandidate({
        candidateId: "cand-v2",
        baseCompositionId: "comp-v1",
        candidateComposition: compV2,
        artifacts: [artV2],
        verificationReport: makePassingReport({ noBehaviorDiffWarning: true }),
      });
      assert.equal(receipt.status, "verified");
      assert.equal(receipt.changeBrief.noBehaviorDiffWarning, true);
      assert.equal(receipt.changeBrief.affectedPlugins[0]?.action, "upgraded");

      // Open isolated preview session
      const preview = await release.openPreview("cand-v2");
      const previewTempDir = dirname(preview.previewDbPath);
      assert.equal(existsSync(preview.previewDbPath), true);

      // Preview sees cloned production task and V2 banner
      const previewListRes = await fetch(`${preview.previewUrl}/api/app/todo-core/tasks`);
      assert.equal(previewListRes.status, 200);
      const previewList = (await previewListRes.json()) as {
        version: string;
        tasks: Array<{ title: string }>;
      };
      assert.equal(previewList.version, "v2");
      assert.deepEqual(
        previewList.tasks.map((t) => t.title),
        ["Production Task 1"],
      );

      // Write inside preview -> must NOT pollute production business.db
      const previewPost = await fetch(`${preview.previewUrl}/api/app/todo-core/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Preview Only Task" }),
      });
      assert.equal(previewPost.status, 201);

      const prodCheckRes = await release.runtime.handleHttpRequest({
        method: "GET",
        path: "/api/app/todo-core/tasks",
      });
      const prodCheckBody = prodCheckRes.body as {
        version: string;
        tasks: Array<{ title: string }>;
      };
      assert.equal(prodCheckBody.version, "v1");
      assert.deepEqual(
        prodCheckBody.tasks.map((t) => t.title),
        ["Production Task 1"],
      );

      // Optimistic lock: stale expectedBaseCompositionId must be rejected (409)
      await assert.rejects(
        () =>
          release!.apply({
            candidateId: "cand-v2",
            expectedBaseCompositionId: "comp-stale",
          }),
        (err: unknown) =>
          err instanceof ReleaseConflictError && err.statusCode === 409,
      );
      assert.equal(release.controlStore.getActiveCompositionId(), "comp-v1");

      // Apply with matching base -> hot-swaps in-process & cleans up preview session
      const applied = await release.apply({
        candidateId: "cand-v2",
        expectedBaseCompositionId: "comp-v1",
      });
      assert.equal(applied.health.mode, "in-process-hot-swap");
      assert.equal(applied.composition.compositionId, "comp-v2");
      assert.equal(existsSync(previewTempDir), false);

      // Add a new task in V2 production
      const v2TaskRes = await release.runtime.handleHttpRequest({
        method: "POST",
        path: "/api/app/todo-core/tasks",
        body: { title: "Task Created In V2" },
      });
      assert.equal(v2TaskRes.status, 201);

      // Rollback to comp-v1 -> does NOT revert business.db; creates new rollback revision
      const rolledBack = await release.rollback("comp-v1");
      assert.equal(rolledBack.composition.kind, "rollback");
      assert.equal(rolledBack.composition.targetCompositionId, "comp-v1");
      assert.equal(rolledBack.health.mode, "in-process-hot-swap");

      const afterRollbackRes = await release.runtime.handleHttpRequest({
        method: "GET",
        path: "/api/app/todo-core/tasks",
      });
      const afterRollbackBody = afterRollbackRes.body as {
        version: string;
        tasks: Array<{ title: string }>;
      };
      assert.equal(afterRollbackBody.version, "v1");
      assert.deepEqual(
        afterRollbackBody.tasks.map((t) => t.title),
        ["Production Task 1", "Task Created In V2"],
      );

      const expectedActiveAfterRollback = rolledBack.composition.compositionId;
      await release.close();
      release = null;

      // Restart service from control.db & business.db -> exact recovery
      const restarted = new CompositionRelease({
        controlDbPath,
        businessDbPath,
        workDir: join(dir, "work-restarted"),
        enablePreviewClientHost: false,
      });
      release = restarted;
      await restarted.bootstrap();

      assert.equal(
        restarted.controlStore.getActiveCompositionId(),
        expectedActiveAfterRollback,
      );
      const afterRestartRes = await restarted.runtime.handleHttpRequest({
        method: "GET",
        path: "/api/app/todo-core/tasks",
      });
      const afterRestartBody = afterRestartRes.body as {
        version: string;
        tasks: Array<{ title: string }>;
      };
      assert.equal(afterRestartBody.version, "v1");
      assert.deepEqual(
        afterRestartBody.tasks.map((t) => t.title),
        ["Production Task 1", "Task Created In V2"],
      );
    } finally {
      if (release) {
        await release.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-closes idle preview session and cleans up temp directory after idleTimeoutMs", async () => {
    const dir = makeTempDir("v3-preview-idle-");
    const businessDbPath = join(dir, "business.db");
    const host = new PreviewSessionHost();
    const artV1 = makeTaskPluginArtifact("v1", "Idle Test");
    const compV1: CompositionSnapshot = {
      compositionId: "comp-v1",
      parentCompositionId: null,
      members: [{ pluginId: "todo-core", versionId: "v1", enabled: true }],
      createdAt: "2026-11-23T00:00:00.000Z",
    };

    try {
      const session = await host.openSession({
        candidateId: "cand-idle",
        baseCompositionId: "comp-v0",
        candidateComposition: compV1,
        artifacts: [artV1],
        productionDbPath: businessDbPath,
        enableClientHost: false,
        idleTimeoutMs: 80,
      });
      const previewTempDir = dirname(session.previewDbPath);
      assert.equal(host.listSessions().length, 1);

      await new Promise((r) => setTimeout(r, 250));
      assert.equal(host.listSessions().length, 0);
      assert.equal(existsSync(previewTempDir), false);
    } finally {
      await host.closeAll();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
