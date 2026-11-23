import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureV3ClientAssets } from "../../src/v3/client-bundle-builder.js";
import { CompositionRelease } from "../../src/v3/composition-release.js";
import { EvolutionLoop } from "../../src/v3/evolution-loop.js";
import { startV3HttpServer } from "../../src/v3/http-gateway.js";
import { buildPluginPackage } from "../../src/v3/plugin-builder.js";
import type { CompositionSnapshot } from "../../src/v3/types.js";
import {
  createStepStubDriver,
  executeEvolutionStepInBrowser,
  type EvolutionStepPlan,
} from "./v3-acceptance-helpers.js";

const TODO_CORE_DIR = resolve("plugins/todo-core");
const TODO_CORE_CONTRACT = readFileSync(
  join(TODO_CORE_DIR, "contract.d.ts"),
  "utf8",
);
const TODO_CORE_SERVER = readFileSync(
  join(TODO_CORE_DIR, "server.ts"),
  "utf8",
);
const TODO_CORE_CLIENT = readFileSync(
  join(TODO_CORE_DIR, "client.tsx"),
  "utf8",
);

const TODO_CORE_CONTRACT_TEST = `
import assert from "node:assert/strict";
export default async function (ctx) {
  const created = await ctx.request({
    method: "POST",
    path: "/api/app/todo-core/tasks",
    body: { title: "Contract Core Task" },
  });
  assert.equal(created.status, 201);
  const taskId = created.body.task.id;
  const done = await ctx.request({
    method: "POST",
    path: \`/api/app/todo-core/tasks/\${taskId}/transition\`,
    body: { nextState: "done" },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.task.state, "done");
}
`;

// Step 1: todo-tags v1 (preserves case)
const TODO_TAGS_SERVER_V1 = `
import type { Context } from "cordis";
import "@host/server-sdk";

interface TagRow {
  readonly id: string;
  readonly task_id: string;
  readonly label: string;
  readonly created_at: string;
}

export const name = "todo-tags";

export function apply(ctx: Context) {
  ctx.db.exec(\`
    CREATE TABLE IF NOT EXISTS plg_todo_tags__tags (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  \`);

  ctx.http.route("GET", "/tags", (req) => {
    const taskId = req.query.taskId;
    const rows = taskId
      ? ctx.db
          .prepare("SELECT id, task_id, label, created_at FROM plg_todo_tags__tags WHERE task_id = ? ORDER BY created_at ASC, id ASC")
          .all<TagRow>(taskId)
      : ctx.db
          .prepare("SELECT id, task_id, label, created_at FROM plg_todo_tags__tags ORDER BY created_at ASC, id ASC")
          .all<TagRow>();
    return {
      tags: rows.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        label: r.label,
        createdAt: r.created_at,
      })),
    };
  });

  ctx.http.route("POST", "/tags", (req) => {
    const body = (req.body ?? {}) as { taskId?: unknown; label?: unknown };
    if (typeof body.taskId !== "string" || !body.taskId.trim()) {
      return { status: 400, body: { error: "taskId is required" } };
    }
    if (typeof body.label !== "string" || !body.label.trim()) {
      return { status: 400, body: { error: "label is required" } };
    }
    const id = globalThis.crypto.randomUUID();
    const label = body.label.trim();
    const createdAt = new Date().toISOString();
    ctx.db
      .prepare("INSERT INTO plg_todo_tags__tags (id, task_id, label, created_at) VALUES (?, ?, ?, ?)")
      .run(id, body.taskId.trim(), label, createdAt);
    return { status: 201, body: { tag: { id, taskId: body.taskId.trim(), label, createdAt } } };
  });
}
`;

// Step 3: todo-tags v2 (lowercases newly saved labels, preserves existing rows)
const TODO_TAGS_SERVER_V2 = TODO_TAGS_SERVER_V1.replace(
  "const label = body.label.trim();",
  "const label = body.label.trim().toLowerCase();",
);

