import { test, expect } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  const composition = await (await request.get("/api/composition")).json();
  if (composition.workflow.id !== "default")
    await request.post("/api/runtime/restore", {
      data: {
        compositionRevision: composition.revision,
        operationId: crypto.randomUUID(),
      },
    });
});
for (const width of [320, 390, 768, 1280]) {
  test(`${width}px: add edit complete reopen delete undo and refresh`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/");
    const title = `准备本周的阅读清单 ${width}`;
    await page
      .getByRole("textbox", { name: "添加任务", exact: true })
      .fill(title);
    await page.getByRole("button", { name: "添加", exact: true }).click();
    const edit = page.getByRole("button", {
      name: `编辑 ${title}`,
      exact: true,
    });
    await edit.click();
    await page
      .getByLabel("备注", { exact: true })
      .fill("挑选两篇文章，整理要点。".repeat(30));
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(edit).toBeFocused();
    await page
      .getByRole("button", { name: `完成 ${title}`, exact: true })
      .click();
    await page.getByRole("button", { name: "已完成", exact: true }).click();
    await page
      .getByRole("button", { name: `重新打开 ${title}`, exact: true })
      .click();
    await page.getByRole("button", { name: "任务", exact: true }).click();
    await edit.click();
    await page.getByLabel("任务名称").fill(`${title}，继续`);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await page.reload();
    await page
      .getByRole("button", { name: `编辑 ${title}，继续`, exact: true })
      .click();
    await expect(page.getByLabel("备注", { exact: true })).toHaveValue(
      "挑选两篇文章，整理要点。".repeat(30),
    );
    await page.getByRole("button", { name: "删除任务", exact: true }).click();
    await page.getByRole("button", { name: "撤销删除" }).click();
    await expect(
      page.getByRole("button", { name: `编辑 ${title}，继续`, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("版本记录", { exact: true })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "进化", exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText("体验复盘流程")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
    await page.screenshot({
      path: info.outputPath(`tasks-${width}.png`),
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
}

test("IME, failed save, AI and editor dismissal preserve drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  const input = page.getByRole("textbox", { name: "添加任务", exact: true });
  await input.fill("保留这个草稿");
  await input.dispatchEvent("compositionstart");
  await input.press("Enter");
  await expect(input).toHaveValue("保留这个草稿");
  await input.dispatchEvent("compositionend");
  await page.route("**/api/commands", (route) => route.abort());
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(input).toHaveValue("保留这个草稿");
  await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  await page
    .getByRole("textbox", { name: "告诉 AI 你的需求" })
    .fill("完成前需要写一句复盘");
  await page.getByRole("button", { name: "关闭AI 助手" }).click();
  await page.reload();
  await expect(input).toHaveValue("保留这个草稿");
  await page.unroute("**/api/commands");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page
    .getByRole("button", { name: "编辑 保留这个草稿", exact: true })
    .click();
  await page.getByLabel("备注", { exact: true }).fill("尚未保存的备注");
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "编辑 保留这个草稿", exact: true })
    .click();
  await expect(page.getByLabel("备注", { exact: true })).toHaveValue(
    "尚未保存的备注",
  );
  await page.getByRole("button", { name: "打开 AI 助手", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "告诉 AI 你的需求" }),
  ).toHaveValue("完成前需要写一句复盘");
});

test("reselecting the current list keeps it usable; search is reversible", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill("检查筛选与搜索");
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("button", { name: "任务", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑 检查筛选与搜索", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "搜索任务", exact: true })
    .fill("不存在的唯一关键词");
  await expect(page.getByText("没有匹配的任务", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "清除搜索", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "编辑 检查筛选与搜索", exact: true }),
  ).toBeVisible();
});

test("plugin action forms use their contract and preserve cancelled input", async ({
  page,
  request,
}) => {
  const composition = await (await request.get("/api/composition")).json();
  const created = await (
    await request.post("/api/commands", {
      data: {
        type: "create",
        title: "动态表单任务",
        compositionRevision: composition.revision,
        operationId: crypto.randomUUID(),
      },
    })
  ).json();
  // Generic UI contract fixture; real legacy workflow/data recovery is tested in tests/app.
  await page.route("**/api/commands", async (route) => {
    const command = route.request().postDataJSON();
    if (command.type !== "action" || command.taskId !== created.task.id)
      return route.continue();
    if (!command.input?.note)
      return route.fulfill({
        json: {
          decision: {
            kind: "input-required",
            fields: [
              { key: "note", label: "完成说明", type: "text", required: true },
            ],
          },
        },
      });
    await route.fulfill({
      json: {
        task: { ...created.task, state: "done" },
        decision: {
          kind: "commit",
          state: "done",
          fields: { note: command.input.note },
        },
      },
    });
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "完成 动态表单任务", exact: true })
    .click();
  await page.getByLabel("完成说明", { exact: true }).fill("保留输入");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "完成 动态表单任务", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "完成 动态表单任务", exact: true })
    .click();
  await expect(page.getByLabel("完成说明", { exact: true })).toHaveValue(
    "保留输入",
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "完成", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
