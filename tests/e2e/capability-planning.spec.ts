import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { createApp } from "../../src/server/app.js";
import { PlanningDriver } from "../app/planning-fixture.js";
import { ExecutionDriver } from "../app/execution-fixture.js";
import { ExperienceSessionHost } from "../../src/server/experience-session.js";
import { activateDual } from "../app/dual-composition-fixture.js";
import { createControllableClock } from "../../src/server/host/clock.js";
import { dualWorkflowDefinition } from "../app/dual-composition-fixture.js";
import { auxWorkflowCode } from "../fixtures/member-ui.js";
import { hookedDefinition } from "../fixtures/hooked.js";
import { capabilityGuides } from "../../src/server/capability-guides.js";
import { hash } from "../../src/release/storage.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";

async function activateDisabledScheduleMember(workspace: Workspace) {
  const workflowCode = await auxWorkflowCode();
  const scheduleCode = readFileSync(
    new URL("../fixtures/hooked-plugin.mjs", import.meta.url),
    "utf8",
  );
  const schedule = workspace.release.record({
    pluginId: "hooked",
    name: "定时成员",
    service: "plugin:hooked",
    contractVersion: "extensions/1",
    source: scheduleCode,
    code: scheduleCode,
    definition: { id: "hooked" },
    evidence: { passed: true, origin: "test" },
  });
  const workflow = workspace.release.record({
    pluginId: "aux-workflow",
    name: "带定时成员的组合",
    service: "workflow",
    contractVersion: "workflow/1",
    source: workflowCode,
    code: workflowCode,
    definition: dualWorkflowDefinition,
    evidence: { passed: true, origin: "test" },
    members: [
      { pluginId: "aux-workflow", enabled: true, role: "workflow" },
      {
        pluginId: "hooked",
        versionId: schedule.id,
        enabled: true,
        role: "auxiliary",
      },
    ],
  });
  await workspace.activate(
    {
      versionId: workflow.id,
      compositionRevision: workspace.composition().revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const current = workspace.composition();
  await workspace.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: current.revision,
    versionId: current.versionId,
    pluginId: "hooked",
    enabled: false,
  });
}

