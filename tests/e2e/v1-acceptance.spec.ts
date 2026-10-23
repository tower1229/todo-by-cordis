import { test, expect } from "@playwright/test";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runV1Acceptance } from "../../scripts/lib/v1-scenario.js";
import { v1Browser } from "../../scripts/lib/v1-browser.js";
import { v1FixtureDriver } from "../app/v1-driver-fixture.js";

for (const [declareTagField, optionalCompletionField] of [[true, false], [false, false], [true, true]])
test(`首版六步桩层真实浏览器体验与独立应用：${declareTagField ? "登记字段" : "动作动态输入字段"} · 可选完成字段=${optionalCompletionField}`, async ({}, info) => {
  // Six independent runs retain their existing ten-minute host budgets.
  test.setTimeout(6 * 600_000 + 60_000);
  const directory = await mkdtemp(join(tmpdir(), "cordis-v1-browser-"));
  let passed = false;
  try {
    const result = await runV1Acceptance({
      directory,
      driver: v1FixtureDriver(false, declareTagField, optionalCompletionField),
      mode: "deterministic-full-six-step",
      record: (event) => appendFileSync(join(directory, "events.jsonl"), JSON.stringify(event) + "\n"),
      browser: v1Browser(info.outputDir),
    });
    expect(result.status).toBe("passed");
    passed = true;
  } catch (error) {
    const preserved = info.outputPath("workspace-evidence");
    try {
      await cp(directory, preserved, { recursive: true });
      await info.attach("preserved-workspace", {
        body: JSON.stringify({ original: directory, copy: preserved }),
        contentType: "application/json",
      });
    } catch (preservationError) {
      console.error("保留六步验收现场失败，原临时目录仍保留：", directory, preservationError);
    }
    throw error;
  } finally {
    if (passed) await rm(directory, { recursive: true, force: true });
  }
});
