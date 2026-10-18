import { assertManifestFrozen, type FrozenManifest } from "./manifest.js";
import { computeStabilityMetrics, type ScenarioRunRecord } from "./metrics.js";
import { oracleComplete, oracleRecorded } from "./oracle.js";

/** Completion is evidence accounting; acceptance is the business result. */
export function evaluateSuite(
  manifest: FrozenManifest,
  records: readonly ScenarioRunRecord[],
) {
  assertManifestFrozen(manifest);
  const expected = manifest.scenarios.flatMap((s) =>
    Array.from(
      { length: manifest.runs.independentRunsPerScenario },
      (_, i) => `${s.id}-r${i + 1}`,
    ),
  );
  const ids = records.map((r) => r.trialId);
  const accountingErrors: string[] = [];
  if (
    new Set(ids).size !== ids.length ||
    ids.some((id) => !id || !expected.includes(id))
  )
    accountingErrors.push("运行身份重复、缺失或不属于冻结清单");
  const missingTrials = expected.filter((id) => !ids.includes(id));
  if (new Set(records.map((r) => r.evidenceKind)).size > 1)
    accountingErrors.push("模型桩与真实模型证据不能混入同一批次");
  for (const record of records) {
    const scenario = manifest.scenarios.find((s) => s.id === record.scenarioId);
    if (
      !scenario ||
      !record.trialId?.startsWith(`${scenario.id}-r`) ||
      record.expectedOutcomeClass !== scenario.expectedOutcomeClass ||
      !oracleRecorded(scenario, record.oracle, {
        manifestHash: manifest.contentHash,
        trialId: record.trialId!,
      }) ||
      (manifest.evaluation && !record.resources)
    )
      accountingErrors.push(`运行定义或独立证据不一致：${record.trialId}`);
  }
  const executionComplete =
    !accountingErrors.length &&
    !missingTrials.length &&
    records.every((r) => r.evidenceComplete === true);
  const budgetViolations = records
    .filter(
      (r) =>
        r.resources &&
        (!Object.values(r.resources).every(
          (v) => Number.isFinite(v) && v >= 0,
        ) ||
          !Number.isInteger(r.resources.calls) ||
          !Number.isInteger(r.resources.candidates) ||
          r.resources.calls !== r.resources.recordedCalls ||
          r.resources.calls > manifest.budget.calls ||
          r.resources.candidates > manifest.budget.candidates ||
          r.resources.activeMilliseconds > manifest.budget.milliseconds),
    )
    .map((r) => r.trialId);
  const acceptancePassed =
    executionComplete &&
    !budgetViolations.length &&
    records.every((r) => {
      const scenario = manifest.scenarios.find((s) => s.id === r.scenarioId);
      return (
        scenario &&
        r.expectedOutcomeClass === scenario.expectedOutcomeClass &&
        !r.failureClass &&
        oracleComplete(scenario, r.oracle, {
          manifestHash: manifest.contentHash,
          trialId: r.trialId!,
        }) &&
        (scenario.expectedOutcomeClass === "full-path-success"
          ? r.observedOutcomeClass === "full-path-success" &&
            r.fullPathSucceeded
          : r.observedOutcomeClass === scenario.expectedOutcomeClass &&
            r.errorBlockingCorrect === true &&
            !r.candidatePassed &&
            !r.fullPathSucceeded)
      );
    });
  return {
    executionComplete,
    acceptancePassed,
    exitCode: executionComplete ? (acceptancePassed ? 0 : 1) : 2,
    expectedTrials: expected.length,
    recordedTrials: records.length,
    missingTrials,
    accountingErrors,
    budgetViolations,
    metrics: computeStabilityMetrics(records),
  };
}