const TODO_TAGS_CLIENT = `
import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Context } from "cordis";
import "@host/client-sdk";

interface TagItem {
  readonly id: string;
  readonly taskId: string;
  readonly label: string;
}

const listeners = new Set<() => void>();
function notifyTagsChanged() {
  for (const fn of listeners) fn();
}

function useTaskTags(taskId: string) {
  const [tags, setTags] = useState<TagItem[]>([]);
  const load = useCallback(async () => {
    const res = await fetch(\`/api/app/todo-tags/tags?taskId=\${encodeURIComponent(taskId)}\`);
    if (!res.ok) return;
    const data = (await res.json()) as { tags?: TagItem[] };
    setTags(data.tags ?? []);
  }, [taskId]);

  useEffect(() => {
    void load();
    const handler = () => void load();
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, [load]);

  return { tags, reload: load };
}

function TaskTagBadges({ task }: { readonly task: { readonly id: string } }) {
  const { tags } = useTaskTags(task.id);
  if (tags.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1" data-todo-tag-badges={task.id}>
      {tags.map((tag) => (
        <span
          key={tag.id}
          data-todo-tag={tag.label}
          className="rounded bg-accent/15 px-1.5 py-0.5 text-[11px] font-medium text-accent"
        >
          #{tag.label}
        </span>
      ))}
    </span>
  );
}

function TaskTagEditor({ task }: { readonly task: { readonly id: string } }) {
  const { tags } = useTaskTags(task.id);
  const [draft, setDraft] = useState("");

  const handleAdd = async () => {
    if (!draft.trim()) return;
    const res = await fetch("/api/app/todo-tags/tags", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ taskId: task.id, label: draft.trim() }),
    });
    if (res.ok) {
      setDraft("");
      notifyTagsChanged();
    }
  };

  return (
    <div className="mt-3 border-t border-line pt-3" data-todo-tag-editor="true">
      <div className="mb-2 text-xs font-medium text-muted">标签 ({tags.length})</div>
      <div className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="输入标签"
          data-todo-tag-input="true"
          className="flex-1 rounded border border-line bg-canvas px-2 py-1 text-xs"
        />
        <button
          type="button"
          onClick={() => void handleAdd()}
          data-todo-tag-submit="true"
          className="rounded bg-accent px-2.5 py-1 text-xs font-medium text-surface"
        >
          添加标签
        </button>
      </div>
    </div>
  );
}

export const name = "todo-tags";

export function apply(ctx: Context) {
  ctx.slots.register("todo.item.badges", (props) => (
    <TaskTagBadges task={props.task} />
  ));
  ctx.slots.register("todo.item.detail", (props) => (
    <TaskTagEditor task={props.task} />
  ));
}
`;

const TODO_TAGS_TEST_V1 = `
import assert from "node:assert/strict";
export default async function (ctx) {
  const created = await ctx.request({
    method: "POST",
    path: "/api/app/todo-core/tasks",
    body: { title: "Tagged Task" },
  });
  assert.equal(created.status, 201);
  const taskId = created.body.task.id;
  const saved = await ctx.request({
    method: "POST",
    path: "/api/app/todo-tags/tags",
    body: { taskId, label: "URGENT" },
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.tag.label, "URGENT");
}
`;

const TODO_TAGS_TEST_V2 = `
import assert from "node:assert/strict";
export default async function (ctx) {
  const created = await ctx.request({
    method: "POST",
    path: "/api/app/todo-core/tasks",
    body: { title: "Tagged Task" },
  });
  assert.equal(created.status, 201);
  const taskId = created.body.task.id;
  const saved = await ctx.request({
    method: "POST",
    path: "/api/app/todo-tags/tags",
    body: { taskId, label: "URGENT" },
  });
  assert.equal(saved.status, 201);
  assert.equal(saved.body.tag.label, "urgent");
}
`;

// Step 2: todo-counter
const TODO_COUNTER_SERVER = `
import type { Context } from "cordis";
import "@host/server-sdk";

export const name = "todo-counter";
export const inject = ["todo"];

export function apply(ctx: Context) {
  ctx.http.route("GET", "/summary", () => {
    const tasks = ctx.todo.list();
    let open = 0;
    let done = 0;
    for (const t of tasks) {
      if (t.state === "done") done += 1;
      else open += 1;
    }
    return { total: tasks.length, open, done };
  });
}
`;

const TODO_COUNTER_CLIENT = `
import type { Context } from "cordis";
import "@host/client-sdk";

export const name = "todo-counter";

export function apply(ctx: Context) {
  ctx.slots.register("todo.list.banner", (props) => {
    const total = props.tasks.length;
    const done = props.tasks.filter((t) => t.state === "done").length;
    const open = total - done;
    return (
      <div
        data-todo-counter="true"
        className="mb-3 rounded-md border border-line bg-surface px-3 py-2 text-xs text-muted"
      >
        统计：总计 {total} · 待办 {open} · 已完成 {done}
      </div>
    );
  });
}
`;

