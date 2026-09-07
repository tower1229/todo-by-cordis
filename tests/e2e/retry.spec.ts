import { test, expect } from "@playwright/test";

test("lost save response reuses operation; failed refresh does not invite duplicate creation", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "添加任务", exact: true });
  await input.fill("响应丢失也只有一条");
  await page.route("**/api/commands", async (route) => {
    await route.fetch();
    await route.abort();
  });
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.unroute("**/api/commands");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(input).toHaveValue("");
  const first = await (
    await request.get("/api/tasks?search=响应丢失也只有一条")
  ).json();
  expect(first.total).toBe(1);
  await input.fill("保存成功但刷新失败");
  await page.route("**/api/tasks?**", (route) => route.abort());
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(input).toHaveValue("");
  await expect(page.getByRole("alert")).toContainText("已保存");
  const second = await (
    await request.get("/api/tasks?search=保存成功但刷新失败")
  ).json();
  expect(second.total).toBe(1);
});
