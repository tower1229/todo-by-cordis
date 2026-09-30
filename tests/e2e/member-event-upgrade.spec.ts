import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { ExperienceSessionHost } from "../../src/server/experience-session.js";
import { createApp } from "../../src/server/app.js";
import { PlanningDriver, toolReply } from "../app/planning-fixture.js";
import { dualWorkflowDefinition } from "../app/dual-composition-fixture.js";
import { tagsTrimOnlyMemberCases } from "../app/member-case-fixtures.js";
import {
  tagsEventUpgradeSource,
  tagsReferenceSource,
} from "../../src/server/capability-guides.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";

const counterSource = `export default {
  contribute() { return { fields: [{ key: "count", label: "计数", type: "text" }], commands: [{ id: "increment", label: "加一", from: ["open"] }] }; },
  decide({ task, action }) {
    if (action !== "increment" || task.state !== "open") return { kind: "reject", message: "不可计数" };
    return { kind: "commit", state: task.state, fields: { ...task.fields, count: String(Number(task.fields.count ?? "0") + 1) } };
  }
};`;
const counterCases = [
  {
    name: "计数增加",
    member: "counter",
    state: "open",
    fields: { count: "7" },
    action: "increment",
    input: {},
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { count: "8" },
    },
  },
  {
    name: "完成后拒绝计数",
    member: "counter",
    state: "done",
    fields: {},
    action: "increment",
    input: {},
    expected: { kind: "reject" as const },
  },
];
const upgradedCases = [
  {
    ...tagsTrimOnlyMemberCases[0],
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { tags: "hello" },
    },
  },
  ...tagsTrimOnlyMemberCases.slice(1),
  {
    name: "创建事件仅一次",
    member: "tags",
    state: "open",
    fields: {},
    action: "confirmCreated",
    input: {},
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { createdSeen: "1" },
    },
  },
  {
    name: "完成任务不可确认创建事件",
    member: "tags",
    state: "done",
    fields: {},
    action: "confirmCreated",
    input: {},
    expected: { kind: "reject" as const },
  },
];

