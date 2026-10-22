import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { Workspace } from "../../src/server/workspace.js";
import { verifyBrowser } from "../../src/server/browser-acceptance.js";
import { hash } from "../../src/release/storage.js";
import { activateWorkflowOnly } from "./dual-composition-fixture.js";

test("浏览器验收不能在页面请求仍处于既有期限内时提前判失败", { timeout: 120_000 }, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "browser-request-deadline-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  await activateWorkflowOnly(workspace);
  const base = workspace.activeVersion();
  const formal = { tasks: workspace.query(), composition: workspace.composition() };
  let delayedResponses = 0;
  const launch = chromium.launch.bind(chromium);
  t.mock.method(chromium, "launch", async (...options: Parameters<typeof chromium.launch>) => {
    const browser = await launch(...options);
    const newContext = browser.newContext.bind(browser);
    t.mock.method(browser, "newContext", async (...options: Parameters<typeof browser.newContext>) => {
      const context = await newContext(...options);
      const newPage = context.newPage.bind(context);
      t.mock.method(context, "newPage", async () => {
        const page = await newPage();
        let created = false, delayed = false;
        page.on("response", (response) => {
          if (new URL(response.url()).pathname !== "/api/commands" || response.request().method() !== "POST") return;
          const body = response.request().postDataJSON() as { type?: string; title?: string };
          if (body.type === "create" && body.title?.startsWith("候选应用后新任务")) created = true;
        });
        await page.route("**/api/tasks?**", async (route) => {
          const response = await route.fetch();
          if (created && !delayed) {
            delayed = true;
            delayedResponses++;
            await new Promise((resolve) => setTimeout(resolve, 6500));
          }
          await route.fulfill({ response }).catch(() => undefined);
        });
        return page;
      });
      return context;
    });
    return browser;
  });
  const evidence = await verifyBrowser(workspace, base, base, [], [], hash([]), new AbortController().signal);
  assert.equal(delayedResponses, 2, "两个默认视口均须经过真实页面请求延迟");
  assert.equal(evidence.results.length, 4);
  assert.ok(evidence.results.every((result) => result.status === "passed"));
  assert.deepEqual({ tasks: workspace.query(), composition: workspace.composition() }, formal);
});
