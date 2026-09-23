import { Hono } from "hono";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { join } from "node:path";
import type { createApp } from "../../../src/server/app.js";
import type { CommandResult } from "../../../src/shared/contracts.js";
import type { StabilityScenario } from "./manifest.js";

export type ExperienceBindings = {
  tags?: { actionLabel: string; fieldLabel: string; expected: string };
  counter?: { actionLabel: string; fieldKey: string };
  reflection?: { fieldLabel: string };
};

export type BrowserPathResult = {
  status: "passed" | "blocked-observed" | "failed";
  viewport: { width: number; height: number };
  openedImprovePanel: boolean;
  confirmedPlan?: boolean;
  confirmedAcceptance?: boolean;
  experienced?: boolean;
  experienceActions?: {
    tagSet?: string;
    counterValue?: string;
    reflectionSet?: string;
    completedAndReopened?: boolean;
  };
  applied?: boolean;
  recoveryEntryVisible: boolean;
  screenshot: string;
  pageErrors: string[];
  observedRunStatus?: string;
  message?: string;
};

type App = ReturnType<typeof createApp>;

/** Static experience bindings per frozen scenario id (stub and real share the same UI path). */
export function experienceBindingsFor(
  scenarioId: string,
): ExperienceBindings | undefined {
  switch (scenarioId) {
    case "tags-add":
      return {
        tags: {
          actionLabel: "设标签",
          fieldLabel: "标签",
          expected: "BrowserTag",
        },
      };
    case "member-upgrade-tags":
      return {
        tags: {
          actionLabel: "设标签",
          fieldLabel: "标签",
          expected: "browsertag",
        },
      };
    case "counter-add":
      return { counter: { actionLabel: "加一", fieldKey: "count" } };
    case "rule-revision-reflection":
      return { reflection: { fieldLabel: "复盘" } };
    default:
      return undefined;
  }
}

