import { test, expect } from "@playwright/test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STABILITY_EVAL_MANIFEST,
  freezeManifest,
} from "../../scripts/lib/stability-eval/manifest.js";
import { runStabilityScenario } from "../../scripts/lib/stability-eval/scenario.js";
import { computeStabilityMetrics } from "../../scripts/lib/stability-eval/metrics.js";
import type { ScenarioRunRecord } from "../../scripts/lib/stability-eval/metrics.js";

test.describe.configure({ mode: "serial" });

const records: ScenarioRunRecord[] = [];

for (const scenario of STABILITY_EVAL_MANIFEST.scenarios) {
  test(`稳定性基线桩层浏览器路径：${scenario.id}`, async () => {
    test.setTimeout(300_000);
    const directory = await mkdtemp(
      join(tmpdir(), `cordis-stability-${scenario.id}-`),
    );
    try {
      const manifest = freezeManifest(STABILITY_EVAL_MANIFEST);
      const result = await runStabilityScenario({
        directory,
        scenario,
        manifest,
        evidenceKind: "model-stub",
      });
      expect(result.record.evidenceKind).toBe("model-stub");
      expect(result.record.scenarioId).toBe(scenario.id);
      expect(
        result.record.observedOutcomeClass,
        (await readFile(result.eventsPath, "utf8"))
          .split("\n")
          .filter(
            (line) =>
              line.includes('"type":"settled"') ||
              line.includes('"type":"archive-error"'),
          )
          .join("\n"),
      ).toBe(scenario.expectedOutcomeClass);
      expect(result.record.fullPathSucceeded).toBe(
        scenario.expectedOutcomeClass === "full-path-success",
      );

      const events = await readFile(result.eventsPath, "utf8");
      expect(events).toContain('"evidenceKind":"model-stub"');
      expect(events).not.toMatch(/AIza[0-9A-Za-z_-]{20,}/);
      expect(events).not.toMatch(/GEMINI_API_KEY/);

      const settled = events
        .split("\n")
        .map((line) => {
          try {
            return JSON.parse(line) as {
              type?: string;
              browser?: {
                experienced?: boolean;
                applied?: boolean;
                recoveryEntryVisible?: boolean;
                experienceActions?: {
                  tagSet?: string;
                  counterValue?: string;
                  reflectionSet?: string;
                  completedAndReopened?: boolean;
                };
              };
              run?: { blockReason?: string; message?: string };
            };
          } catch {
            return null;
          }
        })
        .find((e) => e?.type === "settled");
      expect(settled?.browser?.recoveryEntryVisible).toBe(true);

      if (scenario.requiresExperience) {
        expect(settled?.browser?.experienced).toBe(true);
        const actions = settled?.browser?.experienceActions;
        if (scenario.id === "tags-add")
          expect(actions?.tagSet).toBe("BrowserTag");
        if (scenario.id === "member-upgrade-tags")
          expect(actions?.tagSet).toBe("browsertag");
        if (scenario.id === "counter-add")
          expect(Number(actions?.counterValue)).toBeGreaterThanOrEqual(1);
        if (scenario.id === "rule-revision-reflection") {
          expect(actions?.reflectionSet).toBeTruthy();
          expect(actions?.completedAndReopened).toBe(true);
        }
      }
      if (scenario.requiresApply) expect(settled?.browser?.applied).toBe(true);

      if (scenario.id === "temporarily-unavailable-dependency") {
        expect(
          `${settled?.run?.blockReason ?? ""} ${settled?.run?.message ?? ""}`,
        ).toMatch(/investigation|protection|依赖/);
      }

      records.push(result.record);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("七场景桩层指标汇总列出分母", () => {
  expect(records.length).toBe(STABILITY_EVAL_MANIFEST.scenarios.length);
  const metrics = computeStabilityMetrics(records);
  expect(metrics.fullPathSuccessRate.denominator).toBe(7);
  expect(
    metrics.capabilitySelectionAccuracy.denominator,
  ).toBeGreaterThanOrEqual(1);
  expect(records.every((r) => r.evidenceKind === "model-stub")).toBe(true);
  expect(
    records.filter((r) => r.observedOutcomeClass === "full-path-success")
      .length,
  ).toBe(
    STABILITY_EVAL_MANIFEST.scenarios.filter(
      (s) => s.expectedOutcomeClass === "full-path-success",
    ).length,
  );
});

test("真实浏览器绑定不依赖 stub 的成员、动作和字段名称", async () => {
  const { stabilityStubDriver } = await import(
    "../../scripts/lib/stability-eval/driver-fixture.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "cordis-renamed-binding-"));
  const original = stabilityStubDriver("tags-add");
  try {
    const result = await runStabilityScenario({
      directory,
      scenario: STABILITY_EVAL_MANIFEST.scenarios[0],
      manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
      evidenceKind: "model-stub",
      driver: {
        async generate(request, signal) {
          const reply = await original.generate(request, signal);
          return JSON.parse(
            JSON.stringify(reply)
              .replace(/\btags\b/g, "categorylabel")
              .replaceAll("setTags", "saveCategory")
              .replaceAll("设标签", "设置分类(+)")
              .replaceAll("标签", "分类"),
          ) as typeof reply;
        },
      },
    });
    expect(
      result.record.observedOutcomeClass,
      (await readFile(result.eventsPath, "utf8"))
        .split("\n")
        .filter((line) => line.includes('"type":"settled"'))
        .join("\n"),
    ).toBe("full-path-success");
    expect(result.record.capabilitySelectionCorrect).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("浏览器中途遇到模型传输失败仍归档完整调用和真实失败分类", async () => {
  const { stabilityStubDriver } = await import(
    "../../scripts/lib/stability-eval/driver-fixture.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "cordis-browser-transport-"));
  const original = stabilityStubDriver("tags-add");
  let calls = 0;
  try {
    const result = await runStabilityScenario({
      directory,
      scenario: STABILITY_EVAL_MANIFEST.scenarios[0],
      manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
      evidenceKind: "model-stub",
      driver: {
        async generate(request, signal) {
          if (++calls === 2)
            throw new Error("fetch failed: synthetic transport interruption");
          return original.generate(request, signal);
        },
      },
    });
    expect(result.record.failureClass).toBe("transport");
    expect(result.record.usage).toBeNull();
    expect(result.record.evidenceComplete).toBe(true);
    const events = (await readFile(result.eventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.find((event) => event.type === "settled").browser
        .openedImprovePanel,
    ).toBe(true);
    expect(events.find((event) => event.type === "calls").count).toBe(2);
    expect(
      events.find((event) => event.type === "calls").samples.at(-1).status,
    ).toBe("failed");
    expect(
      await readFile(join(directory, "workspace-evidence.json"), "utf8"),
    ).toContain("synthetic transport interruption");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("慢规划与延迟发送响应不会把旧输入界面误判为方案已就绪", async () => {
  const { stabilityStubDriver } = await import(
    "../../scripts/lib/stability-eval/driver-fixture.js"
  );
  const { runStabilityBrowserPath } = await import(
    "../../scripts/lib/stability-eval/browser.js"
  );
  const directory = await mkdtemp(join(tmpdir(), "cordis-slow-planning-"));
  const original = stabilityStubDriver("member-upgrade-tags");
  let calls = 0;
  try {
    const scenario = STABILITY_EVAL_MANIFEST.scenarios.find(
      (s) => s.id === "member-upgrade-tags",
    )!;
    const result = await runStabilityScenario({
      directory,
      scenario,
      manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
      evidenceKind: "model-stub",
      driver: {
        async generate(request, signal) {
          if (++calls === 2)
            await new Promise((resolve) => setTimeout(resolve, 6500));
          return original.generate(request, signal);
        },
      },
      browserRun: (input) =>
        runStabilityBrowserPath({
          ...input,
          configurePage: async (page) => {
            await page.route("**/api/assistant/commands", async (route) => {
              if (route.request().postDataJSON()?.type === "request")
                await new Promise((resolve) => setTimeout(resolve, 1000));
              await route.continue();
            });
          },
        }),
    });
    expect(result.record.observedOutcomeClass).toBe("full-path-success");
    expect(result.record.evidenceComplete).toBe(true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("响应先超时、点击仍等待时也应捕获失败", async ({ page }) => {
  const { responseForAction } = await import(
    "../../scripts/lib/stability-eval/browser.js"
  );
  await expect(
    responseForAction(
      page,
      () => false,
      () => new Promise((resolve) => setTimeout(resolve, 100)),
      30,
    ),
  ).rejects.toThrow(/Timeout/);
});
