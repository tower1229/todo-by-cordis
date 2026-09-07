import { test, expect } from "@playwright/test";
import type {
  AssistantCommand,
  AssistantSnapshot,
} from "../../src/shared/assistant.js";
// Browser contract fixtures; real backend planning is covered by app tests.
test("investigation, clarification, ready and start entry are available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 850 });
  const base = {
    id: "plan-run",
    request: "完成前复盘",
    updatedAt: new Date().toISOString(),
  };
  let snapshot: AssistantSnapshot = { availability: "ready", run: null };
  const commands: AssistantCommand[] = [];
  await page.route("**/api/assistant**", (route) =>
    route.fulfill({ json: snapshot }),
  );
  await page.route("**/api/assistant/commands", async (route) => {
    const command = route.request().postDataJSON() as AssistantCommand;
    commands.push(command);
    if (command.type === "start") {
      snapshot = {
        availability: "ready",
        run: {
          ...base,
          status: "executing",
          plan: (snapshot.run as { plan: never }).plan,
          steps: [
            {
              id: "gen",
              label: "生成候选",
              status: "running",
              attempt: 1,
            },
          ],
        },
      };
    } else {
      snapshot = {
        availability: "ready",
        run: { ...base, status: "planning" },
      };
    }
    await route.fulfill({ json: snapshot });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await page
    .getByRole("textbox", { name: "告诉 AI 你的需求" })
    .fill(base.request);
  await page.getByRole("button", { name: "发送需求" }).click();
  snapshot = {
    availability: "ready",
    run: { ...base, status: "awaiting-input", question: "复盘必填还是选填？" },
  };
  await expect(page.getByText("复盘必填还是选填？")).toBeVisible();
  await page.getByRole("textbox", { name: "告诉 AI 你的需求" }).fill("必填");
  await page.getByRole("button", { name: "发送需求" }).click();
  const plan = {
    id: "plan-2",
    compositionRevision: 1,
    route: { kind: "application" as const },
    summary: base.request,
    changes: ["增加复盘"],
    outcome: "空复盘不能完成",
    dataImpact: "保留任务",
    requestRevision: 2,
    excluded: [],
    evidence: [{ ref: "active-source", hash: "source-hash" }],
    capabilityChanges: [
      {
        capability: "工作流",
        provider: "active-source",
        consumers: [],
        change: "增加复盘字段",
      },
    ],
    cases: [],
    workflowRules: [],
    ruleChanges: [],
    acceptance: ["空复盘保持未完成"],
    steps: [
      {
        id: "workflow",
        purpose: "调整完成行为",
        dependsOn: [],
        artifact: "工作流候选",
        evidence: "独立验收",
      },
    ],
    writableScope: ["active-source"],
    compatibility: "保留字段",
    rollback: "保留数据撤回",
    preview: "隔离合成任务",
    application: "另行确认应用",
    restartImpact: "重启业务子进程",
    dependencies: [],
    unresolved: [],
  };
  snapshot = {
    availability: "ready",
    run: {
      ...base,
      status: "ready",
      requestRevision: 2,
      revisions: [
        {
          revision: 1,
          type: "request",
          text: base.request,
          createdAt: base.updatedAt,
        },
        {
          revision: 2,
          type: "answer",
          text: "必填",
          createdAt: base.updatedAt,
        },
      ],
      budget: {
        callsUsed: 5,
        callsRemaining: 7,
        candidatesRemaining: 3,
        millisecondsRemaining: 590000,
      },
      plan,
    },
  };
  await expect(page.getByRole("region", { name: "待确认方案" })).toBeVisible();
  await expect(page.getByText("空复盘不能完成")).toBeVisible();
  await expect(page.getByRole("button", { name: "开始执行" })).toBeVisible();
  await expect(page.getByRole("button", { name: "确认执行" })).toHaveCount(0);
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.getByRole("region", { name: "执行进度" })).toBeVisible();
  await expect(page.getByRole("button", { name: "停止" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "告诉 AI 你的需求" })).toHaveCount(
    0,
  );
  expect(commands.map((c) => c.type)).toEqual(["request", "answer", "start"]);
});

test("AI unavailable never fabricates a plan, requests do not change tasks", async ({
  page,
  request,
}) => {
  const before = await (await request.get("/api/composition")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await page
    .getByRole("textbox", { name: "告诉 AI 你的需求" })
    .fill("帮我创建一个插件");
  await expect(
    page.getByText("AI 尚未连接。可以先记下需求。", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "发送需求" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "确认执行" })).toHaveCount(0);
  const rejected = await request.post("/api/assistant/commands", {
    data: {
      type: "request",
      text: "帮我创建一个插件",
      operationId: crypto.randomUUID(),
    },
  });
  expect(rejected.status()).toBe(503);
  expect(await (await request.get("/api/composition")).json()).toEqual(before);
});

test("AI connection loss shows the last known stage and cancellation uses the run identity", async ({
  page,
}) => {
  const run = {
    id: "pending-run",
    request: "调整完成流程",
    updatedAt: new Date().toISOString(),
  };
  let snapshot: AssistantSnapshot = {
    availability: "ready",
    run: { ...run, status: "planning" },
  };
  let offline = false;
  await page.route("**/api/assistant**", (route) => {
    if (route.request().url().includes("/commands")) return route.fallback();
    return offline ? route.abort() : route.fulfill({ json: snapshot });
  });
  const commands: AssistantCommand[] = [];
  await page.route("**/api/assistant/commands", async (route) => {
    commands.push(route.request().postDataJSON());
    snapshot = { availability: "ready", run: { ...run, status: "cancelled" } };
    await route.fulfill({ json: snapshot });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(page.getByText("正在理解需求并整理方案…")).toBeVisible();
  offline = true;
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("正在理解需求并整理方案…")).toBeVisible();
  offline = false;
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已取消");
  expect(commands[0]).toMatchObject({ type: "cancel", runId: run.id });
});
