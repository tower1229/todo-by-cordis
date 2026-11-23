import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureV3ClientAssets } from "../../src/v3/client-bundle-builder.js";
import { CompositionRelease } from "../../src/v3/composition-release.js";
import {
  type V3HttpServerHandle,
  startV3HttpServer,
} from "../../src/v3/http-gateway.js";
import { buildPluginPackage } from "../../src/v3/plugin-builder.js";
import type { VerificationReport } from "../../src/v3/plugin-verifier.js";
import type { CompositionSnapshot } from "../../src/v3/types.js";

async function buildTodoPluginVersion(versionTag: "V1" | "V2") {
  const serverTs = `
import type { Context } from "cordis";
import type { AppRequest } from "@host/server-sdk";

export const name = "todo-core";

export function apply(ctx: Context) {
  const db = ctx.db;
  db.exec(\`
    CREATE TABLE IF NOT EXISTS plg_todo_core__tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL
    );
  \`);

  ctx.http.route("GET", "/tasks", () => {
    const tasks = db
      .prepare("SELECT id, title FROM plg_todo_core__tasks ORDER BY id ASC")
      .all();
    return { status: 200, body: { version: ${JSON.stringify(versionTag)}, tasks } };
  });

  ctx.http.route("POST", "/tasks", (req: AppRequest) => {
    const body = req.body as { title?: string } | undefined;
    const title = typeof body?.title === "string" ? body.title.trim() : "";
    if (!title) return { status: 400, body: { error: "title required" } };
    const info = db
      .prepare("INSERT INTO plg_todo_core__tasks (title) VALUES (?)")
      .run(title);
    return { status: 201, body: { id: Number(info.lastInsertRowid), title } };
  });
}
`;

  const clientTsx = `
import { useEffect, useState } from "react";

export const name = "todo-core";

export function apply(ctx: any) {
  function TodoApp() {
    const [tasks, setTasks] = useState<Array<{ id: number; title: string }>>([]);
    const [title, setTitle] = useState("");

    const load = async () => {
      const res = await fetch("/api/app/todo-core/tasks");
      const data = await res.json();
      setTasks(data.tasks ?? []);
    };

    useEffect(() => {
      void load();
    }, []);

    const addTask = async () => {
      if (!title.trim()) return;
      await fetch("/api/app/todo-core/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title }),
      });
      setTitle("");
      await load();
    };

    return (
      <div data-testid="todo-app" data-plugin-version=${JSON.stringify(versionTag)} className="p-6 space-y-4">
        <h1 data-testid="app-heading" className="text-lg font-semibold">
          Todo App (${versionTag})
        </h1>
        <div className="flex gap-2">
          <input
            data-testid="task-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Add task..."
            className="border px-2 py-1 rounded"
          />
          <button
            type="button"
            data-testid="add-task-btn"
            onClick={() => void addTask()}
            className="border px-3 py-1 rounded"
          >
            Add
          </button>
        </div>
        <ul data-testid="task-list" className="space-y-1">
          {tasks.map((t) => (
            <li key={t.id} data-testid="task-item">{t.title}</li>
          ))}
        </ul>
      </div>
    );
  }

  ctx.router.registerPage({
    path: "/",
    navLabel: "Tasks",
    order: 0,
    component: TodoApp,
  });
}
`;

  return await buildPluginPackage({
    pluginId: "todo-core",
    name: `Todo Core ${versionTag}`,
    dependencies: [],
    serverSource: serverTs,
    clientSource: clientTsx,
    testFiles: {},
  });
}