async function installBaseline(workspace: Workspace) {
  const workflowSource = await readFile(
    new URL("../fixtures/aux-workflow.mjs", import.meta.url),
    "utf8",
  );
  const tags = workspace.release.record({
    pluginId: "tags",
    name: "标签",
    service: "plugin:tags",
    contractVersion: "extensions/1",
    source: tagsReferenceSource,
    code: tagsReferenceSource,
    definition: { id: "tags" },
    evidence: { passed: true, origin: "test" },
  });
  const counter = workspace.release.record({
    pluginId: "counter",
    name: "计数",
    service: "plugin:counter",
    contractVersion: "extensions/1",
    source: counterSource,
    code: counterSource,
    definition: { id: "counter" },
    evidence: { passed: true, origin: "test" },
  });
  const composition = workspace.release.record({
    pluginId: "aux-workflow",
    name: "标签与计数",
    service: "workflow",
    contractVersion: "workflow/1",
    source: workflowSource,
    code: workflowSource,
    definition: dualWorkflowDefinition,
    evidence: {
      passed: true,
      origin: "test",
      memberCases: [...tagsTrimOnlyMemberCases, ...counterCases],
    },
    members: [
      { pluginId: "aux-workflow", enabled: true, role: "workflow" },
      {
        pluginId: "tags",
        versionId: tags.id,
        enabled: true,
        role: "auxiliary",
      },
      {
        pluginId: "counter",
        versionId: counter.id,
        enabled: true,
        role: "auxiliary",
      },
    ],
  });
  await workspace.activate(
    {
      versionId: composition.id,
      compositionRevision: workspace.composition().revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  return { tags, counter, composition };
}

function upgradePlan() {
  return new PlanningDriver({
    summary: "升级标签并确认创建事件",
    changes: ["标签统一小写", "只记录任务创建事件"],
    outcome: "标签小写，创建事件可在任务详情确认",
    dataImpact: "保留计数版本与已有任务字段",
    workflowRules: [],
    memberUpgrades: [{ pluginId: "tags" }],
    memberCases: upgradedCases,
    acceptanceReason: "用户要求标签统一小写",
    capabilityChanges: [
      {
        capability: "command.register",
        provider: "member:tags",
        consumers: ["src/web/ActionForm.tsx"],
        change: "升级标签命令",
      },
      {
        capability: "task.events",
        provider: "member:tags",
        consumers: ["src/web/ActionForm.tsx"],
        change: "订阅创建事件并提供确认动作",
      },
    ],
  });
}

function upgradeDriver(
  planning: PlanningDriver,
  tagsVersionId: string,
  workflowSource: string,
  memberSource = tagsEventUpgradeSource,
) {
  let guideRead = false;
  const reads: string[] = [];
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      const history = JSON.stringify(request.history);
      if (
        request.tools?.some(
          (tool) =>
            tool.name === "submit_candidate" || tool.name === "build_candidate",
        )
      ) {
        const reply = (name: string, args: Record<string, unknown>) => ({
          ...toolReply(name, args),
          history: request.history,
        });
        if (!history.includes("read_contract"))
          return reply("read_contract", {});
        if (!history.includes("read_current_source"))
          return reply("read_current_source", {});
        if (!history.includes("read_member"))
          return reply("read_member", {
            pluginId: "tags",
            versionId: tagsVersionId,
          });
        if (!history.includes("read_guide"))
          return reply("read_guide", { ref: "guide/task.events" });
        reads.push(history);
        return reply("submit_candidate", {
          source: workflowSource,
          members: [{ pluginId: "tags", source: memberSource }],
        });
      }
      const response = await planning.generate(request, signal);
      if (response.calls[0]?.name === "propose_plan" && !guideRead) {
        guideRead = true;
        return {
          ...response,
          calls: [
            {
              name: "read_guides",
              args: { refs: ["guide/command.register", "guide/task.events"] },
            },
          ],
        };
      }
      return response;
    },
  };
  return { driver, reads };
}

