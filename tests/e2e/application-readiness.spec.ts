import { test as base, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { ExperienceSessionHost } from "../../src/server/experience-session.js";
import { createApp } from "../../src/server/app.js";
import { Evolution, settleEvolution } from "../app/evolution-adapter.js";
import { PlanningDriver, toolReply } from "../app/planning-fixture.js";
import {
  candidateScope,
  candidateSource,
  source,
} from "../app/evolution-fixture.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

// A fresh, independently checked candidate per test. No provider or recorded reviews.
const test = base.extend<{
  host: {
    url: string;
    workspace: Workspace;
    evolution: Evolution;
    taskId: string;
  };
}>({
  host: async ({}, use, info) => {
    const directory = info.outputPath("backend");
    await mkdir(directory, { recursive: true });
    const workspace = await Workspace.open(join(directory, "workspace.db"));
    const sessions = new ExperienceSessionHost(workspace);
    const planning = new PlanningDriver({ writableScope: candidateScope });
    const evolution = new Evolution(
      workspace.db,
      {
        async generate(request) {
          if (request.tools?.some((tool) => tool.name === "submit_candidate"))
            return toolReply(
              "submit_candidate",
              JSON.parse(
                candidateSource(
                  source(
                    workspace.composition().workflow.id,
                    workspace.composition().workflow.name,
                  ),
                ),
              ) as Record<string, unknown>,
            );
          return planning.generate(request);
        },
      },
      new EvolutionDomain(workspace),
      sessions,
      { calls: 12, candidates: 3, milliseconds: 1800000 },
    );
    const app = createApp(workspace, evolution, sessions);
    app.use("/*", serveStatic({ root: "./dist/web" }));
    app.get("*", serveStatic({ path: "./dist/web/index.html" }));
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      if (!server.listening) await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing test server address");
      const task = (
        await workspace.command({
          type: "create",
          operationId: randomUUID(),
          compositionRevision: workspace.composition().revision,
          title: "应用后任务",
        })
      ).task!;
      await evolution.command({
        type: "request",
        operationId: randomUUID(),
        text: "完成前必须填写复盘，去掉首尾空白后至少1个最多5000个Unicode码点，重开保留，其他行为不变",
      });
      const ready = await settleEvolution(evolution, "ready");
      if (ready.status !== "ready") throw new Error("Missing ready plan");
      await evolution.command({
        type: "start",
        operationId: randomUUID(),
        runId: ready.id,
        planId: ready.plan.id,
      });
      await settleEvolution(evolution, "awaiting-apply");
      await use({
        url: `http://127.0.0.1:${address.port}`,
        workspace,
        evolution,
        taskId: task.id,
      });
    } finally {
      await writeFile(
        join(directory, "final-assistant.json"),
        JSON.stringify(await evolution.observe(), null, 2),
      );
      await evolution.close();
      await sessions.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      });
      await workspace.close();
    }
  },
});