const TODO_COUNTER_TEST = `
import assert from "node:assert/strict";
export default async function (ctx) {
  await ctx.request({
    method: "POST",
    path: "/api/app/todo-core/tasks",
    body: { title: "Counted Task" },
  });
  const res = await ctx.request({
    method: "GET",
    path: "/api/app/todo-counter/summary",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.total, 1);
  assert.equal(res.body.open, 1);
  assert.equal(res.body.done, 0);
}
`;

// Step 4: todo-core v2 (opens dual-end todo:before-complete bail seam + todo.overlays slot)
const TODO_CORE_CONTRACT_V2 = `${TODO_CORE_CONTRACT}
export interface BeforeCompletePayload {
  readonly task: TaskItem;
  readonly meta?: Record<string, unknown>;
}

declare module "cordis" {
  interface Events {
    "todo:before-complete"(
      payload: BeforeCompletePayload,
    ): Promise<void | false | string> | void | false | string;
  }
}

declare module "@host/client-sdk" {
  interface SlotPropsMap {
    "todo.overlays": TodoListSlotContext;
  }
}
`;

const TODO_CORE_SERVER_V2 = TODO_CORE_SERVER.replace(
  'const hooks = this.ctx.events._hooks["todo:before-transition"] ?? [];',
  `if (nextState === "done") {
      const completeHooks = this.ctx.events._hooks["todo:before-complete"] ?? [];
      for (const hook of [...completeHooks]) {
        const verdict = await hook.callback({
          task: existing,
          meta,
        });
        if (verdict === false) {
          throw httpError(422, "Task completion blocked");
        }
        if (typeof verdict === "string" && verdict.length > 0) {
          throw httpError(422, verdict);
        }
      }
    }
    const hooks = this.ctx.events._hooks["todo:before-transition"] ?? [];`,
);

const TODO_CORE_CLIENT_V2 = TODO_CORE_CLIENT.replace(
  'const verdict = await dispatchClientBail(',
  `if (nextState === "done") {
        const completeVerdict = await dispatchClientBail(
          clientCtx,
          "todo:before-complete",
          { task, meta },
        );
        if (completeVerdict === false) {
          setError("完成操作已取消");
          return;
        }
        if (typeof completeVerdict === "string" && completeVerdict.length > 0) {
          setError(completeVerdict);
          return;
        }
      }
      const verdict = await dispatchClientBail(`,
).replace(
  `          <Slot
            name="todo.list.banner"
            props={{ tasks, filter, refresh }}
            className="mb-3 space-y-2"
          />`,
  `          <Slot
            name="todo.list.banner"
            props={{ tasks, filter, refresh }}
            className="mb-3 space-y-2"
          />
          <div data-todo-overlays-slot="true">
            <Slot name="todo.overlays" props={{ tasks, filter, refresh }} />
          </div>`,
);

// Step 4: todo-review plugin (custom modal + server strong validation)
const TODO_REVIEW_SERVER = `
import type { Context } from "cordis";
import "@host/server-sdk";

interface ReviewRow {
  readonly id: string;
  readonly task_id: string;
  readonly summary: string;
  readonly created_at: string;
}

export const name = "todo-review";
export const inject = ["todo"];

export function apply(ctx: Context) {
  ctx.db.exec(\`
    CREATE TABLE IF NOT EXISTS plg_todo_review__reviews (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  \`);

  ctx.on("todo:before-complete", (payload) => {
    const raw = payload.meta?.reviewSummary;
    if (typeof raw !== "string" || raw.trim().length < 2) {
      return "完成前必须填写复盘说明";
    }
    const id = globalThis.crypto.randomUUID();
    const createdAt = new Date().toISOString();
    ctx.db
      .prepare("INSERT INTO plg_todo_review__reviews (id, task_id, summary, created_at) VALUES (?, ?, ?, ?)")
      .run(id, payload.task.id, raw.trim(), createdAt);
    return undefined;
  });

  ctx.http.route("GET", "/reviews", () => {
    const rows = ctx.db
      .prepare("SELECT id, task_id, summary, created_at FROM plg_todo_review__reviews ORDER BY created_at ASC, id ASC")
      .all<ReviewRow>();
    return {
      reviews: rows.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        summary: r.summary,
        createdAt: r.created_at,
      })),
    };
  });
}
`;

