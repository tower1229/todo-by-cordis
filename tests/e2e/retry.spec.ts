import { test, expect } from "@playwright/test";

test("lost save response reuses operation; failed refresh never invites duplicate creation", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "新增任务", exact: true }).click();
  await page.getByLabel("想做些什么？").fill("响应丢失也只有一条");
  await page.route("**/api/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.unroute("**/api/commands");
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(page.getByLabel("想做些什么？")).toHaveCount(0);
  let data = await (
    await request.get("/api/tasks?search=响应丢失也只有一条")
  ).json();
  expect(data.total).toBe(1);
  await page.getByRole("button", { name: "新增任务", exact: true }).click();
  await page.getByLabel("想做些什么？").fill("保存成功但刷新失败");
  await page.route("**/api/tasks?**", (route) => route.abort());
  await page.getByRole("button", { name: "保存任务", exact: true }).click();
  await expect(page.getByLabel("想做些什么？")).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("已保存");
  data = await (
    await request.get("/api/tasks?search=保存成功但刷新失败")
  ).json();
  expect(data.total).toBe(1);
});
