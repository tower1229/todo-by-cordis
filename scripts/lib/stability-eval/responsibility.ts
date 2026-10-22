import { hash } from "../../../src/release/storage.js";
import { workflowProtocolKernelHash } from "../../../src/release/workflow-protocol.js";
import type { WorkflowProtocolOwner } from "../../../src/shared/workflow-protocol.js";
import { assertManifestFrozen, type FrozenManifest } from "./manifest.js";
import { resolveVersionMembers } from "../../../src/release/composition.js";
import type { Version } from "../../../src/release/types.js";
import type {
  CandidateAttempt,
  PlanBinding,
} from "../../../src/shared/assistant.js";

export type ResponsibilityTrial = {
  trialId: string;
  pairId: string;
  scenarioId: string;
  repetition: number;
  owner: WorkflowProtocolOwner;
  position: 1 | 2;
  sequence: number;
};
export type FrozenResponsibilityExperiment = {
  schema: "cordis.responsibility-experiment/1";
  frozen: true;
  frozenAt: string;
  seed: string;
  manifest: FrozenManifest;
  kernelHash: string;
  arms: readonly ["model", "host"];
  focusScenarios: readonly [
    "rule-revision-reflection",
    "clarification-reflection",
  ];
  trials: ResponsibilityTrial[];
  contentHash: string;
};
export type ResponsibilityBinding = {
  experimentHash: string;
  trialId: string;
  pairId: string;
  owner: WorkflowProtocolOwner;
  kernelHash: string;
  sequence: number;
};
export type ResponsibilityObservation = ResponsibilityBinding & {
  plannedOwner?: WorkflowProtocolOwner;
  consistent: boolean;
  issues: {
    classification: "host-defect" | "evaluator";
    code: string;
    detail: string;
  }[];
  candidates: {
    attempt: number;
    passed: boolean;
    versionId?: string;
    providerId?: string;
    providerVersionId?: string;
    actualOwner?: WorkflowProtocolOwner;
    workflowChanged?: boolean;
    profileHash?: string;
  }[];
};

