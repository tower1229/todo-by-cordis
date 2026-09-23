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

async function clockNow(
  request: import("@playwright/test").APIRequestContext,
) {
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
  await page.getByRole("textbox", { name: "添加任务", exact: true }).fill(title);
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

test("cleared due does not fire after clock advance", async ({
  page,
  request,
}) => {
  await activateHooked(request);
  await page.goto("/");
  const title = "清除截止不触发";
  await page.getByRole("textbox", { name: "添加任务", exact: true }).fill(title);
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
  expect(open.tasks.some((t: { title: string }) => t.title === title)).toBeTruthy();
});

test("short controllable schedule still lands as task fact in browser", async ({
  page,
  request,
}) => {
  await activateHooked(request);
  await page.goto("/");
  const title = "短延时回归";
  await page.getByRole("textbox", { name: "添加任务", exact: true }).fill(title);
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
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/hooked-plugin.mjs"),
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

test("experience end releases schedule without touching formal tasks", async ({
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
  const { createControllableClock } = await import(
    "../../src/server/host/clock.js"
  );
  const { hookedDefinition } = await import("../fixtures/hooked.js");

  const directory = await mkdtemp(join(tmpdir(), "cordis-sched-iso-e2e-"));
  const code = await readFile(
    join(dirname(fileURLToPath(import.meta.url)), "../fixtures/hooked-plugin.mjs"),
    "utf8",
  );
  const formalClock = createControllableClock(
    Date.parse("2026-09-22T12:00:00.000Z"),
  );
  const workspace = await Workspace.open(join(directory, "workspace.db"), {
    clock: formalClock,
  });
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
  const formal = await workspace.command({
    type: "create",
    title: "正式隔离任务",
    compositionRevision: workspace.composition().revision,
    operationId: crypto.randomUUID(),
  });
  await workspace.command({
    type: "action",
    taskId: formal.task!.id,
    actionId: "setDue",
    expectedRevision: formal.task!.revision,
    input: { dueAt: new Date(formalClock.now() + 60_000).toISOString() },
    compositionRevision: workspace.composition().revision,
    operationId: crypto.randomUUID(),
  });

  const snapshot = await sessions.start({
    runId: "iso-e2e",
    candidateId: "candidate",
    versionId: hooked.id,
    evidenceHash: "test",
    compositionRevision: workspace.composition().revision,
  });
  const expTask = sessions.workspaceFor(snapshot.id).read(snapshot.taskId);
  await sessions.command(snapshot.id, {
    type: "action",
    taskId: expTask.id,
    actionId: "setDue",
    expectedRevision: expTask.revision,
    input: { dueAt: new Date(Date.now() + 80).toISOString() },
    operationId: crypto.randomUUID(),
  });
  await page.waitForTimeout(160);
  expect(sessions.workspaceFor(snapshot.id).read(snapshot.taskId).state).toBe(
    "done",
  );
  expect(workspace.read(formal.task!.id).state).toBe("open");
  await sessions.end(snapshot.id);
  expect(workspace.read(formal.task!.id).state).toBe("open");

  const app = createApp(workspace, undefined, sessions, {
    testClock: formalClock,
  });
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
    await expect(
      page.getByRole("button", { name: "编辑 正式隔离任务", exact: true }),
    ).toBeVisible();
    await formalClock.advance(60_000);
    await page.getByRole("button", { name: "已完成", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "编辑 正式隔离任务", exact: true }),
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