test("模型桩浏览器完成标签升级、事件候选体验、应用、启停和撤回", async ({
  page,
}) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(10_000);
  const directory = await mkdtemp(
    join(tmpdir(), "cordis-event-upgrade-browser-"),
  );
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  const sessions = new ExperienceSessionHost(workspace);
  const baseline = await installBaseline(workspace);
  const before = workspace.composition();
  const created = await workspace.command({
    type: "create",
    title: "原有任务",
    compositionRevision: before.revision,
    operationId: randomUUID(),
  });
  const originalTaskId = created.task!.id;
  await workspace.command({
    type: "action",
    taskId: originalTaskId,
    actionId: "setTags",
    input: { tags: "  Old " },
    expectedRevision: created.task!.revision,
    compositionRevision: before.revision,
    operationId: randomUUID(),
  });
  const tagged = workspace.read(originalTaskId);
  await workspace.command({
    type: "action",
    taskId: originalTaskId,
    actionId: "increment",
    input: {},
    expectedRevision: tagged.revision,
    compositionRevision: before.revision,
    operationId: randomUUID(),
  });
  const planning = upgradePlan();
  const { driver, reads } = upgradeDriver(
    planning,
    baseline.tags.id,
    baseline.composition.source,
  );
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
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    const baseURL = `http://127.0.0.1:${address.port}`;
    await page.goto(baseURL);
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    await page
      .getByRole("textbox", { name: "告诉 AI 你的需求" })
      .fill("把已有标签规范化为小写，并在创建任务时记录一次受限事件");
    await page.getByRole("button", { name: "发送需求" }).click();
    await expect
      .poll(async () => {
        const run = (await evolution.observe()).run;
        return run?.status === "blocked" || run?.status === "failed"
          ? `${run.status}: ${run.message}`
          : run?.status;
      })
      .toBe("awaiting-acceptance");
    await expect(page.getByText("业务验收修订比较")).toBeVisible();
    await page.getByRole("button", { name: "确认业务验收修订" }).click();
    await expect
      .poll(async () => (await evolution.observe()).run?.status)
      .toBe("ready");
    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    await expect
      .poll(async () => (await evolution.observe()).run?.status, {
        timeout: 30_000,
      })
      .toBe("awaiting-apply");
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain(baseline.tags.id);
    expect(reads[0]).toContain("guide/task.events");
    expect(workspace.composition().versionId).toBe(before.versionId);
    const candidate = (await evolution.observe()).candidates?.find(
      (item) => item.passed,
    );
    expect(candidate).toBeDefined();
    await page.getByRole("button", { name: "体验", exact: true }).click();
    await expect(
      page.getByRole("status", { name: "候选体验提示" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "加一", exact: true }).click();
    await page
      .getByRole("article", { name: "标签与事件" })
      .getByRole("button", { name: "编辑标签 候选体验任务", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "标签", exact: true })
      .fill("  MiXeD  ");
    await page.getByRole("button", { name: "编辑标签", exact: true }).click();
    await page
      .getByRole("button", { name: "确认创建事件 候选体验任务", exact: true })
      .click();
    const experience = await sessions.observe({});
    expect(experience.status).toBe("active");
    if (experience.status !== "active") throw new Error("No active experience");
    expect(sessions.readSnapshot(experience.id).task.fields).toMatchObject({
      tags: "mixed",
      count: "1",
      createdSeen: "1",
    });
    expect(workspace.read(originalTaskId).fields.createdSeen).toBeUndefined();
    await page.getByRole("button", { name: "结束体验", exact: true }).click();
    await expect(
      page.getByRole("status", { name: "候选体验提示" }),
    ).not.toBeVisible();
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    await page.getByRole("button", { name: "应用", exact: true }).click();
    await expect
      .poll(async () => (await evolution.observe()).run?.status)
      .toBe("succeeded");
    const applied = workspace.composition();
    expect(
      applied.members.find((member) => member.pluginId === "counter")
        ?.versionId,
    ).toBe(baseline.counter.id);
    expect(
      applied.members.find((member) => member.pluginId === "tags")?.versionId,
    ).not.toBe(baseline.tags.id);
    expect(workspace.read(originalTaskId).fields).toMatchObject({
      tags: "Old",
      count: "1",
    });
    await page
      .getByRole("button", { name: "关闭改进应用", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "添加任务", exact: true })
      .fill("升级后任务");
    const createdResponse = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/commands") &&
        response.request().postDataJSON().type === "create",
    );
    await page.getByRole("button", { name: "添加", exact: true }).click();
    const createReceipt = await createdResponse;
    expect(createReceipt.status()).toBe(409);
    await page.reload();
    await page
      .getByRole("textbox", { name: "添加任务", exact: true })
      .fill("升级后任务");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect
      .poll(() =>
        workspace.query().tasks.some((task) => task.title === "升级后任务"),
      )
      .toBe(true);
    const newTask = workspace
      .query()
      .tasks.find((task) => task.title === "升级后任务");
    expect(newTask).toBeDefined();
    await page
      .getByRole("button", { name: "编辑 升级后任务", exact: true })
      .click();
    await page
      .getByRole("article", { name: "标签与事件" })
      .getByRole("button", { name: "确认创建事件 升级后任务", exact: true })
      .click();
    await expect
      .poll(() => workspace.read(newTask!.id).fields.createdSeen)
      .toBe("1");
    await page
      .getByRole("button", { name: "关闭任务详情", exact: true })
      .click();
    await page
      .getByRole("button", { name: "加一 升级后任务", exact: true })
      .click();
    await expect.poll(() => workspace.read(newTask!.id).fields.count).toBe("1");
    await page
      .getByRole("button", { name: "编辑 原有任务", exact: true })
      .click();
    await page
      .getByRole("article", { name: "标签与事件" })
      .getByRole("button", { name: "编辑标签 原有任务", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "标签", exact: true })
      .fill("  HeLLo  ");
    await page.getByRole("button", { name: "编辑标签", exact: true }).click();
    await expect
      .poll(() => workspace.read(originalTaskId).fields.tags)
      .toBe("hello");
    expect(workspace.read(originalTaskId).fields.count).toBe("1");
    await page
      .getByRole("button", { name: "关闭任务详情", exact: true })
      .click();
    await page.getByRole("button", { name: "更多选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "工作区设置" }).click();
    const tagsRow = page.locator("li").filter({ hasText: "tags" });
    await tagsRow.getByRole("button", { name: "停用 tags" }).click();
    await expect(tagsRow.getByText("已停用", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "关闭工作区设置", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "添加任务", exact: true })
      .fill("停用期间任务");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect
      .poll(() =>
        workspace.query().tasks.some((task) => task.title === "停用期间任务"),
      )
      .toBe(true);
    const disabledTask = workspace
      .query()
      .tasks.find((task) => task.title === "停用期间任务");
    await page.getByRole("button", { name: "更多选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "工作区设置" }).click();
    await tagsRow.getByRole("button", { name: "启用 tags" }).click();
    await page
      .getByRole("button", { name: "关闭工作区设置", exact: true })
      .click();
    await page
      .getByRole("button", { name: "编辑 停用期间任务", exact: true })
      .click();
    await page
      .getByRole("article", { name: "标签与事件" })
      .getByRole("button", { name: "确认创建事件 停用期间任务", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("未收到唯一创建事件");
    expect(workspace.read(disabledTask!.id).fields.createdSeen).toBeUndefined();
    await page
      .getByRole("button", { name: "关闭任务详情", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "添加任务", exact: true })
      .fill("再启用任务");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect
      .poll(() =>
        workspace.query().tasks.some((task) => task.title === "再启用任务"),
      )
      .toBe(true);
    const reenabledTask = workspace
      .query()
      .tasks.find((task) => task.title === "再启用任务");
    await page
      .getByRole("button", { name: "编辑 再启用任务", exact: true })
      .click();
    await page
      .getByRole("article", { name: "标签与事件" })
      .getByRole("button", { name: "确认创建事件 再启用任务", exact: true })
      .click();
    await expect
      .poll(() => workspace.read(reenabledTask!.id).fields.createdSeen)
      .toBe("1");
    await page
      .getByRole("button", { name: "关闭任务详情", exact: true })
      .click();
    await page.getByRole("button", { name: "更多选项", exact: true }).click();
    await page.getByRole("menuitem", { name: "工作区设置" }).click();
    const baselineHistory = workspace
      .composition()
      .history.find((item) => item.versionId === before.versionId);
    expect(baselineHistory).toBeDefined();
    await page.getByText("版本记录", { exact: true }).click();
    await page
      .locator("li")
      .filter({ hasText: `版本 ${baselineHistory!.id}` })
      .getByRole("button", { name: "恢复此版本" })
      .click();
    await expect
      .poll(
        () =>
          workspace
            .composition()
            .members.find((member) => member.pluginId === "tags")?.versionId,
      )
      .toBe(baseline.tags.id);
    expect(workspace.read(disabledTask!.id).title).toBe("停用期间任务");
    expect(workspace.read(reenabledTask!.id).fields.createdSeen).toBe("1");
    expect(workspace.read(newTask!.id).fields).toMatchObject({
      createdSeen: "1",
      count: "1",
    });
    expect(workspace.read(originalTaskId).fields).toMatchObject({
      tags: "hello",
      count: "1",
    });
    await page
      .getByRole("button", { name: "关闭工作区设置", exact: true })
      .click();
    await page
      .getByRole("button", { name: "编辑 停用期间任务", exact: true })
      .click();
    await expect(page.getByRole("article", { name: "标签与事件" })).toHaveCount(
      0,
    );
    await page
      .getByRole("button", { name: "关闭任务详情", exact: true })
      .click();
    await page.reload();
    await page
      .getByRole("textbox", { name: "添加任务", exact: true })
      .fill("撤回后任务");
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await expect
      .poll(() =>
        workspace.query().tasks.some((task) => task.title === "撤回后任务"),
      )
      .toBe(true);
    const restoredTask = workspace
      .query()
      .tasks.find((task) => task.title === "撤回后任务");
    await page
      .getByRole("button", { name: "编辑 撤回后任务", exact: true })
      .click();
    await expect(page.getByRole("article", { name: "标签与事件" })).toHaveCount(
      0,
    );
    await page
      .getByRole("button", { name: "关闭任务详情", exact: true })
      .click();
    await page
      .getByRole("button", { name: "加一 撤回后任务", exact: true })
      .click();
    await expect
      .poll(() => workspace.read(restoredTask!.id).fields.count)
      .toBe("1");
    expect(workspace.read(disabledTask!.id).title).toBe("停用期间任务");
  } finally {
    await page.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    await evolution.close();
    await sessions.close();
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const fault of [
  {
    name: "重复创建事件效果",
    source: tagsEventUpgradeSource.replace(
      "(createdEvents.get(task.id) ?? 0) + 1",
      "(createdEvents.get(task.id) ?? 0) + 2",
    ),
    rejectedCase: "创建事件仅一次",
  },
  {
    name: "错误继承标签规范化",
    source: tagsEventUpgradeSource.replace(
      "String(input.tags).trim().toLowerCase()",
      "String(input.tags).trim()",
    ),
    rejectedCase: "标签去空格",
  },
])
  test(`模型桩${fault.name}无法通过同源候选验收`, async () => {
    test.setTimeout(60_000);
    const directory = await mkdtemp(join(tmpdir(), "cordis-duplicate-event-"));
    const workspace = await Workspace.open(join(directory, "workspace.db"));
    const baseline = await installBaseline(workspace);
    const before = workspace.composition();
    expect(fault.source).not.toBe(tagsEventUpgradeSource);
    const { driver } = upgradeDriver(
      upgradePlan(),
      baseline.tags.id,
      baseline.composition.source,
      fault.source,
    );
    const evolution = new Evolution(
      workspace.db,
      driver,
      new EvolutionDomain(workspace),
    );
    try {
      await evolution.command({
        type: "request",
        text: "升级标签并确认创建事件",
        operationId: randomUUID(),
      });
      await expect
        .poll(async () => (await evolution.observe()).run?.status)
        .toBe("awaiting-acceptance");
      const pending = (await evolution.observe()).run;
      if (pending?.status !== "awaiting-acceptance")
        throw new Error("Expected acceptance revision");
      await evolution.command({
        type: "confirm-acceptance",
        runId: pending.id,
        planId: pending.plan.id,
        revisionId: pending.acceptanceRevision.id,
        operationId: randomUUID(),
      });
      await expect
        .poll(async () => (await evolution.observe()).run?.status)
        .toBe("ready");
      const ready = (await evolution.observe()).run;
      if (ready?.status !== "ready") throw new Error("Expected ready plan");
      await evolution.command({
        type: "start",
        runId: ready.id,
        planId: ready.plan.id,
        operationId: randomUUID(),
      });
      await expect
        .poll(async () => (await evolution.observe()).run?.status, {
          timeout: 30_000,
        })
        .toBe("failed");
      const observed = await evolution.observe();
      expect(observed.candidates?.some((candidate) => candidate.passed)).toBe(
        false,
      );
      expect(JSON.stringify(observed)).toContain(fault.rejectedCase);
      expect(workspace.composition().versionId).toBe(before.versionId);
      expect(
        workspace
          .composition()
          .members.find((member) => member.pluginId === "counter")?.versionId,
      ).toBe(baseline.counter.id);
    } finally {
      await evolution.close();
      await workspace.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
