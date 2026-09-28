import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { createApp } from "../../src/server/app.js";
import { PlanningDriver } from "../app/planning-fixture.js";
import { activateDual } from "../app/dual-composition-fixture.js";
import { createControllableClock } from "../../src/server/host/clock.js";

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
    name: "schedule registration without timing checker",
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
    status: "blocked",
    reason: "缺少可靠业务验收检查器",
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
        ).toBe(false);
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
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await evolution.close();
      await workspace.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
