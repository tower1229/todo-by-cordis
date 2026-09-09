import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../../src/release/storage.js";

async function uiDetailVersionId() {
  const code = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/ui-detail-plugin.mjs"),
    "utf8",
  );
  return hash({
    pluginId: "ui-detail",
    name: "UI 贡献证明",
    service: "workflow",
    contractVersion: "workflow/1",
    source: code,
    code,
    definition: {
      id: "ui-detail",
      name: "UI 贡献证明",
      version: "1.0.0",
      initialState: "open",
      states: {
        open: { label: "未完成", category: "open" },
        done: { label: "已完成", category: "done" },
      },
      actions: [
        { id: "complete", label: "完成", from: ["open"] },
        { id: "reopen", label: "重新打开", from: ["done"] },
      ],
      fields: [],
    },
    evidence: { passed: true, origin: "e2e-fixture" },
  });
}

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

test("task.detail UI contribution renders, writes via command, and clears after restore", async ({
  page,
  request,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  const before = await (await request.get("/api/composition")).json();
  const restore = await request.post("/api/runtime/restore", {
    data: {
      compositionRevision: before.revision,
      operationId: crypto.randomUUID(),
      versionId: await uiDetailVersionId(),
    },
  });
  expect(restore.ok()).toBeTruthy();
  const activated = await (await request.get("/api/composition")).json();
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
  await expect(
    page.getByRole("article", { name: "扩展证明" }),
  ).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("contribution action failure does not block assistant or workspace recovery", async ({
  page,
  request,
}) => {
  const before = await (await request.get("/api/composition")).json();
  const restore = await request.post("/api/runtime/restore", {
    data: {
      compositionRevision: before.revision,
      operationId: crypto.randomUUID(),
      versionId: await uiDetailVersionId(),
    },
  });
  expect(restore.ok()).toBeTruthy();

  await page.route("**/api/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type === "action" && command.actionId === "markProof")
      return route.fulfill({
        status: 400,
        json: { code: "ACTION_FAILED", message: "动作失败（验收）" },
      });
    return route.continue();
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
  await expect(
    page.getByRole("button", { name: "关闭改进应用", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "关闭改进应用", exact: true }).click();
  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "工作区设置" }).click();
  await expect(page.getByText("运行状态", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区设置", exact: true }).click();
});
