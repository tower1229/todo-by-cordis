import { test, expect } from "@playwright/test";
import { hookedVersionId } from "../fixtures/hooked.js";

async function restoreDefault(
  request: import("@playwright/test").APIRequestContext,
) {
  const composition = await (await request.get("/api/composition")).json();
  if (composition.workflow.id === "default") return;
  const defaultVersion = composition.history.find(
    (item: { workflowId: string }) => item.workflowId === "default",
  )?.versionId;
  await request.post("/api/runtime/restore", {
    data: {
      compositionRevision: composition.revision,
      operationId: crypto.randomUUID(),
      ...(defaultVersion ? { versionId: defaultVersion } : {}),
    },
  });
}

async function activateHooked(
  request: import("@playwright/test").APIRequestContext,
) {
  const before = await (await request.get("/api/composition")).json();
  const restore = await request.post("/api/runtime/restore", {
    data: {
      compositionRevision: before.revision,
      operationId: crypto.randomUUID(),
      versionId: await hookedVersionId("e2e-fixture"),
    },
  });
  expect(restore.ok()).toBeTruthy();
  return (await request.get("/api/composition")).json();
}

async function clockNow(request: import("@playwright/test").APIRequestContext) {
  const body = await (await request.get("/api/test/clock")).json();
  return body.now as number;
}

async function setDueViaUi(
  page: import("@playwright/test").Page,
  title: string,
  dueAt: string,
) {
  await page
    .getByRole("button", { name: `设截止 ${title}`, exact: true })
    .click();
  await page.getByLabel("截止", { exact: true }).fill(dueAt);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "设截止", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

test.beforeEach(async ({ request }) => {
  await restoreDefault(request);
});

test.afterEach(async ({ request }) => {
  await restoreDefault(request);
});

test("host base schedule service is distinct from members", async ({
  request,
}) => {
  const composition = await (await request.get("/api/composition")).json();
  expect(composition.baseServices).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: "host:online-scheduler",
        kind: "host-base",
        interfaceId: "schedule.runtime",
        status: "active",
      }),
    ]),
  );
  expect(
    composition.members.some(
      (m: { pluginId: string }) => m.pluginId === "host:online-scheduler",
    ),
  ).toBeFalsy();
  expect((await request.get("/api/test/clock")).ok()).toBeTruthy();
});

test("browser observes schedule fire after host clock advance", async ({
  page,
  request,
}) => {
  await activateHooked(request);
  await page.goto("/");
  const title = "到点自动完成";
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  const now = await clockNow(request);
  await setDueViaUi(page, title, new Date(now + 5_000).toISOString());

  await expect(
    page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
  ).toBeVisible();

  const advance = await request.post("/api/test/clock/advance", {
    data: { ms: 5_000 },
  });
  expect(advance.ok()).toBeTruthy();

  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
  ).toBeVisible();
  const tasks = await (await request.get("/api/tasks?category=done")).json();
  const done = tasks.tasks.find((t: { title: string }) => t.title === title);
  expect(done?.state).toBe("done");
});

