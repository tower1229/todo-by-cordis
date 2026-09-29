import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { ExperienceSessionHost } from "../../src/server/experience-session.js";
import { createApp } from "../../src/server/app.js";
import { createControllableClock } from "../../src/server/host/clock.js";
import { PlanningDriver, toolReply } from "../app/planning-fixture.js";
import { dueAutoExpireSource } from "../../src/server/capability-guides.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";

const dueAt = new Date(Date.now() + 10 * 60_000).toISOString();
const memberCases = [
  {
    name: "设置有效截止",
    member: "due",
    state: "open",
    fields: {},
    action: "setDue",
    input: { dueAt },
    expected: { kind: "commit" as const, state: "open", fields: { dueAt } },
  },
  {
    name: "无效截止被拒绝",
    member: "due",
    state: "open",
    fields: {},
    action: "setDue",
    input: { dueAt: "not-a-date" },
    expected: { kind: "reject" as const },
  },
  {
    name: "到期标记",
    member: "due",
    state: "open",
    fields: { dueAt },
    action: "expire",
    input: { scheduledAt: dueAt },
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { dueAt, expired: "true" },
    },
  },
  {
    name: "完成后不标记",
    member: "due",
    state: "done",
    fields: { dueAt },
    action: "expire",
    input: { scheduledAt: dueAt },
    expected: { kind: "reject" as const },
  },
];

