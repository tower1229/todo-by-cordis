import { test, expect } from "@playwright/test";
import type {
  AssistantCommand,
  AssistantSnapshot,
} from "../../src/shared/assistant.js";

// A12/A13 browser seams: interrupted recovery UI, cancel identity, workspace restore entry.

test("A12: interrupted run shows recovery actions and replan entry", async ({
  page,
}) => {
  const run = {
    id: "interrupted-run",
    request: "完成前填写复盘",
    updatedAt: new Date().toISOString(),
    status: "interrupted" as const,
    message:
      "旧计划须重新调查或宿主重启，未完成的运行已中断。请重新提出需求。",
  };
  const snapshot: AssistantSnapshot = { availability: "ready", run };
  await page.route("**/api/assistant**", (route) => {
    if (route.request().url().includes("/commands")) return route.fallback();
    return route.fulfill({ json: snapshot });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(page.getByRole("region", { name: "恢复动作" })).toBeVisible();
  await expect(page.getByText(run.message)).toBeVisible();
  await expect(
    page.getByText("不会自动重放模型", { exact: false }),
  ).toBeVisible();
  await page.getByRole("button", { name: "重新规划", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "告诉 AI 你的需求" }),
  ).toHaveValue(run.request);
});

test("A12: succeeded card exposes version receipt and rollback guidance", async ({
  page,
}) => {
  const snapshot: AssistantSnapshot = {
    availability: "ready",
    run: {
      id: "ok-run",
      request: "完成前填写复盘",
      updatedAt: new Date().toISOString(),
      status: "succeeded",
      summary: "候选已正式应用",
      versionId: "version-applied-abc",
      steps: [{ id: "apply", label: "应用候选", status: "succeeded" }],
    },
  };
  await page.route("**/api/assistant**", (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(page.getByText("已发布版本：version-applied-abc")).toBeVisible();
  await expect(
    page.getByText("期间新增的任务和字段会保留", { exact: false }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "继续修改" })).toBeVisible();
});

test("A13: workspace panel can initiate restore while keeping listed tasks", async ({
  page,
  request,
}) => {
  const title = `A13保留任务 ${Date.now()}`;
  const real = await (await request.get("/api/composition")).json();
  let restoreBody: unknown;
  await page.route("**/api/composition", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await route.fulfill({
      json: {
        ...real,
        previousVersionId: real.previousVersionId ?? "previous-version",
        history: real.history?.length
          ? real.history
          : [
              {
                id: 2,
                workflowId: "review",
                versionId: real.versionId,
                name: "复盘",
                createdAt: new Date().toISOString(),
                pausedMs: 0,
                preparationMs: 1,
              },
              {
                id: 1,
                workflowId: "default",
                versionId: "previous-version",
                name: "默认流程",
                createdAt: new Date().toISOString(),
                pausedMs: 0,
                preparationMs: 1,
              },
            ],
      },
    });
  });
  await page.route("**/api/runtime/restore", async (route) => {
    restoreBody = route.request().postDataJSON();
    await route.fulfill({
      json: { revision: real.revision + 1, versionId: "previous-version" },
    });
  });

  await page.goto("/");
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "更多选项" }).click();
  await page.getByRole("menuitem", { name: "工作区设置" }).click();
  await expect(page.getByText("撤回版本，保留已有任务和字段。")).toBeVisible();
  await page.getByRole("button", { name: "撤回上个版本" }).click();
  await expect
    .poll(() => restoreBody)
    .toMatchObject({ compositionRevision: real.revision });
  await page.getByRole("button", { name: "关闭工作区设置" }).click();
  await expect(
    page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
  ).toBeVisible();
  const tasks = await (
    await request.get(`/api/tasks?search=${encodeURIComponent(title)}`)
  ).json();
  expect(tasks.total).toBe(1);
});

test("A12: cancel during executing keeps run identity without late apply command", async ({
  page,
}) => {
  const base = {
    id: "exec-run",
    request: "完成前复盘",
    updatedAt: new Date().toISOString(),
  };
  let snapshot: AssistantSnapshot = {
    availability: "ready",
    run: {
      ...base,
      status: "executing",
      plan: {
        id: "p1",
        compositionRevision: 1,
        route: { kind: "application" },
        summary: "复盘",
        changes: [],
        outcome: "复盘",
        dataImpact: "保留",
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
        rollback: "保留数据撤回",
        preview: "",
        application: "",
        restartImpact: "",
        dependencies: [],
        unresolved: [],
      },
      steps: [{ id: "gen", label: "生成候选", status: "running", attempt: 1 }],
    },
  };
  const commands: AssistantCommand[] = [];
  await page.route("**/api/assistant**", (route) => {
    if (route.request().url().includes("/commands")) return route.fallback();
    return route.fulfill({ json: snapshot });
  });
  await page.route("**/api/assistant/commands", async (route) => {
    const command = route.request().postDataJSON() as AssistantCommand;
    commands.push(command);
    snapshot = { availability: "ready", run: { ...base, status: "cancelled" } };
    await route.fulfill({ json: snapshot });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(page.getByRole("region", { name: "执行进度" })).toBeVisible();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已取消");
  expect(commands).toEqual([
    expect.objectContaining({ type: "cancel", runId: base.id }),
  ]);
  expect(commands.some((c) => c.type === "apply")).toBe(false);
});