const TODO_REVIEW_CLIENT = `
import { useEffect, useState, type FormEvent } from "react";
import type { Context } from "cordis";
import "@host/client-sdk";

interface PendingReview {
  readonly taskTitle: string;
  readonly resolve: (summary: string | null) => void;
}

let activeSetter: ((pending: PendingReview | null) => void) | null = null;

function ReviewModalOverlay() {
  const [pending, setPending] = useState<PendingReview | null>(null);
  const [summary, setSummary] = useState("");

  useEffect(() => {
    activeSetter = setPending;
    return () => {
      if (activeSetter === setPending) activeSetter = null;
    };
  }, []);

  if (!pending) return null;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (summary.trim().length < 2) return;
    const text = summary.trim();
    const resolve = pending.resolve;
    setSummary("");
    setPending(null);
    resolve(text);
  };

  const handleCancel = () => {
    const resolve = pending.resolve;
    setSummary("");
    setPending(null);
    resolve(null);
  };

  return (
    <div
      data-review-modal="true"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md rounded-lg border border-line bg-surface p-4 shadow-lg"
      >
        <h2 className="mb-2 text-sm font-semibold">完成复盘：{pending.taskTitle}</h2>
        <textarea
          value={summary}
          onChange={(e) => setSummary(e.target.value)}
          placeholder="请填写本次任务的复盘说明"
          data-review-input="true"
          className="mb-3 w-full rounded border border-line bg-canvas p-2 text-sm"
          rows={3}
        />
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={handleCancel}
            data-review-cancel="true"
            className="rounded border border-line px-3 py-1.5 text-xs"
          >
            取消
          </button>
          <button
            type="submit"
            data-review-submit="true"
            className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface"
          >
            提交复盘并完成
          </button>
        </div>
      </form>
    </div>
  );
}

export const name = "todo-review";

export function apply(ctx: Context) {
  ctx.slots.register("todo.overlays", () => <ReviewModalOverlay />);
  ctx.on("todo:before-complete", async (payload: { task: { title: string }; meta?: Record<string, unknown> }) => {
    if (typeof payload.meta?.reviewSummary === "string" && payload.meta.reviewSummary.trim().length >= 2) {
      return undefined;
    }
    if (!activeSetter) {
      return "完成前必须填写复盘说明";
    }
    const result = await new Promise<string | null>((resolve) => {
      activeSetter?.({ taskTitle: payload.task.title, resolve });
    });
    if (!result) {
      return false;
    }
    if (payload.meta) {
      payload.meta.reviewSummary = result;
    }
    return undefined;
  });
}
`;

const TODO_REVIEW_TEST = `
import assert from "node:assert/strict";
export default async function (ctx) {
  const created = await ctx.request({
    method: "POST",
    path: "/api/app/todo-core/tasks",
    body: { title: "Review Required Task" },
  });
  assert.equal(created.status, 201);
  const taskId = created.body.task.id;

  const blocked = await ctx.request({
    method: "POST",
    path: \`/api/app/todo-core/tasks/\${taskId}/transition\`,
    body: { nextState: "done" },
  });
  assert.equal(blocked.status, 422);

  const allowed = await ctx.request({
    method: "POST",
    path: \`/api/app/todo-core/tasks/\${taskId}/transition\`,
    body: { nextState: "done", meta: { reviewSummary: "复盘：流程顺畅" } },
  });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.body.task.state, "done");

  const reviews = await ctx.request({
    method: "GET",
    path: "/api/app/todo-review/reviews",
  });
  assert.equal(reviews.status, 200);
  assert.equal(reviews.body.reviews.length, 1);
}
`;

