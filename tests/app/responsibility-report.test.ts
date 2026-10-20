import test from "node:test";
import assert from "node:assert/strict";
import { extendedTimeManifest } from "../../scripts/lib/stability-eval/resources.js";
import { freezeManifest } from "../../scripts/lib/stability-eval/manifest.js";
import { freezeResponsibilityExperiment } from "../../scripts/lib/stability-eval/responsibility.js";
import {
  evaluateResponsibilityExperiment,
  evaluateSuite,
} from "../../scripts/lib/stability-eval/report.js";
import { pendingOracle } from "../../scripts/lib/stability-eval/oracle.js";
import type { ScenarioRunRecord } from "../../scripts/lib/stability-eval/metrics.js";

function fixture() {
  const manifest = freezeManifest(extendedTimeManifest("a".repeat(40)));
  const experiment = freezeResponsibilityExperiment(manifest, "report");
  const records: ScenarioRunRecord[] = experiment.trials.map((trial) => {
    const scenario = manifest.scenarios.find((s) => s.id === trial.scenarioId)!;
    const positive = scenario.expectedOutcomeClass === "full-path-success";
    const oracle = pendingOracle(scenario, {
      manifestHash: manifest.contentHash,
      trialId: trial.trialId,
    });
    oracle.checks = oracle.checks.map((c) => ({
      ...c,
      status: "passed",
      expected: true,
      actual: true,
    }));
    return {
      trialId: trial.trialId,
      scenarioId: scenario.id,
      evidenceKind: "model-stub",
      evidenceComplete: true,
      expectedOutcomeClass: scenario.expectedOutcomeClass,
      observedOutcomeClass: scenario.expectedOutcomeClass,
      capabilitySelectionCorrect: true,
      errorBlockingCorrect: positive ? null : true,
      firstPlanPassed: true,
      firstCandidatePassed: positive ? true : null,
      candidatePassed: positive,
      fullPathSucceeded: positive,
      repairedInOriginalBudget: false,
      durationMs: 1,
      usage: null,
      failureClass: null,
      resources: {
        calls: 4,
        recordedCalls: 4,
        candidates: positive ? 1 : 0,
        activeMilliseconds: 1000,
      },
      oracle,
      responsibility: {
        experimentHash: experiment.contentHash,
        trialId: trial.trialId,
        pairId: trial.pairId,
        owner: trial.owner,
        kernelHash: experiment.kernelHash,
        sequence: trial.sequence,
        plannedOwner: positive ? trial.owner : undefined,
        consistent: true,
        issues: [],
        candidates: positive
          ? [
              {
                attempt: 1,
                passed: true,
                versionId: "candidate",
                providerId: "primary",
                providerVersionId: "primary-version",
                actualOwner: trial.owner,
                workflowChanged: true,
              },
            ]
          : [],
      },
    };
  });
  return { experiment, records };
}

test("职责实验按冻结的48个身份汇总模型桩证据，保留两组18个正向、6个边界及预定重点分母", () => {
  const { experiment, records } = fixture();
  const result = evaluateResponsibilityExperiment(experiment, records);
  assert.equal(result.executionComplete, true);
  assert.equal(result.acceptancePassed, true);
  assert.equal(result.evidenceKind, "model-stub");
  assert.equal(result.expectedTrials, 48);
  assert.deepEqual(experiment.focusScenarios, [
    "rule-revision-reflection",
    "clarification-reflection",
  ]);
  for (const owner of experiment.arms) {
    assert.equal(result.arms[owner].expectedTrials, 24);
    assert.deepEqual(result.arms[owner].metrics.positiveSuccessRate, {
      numerator: 18,
      denominator: 18,
      rate: 1,
    });
    assert.equal(result.arms[owner].metrics.correctBlockingRate.denominator, 6);
    assert.equal(result.focus[owner].expectedTrials, 6);
  }
  assert.equal(result.pairs.length, 24);
  assert.equal(result.pairedCounts.positive.both, 18);
  assert.equal(result.pairedCounts.focus.both, 6);
  assert.equal(
    evaluateSuite(experiment.manifest, records).executionComplete,
    false,
    "普通入口不能接收或重命名配对身份",
  );
});

test("职责汇总拒绝漏跑、重复、错组、篡改实际职责和混合证据；完整失败保留在原分母", () => {
  const { experiment, records } = fixture();
  for (const mutate of [
    (r: ScenarioRunRecord[]) => {
      r.pop();
    },
    (r: ScenarioRunRecord[]) => {
      r.push(r[0]);
    },
    (r: ScenarioRunRecord[]) => {
      r[0].responsibility!.owner =
        r[0].responsibility!.owner === "host" ? "model" : "host";
    },
    (r: ScenarioRunRecord[]) => {
      const row = r.find((v) => v.responsibility!.candidates.length)!
        .responsibility!.candidates[0];
      row.actualOwner = row.actualOwner === "host" ? "model" : "host";
    },
    (r: ScenarioRunRecord[]) => {
      r[0].evidenceKind = "real-model";
    },
    (r: ScenarioRunRecord[]) => {
      r[0].responsibility!.consistent = false;
    },
  ]) {
    const changed = structuredClone(records);
    mutate(changed);
    const result = evaluateResponsibilityExperiment(experiment, changed);
    assert.equal(result.executionComplete, false);
    assert.equal(result.acceptancePassed, false);
    assert.equal(result.expectedTrials, 48);
    assert.equal(result.exitCode, 2);
  }
  const failed = structuredClone(records);
  const row = failed.find(
    (r) =>
      r.scenarioId === "rule-revision-reflection" &&
      r.responsibility!.owner === "host",
  )!;
  row.fullPathSucceeded = false;
  row.observedOutcomeClass = "failed";
  row.failureClass = "unknown";
  const report = evaluateResponsibilityExperiment(experiment, failed);
  assert.equal(report.executionComplete, true);
  assert.equal(report.acceptancePassed, false);
  assert.equal(report.arms.host.metrics.positiveSuccessRate.denominator, 18);
  assert.equal(report.pairedCounts.focus.modelOnly, 1);
});