for (const width of [1360, 320]) {
  test(`应用成功提示必须等待实际组合刷新，随后可立即操作 ${width}px`, async ({
    page,
    host,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 850 });
    const original = host.workspace.composition();
    const held = deferred();
    const release = deferred();
    await page.route("**/api/composition", async (route) => {
      const response = await route.fetch();
      const composition = (await response.json()) as { revision: number };
      if (composition.revision > original.revision) {
        held.resolve();
        await release.promise;
      }
      await route.fulfill({ response });
    });
    try {
      await page.goto(host.url);
      await page.getByRole("button", { name: "改进应用", exact: true }).click();
      await page.getByRole("button", { name: "确认应用", exact: true }).click();
      await held.promise;
      expect((await host.evolution.observe()).run?.status).toBe("succeeded");
      // The UI must not declare readiness while its real composition response is held.
      await expect(
        page.getByRole("region", { name: "正在应用", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "继续修改", exact: true }),
      ).toHaveCount(0);
      release.resolve();
      await page
        .getByRole("button", { name: "继续修改", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "关闭改进应用", exact: true })
        .click();
      await page
        .getByRole("button", { name: "完成 应用后任务", exact: true })
        .click();
      await expect(
        page.locator('form[data-action-form="complete"]'),
      ).toBeVisible();
      expect(host.workspace.read(host.taskId).state).toBe("open");
    } finally {
      release.resolve();
    }
  });

  test(`提前操作被409保护拦截，重试不误写或重复应用 ${width}px`, async ({
    page,
    host,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 850 });
    const original = host.workspace.composition();
    const before = host.workspace.read(host.taskId);
    const held = deferred();
    const release = deferred();
    await page.route("**/api/assistant?**", async (route) => {
      const response = await route.fetch();
      const snapshot = (await response.json()) as { run?: { status: string } };
      if (snapshot.run?.status === "succeeded") {
        held.resolve();
        await release.promise;
      }
      await route.fulfill({ response });
    });
    try {
      await page.goto(host.url);
      await page.getByRole("button", { name: "改进应用", exact: true }).click();
      await page.getByRole("button", { name: "确认应用", exact: true }).click();
      await held.promise;
      await page
        .getByRole("button", { name: "关闭改进应用", exact: true })
        .click();
      const rejected = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/commands") &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "完成 应用后任务", exact: true })
        .click();
      const receipt = await rejected;
      expect(receipt.status()).toBe(409);
      expect(((await receipt.json()) as { code: string }).code).toBe(
        "COMPOSITION_STALE",
      );
      expect(host.workspace.read(host.taskId)).toEqual(before);
      await expect(page.getByRole("alert")).toContainText("流程已变化");
      await page.getByRole("button", { name: "重试", exact: true }).click();
      release.resolve();
      await page
        .getByRole("button", { name: "完成 应用后任务", exact: true })
        .click();
      const form = page.locator('form[data-action-form="complete"]');
      await expect(form).toBeVisible();
      await form
        .getByRole("textbox", { name: "复盘", exact: true })
        .fill("重试后的复盘🙂");
      await form.getByRole("button", { name: "完成", exact: true }).click();
      await expect
        .poll(() => host.workspace.read(host.taskId).state)
        .toBe("done");
      expect(host.workspace.read(host.taskId).revision).toBe(
        before.revision + 1,
      );
      expect(host.workspace.read(host.taskId).fields.reflection).toBe(
        "重试后的复盘🙂",
      );
      expect(host.workspace.composition().revision).toBe(original.revision + 1);
    } finally {
      release.resolve();
    }
  });

  test(`组合刷新失败不提前完成，刷新页面后可恢复 ${width}px`, async ({
    page,
    host,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 850 });
    const original = host.workspace.composition();
    const before = host.workspace.read(host.taskId);
    let unavailable = true;
    await page.route("**/api/composition", async (route) => {
      const response = await route.fetch();
      const composition = (await response.json()) as { revision: number };
      if (unavailable && composition.revision > original.revision) {
        await route.fulfill({
          status: 503,
          json: { message: "组合暂时不可读" },
        });
        return;
      }
      await route.fulfill({ response });
    });
    await page.goto(host.url);
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    await page.getByRole("button", { name: "确认应用", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("组合暂时不可读");
    await expect(
      page.getByRole("button", { name: "继续修改", exact: true }),
    ).toHaveCount(0);
    expect((await host.evolution.observe()).run?.status).toBe("succeeded");
    expect(host.workspace.read(host.taskId)).toEqual(before);
    unavailable = false;
    await page.reload();
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    await page.getByRole("button", { name: "继续修改", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "关闭改进应用", exact: true })
      .click();
    await page
      .getByRole("button", { name: "完成 应用后任务", exact: true })
      .click();
    await expect(
      page.locator('form[data-action-form="complete"]'),
    ).toBeVisible();
    expect(host.workspace.composition().revision).toBe(original.revision + 1);
  });

  test(`筛选刷新覆盖旧请求时仍等待当前视图就绪 ${width}px`, async ({
    page,
    host,
  }) => {
    test.setTimeout(90000);
    await page.setViewportSize({ width, height: 850 });
    const original = host.workspace.composition();
    const oldHeld = deferred();
    const currentHeld = deferred();
    const releaseOld = deferred();
    const releaseCurrent = deferred();
    let refreshes = 0;
    await page.route("**/api/composition", async (route) => {
      const response = await route.fetch();
      const composition = (await response.json()) as { revision: number };
      if (composition.revision > original.revision) {
        if (++refreshes === 1) {
          oldHeld.resolve();
          await releaseOld.promise;
        } else {
          currentHeld.resolve();
          await releaseCurrent.promise;
        }
      }
      await route.fulfill({ response });
    });
    try {
      await page.goto(host.url);
      await page.getByRole("button", { name: "改进应用", exact: true }).click();
      await page.getByRole("button", { name: "确认应用", exact: true }).click();
      await oldHeld.promise;
      await page
        .getByRole("button", { name: "关闭改进应用", exact: true })
        .click();
      await page.getByRole("button", { name: "已完成", exact: true }).click();
      await currentHeld.promise;
      const oldArrived = page.waitForResponse((response) =>
        response.url().endsWith("/api/composition"),
      );
      releaseOld.resolve();
      await oldArrived;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      await page.getByRole("button", { name: "改进应用", exact: true }).click();
      await expect(
        page.getByRole("region", { name: "正在应用", exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "继续修改", exact: true }),
      ).toHaveCount(0);
      releaseCurrent.resolve();
      await page
        .getByRole("button", { name: "继续修改", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "关闭改进应用", exact: true })
        .click();
      await page.getByRole("button", { name: "全部任务", exact: true }).click();
      await page
        .getByRole("button", { name: "完成 应用后任务", exact: true })
        .click();
      await expect(
        page.locator('form[data-action-form="complete"]'),
      ).toBeVisible();
    } finally {
      releaseOld.resolve();
      releaseCurrent.resolve();
    }
  });
}