test("模型桩浏览器生成、体验并独立应用到期自动过期", async ({ page }) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "cordis-due-browser-"));
  const formalClock = createControllableClock(Date.now());
  const experienceClock = createControllableClock(formalClock.now());
  const browserDueAt = new Date(experienceClock.now() + 60_000).toISOString();
  const workspace = await Workspace.open(join(directory, "workspace.db"), {
    clock: formalClock,
  });
  const sessions = new ExperienceSessionHost(
    workspace,
    30 * 60 * 1000,
    () => experienceClock,
  );
  const baseline = workspace.composition();
  const formalTask = await workspace.command({
    type: "create",
    title: "正式数据",
    operationId: randomUUID(),
    compositionRevision: baseline.revision,
  });
  const source = workspace.release.get(baseline.versionId).source;
  const planning = new PlanningDriver({
    summary: "为任务设置截止时间并自动过期",
    changes: ["可选截止时间", "到点未完成自动标记过期"],
    outcome: "任务到期后可见过期标记",
    dataImpact: "新增截止与过期字段；正式数据在应用前不变",
    workflowRules: [],
    memberAdditions: [{ pluginId: "due", name: "截止时间" }],
    memberCases,
    capabilityChanges: [
      {
        capability: "command.register",
        provider: "member:due",
        consumers: ["src/web/ActionForm.tsx"],
        change: "设置截止与到期动作",
      },
      {
        capability: "schedule.register",
        provider: "member:due",
        consumers: ["src/web/WorkspacePanel.tsx"],
        change: "到点执行过期动作",
      },
    ],
    requiredCapabilities: [
      { interfaceId: "schedule.runtime", providerId: "host:online-scheduler" },
    ],
  });
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      const history = JSON.stringify(request.history);
      const reply = (name: string, args: Record<string, unknown>) => ({
        ...toolReply(name, args),
        history: request.history,
      });
      if (
        request.tools?.some(
          (tool) =>
            tool.name === "submit_candidate" || tool.name === "build_candidate",
        )
      ) {
        if (!history.includes("read_contract"))
          return reply("read_contract", {});
        if (!history.includes("read_current_source"))
          return reply("read_current_source", {});
        if (!history.includes("read_guide"))
          return reply("read_guide", { ref: "guide/schedule.register" });
        return reply("submit_candidate", {
          source,
          members: [{ pluginId: "due", source: dueAutoExpireSource }],
        });
      }
      const result = await planning.generate(request, signal);
      if (
        result.calls[0]?.name === "propose_plan" &&
        !history.includes("read_guides")
      )
        return {
          ...result,
          calls: [
            {
              name: "read_guides",
              args: { refs: ["guide/schedule.register"] },
            },
          ],
        };
      return result;
    },
  };
  const evolution = new Evolution(
    workspace.db,
    driver,
    new EvolutionDomain(workspace),
    sessions,
  );
  const app = createApp(workspace, evolution, sessions);
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.get("*", serveStatic({ path: "./dist/web/index.html" }));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening)
      await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No listener");
    const baseURL = `http://127.0.0.1:${address.port}`;
    await page.goto(baseURL);
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    await page
      .getByRole("textbox", { name: "告诉 AI 你的需求" })
      .fill("任务可选截止时间，到期未完成自动过期");
    await page.getByRole("button", { name: "发送需求" }).click();
    await expect
      .poll(async () => (await evolution.observe()).run?.status)
      .toBe("ready");
    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    await expect
      .poll(async () => (await evolution.observe()).run?.status, {
        timeout: 30_000,
      })
      .toBe("awaiting-apply");
    expect(workspace.composition().versionId).toBe(baseline.versionId);
    expect(workspace.read(formalTask.task!.id).fields).toEqual({});
    await page.getByRole("button", { name: "体验", exact: true }).click();
    await expect(
      page.getByRole("status", { name: "候选体验提示" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "设截止 候选体验任务", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "截止时间", exact: true })
      .fill(browserDueAt);
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    const session = sessions.observe();
    if (session.status !== "active") throw new Error("Missing experience");
    expect(sessions.readSnapshot(session.id).task.fields.dueAt).toBe(
      browserDueAt,
    );
    await page
      .getByRole("button", { name: "设截止 候选体验任务", exact: true })
      .click();
    const movedExperienceAt = new Date(
      experienceClock.now() + 120_000,
    ).toISOString();
    await page
      .getByRole("textbox", { name: "截止时间", exact: true })
      .fill(movedExperienceAt);
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    await experienceClock.advance(60_000);
    expect(
      sessions.readSnapshot(session.id).task.fields.expired,
    ).toBeUndefined();
    await page
      .getByRole("button", { name: "设截止 候选体验任务", exact: true })
      .click();
    await page.getByRole("textbox", { name: "截止时间", exact: true }).fill("");
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    expect(sessions.readSnapshot(session.id).task.fields.dueAt).toBeUndefined();
    await experienceClock.advance(60_000);
    expect(
      sessions.readSnapshot(session.id).task.fields.expired,
    ).toBeUndefined();
    await page
      .getByRole("button", { name: "设截止 候选体验任务", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "截止时间", exact: true })
      .fill(new Date(experienceClock.now() + 60_000).toISOString());
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    await experienceClock.advance(59_999);
    expect(
      sessions.readSnapshot(session.id).task.fields.expired,
    ).toBeUndefined();
    await experienceClock.advance(1);
    await expect
      .poll(() => sessions.readSnapshot(session.id).task.fields.expired)
      .toBe("true");
    await experienceClock.advance(1);
    const onceRevision = sessions.readSnapshot(session.id).task.revision;
    expect(sessions.readSnapshot(session.id).task.revision).toBe(onceRevision);
    await page
      .getByRole("button", { name: "设截止 候选体验任务", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "截止时间", exact: true })
      .fill(new Date(experienceClock.now() + 60_000).toISOString());
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    await page.getByRole("button", { name: "删除任务", exact: true }).click();
    await expect(page.getByText("体验任务已删除")).toBeVisible();
    const deletedExperience = sessions.readSnapshot(session.id).task;
    await experienceClock.advance(60_000);
    expect(sessions.readSnapshot(session.id).task.revision).toBe(
      deletedExperience.revision,
    );
    expect(sessions.readSnapshot(session.id).task.deletedAt).toBeTruthy();
    expect(workspace.read(formalTask.task!.id).fields).toEqual({});
    await page.getByRole("button", { name: "结束体验", exact: true }).click();
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await expect
      .poll(async () => (await evolution.observe()).run?.status)
      .toBe("succeeded");
    await page.reload();
    expect(workspace.read(formalTask.task!.id).fields).toEqual({});
    expect(
      workspace
        .composition()
        .members.some((member) => member.pluginId === "due"),
    ).toBe(true);
    await page
      .getByRole("textbox", { name: "添加任务", exact: true })
      .fill("正式到期任务");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page
      .getByRole("button", { name: "编辑 正式到期任务", exact: true })
      .click();
    const detail = page.getByRole("article", { name: "截止与过期" });
    await detail
      .getByRole("button", { name: "设截止 正式到期任务", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "截止时间", exact: true })
      .fill("无效时间");
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("有效的 ISO 8601");
    const formalDueAt = new Date(formalClock.now() + 60_000).toISOString();
    await page
      .getByRole("textbox", { name: "截止时间", exact: true })
      .fill(formalDueAt);
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    await detail
      .getByRole("button", { name: "设截止 正式到期任务", exact: true })
      .click();
    const movedFormalAt = new Date(formalClock.now() + 120_000).toISOString();
    await page
      .getByRole("textbox", { name: "截止时间", exact: true })
      .fill(movedFormalAt);
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    const appliedTask = workspace
      .query()
      .tasks.find((task) => task.title === "正式到期任务");
    expect(appliedTask?.fields.dueAt).toBe(movedFormalAt);
    await expect(page.getByRole("button", { name: /标为过期/ })).toHaveCount(0);
    const forged = await page.request.post(`${baseURL}/api/commands`, {
      data: {
        type: "action",
        taskId: appliedTask!.id,
        actionId: "expire",
        input: { scheduledAt: movedFormalAt },
        expectedRevision: appliedTask!.revision,
        compositionRevision: workspace.composition().revision,
        operationId: randomUUID(),
      },
    });
    expect(forged.ok()).toBe(false);
    expect(workspace.read(appliedTask!.id).fields.expired).toBeUndefined();
    await formalClock.advance(60_000);
    expect(workspace.read(appliedTask!.id).fields.expired).toBeUndefined();
    await formalClock.advance(60_000);
    await page.reload();
    expect(workspace.read(appliedTask!.id).fields.expired).toBe("true");
    const formalOnce = workspace.read(appliedTask!.id).revision;
    await formalClock.advance(1);
    expect(workspace.read(appliedTask!.id).revision).toBe(formalOnce);
    await page
      .getByRole("button", { name: "编辑 正式到期任务", exact: true })
      .click();
    await expect(
      page.getByRole("article", { name: "截止与过期" }),
    ).toContainText("true");
    await detail
      .getByRole("button", { name: "设截止 正式到期任务", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "截止时间", exact: true })
      .fill(new Date(formalClock.now() + 60_000).toISOString());
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    await detail
      .getByRole("button", { name: "设截止 正式到期任务", exact: true })
      .click();
    await page.getByRole("textbox", { name: "截止时间", exact: true }).fill("");
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    const clearedFormal = workspace.read(appliedTask!.id);
    expect(clearedFormal.fields.dueAt).toBeUndefined();
    await formalClock.advance(60_000);
    expect(workspace.read(appliedTask!.id).revision).toBe(
      clearedFormal.revision,
    );
    await detail
      .getByRole("button", { name: "设截止 正式到期任务", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "截止时间", exact: true })
      .fill(new Date(formalClock.now() + 60_000).toISOString());
    await page.getByRole("button", { name: "设截止", exact: true }).click();
    await page.getByRole("button", { name: "删除任务", exact: true }).click();
    const deletedFormal = workspace.read(appliedTask!.id);
    expect(deletedFormal.deletedAt).toBeTruthy();
    await formalClock.advance(60_000);
    expect(workspace.read(appliedTask!.id).revision).toBe(
      deletedFormal.revision,
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await evolution.close();
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  }
});
