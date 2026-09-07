import { test, expect } from "@playwright/test";

test("quiet workspace, secondary settings, accessible panels and touch targets", async ({
  page,
  request,
}, info) => {
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
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/");
  await expect(page.getByText("暂无任务", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("empty-desktop.png") });
  for (const title of [
    "整理周一会议的讨论要点",
    "读完《设计心理学》第三章",
    "给绿植浇水",
    "预约周末的网球场",
  ]) {
    await page
      .getByRole("textbox", { name: "添加任务", exact: true })
      .fill(title);
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect(
      page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
    ).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath("desktop.png") });
  const ai = page.getByRole("button", { name: "改进应用", exact: true });
  await ai.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("textbox", { name: "告诉 AI 你的需求" }),
  ).toBeFocused();
  await expect(page.getByRole("button", { name: "发送需求" })).toBeDisabled();
  await page.screenshot({ path: info.outputPath("assistant-desktop.png") });
  await page.keyboard.press("Escape");
  await expect(ai).toBeFocused();
  await page.getByRole("button", { name: "更多选项" }).click();
  await page.getByRole("menuitem", { name: "工作区设置" }).click();
  await expect(page.getByText("版本记录", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  const size = await page
    .getByRole("button", { name: "完成 给绿植浇水", exact: true })
    .boundingBox();
  expect(size!.width).toBeGreaterThanOrEqual(44);
  expect(size!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({
    path: info.outputPath("mobile.png"),
    fullPage: true,
  });
  await ai.click();
  await page.screenshot({
    path: info.outputPath("assistant-mobile.png"),
    fullPage: true,
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .getByRole("dialog")
      .evaluate((el) => getComputedStyle(el).animationName),
  ).toBe("none");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
});
