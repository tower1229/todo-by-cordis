import type { StabilityScenario } from "./manifest.js";

export type SettledPlanEvidence = {
  capabilityChanges?: { capability: string; provider: string; change: string }[];
  unresolved?: string[];
  summary?: string;
};

export type SettledScoringInput = {
  scenario: StabilityScenario;
  observedOutcomeClass: string;
  blockReason?: string;
  message?: string;
  plan?: SettledPlanEvidence | null;
  /** True when planning first reached ready before any candidate attempt. */
  reachedReadyOnFirstPlan: boolean;
  /** True when the first planning settle was an explicit blocked state. */
  blockedWithoutReady: boolean;
};

/**
 * Independent of observed===expected: checks plan capability providers / blockers.
 */
export function scoreCapabilityAndBlocking(input: SettledScoringInput): {
  capabilitySelectionCorrect: boolean | null;
  errorBlockingCorrect: boolean | null;
  firstPlanPassed: boolean | null;
} {
  const { scenario, plan, blockReason, message } = input;
  const unresolved = (plan?.unresolved ?? []).join(" ");
  const text = `${message ?? ""} ${blockReason ?? ""} ${unresolved} ${plan?.summary ?? ""}`;
  const providers = (plan?.capabilityChanges ?? []).map((c) => c.provider);

  let capabilitySelectionCorrect: boolean | null = null;
  let errorBlockingCorrect: boolean | null = null;

  switch (scenario.id) {
    case "tags-add":
    case "member-upgrade-tags":
      capabilitySelectionCorrect = providers.some((p) => p === "member:tags");
      break;
    case "counter-add":
      capabilitySelectionCorrect = providers.some(
        (p) => p === "member:counter",
      );
      break;
    case "rule-revision-reflection":
      capabilitySelectionCorrect =
        providers.some((p) => p === "active-source" || p === "workflow") ||
        /复盘|reflection/i.test(plan?.summary ?? "");
      break;
    case "due-auto-expire":
      capabilitySelectionCorrect =
        /定时|调度|timer|scheduler/i.test(text) ||
        providers.some((p) => /scheduler|timer/i.test(p));
      errorBlockingCorrect =
        input.observedOutcomeClass === "current-blocker" &&
        (/定时|调度|timer|scheduler|维护者/i.test(text) ||
          blockReason === "maintainer-capability");
      break;
    case "missing-capability-push":
      capabilitySelectionCorrect =
        /推送|通知|外部\s*IO|外部IO|邮件|短信/i.test(text) ||
        providers.some((p) => /notif/i.test(p));
      errorBlockingCorrect =
        input.observedOutcomeClass === "accurate-block" &&
        (blockReason === "maintainer-capability" ||
          /推送|通知|外部|维护者/i.test(text));
      break;
    case "temporarily-unavailable-dependency":
      capabilitySelectionCorrect =
        /依赖/i.test(text) ||
        providers.some((p) => p === "active-source");
      errorBlockingCorrect =
        input.observedOutcomeClass === "accurate-block" &&
        (blockReason === "investigation" ||
          blockReason === "protection" ||
          /依赖/i.test(text));
      break;
    default:
      capabilitySelectionCorrect = null;
  }

  let firstPlanPassed: boolean | null = null;
  if (scenario.expectedOutcomeClass === "full-path-success") {
    firstPlanPassed = input.reachedReadyOnFirstPlan;
  } else if (
    scenario.expectedOutcomeClass === "accurate-block" ||
    scenario.expectedOutcomeClass === "current-blocker"
  ) {
    // 阻塞场景：首次规划结果即为明确 blocked 计为「首个计划通过」。
    firstPlanPassed = input.blockedWithoutReady;
  }

  return {
    capabilitySelectionCorrect,
    errorBlockingCorrect,
    firstPlanPassed,
  };
}
