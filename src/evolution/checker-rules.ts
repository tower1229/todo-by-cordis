import type { InvestigatedPlan } from "../shared/assistant.js";
import { workflowTextSemantics } from "../shared/checker-semantics.js";
import { hash } from "../release/storage.js";

/** Executable checker predicates, never user-authored requirements. */
export const workflowCheckerRules = [
  {
    id: "workflow-text:validation-normalization",
    factId: "host-fact:workflow-text",
    property: "validationNormalization",
    value: workflowTextSemantics.validationNormalization,
    aspect: "input",
    contract: "完成字段在必填和长度校验前去除首尾空白",
  },
  {
    id: "workflow-text:persistence-normalization",
    factId: "host-fact:workflow-text",
    property: "persistenceNormalization",
    value: workflowTextSemantics.persistenceNormalization,
    aspect: "persistence",
    contract: "完成动作保存完成字段去除首尾空白后的值；不改写其他历史字段",
  },
  {
    id: "workflow-text:length-metric",
    factId: "host-fact:workflow-text",
    property: "lengthMetric",
    value: workflowTextSemantics.lengthMetric,
    aspect: "input",
    contract: "完成字段的长度按 Unicode 码点计算",
  },
] as const;

export type HostCheckerRule = (typeof workflowCheckerRules)[number] & {
  origin: "host";
  checker: "workflow/1";
  checkerHash: string;
  scope: { action: "complete"; fields: string[] };
  checks: { checker: string; caseId: string }[];
  hash: string;
};

export function hostCheckerRules(
  plan: Pick<InvestigatedPlan, "workflowRules" | "cases" | "binding">,
): HostCheckerRule[] {
  const checks = plan.cases
    .filter((c) => c.checker === "workflow/1")
    .map((_c, index) => ({
      checker: "workflow/1",
      caseId: `workflow/1:${index + 1}`,
    }));
  return workflowCheckerRules.map((rule) => {
    const body = {
      ...rule,
      origin: "host" as const,
      checker: "workflow/1" as const,
      checkerHash:
        plan.binding?.checkers.find((c) => c.id === "workflow/1")?.version ??
        "unavailable",
      scope: {
        action: "complete" as const,
        fields: plan.workflowRules.map((f) => f.key),
      },
      checks,
    };
    return { ...body, hash: hash(body) };
  });
}
