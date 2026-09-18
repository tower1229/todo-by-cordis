import { Hono } from "hono";
import assert from "node:assert/strict";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import { join } from "node:path";
import type { V1Options } from "./v1-scenario.js";

/** Real page, real session API; only synthetic data is captured. */
export function v1Browser(
  directory: string,
): NonNullable<V1Options["browser"]> {
  return async (app, phase, session) => {
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