for (const scenario of [
  { name: "先到期后打开详情 1280px", mode: "before", width: 1280 },
  { name: "先到期后打开详情 320px", mode: "before", width: 320 },
  { name: "详情打开后到期仍拒绝旧动作", mode: "after-open", width: 1280 },
  {
    name: "表单打开后到期仍拒绝旧提交并保留草稿",
    mode: "after-form",
    width: 390,
  },
  {
    name: "读取失败禁止旧快照写入，重试后恢复",
    mode: "read-failure",
    width: 390,
  },
  { name: "关闭读取后迟到结果不能覆盖其他面板", mode: "dismiss", width: 320 },
] as const)
  test(`任务修订：${scenario.name}`, async ({ page }, info) => {
    const { serve } = await import("@hono/node-server");
    const { serveStatic } = await import("@hono/node-server/serve-static");
    const { mkdtemp, rm, readFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Workspace } = await import("../../src/server/workspace.js");
    const { createApp } = await import("../../src/server/app.js");
    const { createControllableClock } = await import(
      "../../src/server/host/clock.js"
    );
    const { dueAutoExpireSource } = await import(
      "../../src/server/capability-guides.js"
    );
    const { dualWorkflowDefinition } = await import(
      "../app/dual-composition-fixture.js"
    );
    const directory = await mkdtemp(join(tmpdir(), "cordis-revision-race-"));
    const clock = createControllableClock(
      Date.parse("2030-01-01T00:00:00.000Z"),
    );
    const workspace = await Workspace.open(join(directory, "workspace.db"), {
      clock,
    });
    const workflowCode = await readFile(
      new URL("../fixtures/aux-workflow.mjs", import.meta.url),
      "utf8",
    );
    const due = workspace.release.record({
      pluginId: "due",
      name: "截止",
      service: "plugin:due",
      contractVersion: "extensions/1",
      source: dueAutoExpireSource,
      code: dueAutoExpireSource,
      definition: { id: "due" },
      evidence: { passed: true, origin: "revision-test" },
    });
    const version = workspace.release.record({
      pluginId: "aux-workflow",
      name: "工作流",
      service: "workflow",
      contractVersion: "workflow/1",
      source: workflowCode,
      code: workflowCode,
      definition: dualWorkflowDefinition,
      evidence: { passed: true, origin: "revision-test" },
      members: [
        { pluginId: "aux-workflow", role: "workflow", enabled: true },
        {
          pluginId: "due",
          versionId: due.id,
          role: "auxiliary",
          enabled: true,
        },
      ],
    });
    await workspace.activate(
      {
        versionId: version.id,
        compositionRevision: workspace.composition().revision,
        operationId: crypto.randomUUID(),
      },
      () => undefined,
    );
    const title = `定时器与列表修订竞争 ${scenario.mode}`;
    const created = await workspace.command({
      type: "create",
      title,
      compositionRevision: workspace.composition().revision,
      operationId: crypto.randomUUID(),
    });
    const scheduled = await workspace.command({
      type: "action",
      taskId: created.task!.id,
      actionId: "setDue",
      input: { dueAt: new Date(clock.now() + 5_000).toISOString() },
      expectedRevision: created.task!.revision,
      compositionRevision: workspace.composition().revision,
      operationId: crypto.randomUUID(),
    });
    const oldRevision = scheduled.task!.revision;
    const app = createApp(workspace, undefined, undefined, {
      testClock: clock,
    });
    app.use("/*", serveStatic({ root: "./dist/web" }));
    app.get("*", serveStatic({ path: "./dist/web/index.html" }));
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    const evidence: Record<string, unknown> = {
      mode: scenario.mode,
      oldRevision,
      realTimer: true,
      fabricatedResponse: false,
    };
    const actionRequests: {
      expectedRevision: number;
      input?: Record<string, string>;
    }[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/commands"
      ) {
        const command = request.postDataJSON() as {
          type: string;
          taskId: string;
          expectedRevision: number;
          input?: Record<string, string>;
        };
        if (command.type === "action" && command.taskId === created.task!.id)
          actionRequests.push(command);
      }
    });
    try {
      if (!server.listening)
        await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing server address");
      await page.setViewportSize({ width: scenario.width, height: 900 });
      await page.goto(`http://127.0.0.1:${address.port}`);
      const edit = page.getByRole("button", {
        name: `编辑 ${title}`,
        exact: true,
      });
      await expect(edit).toBeVisible();
      const readTask = () =>
        workspace
          .query("", "all")
          .tasks.find((t) => t.id === created.task!.id)!;
      const advance = async () => {
        await clock.advance(5_000);
        await expect.poll(() => readTask().fields.expired).toBe("true");
        expect(readTask().revision).toBe(oldRevision + 1);
      };
      if (scenario.mode === "dismiss") {
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let started = () => {};
        const reading = new Promise<void>((resolve) => {
          started = resolve;
        });
        await page.route(`**/api/tasks/${created.task!.id}`, async (route) => {
          const response = await route.fetch();
          started();
          await held;
          await route.fulfill({ response });
        });
        await edit.click();
        await reading;
        await expect(
          page.getByRole("status", { name: "正在读取任务详情" }),
        ).toBeVisible();
        await expect(page.locator("[data-task-editor]")).toHaveCount(0);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(edit).toBeFocused();
        await page
          .getByRole("button", { name: "更多选项", exact: true })
          .click();
        await page
          .getByRole("menuitem", { name: "工作区设置", exact: true })
          .click();
        const response = page.waitForResponse(
          (r) => new URL(r.url()).pathname === `/api/tasks/${created.task!.id}`,
        );
        release();
        await (await response).finished();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        await expect(
          page
            .getByRole("dialog")
            .getByRole("heading", { name: "工作区设置", exact: true }),
        ).toBeVisible();
        await expect(page.locator("[data-task-editor]")).toHaveCount(0);
        expect(actionRequests).toHaveLength(0);
        return;
      }
      if (scenario.mode === "read-failure") {
        let reads = 0;
        await page.route(`**/api/tasks/${created.task!.id}`, async (route) => {
          reads++;
          if (reads === 1) return route.abort("failed");
          await route.continue();
        });
        await edit.click();
        await expect(page.getByRole("dialog").getByRole("alert")).toBeVisible();
        await expect(page.locator("[data-task-editor]")).toHaveCount(0);
        expect(actionRequests).toHaveLength(0);
        await page
          .getByRole("button", { name: "重试读取", exact: true })
          .click();
        await expect(page.getByLabel("任务名称", { exact: true })).toHaveValue(
          title,
        );
        expect(reads).toBe(2);
        await page.keyboard.press("Escape");
        await expect(page.getByRole("dialog")).toHaveCount(0);
        await expect(edit).toBeFocused();
        return;
      }
      if (scenario.mode === "before") {
        let delayed = false;
        await page.route("**/api/tasks?*", async (route) => {
          if (delayed) return route.continue();
          delayed = true;
          const response = await route.fetch();
          const body = (await response.json()) as {
            tasks: { id: string; revision: number }[];
          };
          evidence.listRevision = body.tasks.find(
            (t) => t.id === created.task!.id,
          )!.revision;
          await advance();
          evidence.timerRevision = readTask().revision;
          await route.fulfill({ response });
        });
        const listResponse = page.waitForResponse(
          (r) => new URL(r.url()).pathname === "/api/tasks",
        );
        await page
          .locator('[data-filter="all"]')
          .filter({ visible: true })
          .click();
        await listResponse;
        expect(evidence.listRevision).toBe(oldRevision);
        expect(evidence.timerRevision).toBe(oldRevision + 1);
      }
      await edit.click();
      await expect(page.locator("[data-task-editor]")).toBeVisible();
      const detail = (await (
        await page.request.get(
          new URL(`/api/tasks/${created.task!.id}`, page.url()).toString(),
        )
      ).json()) as { revision: number };
      evidence.backendRevision = detail.revision;
      expect(detail.revision).toBe(
        scenario.mode === "before" ? oldRevision + 1 : oldRevision,
      );
      if (scenario.mode === "before")
        await expect(
          page
            .getByRole("article", { name: "截止与过期" })
            .getByText("true", { exact: true }),
        ).toBeVisible();
      if (scenario.mode === "after-open") await advance();
      const [response] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname === "/api/commands",
        ),
        page
          .getByRole("article", { name: "截止与过期" })
          .getByRole("button", { name: `设截止 ${title}`, exact: true })
          .click(),
      ]);
      evidence.action = response.request().postDataJSON() as unknown;
      evidence.status = response.status();
      evidence.result = (await response.json()) as unknown;
      if (scenario.mode === "after-open") {
        expect(response.status()).toBe(409);
        expect(response.request().postDataJSON().expectedRevision).toBe(
          oldRevision,
        );
        await expect(page.getByRole("alert")).toContainText("任务已在别处修改");
        await expect(page.locator("[data-action-form]")).toHaveCount(0);
        expect(actionRequests).toHaveLength(1);
        expect(readTask().revision).toBe(oldRevision + 1);
        return;
      }
      expect(response.status()).toBe(200);
      const viewedRevision =
        scenario.mode === "before" ? oldRevision + 1 : oldRevision;
      expect(response.request().postDataJSON().expectedRevision).toBe(
        viewedRevision,
      );
      const field = page.getByLabel("截止时间", { exact: true });
      await expect(field).toBeVisible();
      const dueAt = new Date(clock.now() + 60_000).toISOString();
      await field.fill(dueAt);
      if (scenario.mode === "after-form") await advance();
      const [submitted] = await Promise.all([
        page.waitForResponse(
          (r) =>
            r.request().method() === "POST" &&
            new URL(r.url()).pathname === "/api/commands",
        ),
        page
          .getByRole("dialog")
          .getByRole("button", { name: "设截止", exact: true })
          .click(),
      ]);
      evidence.submitStatus = submitted.status();
      expect(submitted.request().postDataJSON().expectedRevision).toBe(
        viewedRevision,
      );
      expect(actionRequests).toHaveLength(2);
      if (scenario.mode === "after-form") {
        expect(submitted.status()).toBe(409);
        await expect(page.getByRole("alert")).toContainText("任务已在别处修改");
        await expect(field).toHaveValue(dueAt);
        expect(readTask().fields.dueAt).toBe(scheduled.task!.fields.dueAt);
        expect(readTask().fields.expired).toBe("true");
        expect(readTask().revision).toBe(oldRevision + 1);
      } else {
        expect(submitted.status()).toBe(200);
        await expect(page.locator("[data-task-editor]")).toBeVisible();
        expect(readTask().fields.dueAt).toBe(dueAt);
        expect(readTask().fields.expired).toBeUndefined();
      }
    } finally {
      evidence.actionRequests = actionRequests;
      await info.attach("revision-race", {
        body: Buffer.from(JSON.stringify(evidence, null, 2)),
        contentType: "application/json",
      });
      await page.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await workspace.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

test("browser reconnects to a scheduled result after closing and host restart", async ({
  page,
  request,
  context,
}) => {
  await activateHooked(request);
  await page.goto("/");
  const title = "重连后可见到期结果";
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  const now = await clockNow(request);
  await setDueViaUi(page, title, new Date(now + 5_000).toISOString());
  await page.close();
  expect((await request.post("/api/runtime/retry")).ok()).toBeTruthy();
  expect(
    (
      await request.post("/api/test/clock/advance", { data: { ms: 5_000 } })
    ).ok(),
  ).toBeTruthy();
  const reconnected = await context.newPage();
  await reconnected.goto("/");
  await reconnected
    .getByRole("button", { name: "已完成", exact: true })
    .click();
  await expect(
    reconnected.getByRole("button", { name: `编辑 ${title}`, exact: true }),
  ).toBeVisible();
  const executions = await (
    await request.get("/api/schedules/executions")
  ).json();
  expect(executions.executions).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        scheduleId: "due-field",
        outcome: "succeeded",
      }),
    ]),
  );
});

