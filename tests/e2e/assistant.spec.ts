import { test, expect } from "@playwright/test";
import type {
  AssistantCommand,
  AssistantPlan,
  AssistantSnapshot,
} from "../../src/shared/assistant.js";

// UI contract fixtures only. No model generation or semantic routing claim.
for (const route of [
  { kind: "task" },
  { kind: "create-plugin", name: "完成前复盘" },
  { kind: "modify-plugin", pluginId: "review", name: "完成前复盘" },
] as const) {
  test(`AI contract: ${route.kind}, explicit confirmation and background progress`, async ({
    page,
  }, info) => {
    await page.setViewportSize({
      width: route.kind === "create-plugin" ? 390 : 1280,
      height: 900,
    });
    const plan: AssistantPlan = {
      id: "plan-1",
      compositionRevision: 3,
      route,
      summary: "完成任务前，需要留下一句复盘。",
      changes: ["在完成操作中增加复盘输入", "复盘为空时保持任务未完成"],
      outcome: "点击完成后填写复盘，提交后任务进入已完成。",
      dataImpact: "保留已有任务和复盘内容。",
    };
    const run = {
      id: "run-1",
      request: "完成前写一句复盘",
      updatedAt: new Date().toISOString(),
    };
    let snapshot: AssistantSnapshot = { availability: "ready", run: null };
    const commands: AssistantCommand[] = [];
    await page.route("**/api/assistant", (route) =>
      route.fulfill({ json: snapshot }),
    );
    await page.route("**/api/assistant/commands", async (route) => {
      const command = route.request().postDataJSON() as AssistantCommand;
      commands.push(command);
      if (command.type === "request")
        snapshot = {
          availability: "ready",
          run: { ...run, status: "planning" },
        };
      if (command.type === "confirm")
        snapshot = {
          availability: "ready",
          run: {
            ...run,
            status: "executing",
            plan,
            steps: [
              { id: "build", label: "构建插件", status: "running" },
              { id: "verify", label: "验证任务流程", status: "pending" },
              { id: "apply", label: "应用变更", status: "pending" },
            ],
          },
        };
      await route.fulfill({ json: snapshot });
    });
    await page.goto("/");
    await page
      .getByRole("button", { name: "打开 AI 助手", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "告诉 AI 你的需求" })
      .fill(run.request);
    await page.getByRole("button", { name: "发送需求" }).click();
    await expect(page.getByRole("status")).toContainText("正在理解需求");
    snapshot = {
      availability: "ready",
      run: { ...run, status: "awaiting-confirmation", plan },
    };
    await expect(
      page.getByRole("region", { name: "待确认方案" }),
    ).toBeVisible();
    expect(commands.map((command) => command.type)).toEqual(["request"]);
    const mode =
      route.kind === "task"
        ? "操作任务"
        : route.kind === "create-plugin"
          ? "新建插件 · 完成前复盘"
          : "修改现有插件 · 完成前复盘";
    await expect(page.getByText(mode, { exact: true })).toBeVisible();
    await expect(page.getByText(plan.outcome, { exact: true })).toBeVisible();
    await page.screenshot({
      path: info.outputPath("confirmation.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "确认执行" }).click();
    expect(commands[1]).toMatchObject({
      type: "confirm",
      runId: run.id,
      planId: plan.id,
      compositionRevision: plan.compositionRevision,
    });
    await expect(page.getByRole("list", { name: "执行进度" })).toContainText(
      "构建插件",
    );
    await page.screenshot({
      path: info.outputPath("executing.png"),
      fullPage: true,
    });
    await page.getByRole("button", { name: "关闭AI 助手" }).click();
    await expect(page.getByLabel("AI 正在处理", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("AI 正在处理", { exact: true })).toBeVisible();
    snapshot = {
      availability: "ready",
      run: {
        ...run,
        status: "succeeded",
        summary: "已更新完成流程。",
        steps: [{ id: "apply", label: "应用变更", status: "succeeded" }],
      },
    };
    await expect(page.getByText("AI 有新消息", { exact: true })).toHaveCount(1);
    await page
      .getByRole("button", { name: "打开 AI 助手", exact: true })
      .click();
    await expect(page.getByRole("status")).toContainText("已更新完成流程");
    expect(commands).toHaveLength(2);
  });
}

test("AI unavailable never fabricates a plan, requests do not change tasks", async ({
  page,
  request,
}) => {
  const before = await (await request.get("/api/composition")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
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
  await page.route("**/api/assistant", (route) =>
    offline ? route.abort() : route.fulfill({ json: snapshot }),
  );
  const commands: AssistantCommand[] = [];
  await page.route("**/api/assistant/commands", async (route) => {
    commands.push(route.request().postDataJSON());
    snapshot = { availability: "ready", run: { ...run, status: "cancelled" } };
    await route.fulfill({ json: snapshot });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  await expect(page.getByText("正在理解需求并整理方案…")).toBeVisible();
  offline = true;
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.getByText("正在理解需求并整理方案…")).toBeVisible();
  offline = false;
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("已取消");
  expect(commands[0]).toMatchObject({ type: "cancel", runId: run.id });
});
