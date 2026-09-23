import type { OutcomeClass } from "./manifest.js";

export const failureClasses = [
  "model-understanding-or-generation",
  "documentation-gap",
  "host-defect",
  "tool-protocol",
  "transport",
  "evaluator",
] as const;
export type FailureClass = (typeof failureClasses)[number];

export type ObservedOutcomeClass = OutcomeClass | "failed";

export type ScenarioRunRecord = {
  scenarioId: string;
  evidenceKind: "model-stub" | "real-model";
  evidenceComplete?: boolean;
  expectedOutcomeClass: OutcomeClass;
  observedOutcomeClass: ObservedOutcomeClass;
  /** null when transport failed before capability judgement. */
  capabilitySelectionCorrect: boolean | null;
  /** null when the scenario is not an error-blocking case or never reached judgement. */
  errorBlockingCorrect: boolean | null;
  firstPlanPassed: boolean | null;
  firstCandidatePassed: boolean | null;
  fullPathSucceeded: boolean;
  repairedInOriginalBudget: boolean;
  durationMs: number;
  usage: { promptTokens: number; completionTokens: number } | null;
  failureClass: FailureClass | null;
};

export type Rate = {
  numerator: number;
  denominator: number;
  rate: number | null;
};

export type StabilityMetrics = {
  capabilitySelectionAccuracy: Rate;
  errorBlockingAccuracy: Rate;
  firstPlanPassRate: Rate;
  firstCandidatePassRate: Rate;
  fullPathSuccessRate: Rate;
  inBudgetRepairRate: Rate;
  durationMs: { total: number; samples: number };
  costUsage: {
    promptTokens: number;
    completionTokens: number;
    samplesWithUsage: number;
  };
  failureClassCounts: Record<FailureClass, number>;
};

function rate(numerator: number, denominator: number): Rate {
  return {
    numerator,
    denominator,
    rate: denominator === 0 ? null : numerator / denominator,
  };
}

export function computeStabilityMetrics(
  runs: readonly ScenarioRunRecord[],
): StabilityMetrics {
  let capabilityCorrect = 0;
  let capabilityJudged = 0;
  let blockingCorrect = 0;
  let blockingJudged = 0;
  let firstPlanPass = 0;
  let firstPlanJudged = 0;
  let firstCandidatePass = 0;
  let firstCandidateJudged = 0;
  let fullPathPass = 0;
  let repairs = 0;
  let repairEligible = 0;
  let durationTotal = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let usageSamples = 0;
  const failureClassCounts = Object.fromEntries(
    failureClasses.map((name) => [name, 0]),
  ) as Record<FailureClass, number>;

  for (const run of runs) {
    durationTotal += run.durationMs;
    if (run.usage) {
      promptTokens += run.usage.promptTokens;
      completionTokens += run.usage.completionTokens;
      usageSamples += 1;
    }
    if (run.failureClass) failureClassCounts[run.failureClass] += 1;

    if (run.capabilitySelectionCorrect !== null) {
      capabilityJudged += 1;
      if (run.capabilitySelectionCorrect) capabilityCorrect += 1;
    }
    if (run.errorBlockingCorrect !== null) {
      blockingJudged += 1;
      if (run.errorBlockingCorrect) blockingCorrect += 1;
    }
    if (run.firstPlanPassed !== null) {
      firstPlanJudged += 1;
      if (run.firstPlanPassed) firstPlanPass += 1;
    }
    if (run.firstCandidatePassed !== null) {
      firstCandidateJudged += 1;
      if (run.firstCandidatePassed) firstCandidatePass += 1;
    }
    // 纠错率分母：首个候选失败或实际发生过预算内纠错的运行。
    if (run.firstCandidatePassed === false || run.repairedInOriginalBudget) {
      repairEligible += 1;
      if (run.repairedInOriginalBudget) repairs += 1;
    }
    if (run.fullPathSucceeded) fullPathPass += 1;
  }

  return {
    capabilitySelectionAccuracy: rate(capabilityCorrect, capabilityJudged),
    errorBlockingAccuracy: rate(blockingCorrect, blockingJudged),
    firstPlanPassRate: rate(firstPlanPass, firstPlanJudged),
    firstCandidatePassRate: rate(firstCandidatePass, firstCandidateJudged),
    fullPathSuccessRate: rate(fullPathPass, runs.length),
    inBudgetRepairRate: rate(repairs, repairEligible),
    durationMs: { total: durationTotal, samples: runs.length },
    costUsage: {
      promptTokens,
      completionTokens,
      samplesWithUsage: usageSamples,
    },
    failureClassCounts,
  };
}

/** Classify a failure from archived diagnostics without inventing success. */
export function classifyFailure(input: {
  message?: string;
  transportFailed?: boolean;
  toolProtocolError?: boolean;
  hostDefect?: boolean;
  documentationGap?: boolean;
}): FailureClass {
  if (input.transportFailed) return "transport";
  if (input.toolProtocolError) return "tool-protocol";
  if (input.hostDefect) return "host-defect";
  if (input.documentationGap) return "documentation-gap";
  const text = input.message ?? "";
  if (/Evaluator binding|Archive verification/i.test(text)) return "evaluator";
  if (
    /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up|429|UNAVAILABLE|Gemini fetch/i.test(
      text,
    )
  )
    return "transport";
  if (/INVALID_.*ARGUMENTS|未知工具|tool protocol|schema/i.test(text))
    return "tool-protocol";
  if (/检查器|验收覆盖|资料|指南|提示词|定时|调度基础/i.test(text))
    return "documentation-gap";
  if (/宿主|Workspace|组合指针|正式任务被改/i.test(text)) return "host-defect";
  return "model-understanding-or-generation";
}
