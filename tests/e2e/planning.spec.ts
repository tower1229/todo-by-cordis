import { test, expect } from "@playwright/test";
test.use({ baseURL: "http://127.0.0.1:4519" });
// Only the remote model is a fixture. Browser, HTTP, Evolution, SQLite and UI are real.
test("real backend restores clarification and investigated plan without changing tasks", async ({
  page,
  request,
}, info) => {
  await page.setViewportSize({ width: 390, height: 850 });
  const before = await (await request.get("/api/composition")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await page
    .getByRole("textbox", { name: "告诉 AI 你的需求" })
    .fill("完成前填写复盘");
  await page.getByRole("button", { name: "发送需求" }).click();
  await expect(page.getByText("复盘是必填还是选填？")).toBeVisible();
  const first = await (await request.get("/api/assistant")).json();
  await page.reload();
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(page.getByText("复盘是必填还是选填？")).toBeVisible();
  await page.getByRole("textbox", { name: "告诉 AI 你的需求" }).fill("必填");
  await page.getByRole("button", { name: "发送需求" }).click();
  await expect(page.getByRole("region", { name: "待确认方案" })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始执行", exact: true })).toBeVisible();
  const ready = await (await request.get("/api/assistant")).json();
  expect(ready.run.status).toBe("ready");
  expect(ready.run.id).toBe(first.run.id);
  await page.reload();
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(page.getByRole("region", { name: "待确认方案" })).toBeVisible();
  await page.screenshot({
    path: info.outputPath("plan-mobile.png"),
    fullPage: true,
  });
  expect(await (await request.get("/api/composition")).json()).toEqual(before);
  const exact = await (
    await request.get(`/api/assistant?runId=${first.run.id}`)
  ).json();
  expect(exact.run).toEqual(ready.run);
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.getByRole("region", { name: "执行进度" })).toBeVisible({
    timeout: 15000,
  });
  await expect(page.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "告诉 AI 你的需求" })).toHaveCount(
    0,
  );
  await page.reload();
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(
    page.getByRole("region", { name: /执行进度|候选结果/ }),
  ).toBeVisible({ timeout: 15000 });
  const progressing = await (await request.get("/api/assistant")).json();
  expect(progressing.run.id).toBe(first.run.id);
  expect(["executing", "awaiting-apply"]).toContain(progressing.run.status);
  expect(await (await request.get("/api/composition")).json()).toEqual(before);
  if (progressing.run.status === "executing") {
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已取消");
  } else {
    await page.getByRole("button", { name: "放弃候选", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已取消");
  }
});
