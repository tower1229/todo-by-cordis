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
      expect(result.record.observedOutcomeClass).toBe(
        scenario.expectedOutcomeClass,
      );
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