test("cleared due does not fire after clock advance", async ({
  page,
  request,
}) => {
  await activateHooked(request);
  await page.goto("/");
  const title = "清除截止不触发";
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  const now = await clockNow(request);
  await setDueViaUi(page, title, new Date(now + 8_000).toISOString());
  await setDueViaUi(page, title, "");

  await expect(
    page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
  ).toBeVisible();

  await request.post("/api/test/clock/advance", { data: { ms: 10_000 } });
  await page.reload();
  await expect(
    page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
  ).toHaveCount(0);
  const open = await (await request.get("/api/tasks?category=open")).json();
  expect(
    open.tasks.some((t: { title: string }) => t.title === title),
  ).toBeTruthy();
});

test("short controllable schedule still lands as task fact in browser", async ({
  page,
  request,
}) => {
  await activateHooked(request);
  await page.goto("/");
  const title = "短延时回归";
  await page
    .getByRole("textbox", { name: "添加任务", exact: true })
    .fill(title);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  const now = await clockNow(request);
  await setDueViaUi(page, title, new Date(now + 80).toISOString());
  await request.post("/api/test/clock/advance", { data: { ms: 120 } });
  await page.getByRole("button", { name: "已完成", exact: true }).click();
  await expect(
    page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
  ).toBeVisible();
});

