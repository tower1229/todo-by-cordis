import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

test("empty and seeded overview have clear hierarchy and usable keyboard focus", async ({
  page,
  request,
}) => {
  const composition = await (await request.get("/api/composition")).json();
  const list = await (await request.get("/api/tasks?category=all")).json();
  for (const task of list.tasks)
    await request.post("/api/commands", {
      data: {
        type: "delete",
        taskId: task.id,
        expectedRevision: task.revision,
        compositionRevision: composition.revision,
        operationId: crypto.randomUUID(),
      },
    });
  if (composition.workflow.id !== "default")
    await request.post("/api/releases", {
      data: {
        workflowId: "default",
        compositionRevision: composition.revision,
        operationId: crypto.randomUUID(),
      },
    });
  await page.setViewportSize({ width: 1280, height: 960 });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "今天，想从什么开始？" }),
  ).toBeVisible();
  mkdirSync("docs/reports/m1-screenshots", { recursive: true });
  await page.screenshot({
    path: "docs/reports/m1-screenshots/empty-desktop.png",
  });
  await page.getByRole("button", { name: "或载入三件示例任务" }).click();
  await expect(
    page.getByRole("button", {
      name: "完成 给今天留出 20 分钟阅读",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({
    path: "docs/reports/m1-screenshots/overview-desktop.png",
  });
  await page.getByRole("button", { name: "新增任务", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("想做些什么？")).toBeFocused();
  await page.getByRole("button", { name: "关闭详情" }).click();
  await expect(
    page.getByRole("button", { name: "新增任务", exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    page.getByRole("button", {
      name: "完成 给今天留出 20 分钟阅读",
      exact: true,
    }),
  ).toBeVisible();
  const size = await page
    .getByRole("button", { name: "完成 给今天留出 20 分钟阅读", exact: true })
    .boundingBox();
  expect(size!.width).toBeGreaterThanOrEqual(44);
  expect(size!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: "docs/reports/m1-screenshots/overview-mobile.png",
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "进化", exact: true }).click();
  expect(
    await page
      .locator(".seed-body")
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
});
