import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runV1Acceptance } from "../../scripts/lib/v1-scenario.js";
import { v1Browser } from "../../scripts/lib/v1-browser.js";
import { v1FixtureDriver } from "../app/v1-driver-fixture.js";

test("首版六步桩层真实浏览器体验与独立应用", async ({}, info) => {
  test.setTimeout(120_000);
  const directory = await mkdtemp(join(tmpdir(), "cordis-v1-browser-"));
  try {
    const result = await runV1Acceptance({
      directory,
      driver: v1FixtureDriver(),
      mode: "deterministic-full-six-step",
      record: () => undefined,
      browser: v1Browser(info.outputDir),
    });
    expect(result.status).toBe("passed");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
