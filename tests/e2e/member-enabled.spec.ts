import { test, expect } from "@playwright/test";
import type {
  AssistantCommand,
  AssistantSnapshot,
} from "../../src/shared/assistant.js";
import { memberUiVersionId } from "../fixtures/member-ui.js";

async function restoreDefault(
  request: import("@playwright/test").APIRequestContext,
) {
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
}

test.beforeEach(async ({ request }) => {
  await restoreDefault(request);
});

test.afterEach(async ({ request }) => {
  await restoreDefault(request);
});

async function activateMemberUi(
  request: import("@playwright/test").APIRequestContext,
) {
  const before = await (await request.get("/api/composition")).json();
  const restore = await request.post("/api/runtime/restore", {
    data: {
      compositionRevision: before.revision,
      operationId: crypto.randomUUID(),
      versionId: await memberUiVersionId("e2e-fixture"),
    },
  });
  expect(restore.ok()).toBeTruthy();
  return (await request.get("/api/composition")).json();
}

async function openWorkspaceSettings(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "工作区设置" }).click();
  await expect(page.getByText("组合成员", { exact: true })).toBeVisible();
}

async function roundTripDisableEnable(
  page: import("@playwright/test").Page,
  title: string,
) {
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("button", { name: `编辑 ${title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "备注面板" })).toBeVisible();
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();

  await openWorkspaceSettings(page);
  await expect(page.getByText("panel", { exact: true })).toBeVisible();
  await expect(
    page.getByText("已启用", { exact: true }).first(),
  ).toBeVisible();
  const panelRow = page.locator("li").filter({ hasText: "panel" });
  await expect(panelRow.getByText("已启用", { exact: true })).toBeVisible();
  await panelRow.getByRole("button", { name: "停用 panel" }).click();
  await expect(panelRow.getByText("已停用", { exact: true })).toBeVisible();
  await expect(panelRow.getByRole("button", { name: "启用 panel" })).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区设置", exact: true }).click();

  await page.getByRole("button", { name: `编辑 ${title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "备注面板" })).toHaveCount(0);
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();

  await openWorkspaceSettings(page);
  await expect(panelRow.getByText("已停用", { exact: true })).toBeVisible();
  await panelRow.getByRole("button", { name: "启用 panel" }).click();
  await expect(panelRow.getByText("已启用", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区设置", exact: true }).click();

  await page.getByRole("button", { name: `编辑 ${title}`, exact: true }).click();
  await expect(page.getByRole("heading", { name: "备注面板" })).toBeVisible();
  await page
    .getByRole("article", { name: "备注面板" })
    .getByRole("button", { name: `打备注标记 ${title}`, exact: true })
    .click();
  await expect(
    page.getByRole("article", { name: "备注面板" }).getByText("ok", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭任务详情", exact: true }).click();
}

test("workspace member disable/enable round-trip hides and restores task.detail contribution", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const activated = await activateMemberUi(request);
  expect(activated.workflow.id).toBe("aux-workflow");
  expect(activated.members.some((m: { pluginId: string }) => m.pluginId === "panel")).toBeTruthy();
  expect(
    activated.uiContributions?.some(
      (c: { id: string }) => c.id === "note-panel",
    ),
  ).toBeTruthy();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await roundTripDisableEnable(page, "桌面成员往返");
  const afterDesktop = await (await request.get("/api/composition")).json();
  expect(
    afterDesktop.uiContributions?.some(
      (c: { id: string }) => c.id === "note-panel",
    ),
  ).toBeTruthy();
  expect(
    afterDesktop.members.find((m: { pluginId: string }) => m.pluginId === "panel")
      ?.enabled,
  ).toBe(true);

  await page.setViewportSize({ width: 390, height: 844 });
  await roundTripDisableEnable(page, "窄屏成员往返");
  expect(errors).toEqual([]);
});

test("stale member disable shows readable reason and keeps protected shell", async ({
  page,
  request,
}) => {
  const activated = await activateMemberUi(request);
  expect(activated.uiContributions?.some((c: { id: string }) => c.id === "note-panel")).toBeTruthy();

  const plan = {
    id: "plan-member",
    compositionRevision: activated.revision,
    route: { kind: "application" as const },
    summary: "外壳",
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
      id: "run-member-shell",
      request: "证明外壳",
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
        checks: ["ui.slot:active"],
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
    if (command.type === "cancel")
      snapshot = {
        availability: "ready",
        run: {
          id: "run-member-shell",
          request: "证明外壳",
          updatedAt: new Date().toISOString(),
          status: "cancelled",
        },
      };
    await route.fulfill({ json: snapshot });
  });

  await page.goto("/");
  await openWorkspaceSettings(page);
  await expect(page.getByRole("button", { name: "撤回上个版本", exact: true })).toBeEnabled();

  const beforeStale = await (await request.get("/api/composition")).json();
  const bumped = await request.post("/api/composition/members", {
    data: {
      operationId: crypto.randomUUID(),
      compositionRevision: beforeStale.revision,
      versionId: beforeStale.versionId,
      pluginId: "panel",
      enabled: false,
    },
  });
  expect(bumped.ok()).toBeTruthy();
  const afterBump = await (await request.get("/api/composition")).json();
  expect(afterBump.revision).toBe(beforeStale.revision + 1);
  expect(
    afterBump.uiContributions?.some((c: { id: string }) => c.id === "note-panel"),
  ).toBeFalsy();

  const panelRow = page.locator("li").filter({ hasText: "panel" });
  await panelRow.getByRole("button", { name: "停用 panel" }).click();
  await expect(
    page.getByRole("alert").getByText("流程已变化，请刷新后重试；草稿已保留"),
  ).toBeVisible();
  await expect(panelRow.getByText("已停用", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "撤回上个版本", exact: true })).toBeEnabled();
  await expect(page.getByText("版本记录", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区设置", exact: true }).click();

  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(page.getByRole("button", { name: "应用", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "关闭改进应用", exact: true }).click();

  snapshot = {
    availability: "ready",
    run: {
      id: "run-member-shell",
      request: "证明外壳",
      updatedAt: new Date().toISOString(),
      status: "executing",
      plan,
      steps: [{ id: "gen", label: "生成候选", status: "running", attempt: 1 }],
    },
  };
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await expect(page.getByText("已取消", { exact: true })).toBeVisible();
});
