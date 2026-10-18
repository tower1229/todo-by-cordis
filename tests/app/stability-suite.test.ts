import test from "node:test";
import assert from "node:assert/strict";
import {
  freezeManifest,
  STABILITY_EVAL_MANIFEST,
} from "../../scripts/lib/stability-eval/manifest.js";
import { evaluateSuite } from "../../scripts/lib/stability-eval/report.js";
import type { ScenarioRunRecord } from "../../scripts/lib/stability-eval/metrics.js";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";
import { pendingOracle } from "../../scripts/lib/stability-eval/oracle.js";

const manifest = freezeManifest({
  ...STABILITY_EVAL_MANIFEST,
  scenarios: [STABILITY_EVAL_MANIFEST.scenarios[0]],
});

const record: ScenarioRunRecord = {
  trialId: "tags-add-r1",
  scenarioId: "tags-add",
  evidenceKind: "model-stub",
  evidenceComplete: true,
  expectedOutcomeClass: "full-path-success",
  observedOutcomeClass: "full-path-success",
  capabilitySelectionCorrect: true,
  errorBlockingCorrect: null,
  firstPlanPassed: true,
  firstCandidatePassed: true,
  candidatePassed: true,
  fullPathSucceeded: true,
  repairedInOriginalBudget: false,
  durationMs: 1,
  usage: null,
  failureClass: null,
  resources: {
    calls: 4,
    recordedCalls: 4,
    candidates: 1,
    activeMilliseconds: 1000,
  },
};

test("伪造通过、遗漏断言和旧定义证据不能满足当前版本达标条件", () => {
  const current = currentManifest("a".repeat(40));
  const scenario = current.scenarios.find((s) => s.id === "tags-add")!;
  const frozen = freezeManifest({
    ...current,
    scenarios: [scenario],
    runs: { ...current.runs, independentRunsPerScenario: 1 },
  });
  const pending = pendingOracle(scenario, {
    manifestHash: frozen.contentHash,
    trialId: record.trialId!,
  });
  for (const oracle of [
    undefined,
    pending,
    { ...pending, definitionHash: "old" },
    { ...pending, checks: [] },
  ]) {
    const result = evaluateSuite(frozen, [{ ...record, oracle }]);
    assert.equal(result.acceptancePassed, false);
    assert.notEqual(result.exitCode, 0);
  }
  const failed = {
    ...pending,
    checks: pending.checks.map((c) => ({
      ...c,
      status: "passed" as const,
      expected: true,
      actual: true,
    })),
  };
  failed.checks[0] = { ...failed.checks[0], expected: true, actual: false };
  assert.equal(
    evaluateSuite(frozen, [{ ...record, oracle: failed }]).executionComplete,
    true,
  );
  assert.equal(
    evaluateSuite(frozen, [{ ...record, oracle: failed }]).acceptancePassed,
    false,
  );
});

test("重复、漏跑、换场景身份及证据缺失都返回未完成，不缩小分母", () => {
  for (const records of [
    [],
    [record, record],
    [{ ...record, scenarioId: "counter-add" }],
    [{ ...record, evidenceComplete: false }],
  ]) {
    const result = evaluateSuite(manifest, records);
    assert.equal(result.executionComplete, false);
    assert.equal(result.exitCode, 2);
    assert.equal(result.expectedTrials, 1);
  }
});

test("独立检查通过也不能掩盖超预算或调用账目不一致", () => {
  const current = currentManifest("a".repeat(40));
  const scenario = current.scenarios.find((s) => s.id === "tags-add")!;
  const frozen = freezeManifest({
    ...current,
    scenarios: [scenario],
    runs: { ...current.runs, independentRunsPerScenario: 1 },
  });
  const oracle = pendingOracle(scenario, {
    manifestHash: frozen.contentHash,
    trialId: record.trialId!,
  });
  oracle.checks = oracle.checks.map((c) => ({
    ...c,
    status: "passed",
    expected: true,
    actual: true,
  }));
  for (const resources of [
    { calls: 13, recordedCalls: 13, candidates: 1, activeMilliseconds: 1000 },
    { calls: 4, recordedCalls: 4, candidates: 4, activeMilliseconds: 1000 },
    { calls: 4, recordedCalls: 4, candidates: 1, activeMilliseconds: 600001 },
    { calls: 4, recordedCalls: 3, candidates: 1, activeMilliseconds: 1000 },
  ]) {
    const result = evaluateSuite(frozen, [{ ...record, oracle, resources }]);
    assert.equal(result.executionComplete, true);
    assert.equal(result.acceptancePassed, false);
    assert.equal(result.exitCode, 1);
    assert.deepEqual(result.budgetViolations, ["tags-add-r1"]);
  }
});

test("评测执行完成与达标分开：有完整失败记录也必须返回不通过", () => {
  const result = evaluateSuite(manifest, [
    {
      ...record,
      observedOutcomeClass: "failed",
      fullPathSucceeded: false,
      failureClass: "transport",
    },
  ]);
  assert.equal(result.executionComplete, true);
  assert.equal(result.acceptancePassed, false);
  assert.equal(result.exitCode, 1);
});