test.describe("V3 CompositionRelease end-to-end (Issue #71)", () => {
  test("full preview isolation, optimistic lock rejection, apply hot-swap, rollback preserving data, and restart recovery", async ({
    page,
  }) => {
    const dir = mkdtempSync(join(tmpdir(), "v3-e2e-release-"));
    const controlDbPath = join(dir, "control.db");
    const businessDbPath = join(dir, "business.db");
    const clientAssetsDir = await ensureV3ClientAssets();

    const artV1 = await buildTodoPluginVersion("V1");
    const artV2 = await buildTodoPluginVersion("V2");

    const compV1: CompositionSnapshot = {
      compositionId: "comp-v1",
      parentCompositionId: null,
      members: [
        { pluginId: "todo-core", versionId: artV1.versionId, enabled: true },
      ],
      createdAt: "2026-11-23T00:00:00.000Z",
    };

    const compV2: CompositionSnapshot = {
      compositionId: "comp-v2",
      parentCompositionId: "comp-v1",
      members: [
        { pluginId: "todo-core", versionId: artV2.versionId, enabled: true },
      ],
      createdAt: "2026-11-23T00:05:00.000Z",
    };

    const report: VerificationReport = {
      ok: true,
      errors: [],
      staticViolations: [],
      dagViolations: [],
      probedPlugins: ["todo-core"],
      ablationResults: [],
      noBehaviorDiffWarning: true,
      testChangeDisclosures: [
        {
          pluginId: "todo-core",
          modifiedFiles: ["tests/todo.test.ts"],
          addedFiles: [],
          removedFiles: [],
          fileDiffs: [
            {
              file: "tests/todo.test.ts",
              status: "modified",
              affectedTestCases: ["renders heading"],
              diffSummary: "- expect(heading).toBe('V1')\n+ expect(heading).toBe('V2')",
            },
          ],
        },
      ],
    };

    let release: CompositionRelease | null = new CompositionRelease({
      controlDbPath,
      businessDbPath,
      workDir: join(dir, "work-1"),
      clientAssetsDir,
    });
    let server: V3HttpServerHandle | null = null;

    try {
      await release.bootstrap({
        composition: compV1,
        artifacts: [artV1],
        summary: "初始 V1 组合",
      });

      server = await startV3HttpServer(release.runtime, {
        clientAssetsDir,
        releaseController: release,
      });
      release.setProductionUrl(server.url);

      // 1. Seed production task via real UI
      await page.goto(server.url);
      await expect(page.getByTestId("app-heading")).toHaveText("Todo App (V1)");
      await page.getByTestId("task-input").fill("Formal Task 1");
      await page.getByTestId("add-task-btn").click();
      await expect(page.getByTestId("task-item")).toHaveText(["Formal Task 1"]);

      // Register verified candidate V2
      release.registerVerifiedCandidate({
        candidateId: "cand-v2",
        baseCompositionId: "comp-v1",
        candidateComposition: compV2,
        artifacts: [artV2],
        verificationReport: report,
        summary: "升级 todo-core 至 V2",
      });

      // 2. Open Supervisor drawer, inspect ChangeBrief, test diffs, no-diff warning, then open isolated preview
      await page.locator('[data-supervisor-toggle-drawer="true"]').click();
      await expect(page.locator('[data-supervisor-change-brief="true"]')).toBeVisible();
      await expect(page.locator('[data-supervisor-no-diff-warning="true"]')).toContainText(
        "无行为差分断言，请人工核验预览",
      );
      await expect(page.locator('[data-supervisor-test-diffs="true"]')).toContainText(
        "tests/todo.test.ts",
      );

      await page.locator('[data-supervisor-open-preview-btn="cand-v2"]').click();
      await expect(page.locator('[data-supervisor-preview-banner="true"]')).toBeVisible();
      await expect(page.getByTestId("app-heading")).toHaveText("Todo App (V2)");
      await expect(page.getByTestId("task-item")).toHaveText(["Formal Task 1"]);

      // Write inside isolated preview
      await page.getByTestId("task-input").fill("Preview Only Task");
      await page.getByTestId("add-task-btn").click();
      await expect(page.getByTestId("task-item")).toHaveText([
        "Formal Task 1",
        "Preview Only Task",
      ]);

      // 3. Verify production DB is completely untouched
      const prodTasksRes = await fetch(`${server.url}/api/app/todo-core/tasks`);
      const prodTasksData = (await prodTasksRes.json()) as {
        version: string;
        tasks: Array<{ title: string }>;
      };
      expect(prodTasksData.version).toBe("V1");
      expect(prodTasksData.tasks.map((t) => t.title)).toEqual(["Formal Task 1"]);

      // 4. Stale base optimistic lock rejection (409) & verify both sides remain unchanged
      const staleRes = await fetch(`${server.url}/api/v3/release/apply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          candidateId: "cand-v2",
          expectedBaseCompositionId: "comp-stale-base",
        }),
      });
      expect(staleRes.status).toBe(409);

      const statusAfterConflictRes = await fetch(`${server.url}/api/v3/release/status`);
      const statusAfterConflict = (await statusAfterConflictRes.json()) as {
        activeCompositionId: string;
        candidates: Array<{ candidateId: string; status: string }>;
        activePreviews: Array<{ candidateId: string }>;
      };
      expect(statusAfterConflict.activeCompositionId).toBe("comp-v1");
      expect(
        statusAfterConflict.candidates.find((c) => c.candidateId === "cand-v2")?.status,
      ).toBe("verified");
      expect(statusAfterConflict.activePreviews.length).toBe(1);
      await expect(page.getByTestId("app-heading")).toHaveText("Todo App (V2)");
      await expect(page.getByTestId("task-item")).toHaveText([
        "Formal Task 1",
        "Preview Only Task",
      ]);

      // 5. Click "确认应用" in preview banner -> redirects to production with V2 hot-swapped
      await page.locator('[data-supervisor-preview-banner="true"] [data-supervisor-apply-btn="true"]').click();
      await expect(page.locator('[data-supervisor-preview-banner="true"]')).toHaveCount(0);
      await expect(page.getByTestId("app-heading")).toHaveText("Todo App (V2)");
      await expect(page.getByTestId("task-item")).toHaveText(["Formal Task 1"]);

      // 6. Add a new task in V2 production, then click "一键撤回" to comp-v1
      await page.getByTestId("task-input").fill("V2 Formal Task");
      await page.getByTestId("add-task-btn").click();
      await expect(page.getByTestId("task-item")).toHaveText([
        "Formal Task 1",
        "V2 Formal Task",
      ]);

      await page.locator('[data-supervisor-toggle-drawer="true"]').click();
      await page.locator('[data-supervisor-rollback-btn="comp-v1"]').click();

      // Dual-side hot-swap back to V1 UI while preserving V2 Formal Task!
      await expect(page.getByTestId("app-heading")).toHaveText("Todo App (V1)");
      await expect(page.getByTestId("task-item")).toHaveText([
        "Formal Task 1",
        "V2 Formal Task",
      ]);

      // 7. Restart service and verify exact state & data recovery
      await server.close();
      server = null;
      await release.close();
      release = null;

      release = new CompositionRelease({
        controlDbPath,
        businessDbPath,
        workDir: join(dir, "work-2"),
        clientAssetsDir,
      });
      await release.bootstrap();
      server = await startV3HttpServer(release.runtime, {
        clientAssetsDir,
        releaseController: release,
      });
      release.setProductionUrl(server.url);

      await page.goto(server.url);
      await expect(page.getByTestId("app-heading")).toHaveText("Todo App (V1)");
      await expect(page.getByTestId("task-item")).toHaveText([
        "Formal Task 1",
        "V2 Formal Task",
      ]);
    } finally {
      if (server) {
        await server.close();
      }
      if (release) {
        await release.close();
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
