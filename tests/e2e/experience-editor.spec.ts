import { test, expect } from "@playwright/test";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { ExperienceSessionHost } from "../../src/server/experience-session.js";
import { createApp } from "../../src/server/app.js";
import { uiDetailReleaseInput } from "../fixtures/ui-detail.js";

const experienceTest = test.extend<{
  withUiContributions: boolean;
  experience: { sessions: ExperienceSessionHost; id: string; taskId: string };
}>({
  withUiContributions: [true, { option: true }],
  experience: async ({ page, withUiContributions }, use) => {
    const directory = await mkdtemp(
      join(tmpdir(), "cordis-experience-editor-"),
    );
    const workspace = await Workspace.open(join(directory, "workspace.db"));
    const sessions = new ExperienceSessionHost(workspace);
    const counterCode = `export default {
      contribute() { return {fields:[{key:'count',label:'计数',type:'text'}],commands:[{id:'increment',label:'加一',from:['open']}]}; },
      decide({task}) { return {kind:'commit',state:task.state,fields:{...task.fields,count:String(Number(task.fields.count??'0')+1)}}; }
    };`;
    const counter = workspace.release.record({
      pluginId: "counter",
      name: "计数",
      service: "plugin:counter",
      contractVersion: "extensions/1",
      source: counterCode,
      code: counterCode,
      definition: { id: "counter" },
      evidence: { passed: true, origin: "test" },
    });
    const base = workspace.release.get(workspace.composition().versionId);
    const workflow = withUiContributions
      ? await uiDetailReleaseInput("experience-editor")
      : {
          pluginId: base.pluginId,
          name: base.name,
          service: base.service,
          contractVersion: base.contractVersion,
          source: base.source,
          code: base.code,
          definition: base.definition,
          evidence: { passed: true, origin: "test" },
        };
    const version = workspace.release.record({
      ...workflow,
      members: [
        { pluginId: workflow.pluginId, enabled: true, role: "workflow" },
        {
          pluginId: "counter",
          versionId: counter.id,
          enabled: true,
          role: "auxiliary",
        },
      ],
    });
    const session = await sessions.start({
      runId: "editor-test",
      candidateId: "candidate",
      versionId: version.id,
      evidenceHash: "test",
      compositionRevision: workspace.composition().revision,
    });
    const before = workspace.query();
    const app = createApp(workspace, undefined, sessions);
    app.use("/*", serveStatic({ root: "./dist/web" }));
    app.get("*", serveStatic({ path: "./dist/web/index.html" }));
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    try {
      if (!server.listening)
        await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing server address");
      await page.addInitScript(
        ({ id, runId }) =>
          localStorage.setItem(
            "cordis-experience-session",
            JSON.stringify({ sessionId: id, runId }),
          ),
        session,
      );
      await page.goto(`http://127.0.0.1:${address.port}`);
      await expect(
        page.getByRole("status", { name: "候选体验提示" }),
      ).toBeVisible();
      await use({ sessions, id: session.id, taskId: session.taskId });
      expect(workspace.query()).toEqual(before);
    } finally {
      // Stop browser polling before closing this fixture's HTTP listener.
      await page.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        if ("closeAllConnections" in server) server.closeAllConnections();
      });
      await sessions.close();
      await workspace.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
});

experienceTest("贡献动作后保留备注草稿并保存", async ({ page, experience }) => {
  await page.getByLabel("备注", { exact: true }).fill("贡献前的草稿");
  await page
    .getByRole("button", { name: "打证明标记 候选体验任务", exact: true })
    .click();
  await expect(
    page
      .getByRole("article", { name: "扩展证明" })
      .getByText("ok", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("备注", { exact: true })).toHaveValue(
    "贡献前的草稿",
  );
  const receipt = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/experience/commands") &&
      response.request().postDataJSON().type === "edit",
  );
  await page.getByRole("button", { name: "保存", exact: true }).click();
  expect((await receipt).status()).toBe(200);
});

experienceTest(
  "没有界面贡献的辅助计数动作也可操作",
  async ({ page, experience }) => {
    await page.getByLabel("备注", { exact: true }).fill("计数前的草稿");
    await page.getByRole("button", { name: "加一", exact: true }).click();
    await expect
      .poll(
        () => experience.sessions.readSnapshot(experience.id).task.fields.count,
      )
      .toBe("1");
    await expect(page.getByLabel("备注", { exact: true })).toHaveValue(
      "计数前的草稿",
    );
    const receipt = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/experience/commands") &&
        response.request().postDataJSON().type === "edit",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    expect((await receipt).status()).toBe(200);
  },
);

experienceTest(
  "冲突后从隔离会话读取最新版本并保留草稿",
  async ({ page, experience }) => {
    await page.getByLabel("备注", { exact: true }).fill("并发后的草稿");
    const initial = experience.sessions.readSnapshot(experience.id);
    await experience.sessions.command(experience.id, {
      type: "edit",
      taskId: experience.taskId,
      expectedRevision: initial.task.revision,
      operationId: randomUUID(),
      title: initial.task.title,
      description: "另一个客户端",
    });
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await page
      .getByRole("button", { name: "读取最新版本", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("已读取最新版本");
    await expect(page.getByLabel("备注", { exact: true })).toHaveValue(
      "并发后的草稿",
    );
    const receipt = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/experience/commands") &&
        response.request().postDataJSON().type === "edit",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const response = await receipt;
    expect(response.status()).toBe(200);
    expect((await response.json()).task.description).toBe("并发后的草稿");
  },
);

experienceTest("体验任务可以完成并重新打开", async ({ page, experience }) => {
  await page.getByRole("button", { name: "完成", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "重新打开", exact: true }),
  ).toBeVisible();
  expect(experience.sessions.readSnapshot(experience.id).task.state).toBe(
    "done",
  );
  await page.getByRole("button", { name: "重新打开", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "完成", exact: true }),
  ).toBeVisible();
  expect(experience.sessions.readSnapshot(experience.id).task.state).toBe(
    "open",
  );
});

experienceTest.describe("没有界面贡献的体验", () => {
  experienceTest.use({ withUiContributions: false });
  experienceTest("计数拒绝可见且能重试和保存", async ({ page, experience }) => {
    expect(
      experience.sessions.readSnapshot(experience.id).composition
        .uiContributions ?? [],
    ).toEqual([]);
    await page.getByLabel("备注", { exact: true }).fill("拒绝后保留草稿");
    await page.route("**/api/experience/commands", async (route) => {
      if (route.request().postDataJSON().actionId === "increment")
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            code: "ACTION_REJECTED",
            message: "计数暂不可用",
          }),
        });
      await route.continue();
    });
    await page.getByRole("button", { name: "加一", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("计数暂不可用");
    await expect(
      page.getByRole("button", { name: "加一", exact: true }),
    ).toBeEnabled();
    await page.unroute("**/api/experience/commands");
    await page.getByRole("button", { name: "加一", exact: true }).click();
    await expect
      .poll(
        () => experience.sessions.readSnapshot(experience.id).task.fields.count,
      )
      .toBe("1");
    await expect(page.getByRole("alert")).toHaveCount(0);
    const receipt = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/experience/commands") &&
        response.request().postDataJSON().type === "edit",
    );
    await page.getByRole("button", { name: "保存", exact: true }).click();
    const response = await receipt;
    expect(response.status()).toBe(200);
    expect((await response.json()).task.description).toBe("拒绝后保留草稿");
  });
});