/** Observe actual resolved programs; a requested arm is not evidence of exposure. */
export function observeResponsibility(
  binding: ResponsibilityBinding,
  planned: PlanBinding["workflowProtocol"],
  candidates: readonly CandidateAttempt[],
  getVersion: (id: string) => Version,
): ResponsibilityObservation {
  const issues: ResponsibilityObservation["issues"] = [];
  if (binding.kernelHash !== workflowProtocolKernelHash())
    issues.push({
      classification: "evaluator",
      code: "kernel-drift",
      detail: "冻结后执行内核变化",
    });
  if (
    planned &&
    (planned.owner !== binding.owner ||
      planned.implementationHash !== binding.kernelHash)
  )
    issues.push({
      classification: "evaluator",
      code: "plan-binding",
      detail: "计划职责或内核与预注册分组不一致",
    });
  if (candidates.length && !planned)
    issues.push({
      classification: "host-defect",
      code: "missing-plan",
      detail: "存在候选却没有冻结计划职责",
    });
  const primary = (version: Version) => {
    const member = resolveVersionMembers(version).find(
      (m) => m.enabled && m.role === "workflow",
    );
    if (!member) throw new Error("组合缺少工作流提供者");
    return member.versionId && member.versionId !== version.id
      ? getVersion(member.versionId)
      : version;
  };
  const observed = candidates.map((candidate) => {
    const row: ResponsibilityObservation["candidates"][number] = {
      attempt: candidate.attempt,
      passed: candidate.passed,
      ...(candidate.versionId ? { versionId: candidate.versionId } : {}),
    };
    if (!candidate.versionId) {
      if (candidate.passed)
        issues.push({
          classification: "host-defect",
          code: "missing-version",
          detail: "通过候选缺少精确版本",
        });
      return row;
    }
    try {
      const actual = primary(getVersion(candidate.versionId)),
        base = primary(getVersion(candidate.baseVersion));
      row.providerId = actual.pluginId;
      row.providerVersionId = actual.id;
      row.actualOwner = actual.workflowProtocol ? "host" : "model";
      row.workflowChanged = actual.id !== base.id;
      if (actual.workflowProtocol)
        row.profileHash = hash(actual.workflowProtocol);
      if (row.workflowChanged && row.actualOwner !== binding.owner)
        issues.push({
          classification: "host-defect",
          code: "candidate-owner",
          detail: `候选 ${candidate.attempt} 的实际工作流职责偏离冻结计划`,
        });
    } catch (error) {
      issues.push({
        classification: "evaluator",
        code: "version-evidence",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return row;
  });
  return {
    ...binding,
    plannedOwner: planned?.owner,
    candidates: observed,
    consistent: issues.length === 0,
    issues,
  };
}

function schedule(
  manifest: FrozenManifest,
  seed: string,
): ResponsibilityTrial[] {
  const pairs = manifest.scenarios
    .flatMap((scenario, scenarioIndex) =>
      [1, 2, 3].map((repetition) => ({
        pairId: `${scenario.id}-pair-${repetition}`,
        scenarioId: scenario.id,
        scenarioIndex,
        repetition,
      })),
    )
    .sort((a, b) =>
      hash({ seed, pair: a.pairId }).localeCompare(
        hash({ seed, pair: b.pairId }),
      ),
    );
  return pairs.flatMap((pair, index) => {
    const first: WorkflowProtocolOwner =
      (pair.scenarioIndex + pair.repetition) % 2 ? "model" : "host";
    return [
      first,
      first === "model" ? ("host" as const) : ("model" as const),
    ].map((owner, position) => ({
      trialId: `${pair.pairId}-${owner}`,
      pairId: pair.pairId,
      scenarioId: pair.scenarioId,
      repetition: pair.repetition,
      owner,
      position: (position + 1) as 1 | 2,
      sequence: index * 2 + position + 1,
    }));
  });
}

/** The host generates all trial identities and ordering before the first API call. */
export function freezeResponsibilityExperiment(
  manifest: FrozenManifest,
  seed: string,
  frozenAt = new Date().toISOString(),
): FrozenResponsibilityExperiment {
  const body: Omit<FrozenResponsibilityExperiment, "contentHash"> = {
    schema: "cordis.responsibility-experiment/1",
    frozen: true,
    frozenAt,
    seed,
    manifest: structuredClone(manifest),
    kernelHash: workflowProtocolKernelHash(),
    arms: ["model", "host"],
    focusScenarios: ["rule-revision-reflection", "clarification-reflection"],
    trials: schedule(manifest, seed),
  };
  const experiment = { ...body, contentHash: hash(body) };
  assertResponsibilityExperiment(experiment);
  return experiment;
}

/** Historical definitions remain inspectable; execution additionally checks the live kernel. */
export function assertResponsibilityExperiment(
  experiment: FrozenResponsibilityExperiment,
) {
  if (
    !experiment ||
    experiment.schema !== "cordis.responsibility-experiment/1" ||
    experiment.frozen !== true
  )
    throw new Error("职责实验尚未冻结或版本不支持");
  const { contentHash, ...body } = experiment;
  if (hash(body) !== contentHash) throw new Error("职责实验摘要不一致");
  assertManifestFrozen(experiment.manifest);
  const manifest = experiment.manifest;
  if (
    !["current/4", "current/5", "current/6"].includes(manifest.evaluation ?? "") ||
    manifest.resourceProfile !== "extended-time/1" ||
    manifest.budget.calls !== 12 ||
    manifest.budget.candidates !== 3 ||
    manifest.budget.milliseconds !== 1_800_000 ||
    manifest.scenarios.length !== 8 ||
    manifest.runs.independentRunsPerScenario !== 3
  )
    throw new Error(
      "职责实验必须保持8场景各3对及12次调用、3候选、30分钟的统一预算",
    );
  if (
    typeof experiment.seed !== "string" ||
    !experiment.seed.trim() ||
    experiment.seed.length > 128 ||
    !Number.isFinite(Date.parse(experiment.frozenAt)) ||
    !/^[a-f0-9]{64}$/.test(experiment.kernelHash) ||
    manifest.scenarios.some((s) => !/^[a-z][a-z0-9-]{0,100}$/.test(s.id))
  )
    throw new Error("职责实验种子、内核或场景身份无效");
  if (
    hash(experiment.arms) !== hash(["model", "host"]) ||
    hash(experiment.focusScenarios) !==
      hash(["rule-revision-reflection", "clarification-reflection"]) ||
    hash(experiment.trials) !== hash(schedule(manifest, experiment.seed))
  )
    throw new Error("职责分组或配对顺序偏离冻结生成规则，不能增删或重排样本");
}

export function selectResponsibilityTrial(
  experiment: FrozenResponsibilityExperiment,
  trialId: string | undefined,
  scenarioId: string,
  manifest: FrozenManifest,
): ResponsibilityBinding {
  assertResponsibilityExperiment(experiment);
  assertManifestFrozen(manifest);
  if (experiment.manifest.contentHash !== manifest.contentHash)
    throw new Error("职责实验不能混用来源或验收清单");
  if (experiment.kernelHash !== workflowProtocolKernelHash())
    throw new Error("职责实验执行内核已变化，不能复用冻结身份");
  const trial = experiment.trials.find((t) => t.trialId === trialId);
  if (!trial || trial.scenarioId !== scenarioId)
    throw new Error("职责实验运行不在预注册场景及分组中");
  return {
    experimentHash: experiment.contentHash,
    trialId: trial.trialId,
    pairId: trial.pairId,
    owner: trial.owner,
    kernelHash: experiment.kernelHash,
    sequence: trial.sequence,
  };
}
