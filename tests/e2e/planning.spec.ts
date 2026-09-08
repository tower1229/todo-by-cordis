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

test("failed candidate diagnostics survive correction and refresh in the real progress UI", async ({
  page,
  request,
}) => {
  const send = async (data: Record<string, unknown>) =>
    (
      await request.post("/api/assistant/commands", {
        data: { ...data, operationId: crypto.randomUUID() },
      })
    ).json();
  const before = await (await request.get("/api/composition")).json();
  await send({ type: "request", text: "完成前填写复盘" });
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/assistant")).json()).run.status,
    )
    .toBe("awaiting-input");
  const current = await (await request.get("/api/assistant")).json();
  await send({ type: "answer", runId: current.run.id, text: "必填" });
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/assistant")).json()).run.status,
    )
    .toBe("ready");
  const ready = await (await request.get("/api/assistant")).json();
  await send({ type: "start", runId: ready.run.id, planId: ready.run.plan.id });
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/assistant")).json()).run.status,
      { timeout: 15000 },
    )
    .toBe("awaiting-apply");
  await page.goto("/");
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  const attempts = page.getByRole("region", { name: "候选尝试" });
  await expect(
    attempts.getByText("第 1 次候选 · 未通过", { exact: true }),
  ).toBeVisible();
  await expect(
    attempts.getByText("第 2 次候选 · 独立验收通过", { exact: true }),
  ).toBeVisible();
  await expect(attempts).toContainText("number");
  await page.reload();
  await page.getByRole("button", { name: "改进应用", exact: true }).click();
  await expect(page.getByRole("region", { name: "候选尝试" })).toContainText(
    "第 1 次候选",
  );
  const finished = await (await request.get("/api/assistant")).json();
  expect(finished.run.id).toBe(ready.run.id);
  expect(finished.run.budget.candidatesRemaining).toBe(1);
  expect(await (await request.get("/api/composition")).json()).toEqual(before);

  await expect(
    page.getByRole("button", { name: "体验", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "应用", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "调整后重新规划", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "放弃候选", exact: true }),
  ).toBeVisible();

  await page.getByRole("button", { name: "体验", exact: true }).click();
  await expect(page.getByRole("region", { name: "体验结果" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "体验结果" }).getByText("隔离体验结果（模拟）"),
  ).toBeVisible();
  expect(await (await request.get("/api/composition")).json()).toEqual(before);

  const afterExperience = await (await request.get("/api/assistant")).json();
  const candidate = afterExperience.candidates.find(
    (c: { passed: boolean }) => c.passed,
  );
  const badHash = await request.post("/api/assistant/commands", {
    data: {
      type: "apply",
      operationId: "browser-apply-bad-hash",
      runId: ready.run.id,
      candidateId: candidate.id,
      evidenceHash: "tampered-evidence",
      compositionRevision: before.revision,
    },
  });
  expect(badHash.status()).toBe(409);
  const badRevision = await request.post("/api/assistant/commands", {
    data: {
      type: "apply",
      operationId: "browser-apply-bad-revision",
      runId: ready.run.id,
      candidateId: candidate.id,
      evidenceHash: candidate.evidenceHash,
      compositionRevision: before.revision + 99,
    },
  });
  expect(badRevision.status()).toBe(409);
  expect(await (await request.get("/api/composition")).json()).toEqual(before);

  const applyBody = {
    type: "apply",
    operationId: "browser-apply-1",
    runId: ready.run.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash,
    compositionRevision: before.revision,
  };
  const applying = await (
    await request.post("/api/assistant/commands", { data: applyBody })
  ).json();
  expect(["applying", "succeeded"]).toContain(applying.run.status);
  if (applying.run.status === "applying") {
    const mid = await (
      await request.post("/api/assistant/commands", { data: applyBody })
    ).json();
    expect(mid).toEqual(applying);
  }
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/assistant")).json()).run.status,
      { timeout: 15000 },
    )
    .toBe("succeeded");
  const composition = await (await request.get("/api/composition")).json();
  expect(composition.versionId).toBe(afterExperience.run.versionId);
  expect(composition.revision).toBeGreaterThan(before.revision);
  const finalReplay = await (
    await request.post("/api/assistant/commands", { data: applyBody })
  ).json();
  expect(finalReplay.run.status).toBe("succeeded");

  await page.reload();
  await page.getByRole("button", {name:"改进应用", exact:true}).click();
  await page.getByRole("button", {name:"继续修改", exact:true}).click();
  await page.getByRole("textbox", {name:"告诉 AI 你的需求"}).fill("复盘至少三个字");
  await page.getByRole("button", {name:"发送需求"}).click();
  await expect(page.getByRole("button", {name:"确认业务验收修订", exact:true})).toBeVisible();
  await expect(page.getByRole("button", {name:"开始执行", exact:true})).toHaveCount(0);
  const comparison = page.getByLabel("规则比较");
  await expect(comparison).toContainText('旧规则：');
  await expect(comparison).toContainText('"minLength":1');
  await expect(comparison).toContainText('"minLength":3');
  await expect(comparison).toContainText("用户要求复盘至少三个字");
  const pending = await (await request.get("/api/assistant")).json();
  expect(pending.run.parentRunId).toBe(ready.run.id);
  expect(pending.run.baseVersion).toBe(composition.versionId);
  await page.reload();
  await page.getByRole("button", {name:"改进应用", exact:true}).click();
  await expect(page.getByLabel("规则比较")).toContainText("旧规则");
  await page.getByRole("button", {name:"确认业务验收修订", exact:true}).click();
  await expect(page.getByRole("button", {name:"开始执行", exact:true})).toBeVisible();
  expect((await (await request.get("/api/assistant")).json()).run.acceptanceRevisions).toHaveLength(1);
  expect((await (await request.get("/api/composition")).json()).versionId).toBe(composition.versionId);
  await page.getByRole("button", {name:"开始执行", exact:true}).click();
  await expect(page.getByRole("region", {name:"候选结果"})).toBeVisible({timeout:15000});
  await page.getByRole("button", {name:"应用", exact:true}).click();
  await expect(page.getByRole("button", {name:"继续修改", exact:true})).toBeVisible({timeout:15000});
  expect((await (await request.get("/api/composition")).json()).versionId).not.toBe(composition.versionId);
});
