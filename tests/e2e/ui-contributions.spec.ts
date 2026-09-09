import { test, expect } from "@playwright/test";
import type {
  AssistantCommand,
  AssistantSnapshot,
} from "../../src/shared/assistant.js";
import { uiDetailVersionId } from "../fixtures/ui-detail.js";

test.beforeEach(async ({ request }) => {
  const composition = await (await request.get("/api/composition")).json();
  if (composition.workflow.id === "default") return;
  const defaultVersion = composition.history.find(
    (item: { workflowId: string }) => item.workflowId === "default",
  )?.versionId;
  await request.post("/api/runtime/restore", {
    data: {
      compositionRevision: composition.revision,
      operationId: crypto.randomUUID(),
      ...(defaultVersion ? { versionId: defaultVersion } : {}),
    },
  });
});

async function activateUiDetail(
  request: import("@playwright/test").APIRequestContext,
) {
  const before = await (await request.get("/api/composition")).json();
  const restore = await request.post("/api/runtime/restore", {
    data: {
      compositionRevision: before.revision,
      operationId: crypto.randomUUID(),
      versionId: await uiDetailVersionId("e2e-fixture"),
    },
  });
  expect(restore.ok()).toBeTruthy();
  return (await request.get("/api/composition")).json();
}

test("task.detail UI contribution renders, writes via command, and clears after restore", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const activated = await activateUiDetail(request);
  expect(activated.workflow.id).toBe("ui-detail");
  expect(activated.uiContributions?.[0]?.title).toBe("扩展证明");
  expect(
    activated.extensions.capabilities.some(
      (c: { interfaceId: string; status: string }) =>
        c.interfaceId === "ui.slot" && c.status === "active",
    ),
  ).toBeTruthy();

  await page.goto("/");
  const title = "UI 贡献浏览器验收";
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("button", { name: `编辑 ${title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "扩展证明" })).toBeVisible();
  await expect(page.getByText("仅用于验证 UI 贡献闭环。")).toBeVisible();
  await page
    .getByRole("article", { name: "扩展证明" })
    .getByRole("button", { name: `打证明标记 ${title}`, exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "扩展证明" }).getByText("ok", { exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByText("改进应用", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭改进应用", exact: true }).click();

  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "工作区设置" }).click();
  await page.getByRole("button", { name: "撤回上个版本", exact: true }).click();
  await expect(page.getByText("默认流程", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区设置", exact: true }).click();

  await page.getByRole("button", { name: `编辑 ${title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "扩展证明" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("contribution action failure does not block stop/apply or workspace recovery", async ({
  page,
  request,
}) => {
  await activateUiDetail(request);

  await page.route("**/api/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "action" && command.actionId === "markProof")
      return route.fulfill({
        status: 400,
        json: { code: "ACTION_FAILED", message: "动作失败（验收）" },
      });
    return route.continue();
  });

  const plan = {
    id: "plan-ui",
    compositionRevision: 1,
    route: { kind: "application" as const },
    summary: "UI 贡献故障壳",
    changes: ["证明"],
    outcome: "可验证",
    dataImpact: "保留任务",
    requestRevision: 1,
    excluded: [],
    evidence: [{ ref: "active-source", hash: "source-hash" }],
    capabilityChanges: [],
    acceptance: [],
  };
  let snapshot: AssistantSnapshot = {
    availability: "ready",
    run: {
      id: "run-ui-fail",
      request: "证明故障壳",
      updatedAt: new Date().toISOString(),
      status: "awaiting-apply",
      plan,
      steps: [],
      summary: "候选已验证",
      experience: {
        candidateId: "cand-1",
        marked: "not-applied",
        isolated: true,
        simulated: true,
        checks: ["ui.slot:active", "ui.write:commit"],
        uiContributions: [
          {
            id: "proof-panel",
            slot: "task.detail",
            title: "扩展证明",
            body: "体验摘要",
            actions: [{ commandId: "markProof", label: "打证明标记" }],
            fields: [{ key: "proofMark", label: "证明标记" }],
            providerId: "ui-detail",
          },
        ],
        note: "隔离模拟",
      },
    },
    candidates: [
      {
        id: "cand-1",
        planId: plan.id,
        baseVersion: "base",
        attempt: 1,
        passed: true,
        evidenceHash: "evidence",
        versionId: "v1",
        sourceHash: "src",
      },
    ],
  };
  await page.route("**/api/assistant**", (route) => {
    if (route.request().url().includes("/commands")) return route.fallback();
    return route.fulfill({ json: snapshot });
  });
  await page.route("**/api/assistant/commands", async (route) => {
    const command = route.request().postDataJSON() as AssistantCommand;
    if (command.type === "cancel") {
      snapshot = {
        availability: "ready",
        run: {
          id: "run-ui-fail",
          request: "证明故障壳",
          updatedAt: new Date().toISOString(),
          status: "cancelled",
        },
      };
    }
    await route.fulfill({ json: snapshot });
  });

  await page.goto("/");
  const title = "故障隔离任务";
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("button", { name: `编辑 ${title}`, exact: true }).click();
  await page
    .getByRole("article", { name: "扩展证明" })
    .getByRole("button", { name: `打证明标记 ${title}`, exact: true })
    .click();
  await expect(
    page
      .getByRole("region", { name: "任务详情扩展" })
      .getByText("动作失败（验收）", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();

  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(page.getByRole("heading", { name: "扩展证明" })).toBeVisible();
  await expect(page.getByText("模拟写入结果：ui.write:commit")).toBeVisible();
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "放弃候选", exact: true }).click();
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭改进应用", exact: true }).click();

  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "工作区设置" }).click();
  await expect(page.getByText("运行状态", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区设置", exact: true }).click();
});

test("illegal task.detail contribution shows substitute without crashing shell", async ({
  page,
  request,
}) => {
  const composition = await (await request.get("/api/composition")).json();
  const created = await (
    await request.post("/api/commands", {
      data: {
        type: "create",
        title: "替代态任务",
        compositionRevision: composition.revision,
        operationId: crypto.randomUUID(),
      },
    })
  ).json();
  await page.route("**/api/composition", async (route) => {
    const body = await (await route.fetch()).json();
    await route.fulfill({
      json: {
        ...body,
        uiContributions: [],
        uiContributionFaults: [
          {
            id: "broken",
            slot: "task.detail",
            reason: "未知命令：missing",
            providerId: "broken",
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: `编辑 ${created.task.title}`, exact: true })
    .click();
  await expect(page.getByText("此 UI 贡献不可用", { exact: true })).toBeVisible();
  await expect(page.getByText("broken：未知命令：missing")).toBeVisible();
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "关闭改进应用", exact: true }),
  ).toBeVisible();
});

test("contribution input-required opens ActionForm and returns to task detail", async ({
  page,
  request,
}) => {
  await activateUiDetail(request);
  let taskId = "";
  let marked = false;
  await page.route("**/api/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "action" || command.actionId !== "markProof")
      return route.continue();
    if (!command.input?.note) {
      return route.fulfill({
        json: {
          decision: {
            kind: "input-required",
            fields: [
              { key: "note", label: "证明说明", type: "text", required: true },
            ],
          },
        },
      });
    }
    marked = true;
    taskId = command.taskId;
    const task = {
      id: command.taskId,
      title: "表单回程任务",
      description: "",
      state: "open",
      revision: (command.expectedRevision ?? 1) + 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      fields: { proofMark: "ok", note: command.input.note },
    };
    return route.fulfill({
      json: {
        task,
        decision: { kind: "commit", state: "open", fields: task.fields },
      },
    });
  });
  await page.route("**/api/tasks/*", async (route) => {
    if (route.request().method() !== "GET" || !marked || !taskId)
      return route.continue();
    if (!route.request().url().includes(taskId)) return route.continue();
    return route.fulfill({
      json: {
        id: taskId,
        title: "表单回程任务",
        description: "",
        state: "open",
        revision: 2,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        deletedAt: null,
        fields: { proofMark: "ok", note: "已核对" },
      },
    });
  });

  await page.goto("/");
  const title = "表单回程任务";
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("button", { name: `编辑 ${title}`, exact: true }).click();
  await page
    .getByRole("article", { name: "扩展证明" })
    .getByRole("button", { name: `打证明标记 ${title}`, exact: true })
    .click();
  await page.getByLabel("证明说明", { exact: true }).fill("已核对");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "打证明标记", exact: true })
    .click();
  await expect(page.getByRole("heading", { name: "扩展证明" })).toBeVisible();
  await expect(
    page.getByRole("article", { name: "扩展证明" }).getByText("ok", { exact: true }),
  ).toBeVisible();
  expect(marked).toBeTruthy();
});

test("executing run still exposes stop after contribution action failure", async ({
  page,
  request,
}) => {
  await activateUiDetail(request);
  await page.route("**/api/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "action" && command.actionId === "markProof")
      return route.fulfill({
        status: 400,
        json: { code: "ACTION_FAILED", message: "动作失败（验收）" },
      });
    return route.continue();
  });
  const plan = {
    id: "plan-exec",
    compositionRevision: 1,
    route: { kind: "application" as const },
    summary: "执行中",
    changes: [],
    outcome: "",
    dataImpact: "",
    requestRevision: 1,
    excluded: [],
    evidence: [],
    capabilityChanges: [],
    acceptance: [],
  };
  let snapshot: AssistantSnapshot = {
    availability: "ready",
    run: {
      id: "run-exec",
      request: "执行中停止",
      updatedAt: new Date().toISOString(),
      status: "executing",
      plan,
      steps: [
        { id: "gen", label: "生成候选", status: "running", attempt: 1 },
      ],
    },
  };
  await page.route("**/api/assistant**", (route) => {
    if (route.request().url().includes("/commands")) return route.fallback();
    return route.fulfill({ json: snapshot });
  });
  await page.route("**/api/assistant/commands", async (route) => {
    const command = route.request().postDataJSON() as AssistantCommand;
    if (command.type === "cancel")
      snapshot = {
        availability: "ready",
        run: {
          id: "run-exec",
          request: "执行中停止",
          updatedAt: new Date().toISOString(),
          status: "cancelled",
        },
      };
    await route.fulfill({ json: snapshot });
  });

  await page.goto("/");
  const title = "执行中停止任务";
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("button", { name: `编辑 ${title}`, exact: true }).click();
  await page
    .getByRole("article", { name: "扩展证明" })
    .getByRole("button", { name: `打证明标记 ${title}`, exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "任务详情扩展" }).getByRole("alert"),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
});
