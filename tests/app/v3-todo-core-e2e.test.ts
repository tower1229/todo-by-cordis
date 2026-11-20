import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SupervisedCordisRuntime } from "../../src/v3/cordis-runtime.js";
import { startV3HttpServer } from "../../src/v3/http-gateway.js";
import {
  compileServerPluginArtifact,
  loadServerPluginPackage,
} from "../../src/v3/plugin-loader.js";
import type { CompositionSnapshot } from "../../src/v3/types.js";

function makeSnapshot(
  compositionId: string,
  members: Array<{ pluginId: string; versionId: string; enabled?: boolean }>,
  parentCompositionId: string | null = null,
): CompositionSnapshot {
  return {
    compositionId,
    parentCompositionId,
    members: members.map((m) => ({
      pluginId: m.pluginId,
      versionId: m.versionId,
      enabled: m.enabled ?? true,
    })),
    createdAt: new Date().toISOString(),
  };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  return { status: res.status, body };
}

describe("V3 todo-core end-to-end HTTP integration", () => {
  const dirs: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) {
      await close();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("completes full server lifecycle: todo-core CRUD -> hot-mount tags -> hot-disable (404 + zero data loss) -> hot-re-enable -> infinite-loop fault auto-rebuild", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v3-todo-e2e-"));
    dirs.push(dir);

    const runtime = new SupervisedCordisRuntime({
      dbPath: join(dir, "app.db"),
      workDir: dir,
      requestTimeoutMs: 500,
      applyTimeoutMs: 2000,
      drainTimeoutMs: 500,
    });
    closers.push(() => runtime.close());

    const server = await startV3HttpServer(runtime, { port: 0 });
    closers.push(() => server.close());

    const todoArtifact = loadServerPluginPackage(
      resolve(process.cwd(), "plugins/todo-core"),
    );

    // Handwritten auxiliary plugin fixture: tags (uses weak task_id + injects todo service)
    const tagsArtifact = compileServerPluginArtifact({
      pluginId: "tags",
      name: "Tags",
      dependencies: ["todo-core"],
      serverSource: `
        import type { Context } from "cordis";
        import type {} from "@host/server-sdk";

        export const inject = ["todo"];

        export function apply(ctx: Context) {
          const db = ctx.db;
          db.exec(\`
            CREATE TABLE IF NOT EXISTS plg_tags__items (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL,
              label TEXT NOT NULL,
              UNIQUE(task_id, label)
            )
          \`);

          ctx.http.route("POST", "/tasks/:taskId", (req) => {
            const taskId = req.params.taskId;
            const todo = (ctx as unknown as { todo: { get(id: string): unknown } }).todo;
            if (!todo.get(taskId)) {
              return { status: 404, body: { error: "Task not found" } };
            }
            const label = String((req.body as { label?: string })?.label ?? "").trim();
            if (!label) {
              return { status: 400, body: { error: "label is required" } };
            }
            const id = globalThis.crypto.randomUUID();
            db.prepare(
              "INSERT OR IGNORE INTO plg_tags__items (id, task_id, label) VALUES (?, ?, ?)",
            ).run(id, taskId, label);
            const rows = db
              .prepare("SELECT label FROM plg_tags__items WHERE task_id = ? ORDER BY label")
              .all<{ label: string }>(taskId);
            return { status: 201, body: { taskId, tags: rows.map((r) => r.label) } };
          });

          ctx.http.route("GET", "/tasks/:taskId", (req) => {
            const taskId = req.params.taskId;
            const rows = db
              .prepare("SELECT label FROM plg_tags__items WHERE task_id = ? ORDER BY label")
              .all<{ label: string }>(taskId);
            return { taskId, tags: rows.map((r) => r.label) };
          });
        }
      `,
    });

    // Handwritten faulty plugin fixture that triggers an infinite loop on HTTP request
    const faultyArtifact = compileServerPluginArtifact({
      pluginId: "faulty-loop",
      name: "Faulty Loop",
      dependencies: [],
      serverSource: `
        import type { Context } from "cordis";
        import type {} from "@host/server-sdk";

        export function apply(ctx: Context) {
          ctx.http.route("POST", "/hang", () => {
            while (true) {
              // intentional infinite loop
            }
          });
        }
      `,
    });

    runtime.registerArtifact(todoArtifact);
    runtime.registerArtifact(tagsArtifact);
    runtime.registerArtifact(faultyArtifact);

    // 1. Mount todo-core and exercise full CRUD + state transition over HTTP
    const h1 = await runtime.applyComposition(
      makeSnapshot("comp-1", [
        { pluginId: "todo-core", versionId: todoArtifact.versionId },
      ]),
    );
    assert.deepEqual(h1.activePlugins, ["todo-core"]);

    const create1 = await fetchJson(`${server.url}/api/app/todo-core/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Build V3 server runtime", notes: "M1" }),
    });
    assert.equal(create1.status, 201);
    const task1 = create1.body.task as {
      id: string;
      title: string;
      notes: string;
      state: string;
    };
    assert.equal(task1.title, "Build V3 server runtime");
    assert.equal(task1.notes, "M1");
    assert.equal(task1.state, "open");

    const create2 = await fetchJson(`${server.url}/api/app/todo-core/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Temporary task" }),
    });
    assert.equal(create2.status, 201);
    const task2 = create2.body.task as { id: string };

    // PATCH update
    const patched = await fetchJson(
      `${server.url}/api/app/todo-core/tasks/${task1.id}`,
      {
        method: "PATCH",
        body: JSON.stringify({ title: "Build V3 Cordis runtime" }),
      },
    );
    assert.equal(patched.status, 200);
    assert.equal(
      (patched.body.task as { title: string }).title,
      "Build V3 Cordis runtime",
    );

    // POST transition open -> done -> open
    const doneRes = await fetchJson(
      `${server.url}/api/app/todo-core/tasks/${task1.id}/transition`,
      {
        method: "POST",
        body: JSON.stringify({ nextState: "done" }),
      },
    );
    assert.equal(doneRes.status, 200);
    assert.equal((doneRes.body.task as { state: string }).state, "done");

    const listDone = await fetchJson(
      `${server.url}/api/app/todo-core/tasks?state=done`,
    );
    assert.equal(listDone.status, 200);
    assert.equal((listDone.body.tasks as unknown[]).length, 1);

    // DELETE task2
    const delRes = await fetchJson(
      `${server.url}/api/app/todo-core/tasks/${task2.id}`,
      { method: "DELETE" },
    );
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.deleted, true);

    const getDeleted = await fetchJson(
      `${server.url}/api/app/todo-core/tasks/${task2.id}`,
    );
    assert.equal(getDeleted.status, 404);

    // 2. Hot-mount tags plugin in the same worker subprocess and verify immediately
    const h2 = await runtime.applyComposition(
      makeSnapshot(
        "comp-2-tags",
        [
          { pluginId: "todo-core", versionId: todoArtifact.versionId },
          { pluginId: "tags", versionId: tagsArtifact.versionId },
        ],
        "comp-1",
      ),
    );
    assert.equal(h2.mode, "in-process-hot-swap");
    assert.equal(h2.workerPid, h1.workerPid);

    const addTag = await fetchJson(
      `${server.url}/api/app/tags/tasks/${task1.id}`,
      {
        method: "POST",
        body: JSON.stringify({ label: "architecture" }),
      },
    );
    assert.equal(addTag.status, 201);
    assert.deepEqual(addTag.body.tags, ["architecture"]);

    // Introspect endpoint confirms both ACTIVE plugins and routes
    const intro = await fetchJson(`${server.url}/api/v3/runtime/introspect`);
    assert.equal(intro.status, 200);
    assert.equal(intro.body.compositionId, "comp-2-tags");
    assert.ok((intro.body.services as string[]).includes("todo"));

    // 3. Hot-disable tags -> route returns 404, todo-core keeps working, tags data zero loss
    const h3 = await runtime.applyComposition(
      makeSnapshot(
        "comp-3-tags-off",
        [
          { pluginId: "todo-core", versionId: todoArtifact.versionId },
          {
            pluginId: "tags",
            versionId: tagsArtifact.versionId,
            enabled: false,
          },
        ],
        "comp-2-tags",
      ),
    );
    assert.equal(h3.mode, "in-process-hot-swap");
    assert.equal(h3.workerPid, h1.workerPid);

    const tagsGone = await fetchJson(
      `${server.url}/api/app/tags/tasks/${task1.id}`,
    );
    assert.equal(tagsGone.status, 404);

    const taskStillReadable = await fetchJson(
      `${server.url}/api/app/todo-core/tasks/${task1.id}`,
    );
    assert.equal(taskStillReadable.status, 200);
    assert.equal(
      (taskStillReadable.body.task as { title: string }).title,
      "Build V3 Cordis runtime",
    );

    // 4. Hot-re-enable tags -> route and previously stored data immediately restored, accepts new writes
    const h4 = await runtime.applyComposition(
      makeSnapshot(
        "comp-4-tags-on",
        [
          { pluginId: "todo-core", versionId: todoArtifact.versionId },
          {
            pluginId: "tags",
            versionId: tagsArtifact.versionId,
            enabled: true,
          },
        ],
        "comp-3-tags-off",
      ),
    );
    assert.equal(h4.mode, "in-process-hot-swap");
    assert.equal(h4.workerPid, h1.workerPid);

    const tagsRestored = await fetchJson(
      `${server.url}/api/app/tags/tasks/${task1.id}`,
    );
    assert.equal(tagsRestored.status, 200);
    assert.deepEqual(tagsRestored.body.tags, ["architecture"]);

    const addTag2 = await fetchJson(
      `${server.url}/api/app/tags/tasks/${task1.id}`,
      {
        method: "POST",
        body: JSON.stringify({ label: "cordis" }),
      },
    );
    assert.equal(addTag2.status, 201);
    assert.deepEqual(addTag2.body.tags, ["architecture", "cordis"]);

    // 5. Mount faulty infinite-loop plugin, trigger infinite loop -> worker hard-killed & rebuilt, todo-core recovers
    const h5 = await runtime.applyComposition(
      makeSnapshot(
        "comp-5-faulty",
        [
          { pluginId: "todo-core", versionId: todoArtifact.versionId },
          { pluginId: "tags", versionId: tagsArtifact.versionId },
          { pluginId: "faulty-loop", versionId: faultyArtifact.versionId },
        ],
        "comp-4-tags-on",
      ),
    );
    const pidBeforeCrash = h5.workerPid;

    const hangRes = await fetchJson(`${server.url}/api/app/faulty-loop/hang`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.ok(hangRes.status === 503 || hangRes.status === 504);

    // Immediately after worker timeout & rebuild, todo-core & tags recover with all data intact
    const listAfterRecovery = await fetchJson(
      `${server.url}/api/app/todo-core/tasks`,
    );
    assert.equal(listAfterRecovery.status, 200);
    assert.equal((listAfterRecovery.body.tasks as unknown[]).length, 1);

    const tagsAfterRecovery = await fetchJson(
      `${server.url}/api/app/tags/tasks/${task1.id}`,
    );
    assert.equal(tagsAfterRecovery.status, 200);
    assert.deepEqual(tagsAfterRecovery.body.tags, ["architecture", "cordis"]);

    const introAfterRecovery = await fetchJson(
      `${server.url}/api/v3/runtime/introspect`,
    );
    assert.equal(introAfterRecovery.status, 200);
    assert.notEqual(introAfterRecovery.body.workerPid, pidBeforeCrash);
  });

  it("supports hot-mounting and hot-disabling a downstream transition interceptor plugin via todo:before-transition hook", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v3-todo-hook-"));
    dirs.push(dir);

    const runtime = new SupervisedCordisRuntime({
      dbPath: join(dir, "app.db"),
      workDir: dir,
    });
    closers.push(() => runtime.close());

    const server = await startV3HttpServer(runtime, { port: 0 });
    closers.push(() => server.close());

    const todoArtifact = loadServerPluginPackage(
      resolve(process.cwd(), "plugins/todo-core"),
    );

    const reviewArtifact = compileServerPluginArtifact({
      pluginId: "review",
      name: "Review Gate",
      dependencies: ["todo-core"],
      serverSource: `
        import type { Context } from "cordis";
        import type {} from "@host/server-sdk";

        export const inject = ["todo"];

        export function apply(ctx: Context) {
          const db = ctx.db;
          db.exec(\`
            CREATE TABLE IF NOT EXISTS plg_review__notes (
              task_id TEXT PRIMARY KEY,
              note TEXT NOT NULL
            )
          \`);

          ctx.http.route("POST", "/tasks/:taskId", (req) => {
            const note = String((req.body as { note?: string })?.note ?? "").trim();
            if (!note) return { status: 400, body: { error: "note required" } };
            db.prepare(
              "INSERT OR REPLACE INTO plg_review__notes (task_id, note) VALUES (?, ?)",
            ).run(req.params.taskId, note);
            return { status: 201, body: { taskId: req.params.taskId, note } };
          });

          (ctx as unknown as {
            on(
              event: string,
              listener: (payload: { task: { id: string }; nextState: string }) => string | false | void,
            ): () => void;
          }).on("todo:before-transition", (payload) => {
            if (payload.nextState !== "done") return;
            const row = db
              .prepare("SELECT note FROM plg_review__notes WHERE task_id = ?")
              .get<{ note: string }>(payload.task.id);
            if (!row?.note) {
              return "Review note is required before completing task";
            }
            if (row.note === "REJECT_FALSE") {
              return false;
            }
          });
        }
      `,
    });

    runtime.registerArtifact(todoArtifact);
    runtime.registerArtifact(reviewArtifact);

    await runtime.applyComposition(
      makeSnapshot("c1", [
        { pluginId: "todo-core", versionId: todoArtifact.versionId },
        { pluginId: "review", versionId: reviewArtifact.versionId },
      ]),
    );

    const created = await fetchJson(`${server.url}/api/app/todo-core/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Ship V3-T1" }),
    });
    const taskId = (created.body.task as { id: string }).id;

    // Without review note -> blocked by review hook (422)
    const blocked = await fetchJson(
      `${server.url}/api/app/todo-core/tasks/${taskId}/transition`,
      { method: "POST", body: JSON.stringify({ nextState: "done" }) },
    );
    assert.equal(blocked.status, 422);
    assert.match(String(blocked.body.error), /review note/i);

    // Listener returning boolean false -> also blocks transition (422)
    await fetchJson(`${server.url}/api/app/review/tasks/${taskId}`, {
      method: "POST",
      body: JSON.stringify({ note: "REJECT_FALSE" }),
    });
    const blockedFalse = await fetchJson(
      `${server.url}/api/app/todo-core/tasks/${taskId}/transition`,
      { method: "POST", body: JSON.stringify({ nextState: "done" }) },
    );
    assert.equal(blockedFalse.status, 422);

    // Save valid review note -> transition succeeds (200)
    const noteRes = await fetchJson(
      `${server.url}/api/app/review/tasks/${taskId}`,
      { method: "POST", body: JSON.stringify({ note: "All gates green" }) },
    );
    assert.equal(noteRes.status, 201);

    const completed = await fetchJson(
      `${server.url}/api/app/todo-core/tasks/${taskId}/transition`,
      { method: "POST", body: JSON.stringify({ nextState: "done" }) },
    );
    assert.equal(completed.status, 200);
    assert.equal((completed.body.task as { state: string }).state, "done");

    // Hot-disable review -> listener auto-unregistered via Fiber effect; another task completes directly
    await runtime.applyComposition(
      makeSnapshot(
        "c2",
        [
          { pluginId: "todo-core", versionId: todoArtifact.versionId },
          {
            pluginId: "review",
            versionId: reviewArtifact.versionId,
            enabled: false,
          },
        ],
        "c1",
      ),
    );

    const created2 = await fetchJson(`${server.url}/api/app/todo-core/tasks`, {
      method: "POST",
      body: JSON.stringify({ title: "Direct complete" }),
    });
    const taskId2 = (created2.body.task as { id: string }).id;
    const directDone = await fetchJson(
      `${server.url}/api/app/todo-core/tasks/${taskId2}/transition`,
      { method: "POST", body: JSON.stringify({ nextState: "done" }) },
    );
    assert.equal(directDone.status, 200);
    assert.equal((directDone.body.task as { state: string }).state, "done");
  });
});