async function activateStubInterface(workspace: Workspace) {
  const source = readFileSync(
    new URL("../fixtures/hooked-plugin.mjs", import.meta.url),
    "utf8",
  );
  const version = workspace.release.record({
    pluginId: "hooked",
    name: "宿主接口状态夹具",
    service: "workflow",
    contractVersion: "workflow/1",
    source,
    code: source,
    definition: hookedDefinition,
    evidence: { passed: true, origin: "test" },
  });
  await workspace.activate(
    {
      versionId: version.id,
      compositionRevision: workspace.composition().revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
}

const cases = [
  {
    name: "online scheduler is discoverable without registered jobs",
    finish: {},
    status: "ready",
    reason: "",
  },
  {
    name: "missing host capability",
    finish: {
      requiredCapabilities: [
        {
          interfaceId: "notification.runtime",
          providerId: "host:notification",
        },
      ],
    },
    status: "blocked",
    reason: "未安装",
  },
  {
    name: "incompatible host contract",
    finish: {
      requiredCapabilities: [
        {
          interfaceId: "schedule.runtime",
          providerId: "host:online-scheduler",
          contractVersion: "schedule.runtime/999",
        },
      ],
    },
    status: "blocked",
    reason: "不兼容",
  },
  {
    name: "disabled member contribution",
    setup: "disabled",
    finish: {
      requiredCapabilities: [
        { interfaceId: "command.register", providerId: "tags" },
      ],
    },
    status: "blocked",
    reason: "已停用",
  },
  {
    name: "member without schedules can re-enable",
    setup: "disabled",
    finish: {
      workflowRules: [],
      writableScope: [],
      memberEnabled: { pluginId: "tags", enabled: true },
    },
    status: "ready",
    reason: "",
  },
  {
    name: "previously registered schedule can plan with timing checker",
    setup: "disabled-schedule",
    finish: {
      workflowRules: [],
      writableScope: [],
      memberEnabled: { pluginId: "hooked", enabled: true },
    },
    status: "ready",
    reason: "",
  },
  {
    name: "stopped host service",
    setup: "stopped",
    finish: {
      requiredCapabilities: [
        {
          interfaceId: "schedule.runtime",
          providerId: "host:online-scheduler",
        },
      ],
    },
    status: "blocked",
    reason: "运行异常",
  },
  {
    name: "declared interface without an executable implementation",
    finish: {
      requiredCapabilities: [
        { interfaceId: "query.filter", providerId: "default" },
      ],
    },
    status: "blocked",
    reason: "未授权",
  },
  {
    name: "registered stub interface is unsupported",
    setup: "stub",
    finish: {
      requiredCapabilities: [
        { interfaceId: "query.filter", providerId: "hooked" },
      ],
    },
    status: "blocked",
    reason: "宿主尚不支持执行该接口",
  },
  {
    name: "schedule registration has timing checker",
    finish: {
      capabilityChanges: [
        {
          capability: "schedule.register",
          provider: "active-source",
          consumers: ["src/web/ActionForm.tsx"],
          change: "按任务时间执行已注册动作",
        },
      ],
    },
    status: "ready",
    reason: "",
  },
  {
    name: "existing schedule registration uses timing checker",
    setup: "stub",
    finish: {
      requiredCapabilities: [
        { interfaceId: "schedule.register", providerId: "hooked" },
      ],
    },
    status: "ready",
    reason: "",
  },
] as const;

for (const scenario of cases) {
  test(`browser planning: ${scenario.name}`, async ({ page }) => {
    const dir = mkdtempSync(join(tmpdir(), "cordis-capability-browser-"));
    const workspace = await Workspace.open(join(dir, "workspace.db"), {
      clock: createControllableClock(Date.parse("2026-09-28T00:00:00Z")),
    });
    if ("setup" in scenario && scenario.setup === "disabled") {
      await activateDual(workspace);
      const current = workspace.composition();
      await workspace.setMemberEnabled({
        operationId: randomUUID(),
        compositionRevision: current.revision,
        versionId: current.versionId,
        pluginId: "tags",
        enabled: false,
      });
    }
    if ("setup" in scenario && scenario.setup === "stopped")
      workspace.testHarness()?.scheduleService.stop();
    if ("setup" in scenario && scenario.setup === "disabled-schedule")
      await activateDisabledScheduleMember(workspace);
    if ("setup" in scenario && scenario.setup === "stub")
      await activateStubInterface(workspace);
    const evolution = new Evolution(
      workspace.db,
      new PlanningDriver(scenario.finish),
      new EvolutionDomain(workspace),
    );
    const app = createApp(workspace, evolution);
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
        .fill("改进任务行为");
      await page.getByRole("button", { name: "发送需求" }).click();
      await expect
        .poll(async () => {
          const response = await page.request.get(`${baseURL}/api/assistant`);
          return (await response.json()).run?.status;
        })
        .toBe(scenario.status);
      const snapshot = await (
        await page.request.get(`${baseURL}/api/assistant`)
      ).json();
      if (scenario.status === "ready") {
        const composition = await (
          await page.request.get(`${baseURL}/api/composition`)
        ).json();
        expect(composition.baseServices).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              id: "host:online-scheduler",
              status: "active",
            }),
          ]),
        );
        expect(
          composition.extensions.capabilities.some(
            (item: { interfaceId: string; status: string }) =>
              item.interfaceId === "schedule.register" &&
              item.status === "active",
          ),
        ).toBe(
          scenario.name ===
            "existing schedule registration uses timing checker",
        );
        await expect(
          page.getByRole("region", { name: "待确认方案" }),
        ).toBeVisible();
      } else {
        expect(snapshot.run.message).toContain(scenario.reason);
        await expect(
          page.getByRole("button", { name: "开始执行", exact: true }),
        ).toHaveCount(0);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await evolution.close();
      await workspace.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("browser rejects stale guide before execution and after experience, then accepts a fresh plan", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-stale-guide-browser-"));
  const workspace = await Workspace.open(join(dir, "workspace.db"));
  const sessions = new ExperienceSessionHost(workspace);
  const planning = new PlanningDriver();
  const execution = new ExecutionDriver(planning);
  const guideRef = "guide/command.register";
  const original = capabilityGuides[guideRef];
  let invalidateDuringExecution = false;
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      const reply = await execution.generate(request, signal);
      if (
        reply.calls[0]?.name === "propose_plan" &&
        !JSON.stringify(request.history).includes('"name":"read_guides"')
      )
        return {
          ...reply,
          calls: [{ name: "read_guides", args: { refs: [guideRef] } }],
        };
      if (
        reply.calls[0]?.name === "submit_candidate" &&
        invalidateDuringExecution
      ) {
        capabilityGuides[guideRef] = `${original}\n资料修订 B`;
        invalidateDuringExecution = false;
      }
      return reply;
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
    if (!address || typeof address === "string")
      throw new Error("No server address");
    const baseURL = `http://127.0.0.1:${address.port}`;
    const observe = async () =>
      (await (await page.request.get(`${baseURL}/api/assistant`)).json()) as {
        run: {
          id: string;
          status: string;
          message?: string;
          staleReason?: string;
          experienceSession?: { status: string };
          plan: {
            id: string;
            binding: { materials: { ref: string; hash: string }[] };
          };
        };
        candidates: { id: string; passed: boolean; evidenceHash: string }[];
      };
    await page.goto(baseURL);
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    await page
      .getByRole("textbox", { name: "告诉 AI 你的需求" })
      .fill("完成前填写复盘");
    await page.getByRole("button", { name: "发送需求" }).click();
    await expect.poll(async () => (await observe()).run.status).toBe("ready");
    const old = await observe();
    expect(
      old.run.plan.binding.materials.some((item) => item.ref === guideRef),
    ).toBe(true);
    capabilityGuides[guideRef] = `${original}\n资料修订 A`;
    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      `调查资料已变化：${guideRef}`,
    );
    expect((await observe()).run.status).toBe("ready");
    await page.reload();
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "请修改需求并重新调查、确认",
    );
    expect(workspace.query().total).toBe(0);

    await page.getByRole("button", { name: "修改需求" }).click();
    await page
      .getByRole("textbox", { name: "告诉 AI 你的需求" })
      .fill("完成前填写复盘，按当前指南重新调查");
    await page.getByRole("button", { name: "发送需求" }).click();
    await expect.poll(async () => (await observe()).run.status).toBe("ready");
    const fresh = await observe();
    expect(fresh.run.plan.id).not.toBe(old.run.plan.id);
    expect(
      fresh.run.plan.binding.materials.find((item) => item.ref === guideRef)
        ?.hash,
    ).toBe(hash(capabilityGuides[guideRef]));
    invalidateDuringExecution = true;
    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    await expect
      .poll(async () => (await observe()).run.status, { timeout: 20000 })
      .toBe("failed");
    expect((await observe()).run.message).toContain(
      `调查资料已变化：${guideRef}`,
    );
    expect((await observe()).candidates).toHaveLength(0);
    expect(workspace.query().total).toBe(0);

    await page.getByRole("button", { name: "修改后重试" }).click();
    await page
      .getByRole("textbox", { name: "告诉 AI 你的需求" })
      .fill("完成前填写复盘，执行资料变化后重新调查");
    await page.getByRole("button", { name: "发送需求" }).click();
    await expect.poll(async () => (await observe()).run.status).toBe("ready");
    const executionReady = await observe();
    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    await expect
      .poll(async () => (await observe()).run.status, { timeout: 20000 })
      .toBe("awaiting-apply");
    const candidate = (await observe()).candidates.find((item) => item.passed);
    expect(candidate).toBeTruthy();
    const experience = await page.request.post(
      `${baseURL}/api/assistant/commands`,
      {
        data: {
          type: "experience",
          operationId: randomUUID(),
          runId: executionReady.run.id,
          candidateId: candidate!.id,
        },
      },
    );
    expect(experience.status()).toBe(200);
    capabilityGuides[guideRef] = `${original}\n资料修订 C`;
    const apply = await page.request.post(`${baseURL}/api/assistant/commands`, {
      data: {
        type: "apply",
        operationId: randomUUID(),
        runId: executionReady.run.id,
        candidateId: candidate!.id,
        evidenceHash: candidate!.evidenceHash,
        compositionRevision: workspace.composition().revision,
      },
    });
    expect(apply.status()).toBe(409);
    expect((await apply.json()).message).toContain(
      `调查资料已变化：${guideRef}`,
    );
    expect((await observe()).run.status).toBe("awaiting-apply");
    expect((await observe()).run.experienceSession?.status).toBe("active");
    await page.reload();
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText(
      "请调整后重新规划、体验并确认新候选",
    );
    expect(workspace.query().total).toBe(0);

    const previousVersion = workspace.composition().versionId;
    await page.getByRole("button", { name: "调整后重新规划" }).click();
    await page
      .getByRole("textbox", { name: "告诉 AI 你的需求" })
      .fill("完成前填写复盘，按最新指南重新调查");
    await page.getByRole("button", { name: "发送需求" }).click();
    await expect.poll(async () => (await observe()).run.status).toBe("ready");
    const renewed = await observe();
    await page.getByRole("button", { name: "开始执行", exact: true }).click();
    await expect
      .poll(async () => (await observe()).run.status, { timeout: 20000 })
      .toBe("awaiting-apply");
    const renewedCandidate = (await observe()).candidates.find(
      (item) => item.passed,
    )!;
    const renewedExperience = await page.request.post(
      `${baseURL}/api/assistant/commands`,
      {
        data: {
          type: "experience",
          operationId: randomUUID(),
          runId: renewed.run.id,
          candidateId: renewedCandidate.id,
        },
      },
    );
    expect(renewedExperience.status()).toBe(200);
    const renewedApply = await page.request.post(
      `${baseURL}/api/assistant/commands`,
      {
        data: {
          type: "apply",
          operationId: randomUUID(),
          runId: renewed.run.id,
          candidateId: renewedCandidate.id,
          evidenceHash: renewedCandidate.evidenceHash,
          compositionRevision: workspace.composition().revision,
        },
      },
    );
    expect(renewedApply.status()).toBe(200);
    await expect
      .poll(async () => (await observe()).run.status, { timeout: 20000 })
      .toBe("succeeded");
    expect(workspace.composition().versionId).not.toBe(previousVersion);
    expect(workspace.query().total).toBe(0);
  } finally {
    capabilityGuides[guideRef] = original;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await evolution.close();
    await workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser planning corrects bad guide arguments and rejects an unsent catalog hash", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-guide-browser-"));
  const workspace = await Workspace.open(join(dir, "workspace.db"));
  const base = new PlanningDriver();
  let phase = 0;
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      const reply = await base.generate(request, signal);
      if (reply.calls[0]?.name !== "propose_plan") return reply;
      if (phase++ === 0)
        return {
          ...reply,
          calls: [{ name: "read_guides", args: { refs: ["guide/unknown"] } }],
        };
      if (phase === 2)
        return {
          ...reply,
          calls: [
            {
              name: "propose_plan",
              args: {
                ...reply.calls[0].args,
                evidence: [
                  ...(reply.calls[0].args.evidence as {
                    ref: string;
                    hash: string;
                  }[]),
                  {
                    ref: "guide/command.register",
                    hash: hash(capabilityGuides["guide/command.register"]),
                  },
                ],
              },
            },
          ],
        };
      return reply;
    },
  };
  const evolution = new Evolution(
    workspace.db,
    driver,
    new EvolutionDomain(workspace),
  );
  const app = createApp(workspace, evolution);
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
      .fill("完成任务前添加复盘");
    await page.getByRole("button", { name: "发送需求" }).click();
    await expect
      .poll(
        async () =>
          (await (await page.request.get(`${baseURL}/api/assistant`)).json())
            .run?.status,
      )
      .toBe("ready");
    expect(phase).toBe(3);
    const history = JSON.stringify(base.requests.at(-1)?.history);
    expect(history).toContain("REF_UNAVAILABLE");
    expect(history).toContain("调查证据不存在或未读取");
    await expect(
      page.getByRole("region", { name: "待确认方案" }),
    ).toBeVisible();
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await evolution.close();
    await workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("browser planning can read the bounded task event upgrade guide", async ({
  page,
}) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-event-guide-browser-"));
  const workspace = await Workspace.open(join(dir, "workspace.db"));
  const base = new PlanningDriver();
  let readGuide = false;
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      const reply = await base.generate(request, signal);
      if (reply.calls[0]?.name === "propose_plan" && !readGuide) {
        readGuide = true;
        return {
          ...reply,
          calls: [
            { name: "read_guides", args: { refs: ["guide/task.events"] } },
          ],
        };
      }
      return reply;
    },
  };
  const evolution = new Evolution(
    workspace.db,
    driver,
    new EvolutionDomain(workspace),
  );
  const app = createApp(workspace, evolution);
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.get("*", serveStatic({ path: "./dist/web/index.html" }));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening)
      await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test server address");
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    await page
      .getByRole("textbox", { name: "告诉 AI 你的需求" })
      .fill("升级标签并订阅任务创建事件");
    await page.getByRole("button", { name: "发送需求" }).click();
    await expect
      .poll(async () => (await evolution.observe()).run?.status)
      .toBe("ready");
    const history = JSON.stringify(base.requests.at(-1)?.history);
    expect(history).toContain("guide/task.events");
    expect(history).toContain("task.created");
    expect(history).toContain("不得借事件回调直接写库");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await evolution.close();
    await workspace.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
