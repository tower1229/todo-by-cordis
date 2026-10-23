import { test, expect } from "@playwright/test";
test.use({ baseURL: "http://127.0.0.1:4520" });
test("真实服务中的预算暂停、刷新、追加、验收、体验和显式应用", async ({
  page,
  request,
}, info) => {
  test.setTimeout(180000);
  await page.setViewportSize({ width: 320, height: 850 });
  const before = await (await request.get("/api/composition")).json();
  await page.goto("/");
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await page
    .getByRole("textbox", { name: "告诉 AI 你的需求" })
    .fill("完成前填写复盘");
  await page.getByRole("button", { name: "发送需求" }).click();
  await expect(page.getByRole("heading", { name: "需要你选择" })).toBeVisible();
  await page.getByRole("radio", { name: /必填/ }).check();
  await page.getByRole("button", { name: "提交回答" }).click();
  await page.getByRole("button", { name: "开始执行", exact: true }).click();
  await expect(page.getByRole("region", { name: "等待追加资源" })).toBeVisible({
    timeout: 60000,
  });
  const paused = await (await request.get("/api/assistant")).json();
  expect(paused.run.status).toBe("awaiting-budget");
  expect(paused.run.pause.resource).toBe("candidates");
  expect(paused.run.budget.callsUsed).toBeGreaterThan(0);
  expect(await (await request.get("/api/composition")).json()).toEqual(before);
  await expect(
    page.getByRole("textbox", { name: "告诉 AI 你的需求" }),
  ).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "继续进行", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("budget-mobile.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "继续进行", exact: true }).dblclick();
  await expect(
    page.getByRole("button", { name: "体验", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  const validated = await (await request.get("/api/assistant")).json();
  expect(validated.run.id).toBe(paused.run.id);
  expect(validated.run.plan.requirementGate.seal).toBe(
    paused.run.plan.requirementGate.seal,
  );
  expect(validated.run.budget.grants).toHaveLength(1);
  expect(validated.run.revisions.at(-1).text).toBe("必填");
  expect(validated.run.revisions.at(-1).answers[0].question).toContain("复盘");
  expect(validated.run.plan.answeredQuestions[0].answer).toBe("必填");
  expect(validated.run.budget.callsUsed).toBeGreaterThan(
    paused.run.budget.callsUsed,
  );
  await expect(page.getByRole("list", { name: "执行进度" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "体验", exact: true })).toBeInViewport();
  await expect(page.getByRole("button", { name: "确认应用", exact: true })).toBeInViewport();
  await page.getByRole("button", { name: "运行详情", exact: true }).click();
  await expect(page.getByRole("list", { name: "执行进度" })).toBeVisible();
  await page.getByRole("button", { name: "运行详情", exact: true }).click();
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.screenshot({
    path: info.outputPath("candidate-desktop.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "体验", exact: true }).click();
  await expect(
    page.getByRole("status", { name: "候选体验提示" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "结束体验", exact: true }).click();
  await expect(page.getByRole("status", { name: "候选体验提示" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  expect(await (await request.get("/api/composition")).json()).toEqual(before);
  await page.getByRole("button", { name: "确认应用", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/assistant")).json()).run.status,
      { timeout: 30000 },
    )
    .toBe("succeeded");
  expect(
    (await (await request.get("/api/composition")).json()).versionId,
  ).not.toBe(before.versionId);
});
