import { Hono } from "hono";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { join } from "node:path";
import type { V1Options } from "./v1-scenario.js";
import type { CommandResult } from "../../src/shared/contracts.js";

/** Real page, real session API; only synthetic data is captured. */
export function v1Browser(
  directory: string,
): NonNullable<V1Options["browser"]> {
  return async (app, phase, session, bindings) => {
    const browserApp = new Hono().route("/", app);
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
    const path = join(directory, `phase-${phase}-browser.png`);
    try {
      if (!server.listening)
        await new Promise<void>((resolve, reject) => {
          server.once("listening", resolve);
          server.once("error", reject);
        });
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      browser = await chromium.launch();
      page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${address.port}`);
      await page.getByRole("button", { name: "改进应用", exact: true }).click();
      await page.getByRole("button", { name: "体验", exact: true }).click();
      const banner = page.getByRole("status", { name: "候选体验提示" });
      await expect(banner).toContainText("候选体验 · 测试数据 · 尚未应用");
      await page.reload();
      await expect(banner).toBeVisible();
      async function clickAction(id: string) {
        const action = session.composition.workflow.actions.find((item) => item.id === id);
        assert.ok(action, `候选界面缺少动作 ${id}`);
        const contribution = session.composition.uiContributions.flatMap((item) => item.actions)
          .find((item) => item.commandId === id);
        const name = contribution ? `${contribution.label} ${session.task.title}` : action.label;
        await page!.getByRole("button", { name, exact: true }).click();
        return contribution?.label ?? action.label;
      }
      if (bindings.tags && phase !== 4) {
        const formResponse = page.waitForResponse((r) =>
          r.url().endsWith("/api/experience/commands") &&
          r.request().postDataJSON().actionId === bindings.tags!.action);
        const label = await clickAction(bindings.tags.action);
        const form = await formResponse;
        assert.equal(form.status(), 200);
        const receipt = await form.json() as CommandResult;
        assert.equal(receipt.decision?.kind, "input-required");
        assert.ok(receipt.decision?.kind === "input-required");
        const field = receipt.decision.fields.find((item) => item.key === bindings.tags!.field);
        assert.ok(field, "标签动作须通过 input-required 返回冻结输入字段");
        await page.getByLabel(field.label, { exact: true }).fill("  BrowserTag  ");
        const response = page.waitForResponse((r) => r.url().endsWith("/api/experience/commands") && r.request().postDataJSON().input);
        await page.getByRole("button", { name: label, exact: true }).click();
        const saved = await response;
        assert.equal(saved.status(), 200);
        assert.equal((await saved.json()).task.fields[bindings.tags.field], phase >= 2 ? "browsertag" : "BrowserTag");
      }
      if (bindings.counter) {
        const response = page.waitForResponse((r) => r.url().endsWith("/api/experience/commands") && r.request().postDataJSON().actionId === bindings.counter!.action);
        await clickAction(bindings.counter.action);
        const saved = await response;
        assert.equal(saved.status(), 200);
        assert.equal((await saved.json()).task.fields[bindings.counter.field], String(Number(session.task.fields[bindings.counter.field] ?? "0") + 1));
      }
      const complete = session.composition.workflow.actions.find((action) => action.id === "complete");
      const reopen = session.composition.workflow.actions.find((action) => action.id === "reopen");
      assert.ok(complete && reopen);
      await page.getByRole("button", { name: complete.label, exact: true }).click();
      if (phase >= 3) {
        const reflection = session.composition.retainedFields.find(
          (field) => session.task.fields[field.key] === "完成复盘",
        );
        assert.ok(reflection, "候选体验须保留复盘字段");
        await page.getByLabel(reflection.label, { exact: true }).fill("浏览器完成复盘");
        await page.getByRole("button", { name: complete.label, exact: true }).click();
      }
      await page.getByRole("button", { name: reopen.label, exact: true }).click();
      await expect(page.getByRole("button", { name: complete.label, exact: true })).toBeVisible();
      await page.screenshot({ path, fullPage: true });
      await page.getByLabel("备注", { exact: true }).fill("浏览器隔离写入");
      const [saved] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url().endsWith("/api/experience/commands") &&
            response.request().method() === "POST",
        ),
        page.getByRole("button", { name: "保存", exact: true }).click(),
      ]);
      assert.equal(saved.status(), 200);
      const receipt = await saved.json();
      assert.equal(receipt.task.id, session.taskId);
      assert.equal(receipt.task.description, "浏览器隔离写入");
      assert.deepEqual(errors, []);
      return {
        status: "passed",
        viewport: { width: 390, height: 844 },
        refresh: true,
        completedAndReopened: true,
        tagInput: Boolean(bindings.tags && phase !== 4),
        counterAction: Boolean(bindings.counter),
        reflectionInput: phase >= 3,
        editedSyntheticTask: session.taskId,
        screenshot: path,
        pageErrors: errors,
      };
    } catch (error) {
      await page?.screenshot({ path, fullPage: true }).catch(() => undefined);
      throw error;
    } finally {
      await browser?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  };
}
