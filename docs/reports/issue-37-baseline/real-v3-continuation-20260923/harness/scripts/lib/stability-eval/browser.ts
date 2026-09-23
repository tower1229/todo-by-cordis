import type { AssistantSnapshot } from "../../../src/shared/assistant.js";
import { Hono } from "hono";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  chromium,
  expect,
  type Browser,
  type Page,
  type Response,
} from "@playwright/test";
import { join } from "node:path";
import type { createApp } from "../../../src/server/app.js";
import type { CommandResult } from "../../../src/shared/contracts.js";
import type { StabilityScenario } from "./manifest.js";

export type ExperienceBindings = {
  tags?: {
    actionLabel: string;
    fieldLabel: string;
    fieldKey: string;
    inputKey: string;
    expected: string;
  };
  counter?: { actionLabel: string; fieldKey: string };
  reflection?: { fieldLabel: string };
};

export type BrowserPathResult = {
  status: "passed" | "blocked-observed" | "failed";
  viewport: { width: number; height: number };
  openedImprovePanel: boolean;
  resumedExistingCandidate?: boolean;
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

/** Drive real improve-panel → confirm → experience → apply → recovery entry. */
export async function runStabilityBrowserPath(input: {
  app: App;
  directory: string;
  scenario: StabilityScenario;
  clarificationAnswer?: string;
  bindings?: ExperienceBindings;
  resolveBindings?: () => Promise<ExperienceBindings | undefined>;
  configurePage?: (page: Page) => Promise<void>;
  resumeExistingCandidate?: boolean;
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
  let latestRun: AssistantSnapshot["run"] = null;
  const currentRunStatus = (): string | undefined => latestRun?.status;
  const updateRun = (run: AssistantSnapshot["run"]) => {
    if (run && (!latestRun || run.updatedAt >= latestRun.updatedAt))
      latestRun = run;
  };
  const throwIfRunFailed = () => {
    if (
      latestRun &&
      ["failed", "interrupted", "cancelled"].includes(latestRun.status)
    )
      throw new Error(
        "message" in latestRun ? latestRun.message : latestRun.status,
      );
  };
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
    page.on("response", async (response) => {
      if (
        !["/api/assistant", "/api/assistant/commands"].includes(
          new URL(response.url()).pathname,
        )
      )
        return;
      try {
        const snapshot = (await response.json()) as AssistantSnapshot;
        updateRun(snapshot.run);
      } catch {
        /* Connection may close during failure capture. */
      }
    });
    await input.configurePage?.(page);
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByRole("button", { name: "改进应用", exact: true }).click();
    result.openedImprovePanel = true;

    if (!input.resumeExistingCandidate) {
      const composer = page.getByRole("textbox", { name: "告诉 AI 你的需求" });
      await composer.fill(input.scenario.request);
      const submitted = await responseForAction(
        page,
        (response) =>
          new URL(response.url()).pathname === "/api/assistant/commands" &&
          response.request().method() === "POST",
        () => page!.getByRole("button", { name: "发送需求" }).click(),
      );
      updateRun(((await submitted.json()) as AssistantSnapshot).run);

      await expect
        .poll(
          async () =>
            !latestRun || latestRun.status === "planning"
              ? "waiting"
              : ["failed", "interrupted", "cancelled"].includes(
                    latestRun.status,
                  )
                ? "failed"
                : detectPlanningState(page!, latestRun.status),
          { timeout: 120_000 },
        )
        .not.toBe("waiting");

      throwIfRunFailed();
      if (await isBlocked(page))
        return await finishBlocked(page, result, screenshot, errors);

      if (
        currentRunStatus() === "awaiting-input" &&
        input.clarificationAnswer
      ) {
        await page
          .getByRole("textbox", { name: "告诉 AI 你的需求" })
          .fill(input.clarificationAnswer);
        const answered = await responseForAction(
          page,
          (response) =>
            new URL(response.url()).pathname === "/api/assistant/commands" &&
            response.request().method() === "POST",
          () => page!.getByRole("button", { name: "发送需求" }).click(),
        );
        updateRun(((await answered.json()) as AssistantSnapshot).run);
        await expect
          .poll(
            async () =>
              !latestRun || latestRun.status === "planning"
                ? "waiting"
                : ["failed", "interrupted", "cancelled"].includes(
                      latestRun.status,
                    )
                  ? "failed"
                  : detectPlanningState(page!, latestRun.status),
            { timeout: 120_000 },
          )
          .not.toBe("waiting");
      }

      throwIfRunFailed();
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

      await expect(
        page.getByRole("region", { name: "待确认方案" }),
      ).toBeVisible();
      result.confirmedPlan = true;
      await page.getByRole("button", { name: "开始执行", exact: true }).click();

      await expect
        .poll(
          async () =>
            latestRun &&
            ["failed", "interrupted", "cancelled"].includes(latestRun.status)
              ? "failed"
              : detectExecutionState(page!),
          { timeout: 180_000 },
        )
        .toMatch(/awaiting-apply|blocked|failed/);

      throwIfRunFailed();
      if (await isBlocked(page))
        return await finishBlocked(page, result, screenshot, errors);
    } else {
      result.resumedExistingCandidate = true;
      await expect(
        page.getByRole("button", { name: "体验", exact: true }),
      ).toBeVisible();
    }

    if (input.scenario.requiresExperience) {
      await page.getByRole("button", { name: "体验", exact: true }).click();
      await expect(
        page.getByRole("status", { name: "候选体验提示" }),
      ).toContainText("候选体验 · 测试数据 · 尚未应用");
      result.experienced = true;
      result.experienceActions = await exerciseExperience(
        page,
        input.bindings ?? (await input.resolveBindings?.()),
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
    return result;
  } finally {
    await browser?.close().catch(() => undefined);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

async function detectPlanningState(
  page: Page,
  status: string,
): Promise<string> {
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
    status === "awaiting-input" &&
    (await page
      .getByRole("textbox", { name: "告诉 AI 你的需求" })
      .isVisible()
      .catch(() => false))
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

/** Attach rejection handlers before either the click or response wait can fail. */
export async function responseForAction(
  page: Page,
  predicate: (response: Response) => boolean,
  action: () => Promise<unknown>,
  timeout = 30_000,
): Promise<Response> {
  const [response] = await Promise.all([
    page.waitForResponse(predicate, { timeout }),
    action(),
  ]);
  return response;
}

function actionButton(page: Page, label: string) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The host's contribution buttons append the synthetic task title to their accessible name.
  return page
    .getByRole("button", { name: new RegExp(`^${escaped}(?: 候选体验任务)?$`) })
    .first();
}

async function exerciseExperience(
  page: Page,
  bindings: ExperienceBindings | undefined,
): Promise<NonNullable<BrowserPathResult["experienceActions"]>> {
  const actions: NonNullable<BrowserPathResult["experienceActions"]> = {};
  const commandResponse = (r: Response) =>
    r.url().endsWith("/api/experience/commands") &&
    r.request().method() === "POST";
  if (bindings?.tags) {
    const form = await responseForAction(page, commandResponse, () =>
      actionButton(page, bindings.tags!.actionLabel).click(),
    );
    assert.equal(form.status(), 200);
    const receipt = (await form.json()) as CommandResult;
    assert.equal(receipt.decision?.kind, "input-required");
    const field = receipt.decision.fields.find(
      (f) => f.key === bindings.tags!.inputKey,
    );
    assert.ok(
      field,
      "Evaluator binding: frozen input field absent from actual form",
    );
    await page.getByLabel(field.label, { exact: true }).fill("  BrowserTag  ");
    const saved = await responseForAction(page, commandResponse, () =>
      actionButton(page, bindings.tags!.actionLabel).click(),
    );
    assert.equal(saved.status(), 200);
    const task = ((await saved.json()) as CommandResult).task!;
    assert.equal(task.fields[bindings.tags.fieldKey], bindings.tags.expected);
    actions.tagSet = task.fields[bindings.tags.fieldKey];
  }
  if (bindings?.counter) {
    const saved = await responseForAction(page, commandResponse, () =>
      actionButton(page, bindings.counter!.actionLabel).click(),
    );
    assert.equal(saved.status(), 200);
    const task = ((await saved.json()) as CommandResult).task!;
    assert.equal(Number(task.fields[bindings.counter.fieldKey]), 1);
    actions.counterValue = task.fields[bindings.counter.fieldKey];
  }
  const complete = page.getByRole("button", { name: "完成", exact: true });
  if (await complete.isVisible().catch(() => false)) {
    const matchesComplete = (r: Response) =>
      commandResponse(r) && r.request().postDataJSON()?.actionId === "complete";
    let receipt = (await (
      await responseForAction(page, matchesComplete, () => complete.click())
    ).json()) as CommandResult;
    if (receipt.decision?.kind === "input-required") {
      const label =
        bindings?.reflection?.fieldLabel ??
        receipt.decision.fields.find(
          (f) => /复盘|reflection/i.test(f.key) || /复盘/.test(f.label),
        )?.label;
      if (label) {
        await page.getByLabel(label, { exact: true }).fill("浏览器完成复盘");
        actions.reflectionSet = "浏览器完成复盘";
      }
      receipt = (await (
        await responseForAction(page, matchesComplete, () => complete.click())
      ).json()) as CommandResult;
    }
    assert.equal(receipt.decision?.kind, "commit");
    assert.equal(receipt.task?.state, "done");
    const reopen = page.getByRole("button", { name: "重新打开", exact: true });
    if (await reopen.isVisible().catch(() => false)) {
      const reopened = (await (
        await responseForAction(
          page,
          (r) =>
            commandResponse(r) &&
            r.request().postDataJSON()?.actionId === "reopen",
          () => reopen.click(),
        )
      ).json()) as CommandResult;
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