/** Drive real improve-panel → confirm → experience → apply → recovery entry. */
export async function runStabilityBrowserPath(input: {
  app: App;
  directory: string;
  scenario: StabilityScenario;
  clarificationAnswer?: string;
  bindings?: ExperienceBindings;
}): Promise<BrowserPathResult> {
  const browserApp = new Hono().route("/", input.app);
  browserApp.use("/*", serveStatic({ root: "./dist/web" }));
  browserApp.get("*", serveStatic({ path: "./dist/web/index.html" }));
  const server = serve({
    fetch: browserApp.fetch,
    hostname: "127.0.0.1",
    port: 0,
  });
  let browser: Browser | undefined;
  let page: Page | undefined;
  const errors: string[] = [];
  const screenshot = join(input.directory, `browser-${input.scenario.id}.png`);
  const result: BrowserPathResult = {
    status: "failed",
    viewport: { width: 390, height: 844 },
    openedImprovePanel: false,
    recoveryEntryVisible: false,
    screenshot,
    pageErrors: errors,
  };
  try {
    if (!server.listening)
      await new Promise<void>((resolve, reject) => {
        server.once("listening", resolve);
        server.once("error", reject);
      });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: result.viewport });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    result.openedImprovePanel = true;

    const composer = page.getByRole("textbox", { name: "告诉 AI 你的需求" });
    await composer.fill(input.scenario.request);
    await page.getByRole("button", { name: "发送需求" }).click();

    await expect
      .poll(async () => detectPlanningState(page!), { timeout: 120_000 })
      .not.toBe("waiting");

    if (await isBlocked(page))
      return await finishBlocked(page, result, screenshot, errors);

    if (
      (await page.getByText(/\?|？/).first().isVisible().catch(() => false)) &&
      input.clarificationAnswer
    ) {
      await page
        .getByRole("textbox", { name: "告诉 AI 你的需求" })
        .fill(input.clarificationAnswer);
      await page.getByRole("button", { name: "发送需求" }).click();
      await expect
        .poll(async () => detectPlanningState(page!), { timeout: 120_000 })
        .not.toBe("waiting");
    }

    if (await isBlocked(page))
      return await finishBlocked(page, result, screenshot, errors);

    const confirmAcceptance = page.getByRole("button", {
      name: "确认业务验收修订",
      exact: true,
    });
    if (await confirmAcceptance.isVisible().catch(() => false)) {
      await confirmAcceptance.click();
      result.confirmedAcceptance = true;
      await expect(
        page.getByRole("button", { name: "开始执行", exact: true }),
      ).toBeVisible({ timeout: 120_000 });
    }

    await expect(page.getByRole("region", { name: "待确认方案" })).toBeVisible();
    result.confirmedPlan = true;
    await page.getByRole("button", { name: "开始执行", exact: true }).click();

    await expect
      .poll(async () => detectExecutionState(page!), { timeout: 180_000 })
      .toMatch(/awaiting-apply|blocked|failed/);

    if (await isBlocked(page))
      return await finishBlocked(page, result, screenshot, errors);

    if (input.scenario.requiresExperience) {
      await page.getByRole("button", { name: "体验", exact: true }).click();
      await expect(
        page.getByRole("status", { name: "候选体验提示" }),
      ).toContainText("候选体验 · 测试数据 · 尚未应用");
      result.experienced = true;
      result.experienceActions = await exerciseExperience(
        page,
        input.bindings ?? experienceBindingsFor(input.scenario.id),
      );
      await page.getByRole("button", { name: "结束体验", exact: true }).click();
      await page.getByRole("button", { name: "改进应用", exact: true }).click();
    }

    if (input.scenario.requiresApply) {
      await page.getByRole("button", { name: "应用", exact: true }).click();
      await expect
        .poll(
          async () =>
            page!
              .getByText(/已发布版本|候选已正式应用|已成功/)
              .first()
              .isVisible()
              .catch(() => false),
          { timeout: 60_000 },
        )
        .toBe(true);
      result.applied = true;
      result.observedRunStatus = "succeeded";
    }

    await openRecoveryEntry(page, result);
    await page.screenshot({ path: screenshot, fullPage: true });
    assert.deepEqual(errors, []);
    result.status = "passed";
    return result;
  } catch (error) {
    result.message = error instanceof Error ? error.message : String(error);
    await page
      ?.screenshot({ path: screenshot, fullPage: true })
      .catch(() => undefined);
    throw error;
  } finally {
    await browser?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function detectPlanningState(page: Page): Promise<string> {
  if (await isBlocked(page)) return "blocked";
  if (
    await page
      .getByRole("region", { name: "待确认方案" })
      .isVisible()
      .catch(() => false)
  )
    return "ready";
  if (
    await page
      .getByRole("button", { name: "确认业务验收修订", exact: true })
      .isVisible()
      .catch(() => false)
  )
    return "awaiting-acceptance";
  if (
    (await page
      .getByRole("textbox", { name: "告诉 AI 你的需求" })
      .isVisible()
      .catch(() => false)) &&
    (await page.getByText(/\?|？/).first().isVisible().catch(() => false))
  )
    return "awaiting-input";
  return "waiting";
}

async function detectExecutionState(page: Page): Promise<string> {
  if (
    await page
      .getByRole("button", { name: "体验", exact: true })
      .isVisible()
      .catch(() => false)
  )
    return "awaiting-apply";
  if (await isBlocked(page)) return "blocked";
  if (
    await page
      .getByRole("status")
      .filter({ hasText: /失败|已取消|中断/ })
      .isVisible()
      .catch(() => false)
  )
    return "failed";
  return "executing";
}

async function isBlocked(page: Page): Promise<boolean> {
  return page
    .getByRole("region", { name: "无法开始" })
    .isVisible()
    .catch(() => false);
}

async function finishBlocked(
  page: Page,
  result: BrowserPathResult,
  screenshot: string,
  errors: string[],
): Promise<BrowserPathResult> {
  result.observedRunStatus = "blocked";
  result.status = "blocked-observed";
  await openRecoveryEntry(page, result);
  await page.screenshot({ path: screenshot, fullPage: true });
  assert.deepEqual(errors, []);
  return result;
}

async function exerciseExperience(
  page: Page,
  bindings: ExperienceBindings | undefined,
): Promise<NonNullable<BrowserPathResult["experienceActions"]>> {
  const actions: NonNullable<BrowserPathResult["experienceActions"]> = {};
  if (bindings?.tags) {
    const formPending = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/experience/commands") &&
        r.request().method() === "POST" &&
        !r.request().postDataJSON()?.input,
    );
    await page
      .getByRole("button", { name: new RegExp(`^${bindings.tags.actionLabel}`) })
      .first()
      .click();
    const form = await formPending;
    assert.equal(form.status(), 200);
    const receipt = (await form.json()) as CommandResult;
    assert.equal(receipt.decision?.kind, "input-required");
    await page
      .getByLabel(bindings.tags.fieldLabel, { exact: true })
      .fill("  BrowserTag  ");
    const label = bindings.tags.actionLabel;
    const savedPending = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/experience/commands") &&
        Boolean(r.request().postDataJSON()?.input),
    );
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).first().click();
    const saved = await savedPending;
    assert.equal(saved.status(), 200);
    const task = ((await saved.json()) as CommandResult).task!;
    const field =
      Object.entries(task.fields).find(
        ([, value]) => value === bindings.tags!.expected,
      )?.[0] ??
      Object.keys(task.fields).find((key) => /tag/i.test(key));
    assert.ok(field, "体验须写出标签字段");
    assert.equal(task.fields[field], bindings.tags.expected);
    actions.tagSet = task.fields[field];
  }

  if (bindings?.counter) {
    const pending = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/experience/commands") &&
        r.request().method() === "POST",
    );
    await page
      .getByRole("button", {
        name: new RegExp(`^${bindings.counter.actionLabel}`),
      })
      .first()
      .click();
    const saved = await pending;
    assert.equal(saved.status(), 200);
    const task = ((await saved.json()) as CommandResult).task!;
    const value =
      task.fields[bindings.counter.fieldKey] ?? task.fields.count ?? "";
    assert.ok(value, "体验须写出计数字段");
    assert.equal(Number(value) >= 1, true, `计数应至少为 1，实际 ${value}`);
    actions.counterValue = String(value);
  }

  const complete = page.getByRole("button", { name: "完成", exact: true });
  if (await complete.isVisible().catch(() => false)) {
    let pending = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/experience/commands") &&
        r.request().postDataJSON()?.actionId === "complete",
    );
    await complete.click();
    let receipt = (await (await pending).json()) as CommandResult;
    if (receipt.decision?.kind === "input-required") {
      const reflectionLabel =
        bindings?.reflection?.fieldLabel ??
        receipt.decision.fields.find(
          (f) => /复盘|reflection/i.test(f.key) || /复盘/.test(f.label),
        )?.label;
      if (reflectionLabel) {
        await page
          .getByLabel(reflectionLabel, { exact: true })
          .fill("浏览器完成复盘");
        actions.reflectionSet = "浏览器完成复盘";
      }
      pending = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/experience/commands") &&
          r.request().postDataJSON()?.actionId === "complete",
      );
      await page.getByRole("button", { name: "完成", exact: true }).click();
      receipt = (await (await pending).json()) as CommandResult;
    }
    assert.equal(receipt.decision?.kind, "commit");
    assert.equal(receipt.task?.state, "done");
    const reopen = page.getByRole("button", { name: "重新打开", exact: true });
    if (await reopen.isVisible().catch(() => false)) {
      pending = page.waitForResponse(
        (r) =>
          r.url().endsWith("/api/experience/commands") &&
          r.request().postDataJSON()?.actionId === "reopen",
      );
      await reopen.click();
      const reopened = (await (await pending).json()) as CommandResult;
      assert.equal(reopened.decision?.kind, "commit");
      assert.equal(reopened.task?.state, "open");
      actions.completedAndReopened = true;
    }
  }

  return actions;
}

async function openRecoveryEntry(
  page: Page,
  result: BrowserPathResult,
): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await page.getByRole("menuitem", { name: "工作区设置" }).click();
  await expect(
    page.getByText(/撤回上个版本|版本记录|恢复此版本/).first(),
  ).toBeVisible({ timeout: 10_000 });
  result.recoveryEntryVisible = true;
  await page
    .getByRole("button", { name: "关闭工作区设置", exact: true })
    .click()
    .catch(() => undefined);
}
