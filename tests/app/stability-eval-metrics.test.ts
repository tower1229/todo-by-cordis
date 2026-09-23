import test from "node:test";
import assert from "node:assert/strict";
import {
  computeStabilityMetrics,
  classifyFailure,
  type ScenarioRunRecord,
} from "../../scripts/lib/stability-eval/metrics.js";

const base = (
  partial: Partial<ScenarioRunRecord> & Pick<ScenarioRunRecord, "scenarioId">,
): ScenarioRunRecord => ({
  evidenceKind: "model-stub",
  expectedOutcomeClass: "full-path-success",
  observedOutcomeClass: "full-path-success",
  capabilitySelectionCorrect: true,
  errorBlockingCorrect: null,
  firstPlanPassed: true,
  firstCandidatePassed: true,
  fullPathSucceeded: true,
  repairedInOriginalBudget: false,
  durationMs: 1000,
  usage: { promptTokens: 10, completionTokens: 5 },
  failureClass: null,
  ...partial,
});

test("指标列出分母并区分能力选择、错误阻塞、首个计划/候选、完整路径与预算内纠错", () => {
  const metrics = computeStabilityMetrics([
    base({ scenarioId: "tags-add" }),
    base({
      scenarioId: "counter-add",
      firstCandidatePassed: false,
      repairedInOriginalBudget: true,
      fullPathSucceeded: true,
    }),
    base({
      scenarioId: "due-auto-expire",
      expectedOutcomeClass: "current-blocker",
      observedOutcomeClass: "current-blocker",
      capabilitySelectionCorrect: false,
      errorBlockingCorrect: true,
      firstPlanPassed: false,
      firstCandidatePassed: null,
      fullPathSucceeded: false,
      failureClass: "documentation-gap",
    }),
    base({
      scenarioId: "missing-capability-push",
      expectedOutcomeClass: "accurate-block",
      observedOutcomeClass: "accurate-block",
      capabilitySelectionCorrect: true,
      errorBlockingCorrect: true,
      firstPlanPassed: false,
      firstCandidatePassed: null,
      fullPathSucceeded: false,
      failureClass: null,
    }),
    base({
      scenarioId: "transport-fail",
      expectedOutcomeClass: "full-path-success",
      observedOutcomeClass: "failed",
      capabilitySelectionCorrect: null,
      errorBlockingCorrect: null,
      firstPlanPassed: null,
      firstCandidatePassed: null,
      fullPathSucceeded: false,
      failureClass: "transport",
      usage: null,
    }),
  ]);

  assert.equal(metrics.capabilitySelectionAccuracy.numerator, 3);
  assert.equal(metrics.capabilitySelectionAccuracy.denominator, 4);
  assert.equal(metrics.errorBlockingAccuracy.numerator, 2);
  assert.equal(metrics.errorBlockingAccuracy.denominator, 2);
  assert.equal(metrics.firstPlanPassRate.numerator, 2);
  assert.equal(metrics.firstPlanPassRate.denominator, 4);
  assert.equal(metrics.firstCandidatePassRate.numerator, 1);
  assert.equal(metrics.firstCandidatePassRate.denominator, 2);
  assert.equal(metrics.fullPathSuccessRate.numerator, 2);
  assert.equal(metrics.fullPathSuccessRate.denominator, 5);
  assert.equal(metrics.inBudgetRepairRate.numerator, 1);
  assert.equal(metrics.inBudgetRepairRate.denominator, 1);
  assert.equal(metrics.durationMs.total, 5000);
  assert.equal(metrics.costUsage.promptTokens, 40);
  assert.equal(metrics.costUsage.completionTokens, 20);
  assert.deepEqual(metrics.failureClassCounts, {
    "model-understanding-or-generation": 0,
    "documentation-gap": 1,
    "host-defect": 0,
    "tool-protocol": 0,
    transport: 1,
    evaluator: 0,
  });
});

test("恢复浏览器的耗时不能混入完整场景耗时统计", () => {
  const metrics = computeStabilityMetrics([
    base({ scenarioId: "fresh" }),
    base({
      scenarioId: "recovered",
      durationScope: "recovery-only",
      durationMs: 123,
      fullPathSucceeded: false,
      recoveredBrowserSucceeded: true,
      observedOutcomeClass: "failed",
      failureClass: "evaluator",
    }),
  ]);
  assert.deepEqual(metrics.durationMs, { total: 1000, samples: 1 });
  assert.equal(metrics.fullPathSuccessRate.numerator, 1);
  assert.equal(metrics.failureClassCounts.evaluator, 1);
});

test("无法唯一定位注册 UI 时归类评估器错误", () => {
  assert.equal(
    classifyFailure({
      message: "locator.click: strict mode violation: resolved to 2 elements",
    }),
    "evaluator",
  );
  assert.equal(
    classifyFailure({ message: "locator.click: Timeout 30000ms exceeded" }),
    "evaluator",
  );
});