test("real wall timer fires through schedule adapter in browser", async ({
  page,
}) => {
  const { serve } = await import("@hono/node-server");
  const { serveStatic } = await import("@hono/node-server/serve-static");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const { Workspace } = await import("../../src/server/workspace.js");
  const { createApp } = await import("../../src/server/app.js");
  const { ExperienceSessionHost } = await import(
    "../../src/server/experience-session.js"
  );
  const { hookedDefinition } = await import("../fixtures/hooked.js");

  const directory = await mkdtemp(join(tmpdir(), "cordis-sched-realtime-"));
  const code = await readFile(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../fixtures/hooked-plugin.mjs",
    ),
    "utf8",
  );
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  const sessions = new ExperienceSessionHost(workspace);
  const hooked = workspace.release.record({
    pluginId: "hooked",
    name: "钩子夹具",
    service: "workflow",
    contractVersion: "workflow/1",
    source: code,
    code,
    definition: hookedDefinition,
    evidence: { passed: true, origin: "test" },
  });
  await workspace.activate(
    {
      versionId: hooked.id,
      compositionRevision: workspace.composition().revision,
      operationId: crypto.randomUUID(),
    },
    () => undefined,
  );
  const created = await workspace.command({
    type: "create",
    title: "真实短延时",
    compositionRevision: workspace.composition().revision,
    operationId: crypto.randomUUID(),
  });
  await workspace.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setDue",
    expectedRevision: created.task!.revision,
    input: { dueAt: new Date(Date.now() + 80).toISOString() },
    compositionRevision: workspace.composition().revision,
    operationId: crypto.randomUUID(),
  });

  const probeApp = createApp(workspace, undefined, sessions);
  expect((await probeApp.request("/api/test/clock")).status).toBe(404);
  expect(
    (
      await probeApp.request("/api/test/clock/advance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ms: 1 }),
      })
    ).status,
  ).toBe(404);

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
    await page.waitForTimeout(160);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "已完成", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "编辑 真实短延时", exact: true }),
    ).toBeVisible();
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    await sessions.close();
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("browser sees deadline recovery after member enable and rollback keeps tasks", async ({
  page,
}) => {
  const { serve } = await import("@hono/node-server");
  const { serveStatic } = await import("@hono/node-server/serve-static");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { Workspace } = await import("../../src/server/workspace.js");
  const { createApp } = await import("../../src/server/app.js");
  const { createControllableClock } = await import(
    "../../src/server/host/clock.js"
  );
  const { dueAutoExpireSource } = await import(
    "../../src/server/capability-guides.js"
  );
  const { dualWorkflowDefinition } = await import(
    "../app/dual-composition-fixture.js"
  );
  const directory = await mkdtemp(
    join(tmpdir(), "cordis-sched-browser-recover-"),
  );
  const clock = createControllableClock(Date.parse("2030-01-01T00:00:00.000Z"));
  const workspace = await Workspace.open(join(directory, "workspace.db"), {
    clock,
  });
  const workflowCode = await readFile(
    new URL("../fixtures/aux-workflow.mjs", import.meta.url),
    "utf8",
  );
  const dueCode = dueAutoExpireSource;
  const due = workspace.release.record({
    pluginId: "due",
    name: "截止",
    service: "plugin:due",
    contractVersion: "extensions/1",
    source: dueCode,
    code: dueCode,
    definition: { id: "due" },
    evidence: { passed: true, origin: "test" },
  });
  const version = workspace.release.record({
    pluginId: "aux-workflow",
    name: "工作流",
    service: "workflow",
    contractVersion: "workflow/1",
    source: workflowCode,
    code: workflowCode,
    definition: dualWorkflowDefinition,
    evidence: { passed: true, origin: "test" },
    members: [
      { pluginId: "aux-workflow", role: "workflow", enabled: true },
      { pluginId: "due", versionId: due.id, role: "auxiliary", enabled: true },
    ],
  });
  await workspace.activate(
    {
      versionId: version.id,
      compositionRevision: workspace.composition().revision,
      operationId: crypto.randomUUID(),
    },
    () => undefined,
  );
  const app = createApp(workspace, undefined, undefined, { testClock: clock });
  app.use("/*", serveStatic({ root: "./dist/web" }));
  app.get("*", serveStatic({ path: "./dist/web/index.html" }));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  try {
    if (!server.listening)
      await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    await page.goto(`http://127.0.0.1:${address.port}`);
    const title = "启停与撤回保留";
    await page
      .getByRole("textbox", { name: "添加任务", exact: true })
      .fill(title);
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page
      .getByRole("button", { name: `设截止 ${title}`, exact: true })
      .click();
    await page
      .getByLabel("截止时间", { exact: true })
      .fill(new Date(clock.now() + 5_000).toISOString());
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "设截止", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    const active = workspace.composition();
    const disabled = await app.request("/api/composition/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: "due",
        enabled: false,
        versionId: active.versionId,
        compositionRevision: active.revision,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(disabled.ok).toBeTruthy();
    const disabledVersionId = workspace.composition().versionId;
    await clock.advance(5_000);
    expect(
      workspace.query("", "open").tasks.find((task) => task.title === title)
        ?.fields.expired,
    ).toBeUndefined();
    const beforeEnable = workspace.composition();
    const enabled = await app.request("/api/composition/members", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        pluginId: "due",
        enabled: true,
        versionId: beforeEnable.versionId,
        compositionRevision: beforeEnable.revision,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(enabled.ok).toBeTruthy();
    await workspace.whenSchedulesIdle();
    await page.reload();
    await expect(
      page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
    ).toBeVisible();
    expect(
      workspace.query("", "open").tasks.find((task) => task.title === title)
        ?.fields.expired,
    ).toBe("true");
    const restored = await app.request("/api/runtime/restore", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        versionId: disabledVersionId,
        compositionRevision: workspace.composition().revision,
        operationId: crypto.randomUUID(),
      }),
    });
    expect(restored.ok).toBeTruthy();
    await page.reload();
    await expect(
      page.getByRole("button", { name: `编辑 ${title}`, exact: true }),
    ).toBeVisible();
    expect(
      workspace.query("", "open").tasks.find((task) => task.title === title)
        ?.fields.expired,
    ).toBe("true");

    await workspace.activate(
      {
        versionId: version.id,
        compositionRevision: workspace.composition().revision,
        operationId: crypto.randomUUID(),
      },
      () => undefined,
    );
    await page.reload();
    const restartTitle = "重启补执行截止";
    // Exercise acknowledgement ordering even when the browser-to-host write is delayed.
    await page.route("**/api/commands", async (route) => {
      const command = route.request().postDataJSON() as { type?: string; actionId?: string };
      if (command.type === "action" && command.actionId === "setDue")
        await new Promise((resolve) => setTimeout(resolve, 100));
      await route.continue();
    });
    await page
      .getByRole("textbox", { name: "添加任务", exact: true })
      .fill(restartTitle);
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page
      .getByRole("button", { name: `设截止 ${restartTitle}`, exact: true })
      .click();
    await page
      .getByLabel("截止时间", { exact: true })
      .fill(new Date(clock.now() + 5_000).toISOString());
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "设截止", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeHidden();
    workspace.testHarness()!.scheduleService.stop();
    await clock.advance(5_000);
    await workspace.restart();
    await workspace.whenSchedulesIdle();
    await page.reload();
    await expect(
      page.getByRole("button", { name: `编辑 ${restartTitle}`, exact: true }),
    ).toBeVisible();
    expect(
      workspace
        .query("", "open")
        .tasks.find((task) => task.title === restartTitle)?.fields.expired,
    ).toBe("true");
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      if ("closeAllConnections" in server) server.closeAllConnections();
    });
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  }
});

