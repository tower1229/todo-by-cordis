import { assertManifestFrozen, type FrozenManifest } from "./manifest.js";
import { computeStabilityMetrics, type ScenarioRunRecord } from "./metrics.js";
import { oracleComplete, oracleRecorded } from "./oracle.js";
import {
  assertResponsibilityExperiment,
  type FrozenResponsibilityExperiment,
} from "./responsibility.js";
import type { WorkflowProtocolOwner } from "../../../src/shared/workflow-protocol.js";

/** Completion is evidence accounting; acceptance is the business result. */
export function evaluateSuite(
  manifest: FrozenManifest,
  records: readonly ScenarioRunRecord[],
) {
  assertManifestFrozen(manifest);
  const expected = manifest.scenarios.flatMap((s) =>
    Array.from(
      { length: manifest.runs.independentRunsPerScenario },
      (_, i) => ({ trialId: `${s.id}-r${i + 1}`, scenarioId: s.id }),
    ),
  );
  return evaluateCatalog(manifest, records, expected);
}

function evaluateCatalog(
  manifest: FrozenManifest,
  records: readonly ScenarioRunRecord[],
  catalog: readonly { trialId: string; scenarioId: string }[],
) {
  const expected = catalog.map((t) => t.trialId);
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
      catalog.find((t) => t.trialId === record.trialId)?.scenarioId !==
        record.scenarioId ||
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

/** Preserve registered identities and oracle bindings; never rename records to fit another arm. */
export function evaluateResponsibilityExperiment(
  experiment: FrozenResponsibilityExperiment,
  records: readonly ScenarioRunRecord[],
) {
  assertResponsibilityExperiment(experiment);
  const manifest = experiment.manifest;
  const all = evaluateCatalog(manifest, records, experiment.trials);
  for (const record of records) {
    const trial = experiment.trials.find((t) => t.trialId === record.trialId);
    const proof = record.responsibility;
    if (
      !trial ||
      !proof ||
      proof.experimentHash !== experiment.contentHash ||
      proof.trialId !== trial.trialId ||
      proof.pairId !== trial.pairId ||
      proof.owner !== trial.owner ||
      proof.kernelHash !== experiment.kernelHash ||
      proof.sequence !== trial.sequence ||
      !proof.consistent ||
      proof.issues.length ||
      (proof.plannedOwner !== undefined &&
        proof.plannedOwner !== trial.owner) ||
      (proof.candidates.length > 0 && !proof.plannedOwner) ||
      proof.candidates.some(
        (c) => c.workflowChanged && c.actualOwner !== trial.owner,
      ) ||
      proof.candidates.some(
        (c) =>
          c.passed && (!c.versionId || !c.providerVersionId || !c.actualOwner),
      ) ||
      proof.candidates.some((c) => c.passed) !== Boolean(record.candidatePassed)
    )
      all.accountingErrors.push(
        `职责分组或实际工作流证据不一致：${record.trialId}`,
      );
  }
  const arm = (owner: WorkflowProtocolOwner, focus = false) =>
    evaluateCatalog(
      manifest,
      records.filter(
        (r) =>
          experiment.trials.some(
            (t) => t.trialId === r.trialId && t.owner === owner,
          ) &&
          (!focus ||
            experiment.focusScenarios.some((id) => id === r.scenarioId)),
      ),
      experiment.trials.filter(
        (t) =>
          t.owner === owner &&
          (!focus ||
            experiment.focusScenarios.some((id) => id === t.scenarioId)),
      ),
    );
  const arms = { model: arm("model"), host: arm("host") };
  const focus = { model: arm("model", true), host: arm("host", true) };
  const pairs = experiment.trials
    .filter((t) => t.position === 1)
    .map((first) => {
      const outcome = (owner: WorkflowProtocolOwner) => {
        const trial = experiment.trials.find(
          (t) => t.pairId === first.pairId && t.owner === owner,
        )!;
        const record = records.find((r) => r.trialId === trial.trialId);
        // A single-row catalog uses the same business gates and resource checks.
        const verdict = evaluateCatalog(manifest, record ? [record] : [], [
          trial,
        ]);
        return {
          trialId: trial.trialId,
          outcome: record?.observedOutcomeClass ?? "missing",
          matched: verdict.acceptancePassed,
        };
      };
      return {
        pairId: first.pairId,
        scenarioId: first.scenarioId,
        positive:
          manifest.scenarios.find((s) => s.id === first.scenarioId)!
            .expectedOutcomeClass === "full-path-success",
        focus: experiment.focusScenarios.some((id) => id === first.scenarioId),
        model: outcome("model"),
        host: outcome("host"),
      };
    });
  const counts = (selected: typeof pairs) =>
    selected.reduce(
      (count, pair) => {
        if (pair.model.matched && pair.host.matched) count.both++;
        else if (pair.model.matched) count.modelOnly++;
        else if (pair.host.matched) count.hostOnly++;
        else count.neither++;
        return count;
      },
      { both: 0, modelOnly: 0, hostOnly: 0, neither: 0 },
    );
  const executionComplete =
    all.executionComplete && !all.accountingErrors.length;
  const acceptancePassed =
    executionComplete &&
    arms.model.acceptancePassed &&
    arms.host.acceptancePassed;
  return {
    ...all,
    executionComplete,
    acceptancePassed,
    exitCode: executionComplete ? (acceptancePassed ? 0 : 1) : 2,
    experimentHash: experiment.contentHash,
    evidenceKind:
      new Set(records.map((r) => r.evidenceKind)).size === 1
        ? records[0]?.evidenceKind
        : null,
    arms,
    focus,
    pairs,
    pairedCounts: {
      positive: counts(pairs.filter((p) => p.positive)),
      boundary: counts(pairs.filter((p) => !p.positive)),
      focus: counts(pairs.filter((p) => p.focus)),
    },
  };
}
