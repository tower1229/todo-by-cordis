import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
test.beforeEach(async ({ request }) => {
  const composition = await (await request.get("/api/composition")).json();
  if (composition.workflow.id !== "default")
    await request.post("/api/releases", {
      data: {
        workflowId: "default",
        compositionRevision: composition.revision,
        operationId: crypto.randomUUID(),
      },
    });
});
for (const width of [320, 390, 768, 1280]) {
  test(`${width}px: create edit review cancel restore and refresh`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("/");
    await page.getByRole("button", { name: "新增任务", exact: true }).click();
    const title = `为今天留一点空间 ${width}`;
    await page.getByLabel("想做些什么？").fill(title);
    await page
      .getByLabel("补充一点细节")
      .fill("这是一条很长的中文描述，用来检查手机界面是否自然换行。".repeat(8));
    await page.getByRole("button", { name: "保存任务", exact: true }).click();
    await expect(
      page.getByRole("button", { name: `完成 ${title}`, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `完成 ${title}`, exact: true })
      .click();
    await page.getByRole("button", { name: "已完成", exact: true }).click();
    await page
      .getByRole("button", { name: `重新打开 ${title}`, exact: true })
      .click();
    await page
      .getByRole("button", { name: /未完成/ })
      .first()
      .click();
    if (width < 768)
      await page.getByRole("button", { name: "进化", exact: true }).click();
    await page
      .getByRole("button", { name: "体验复盘流程", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "恢复轻快完成" }),
    ).toBeEnabled();
    mkdirSync("docs/reports/m1-screenshots", { recursive: true });
    await page.screenshot({
      path: `docs/reports/m1-screenshots/evolution-${width}.png`,
      fullPage: true,
    });
    if (width < 768)
      await page.getByRole("button", { name: "待办", exact: true }).click();
    await page
      .getByRole("button", { name: `完成 ${title}`, exact: true })
      .click();
    await page.getByLabel("这次，有什么收获？").fill("一小步也算数");
    await page.getByRole("button", { name: "先不完成" }).click();
    await expect(
      page.getByRole("button", { name: `完成 ${title}`, exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: `完成 ${title}`, exact: true })
      .click();
    await expect(page.getByLabel("这次，有什么收获？")).toHaveValue(
      "一小步也算数",
    );
    await page.getByRole("button", { name: "留下复盘并完成" }).click();
    if (width < 768)
      await page.getByRole("button", { name: "进化", exact: true }).click();
    await page.getByRole("button", { name: "恢复轻快完成" }).click();
    await expect(
      page.getByRole("button", { name: "体验复盘流程" }),
    ).toBeEnabled();
    if (width < 768)
      await page.getByRole("button", { name: "待办", exact: true }).click();
    await page.getByRole("button", { name: "已完成", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(`^${title}`) }).click();
    await expect(page.getByText("一小步也算数", { exact: true })).toBeVisible();
    await page.getByLabel("想做些什么？").fill(`${title}，继续向前`);
    await page.getByRole("button", { name: "保存任务", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "已完成", exact: true }).click();
    await expect(
      page.getByRole("button", { name: new RegExp(`^${title}，继续向前`) }),
    ).toBeVisible();
    await page.getByRole("button", { name: `删除 ${title}，继续向前` }).click();
    await page.getByRole("button", { name: "撤销删除" }).click();
    await expect(
      page.getByRole("button", { name: new RegExp(`^${title}，继续向前`) }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: `docs/reports/m1-screenshots/tasks-${width}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}
test("failed save, navigation, IME and composition changes preserve draft", async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "新增任务", exact: true }).click();
  const input = page.getByLabel("想做些什么？");
  await input.fill("保留这个草稿");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  await expect(input).toHaveValue("保留这个草稿");
  await input.dispatchEvent("compositionend");
  await page.route("**/api/commands", (route) => route.abort());
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue("保留这个草稿");
  await page.getByRole("button", { name: "返回待办" }).click();
  await page.getByRole("button", { name: "进化", exact: true }).click();
  await page.getByRole("button", { name: "体验复盘流程" }).click();
  await expect(
    page.getByRole("button", { name: "恢复轻快完成" }),
  ).toBeEnabled();
  await page.getByRole("button", { name: "待办", exact: true }).click();
  await page.getByRole("button", { name: "新增任务", exact: true }).click();
  await expect(page.getByLabel("想做些什么？")).toHaveValue("保留这个草稿");
  await page.unroute("**/api/commands");
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "完成 保留这个草稿", exact: true }),
  ).toBeVisible();
});