for (const endBeforeFire of [true, false]) {
  test(`browser experience pending schedule ${endBeforeFire ? "cancels on exit" : "fires while open"}`, async ({
    page,
  }) => {
    const { serve } = await import("@hono/node-server");
    const { serveStatic } = await import("@hono/node-server/serve-static");
    const { mkdtemp, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { Workspace } = await import("../../src/server/workspace.js");
    const { createApp } = await import("../../src/server/app.js");
    const { ExperienceSessionHost } = await import(
      "../../src/server/experience-session.js"
    );
    const { Evolution } = await import("../app/evolution-adapter.js");
    const { EvolutionDomain } = await import(
      "../../src/server/evolution-domain.js"
    );
    const { bindPlan, capture } = await import("../../src/server/planning.js");
    const { freezeRequirements, candidateEvidenceHash } = await import(
      "../../src/server/requirement-coverage.js"
    );
    const { verifyBrowser } = await import(
      "../../src/server/browser-acceptance.js"
    );
    const { hash } = await import("../../src/release/storage.js");
    const { compileSpec } = await import(
      "../../src/evolution/specification.js"
    );
    const { createControllableClock } = await import(
      "../../src/server/host/clock.js"
    );
    const { verifyViaIsolatedWorkspace } = await import(
      "../../src/server/workspace-acceptance.js"
    );
    const { hookedReleaseInput } = await import("../fixtures/hooked.js");
    const directory = await mkdtemp(join(tmpdir(), "cordis-schedule-browser-"));
    const formalClock = createControllableClock(Date.now());
    const experienceClock = createControllableClock(formalClock.now());
    let pendingTimers = 0;
    let firedTimers = 0;
    const workspace = await Workspace.open(join(directory, "workspace.db"), {
      clock: formalClock,
    });
    const sessions = new ExperienceSessionHost(
      workspace,
      30 * 60 * 1000,
      () => ({
        now: () => experienceClock.now(),
        setTimeout(handler, delay) {
          let pending = true;
          pendingTimers++;
          const handle = experienceClock.setTimeout(async () => {
            pending = false;
            pendingTimers--;
            firedTimers++;
            await handler();
          }, delay);
          return {
            clear() {
              if (pending) pendingTimers--;
              pending = false;
              handle.clear();
            },
          };
        },
      }),
    );
    const formalVersion = workspace.release.record(
      await hookedReleaseInput("schedule-formal"),
    );
    const hooked = workspace.release.record(
      await hookedReleaseInput("schedule-browser"),
    );
    const checks = await verifyViaIsolatedWorkspace(
      workspace,
      hooked,
      [
        {
          name: "设置未来截止",
          state: "open",
          fields: {},
          action: "setDue",
          input: { dueAt: new Date(formalClock.now() + 60_000).toISOString() },
          expected: {
            kind: "commit",
            state: "open",
            fields: {
              dueAt: new Date(formalClock.now() + 60_000).toISOString(),
            },
          },
        },
      ],
      AbortSignal.timeout(10_000),
    );
    expect(checks.length).toBeGreaterThan(0);
    await workspace.activate(
      {
        versionId: formalVersion.id,
        compositionRevision: workspace.composition().revision,
        operationId: crypto.randomUUID(),
      },
      () => undefined,
    );
    const evolution = new Evolution(
      workspace.db,
      {
        async generate() {
          throw new Error("This lifecycle fixture never calls a model");
        },
      },
      new EvolutionDomain(workspace),
      sessions,
    );
    // Seed a verified, unapplied candidate; all session and business operations below use the real browser/control plane.
    const planDraft = {
      id: "schedule-plan",
      compositionRevision: workspace.composition().revision,
      baseVersion: formalVersion.id,
      route: { kind: "application" },
      summary: "调度候选",
      changes: [],
      outcome: "调度生命周期验证",
      dataImpact: "仅体验数据",
      requestRevision: 1,
      excluded: [],
      writableScope: [],
      dependencies: [],
      evidence: [],
      capabilityChanges: [],
      acceptance: [],
      workflowRules: [],
      cases: [],
      steps: [],
      unresolved: [],
    };
    const requirement = {
      id: "schedule-lifecycle-fixture",
      description: "体验调度候选",
      sourceRevision: "fixture:1",
      sourceQuote: "体验调度候选",
      type: "behavior" as const,
      checks: [{ checker: "schedule/1", caseId: "schedule/1:1" }],
      obligations: [
        {
          version: 1 as const,
          id: "fixture-schedule-backend",
          kind: "backend" as const,
          checks: [{ checker: "schedule/1", caseId: "schedule/1:1" }],
        },
      ],
    };
    const {admissionReceiptFixture} = await import("../app/planning-fixture.js");
    const requestAdmission=admissionReceiptFixture(capture(workspace),[{id:"fixture:1",text:requirement.sourceQuote}]);
    const planDefinition = {
      ...planDraft,
      requestAdmission,
      requirements: [requirement],
      browserCases: [],
      cases: [
        {
          given: "体验任务含未来截止",
          when: "退出体验或等待到期",
          then: "定时器按体验生命周期释放或触发",
          checker: "schedule/1",
        },
      ],
      binding: bindPlan({...planDraft, cases: [{given: "体验任务含未来截止", when: "退出体验或等待到期", then: "定时器按体验生命周期释放或触发", checker: "schedule/1"}]}, capture(workspace), []),
    };
    // This is an authored lifecycle fixture, not real-model semantic review.
    // It receives actual Chromium receipts instead of bypassing the new gate.
    const {compileSemantics} = await import("../../src/evolution/requirement-semantics.js");
    const semanticState=compileSemantics(planDefinition as import("../../src/shared/assistant.js").InvestigatedPlan,[{id:"fixture:1",text:requirement.sourceQuote}]);
    const specification = {
      ...planDefinition,
      semanticState,
      changeSpec: compileSpec(
        {...planDefinition,semanticState} as import("../../src/shared/assistant.js").InvestigatedPlan,
        "schedule-run",
        hash(formalVersion.source),
      ),
    };
    const plan = {
      ...specification,
      requirementGate: freezeRequirements(
        specification,
        [{ id: "fixture:1", text: requirement.sourceQuote }],
        hash(undefined),
        { reviewedIds: [requirement.id], issues: [] },
        ["schedule/1", "browser/1"],
      ),
    };
    workspace.db
      .prepare("INSERT INTO evolution_requirement_freezes VALUES(?,?)")
      .run(plan.id, JSON.stringify(plan.requirementGate));
    const browser = await verifyBrowser(
      workspace,
      hooked,
      formalVersion,
      [],
      plan.requirements,
      plan.requirementGate.definitionHash,
      new AbortController().signal,
    );
    const { id: _id, entry: _entry, createdAt: _time, ...artifact } = hooked;
    const verified = workspace.release.record({
      ...artifact,
      evidence: {
        ...(hooked.evidence as Record<string, unknown>),
        checks,
        requirements: plan.requirements,
        changeSpec: plan.changeSpec,
        browserCases: [],
        requirementGate: plan.requirementGate,
        browser,
        passed: true,
      },
    });
    const candidate = {
      id: "schedule-candidate",
      planId: plan.id,
      baseVersion: formalVersion.id,
      attempt: 1,
      passed: true,
      requirementSeal: plan.requirementGate.seal,
      browser,
      versionId: verified.id,
      sourceHash: "fixture",
    };
    const domain = new EvolutionDomain(workspace);
    const run = {
      id: "schedule-run",
      requestAdmissions: [requestAdmission],
      request: "体验调度候选",
      updatedAt: new Date().toISOString(),
      status: "awaiting-apply",
      plan,
      steps: [],
      summary: "候选已验证",
      versionId: verified.id,
    };
    workspace.db.prepare("INSERT INTO evolution_runs(id,body) VALUES(?,?)").run(
      run.id,
      JSON.stringify({
        run,
        plan,
        target: domain.target(plan),
        versionId: verified.id,
        history: [],
        calls: 0,
        candidates: 1,
        elapsed: 0,
      }),
    );
    workspace.db
      .prepare("INSERT INTO evolution_candidates(runId,body) VALUES(?,?)")
      .run(
        run.id,
        JSON.stringify({
          ...candidate,
          evidenceHash: candidateEvidenceHash(
            candidate,
            plan,
            domain.acceptanceEvidence(verified.id),
          ),
        }),
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
        throw new Error("Missing listener");
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page
        .getByRole("textbox", { name: "添加任务", exact: true })
        .fill("正式隔离任务");
      await page.getByRole("button", { name: "添加", exact: true }).click();
      await setDueViaUi(
        page,
        "正式隔离任务",
        new Date(formalClock.now() + 60_000).toISOString(),
      );
      const formalBefore = workspace.query();
      await page.getByRole("button", { name: "改进应用", exact: true }).click();
      await page.getByRole("button", { name: "体验", exact: true }).click();
      await expect(
        page.getByRole("status", { name: "候选体验提示" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "设截止", exact: true }).click();
      await page
        .getByLabel("截止", { exact: true })
        .fill(new Date(experienceClock.now() + 5000).toISOString());
      await page.getByRole("button", { name: "设截止", exact: true }).click();
      await expect.poll(() => pendingTimers).toBe(1);
      expect(firedTimers).toBe(0);
      const session = sessions.observe();
      if (session.status !== "active") throw new Error("Missing session");
      expect(sessions.readSnapshot(session.id).task.state).toBe("open");
      if (endBeforeFire) {
        await page
          .getByRole("button", { name: "结束体验", exact: true })
          .click();
        await expect.poll(() => sessions.observe().status).toBe("none");
        expect(pendingTimers).toBe(0);
      }
      await experienceClock.advance(6000);
      expect(firedTimers).toBe(endBeforeFire ? 0 : 1);
      if (!endBeforeFire) {
        expect(sessions.readSnapshot(session.id).task.state).toBe("done");
        await page.reload();
        await expect(
          page.getByRole("button", { name: "重新打开", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "结束体验", exact: true })
          .click();
      }
      expect(workspace.query()).toEqual(formalBefore);
      await formalClock.advance(60_000);
      await page.reload();
      await page.getByRole("button", { name: "已完成", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "编辑 正式隔离任务", exact: true }),
      ).toBeVisible();
    } finally {
      await page.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await evolution.close();
      await workspace.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
