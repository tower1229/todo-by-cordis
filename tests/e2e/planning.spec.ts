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
  await expect(
    page.getByRole("button", { name: "开始执行", exact: true }),
  ).toBeVisible();
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

  const startBody = {
    type: "start",
    operationId: "browser-start-1",
    runId: ready.run.id,
    planId: ready.run.plan.id,
  };
  const started = await (
    await request.post("/api/assistant/commands", { data: startBody })
  ).json();
  expect(started.run.status).toBe("executing");
  const replay = await (
    await request.post("/api/assistant/commands", { data: startBody })
  ).json();
  expect(replay).toEqual(started);
  const revise = await request.post("/api/assistant/commands", {
    data: {
      type: "revise",
      operationId: "browser-revise-locked",
      runId: ready.run.id,
      text: "改成选填复盘",
    },
  });
  expect(revise.status()).toBe(409);
  const locked = await revise.json();
  expect(locked.code).toBe("REQUEST_LOCKED");

  await page.reload();
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(
    page.getByRole("region", { name: /执行进度|候选结果/ }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByRole("textbox", { name: "告诉 AI 你的需求" }),
  ).toHaveCount(0);
  const progressing = await (await request.get("/api/assistant")).json();
  expect(progressing.run.id).toBe(first.run.id);
  expect(["executing", "awaiting-apply"]).toContain(progressing.run.status);
  expect(progressing.run.plan.id).toBe(ready.run.plan.id);
  expect(await (await request.get("/api/composition")).json()).toEqual(before);
  if (progressing.run.status === "executing") {
    await expect(
      page.getByRole("button", { name: "停止", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "停止", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已取消");
  } else {
    await page.getByRole("button", { name: "放弃候选", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("已取消");
  }
});