test.describe("V3 Six-Step Todo Self-Iteration Acceptance (Zero-Cost Stub + Real Chromium)", () => {
  test("runs full 0->5 six-step Todo evolution, restart recovery, and data-preserving rollback", async ({
    page,
  }) => {
    test.setTimeout(300_000);

    const dir = mkdtempSync(join(tmpdir(), "v3-six-step-"));
    const controlDbPath = join(dir, "supervisor.db");
    const businessDbPath = join(dir, "app.db");
    const assetsDir = await ensureV3ClientAssets();

    const release = new CompositionRelease({
      controlDbPath,
      businessDbPath,
      workDir: join(dir, "work"),
      clientAssetsDir: assetsDir,
      enablePreviewClientHost: true,
    });

    const todoCoreV1 = await buildPluginPackage({
      pluginId: "todo-core",
      name: "Todo Core",
      dependencies: [],
      contractTypes: TODO_CORE_CONTRACT,
      serverSource: TODO_CORE_SERVER,
      clientSource: TODO_CORE_CLIENT,
      testFiles: {
        "todo-core.contract.test.ts": TODO_CORE_CONTRACT_TEST,
      },
    });

    const initComp: CompositionSnapshot = {
      compositionId: "comp-todo-step0",
      parentCompositionId: null,
      members: [
        {
          pluginId: todoCoreV1.pluginId,
          versionId: todoCoreV1.versionId,
          enabled: true,
        },
      ],
      createdAt: new Date().toISOString(),
    };
    await release.bootstrap({ composition: initComp, artifacts: [todoCoreV1] });

    const steps: readonly EvolutionStepPlan[] = [
      {
        prompt: "Step 1: 新增标签插件（自有表、接口与客户端标签展示编辑）",
        stageArgs: {
          upserts: [
            {
              pluginId: "todo-tags",
              name: "Todo Tags",
              dependencies: ["todo-core"],
              contractTypes: "",
              sourceFiles: {
                "server.ts": TODO_TAGS_SERVER_V1,
                "client.tsx": TODO_TAGS_CLIENT,
              },
              testFiles: {
                "tags.contract.test.ts": TODO_TAGS_TEST_V1,
              },
            },
          ],
        },
        summary: "Step 1: 新增标签插件",
        highlights: ["自有表 plg_todo_tags__tags", "任务列表与详情支持标签展示与添加"],
      },
      {
        prompt: "Step 2: 新增独立计数插件",
        stageArgs: {
          upserts: [
            {
              pluginId: "todo-counter",
              name: "Todo Counter",
              dependencies: ["todo-core"],
              contractTypes: "",
              sourceFiles: {
                "server.ts": TODO_COUNTER_SERVER,
                "client.tsx": TODO_COUNTER_CLIENT,
              },
              testFiles: {
                "counter.contract.test.ts": TODO_COUNTER_TEST,
              },
            },
          ],
        },
        summary: "Step 2: 新增独立计数插件",
        highlights: ["展示总计/待办/已完成数量", "上游与标签插件版本锁定不动"],
      },
      {
        prompt: "Step 3: 升级标签插件使新保存标签统一小写，保留历史大写标签",
        stageArgs: {
          upserts: [
            {
              pluginId: "todo-tags",
              name: "Todo Tags",
              dependencies: ["todo-core"],
              contractTypes: "",
              sourceFiles: {
                "server.ts": TODO_TAGS_SERVER_V2,
                "client.tsx": TODO_TAGS_CLIENT,
              },
              testFiles: {
                "tags.contract.test.ts": TODO_TAGS_TEST_V2,
              },
            },
          ],
        },
        summary: "Step 3: 标签新保存统一小写",
        highlights: ["新标签统一小写", "历史大写标签保留可读"],
      },
      {
        prompt: "Step 4: 完成前必须填写复盘（同批开放 todo-core 双端 bail 接缝并新增复盘插件）",
        stageArgs: {
          upserts: [
            {
              pluginId: "todo-core",
              name: "Todo Core",
              dependencies: [],
              contractTypes: TODO_CORE_CONTRACT_V2,
              sourceFiles: {
                "server.ts": TODO_CORE_SERVER_V2,
                "client.tsx": TODO_CORE_CLIENT_V2,
              },
              testFiles: {
                "todo-core.contract.test.ts": TODO_CORE_CONTRACT_TEST,
                "todo-core.seam.test.ts": `
import assert from "node:assert/strict";
export default async function (ctx) {
  const session = await ctx.openBrowserPage("/");
  try {
    await session.page.locator("[data-todo-overlays-slot]").waitFor({ state: "attached", timeout: 5000 });
    const count = await session.page.locator("[data-todo-overlays-slot]").count();
    assert.equal(count, 1);
  } finally {
    await session.close();
  }
}
`,
              },
            },
            {
              pluginId: "todo-review",
              name: "Todo Review",
              dependencies: ["todo-core"],
              contractTypes: "",
              sourceFiles: {
                "server.ts": TODO_REVIEW_SERVER,
                "client.tsx": TODO_REVIEW_CLIENT,
              },
              testFiles: {
                "review.contract.test.ts": TODO_REVIEW_TEST,
              },
            },
          ],
        },
        summary: "Step 4: 完成前必须填写复盘",
        highlights: ["todo-core 开放双端 todo:before-complete 接缝", "新增复盘弹窗与服务端强校验"],
      },
      {
        prompt: "Step 5: 零业务代码停用标签插件",
        stageArgs: {
          toggles: [{ pluginId: "todo-tags", enabled: false }],
        },
        summary: "Step 5: 停用标签插件（保数据）",
        highlights: ["双端热卸载 todo-tags", "标签数据表零丢失"],
      },
      {
        prompt: "Step 6: 零业务代码重新启用标签插件",
        stageArgs: {
          toggles: [{ pluginId: "todo-tags", enabled: true }],
        },
        summary: "Step 6: 重新启用标签插件",
        highlights: ["双端热恢复 todo-tags", "历史标签完整回归"],
      },
    ];

    const stubDriver = createStepStubDriver(steps, "todo");

    // Real 4-gate verifyCandidate is used by default (no verifyFn override!)
    const loop = new EvolutionLoop({
      release,
      modelDriver: stubDriver,
    });
    release.setEvolutionController(loop);

    const server = await startV3HttpServer(release.runtime, {
      clientAssetsDir: assetsDir,
      enableClientHost: true,
      releaseController: release,
      evolutionController: loop,
    });
    release.setProductionUrl(server.url);

    let step5CompositionId = "";
    let step6CompositionId = "";

    try {
      // Step 0: Create initial task via real UI
      await page.goto(server.url);
      const taskInput = page.locator('input[placeholder*="添加任务"], input[placeholder*="新任务"]').first();
      await expect(taskInput).toBeVisible({ timeout: 15_000 });
      await taskInput.fill("准备发布清单");
      await taskInput.press("Enter");
      await expect(page.getByText("准备发布清单")).toBeVisible({ timeout: 10_000 });

      // Step 1: Add todo-tags v1
      await executeEvolutionStepInBrowser(
        page,
        server.url,
        steps[0]!.prompt,
        steps[0]!.summary,
      );
      const compAfterStep1 = release.getStatus().activeComposition!;
      const todoCoreVersionAfterStep1 = compAfterStep1.members.find(
        (m) => m.pluginId === "todo-core",
      )!.versionId;
      const todoTagsVersionAfterStep1 = compAfterStep1.members.find(
        (m) => m.pluginId === "todo-tags",
      )!.versionId;

      // Add uppercase tag "URGENT" to "准备发布清单"
      await page.getByText("准备发布清单").click();
      await expect(page.locator("[data-todo-tag-editor]")).toBeVisible({
        timeout: 10_000,
      });
      await page.locator("[data-todo-tag-input]").fill("URGENT");
      await page.locator("[data-todo-tag-submit]").click();
      await expect(page.locator('[data-todo-tag="URGENT"]')).toBeVisible({
        timeout: 10_000,
      });

      // Step 2: Add independent todo-counter (verify todo-core & todo-tags versions strictly locked)
      await executeEvolutionStepInBrowser(
        page,
        server.url,
        steps[1]!.prompt,
        steps[1]!.summary,
      );
      const compAfterStep2 = release.getStatus().activeComposition!;
      expect(
        compAfterStep2.members.find((m) => m.pluginId === "todo-core")!.versionId,
      ).toBe(todoCoreVersionAfterStep1);
      expect(
        compAfterStep2.members.find((m) => m.pluginId === "todo-tags")!.versionId,
      ).toBe(todoTagsVersionAfterStep1);
      await expect(page.locator("[data-todo-counter]")).toContainText("总计 1");

      // Step 3: Upgrade todo-tags to lowercase new tags (check testChangeDisclosures)
      await executeEvolutionStepInBrowser(
        page,
        server.url,
        steps[2]!.prompt,
        steps[2]!.summary,
        async () => {
          const run = loop.listRuns()[0];
          const disclosures = run?.changeBrief?.testChangeDisclosures ?? [];
          expect(disclosures.length).toBeGreaterThan(0);
          const tagDisclosure = disclosures.find(
            (d) => d.pluginId === "todo-tags",
          );
          expect(tagDisclosure).toBeDefined();
          expect(
            tagDisclosure!.fileDiffs.some(
              (e) =>
                e.diffSummary.includes('"URGENT"') &&
                e.diffSummary.includes('"urgent"'),
            ),
          ).toBe(true);
        },
        async () => {
          const dialog = page.getByRole("dialog", { name: "运行组合与发布控制" });
          await expect(dialog).toContainText('"URGENT"');
          await expect(dialog).toContainText('"urgent"');
        },
      );

      // Historical uppercase "URGENT" remains readable; new "Backend" becomes "backend"
      await expect(page.locator('[data-todo-tag="URGENT"]')).toBeVisible({
        timeout: 10_000,
      });
      await page.getByText("准备发布清单").click();
      await page.locator("[data-todo-tag-input]").fill("Backend");
      await page.locator("[data-todo-tag-submit]").click();
      await expect(page.locator('[data-todo-tag="backend"]')).toBeVisible({
        timeout: 10_000,
      });

      // Step 4: Same batch upgrades todo-core (dual-end bail seam) + adds todo-review
      await executeEvolutionStepInBrowser(
        page,
        server.url,
        steps[3]!.prompt,
        steps[3]!.summary,
        async () => {
          const run = loop.listRuns()[0]!;
          expect(run.candidateId).toBeTruthy();
          const receipt = release.controlStore.getCandidateReceipt(
            run.candidateId!,
          );
          const report = receipt?.verificationReport;
          expect(report?.ok).toBe(true);
          // Gate 2 ablation verified todo-core without todo-review
          const coreAblation = report?.ablationResults.find(
            (a) =>
              a.targetPluginId === "todo-core" &&
              a.ablatedPlugins.includes("todo-review"),
          );
          expect(coreAblation?.passed).toBe(true);
          // Sibling plugins (todo-tags, todo-counter) are isolated from todo-review in subgraph tests
          const reviewSubgraph = report?.subgraphResults?.find(
            (s) => s.pluginId === "todo-review",
          );
          expect([...(reviewSubgraph?.closurePlugins ?? [])].sort()).toEqual([
            "todo-core",
            "todo-review",
          ]);
          for (const siblingId of ["todo-tags", "todo-counter"]) {
            const sub = report?.subgraphResults?.find(
              (s) => s.pluginId === siblingId,
            );
            expect(sub).toBeDefined();
            expect(sub!.closurePlugins).not.toContain("todo-review");
            expect(sub!.candidatePassed).toBe(true);
          }
        },
      );

      // Verify server-side strong validation rejects completion without review
      const tasksRes = await fetch(`${server.url}/api/app/todo-core/tasks`);
      const tasksJson = (await tasksRes.json()) as {
        tasks: Array<{ id: string; title: string }>;
      };
      const targetTask = tasksJson.tasks.find((t) => t.title === "准备发布清单")!;
      const blockedRes = await fetch(
        `${server.url}/api/app/todo-core/tasks/${encodeURIComponent(targetTask.id)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nextState: "done" }),
        },
      );
      expect(blockedRes.status).toBe(422);

      // Complete task via UI -> opens custom review modal -> submit review
      await page
        .locator(`button[aria-label*="完成"], button[title*="完成"]`)
        .first()
        .click();
      await expect(page.locator("[data-review-modal]")).toBeVisible({
        timeout: 10_000,
      });
      await page.locator("[data-review-input]").fill("已完成全部回归验证");
      await page.locator("[data-review-submit]").click();
      await expect(page.locator("[data-review-modal]")).toBeHidden({
        timeout: 10_000,
      });
      await expect(page.locator("[data-todo-counter]")).toContainText("已完成 1");

      // Step 5: Zero-code disable todo-tags
      await executeEvolutionStepInBrowser(
        page,
        server.url,
        steps[4]!.prompt,
        steps[4]!.summary,
      );
      step5CompositionId = release.getStatus().activeComposition!.compositionId;
      await expect(page.locator('[data-todo-tag="URGENT"]')).toHaveCount(0);
      await expect(page.locator("[data-todo-counter]")).toContainText("已完成 1");

      // Verify todo-review continues to run normally while todo-tags is disabled
      const reviewsStep5 = await fetch(`${server.url}/api/app/todo-review/reviews`);
      expect(reviewsStep5.status).toBe(200);
      const reviewsStep5Json = (await reviewsStep5.json()) as {
        reviews: Array<{ summary: string }>;
      };
      expect(reviewsStep5Json.reviews.map((r) => r.summary)).toEqual([
        "已完成全部回归验证",
      ]);
      const probeTaskRes = await fetch(`${server.url}/api/app/todo-core/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Step 5 Review Probe" }),
      });
      const probeTaskId = (
        (await probeTaskRes.json()) as { task: { id: string } }
      ).task.id;
      const probeBlocked = await fetch(
        `${server.url}/api/app/todo-core/tasks/${encodeURIComponent(probeTaskId)}/transition`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ nextState: "done" }),
        },
      );
      expect(probeBlocked.status).toBe(422);
      await fetch(
        `${server.url}/api/app/todo-core/tasks/${encodeURIComponent(probeTaskId)}`,
        { method: "DELETE" },
      );

      // Verify tag table data zero loss in SQLite
      const dbAfterStep5 = new DatabaseSync(businessDbPath, { readOnly: true });
      const tagRowsStep5 = dbAfterStep5
        .prepare("SELECT label FROM plg_todo_tags__tags ORDER BY created_at ASC")
        .all() as Array<{ label: string }>;
      dbAfterStep5.close();
      expect(tagRowsStep5.map((r) => r.label)).toEqual(["URGENT", "backend"]);

      // Step 6: Zero-code re-enable todo-tags
      await executeEvolutionStepInBrowser(
        page,
        server.url,
        steps[5]!.prompt,
        steps[5]!.summary,
      );
      step6CompositionId = release.getStatus().activeComposition!.compositionId;

      // Switch to "已完成" filter to see the completed task and its restored tags
      await page.getByRole("button", { name: "已完成" }).click();
      await expect(page.locator('[data-todo-tag="URGENT"]')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.locator('[data-todo-tag="backend"]')).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await loop.close();
      await server.close();
      await release.close();
    }

    // Post-step-6: Restart recovery + Data-preserving rollback
    const recoveredRelease = new CompositionRelease({
      controlDbPath,
      businessDbPath,
      workDir: join(dir, "work-recovered"),
      clientAssetsDir: assetsDir,
      enablePreviewClientHost: true,
    });
    await recoveredRelease.bootstrap();
    expect(recoveredRelease.getStatus().activeComposition?.compositionId).toBe(
      step6CompositionId,
    );

    const recoveredServer = await startV3HttpServer(recoveredRelease.runtime, {
      clientAssetsDir: assetsDir,
      enableClientHost: true,
      releaseController: recoveredRelease,
    });
    recoveredRelease.setProductionUrl(recoveredServer.url);

    try {
      await page.goto(recoveredServer.url);
      await expect(page.locator("[data-todo-counter]")).toContainText("已完成 1", {
        timeout: 15_000,
      });
      await page.getByRole("button", { name: "已完成" }).click();
      await expect(page.locator('[data-todo-tag="URGENT"]')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.locator('[data-todo-tag="backend"]')).toBeVisible({
        timeout: 10_000,
      });

      // Data-preserving rollback to Step 5 (todo-tags disabled)
      const rollbackResult = await recoveredRelease.rollback(step5CompositionId);
      expect(rollbackResult.composition.compositionId).toMatch(/^comp-rb-/);
      expect(
        rollbackResult.composition.members.find(
          (m) => m.pluginId === "todo-tags",
        )?.enabled,
      ).toBe(false);
      await page.reload();
      await expect(page.locator("[data-todo-counter]")).toContainText("已完成 1", {
        timeout: 15_000,
      });
      await expect(page.locator('[data-todo-tag="URGENT"]')).toHaveCount(0);

      // Historical data in SQLite remains completely intact after rollback
      const dbAfterRollback = new DatabaseSync(businessDbPath, { readOnly: true });
      const tagRowsRollback = dbAfterRollback
        .prepare("SELECT label FROM plg_todo_tags__tags ORDER BY created_at ASC")
        .all() as Array<{ label: string }>;
      const reviewRowsRollback = dbAfterRollback
        .prepare("SELECT summary FROM plg_todo_review__reviews")
        .all() as Array<{ summary: string }>;
      dbAfterRollback.close();
      expect(tagRowsRollback.map((r) => r.label)).toEqual(["URGENT", "backend"]);
      expect(reviewRowsRollback.map((r) => r.summary)).toEqual([
        "已完成全部回归验证",
      ]);
    } finally {
      await recoveredServer.close();
      await recoveredRelease.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
