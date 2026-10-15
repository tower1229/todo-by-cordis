import type {
  InvestigatedPlan,
  RequirementReview,
} from "../shared/assistant.js";
import { workflowTextSemantics } from "../shared/checker-semantics.js";
import { hash } from "../release/storage.js";
import { readOnlyFieldText } from "../shared/field-presentation.js";

export type TechnicalFact = {
  id: string;
  properties: Record<string, string>;
  evidenceHash: string;
};
export type TechnicalDecision = {
  issue: RequirementReview["issues"][number];
  factId: string;
  factHash: string;
  property: string;
  expected: string;
  actual?: string;
  outcome: "satisfied" | "conflict" | "unsupported";
};
export function businessChoices(
  plan: Pick<InvestigatedPlan, "requirements" | "workflowRules">,
) {
  return (plan.requirements ?? []).flatMap((requirement) => [
    ...plan.workflowRules.map((field) => ({
      id: `business-choice:input-required:${requirement.id}:${field.key}`,
      requirementId: requirement.id,
      question: `${field.label}是必填还是选填？`,
    })),
    ...(requirement.obligations ?? []).flatMap((o) =>
      o.kind === "field"
        ? [
            {
              id: `business-choice:initial-display:${requirement.id}:${o.id}`,
              requirementId: requirement.id,
              obligationId: o.id,
              question: `尚未填写 ${o.field} 时，详情应显示什么？`,
            },
          ]
        : o.kind === "assertion" && o.expected.kind === "action-visible"
          ? [
              {
                id: `business-choice:action-availability:${o.id}`,
                requirementId: requirement.id,
                question: `在这项要求的场景中，是否应显示 ${o.expected.action} 动作？`,
              },
            ]
          : [],
    ),
  ]);
}
/** A review cannot send arbitrary wording to the user. Questions are host projections. */
export function reviewQuestion(
  review: RequirementReview,
  plan: Pick<InvestigatedPlan, "requirements" | "workflowRules">,
): string | undefined {
  const choices = businessChoices(plan);
  let question: string | undefined;
  for (const issue of review.issues) {
    if (!issue.clarification && !issue.clarificationChoice) continue;
    if (issue.technical || issue.target?.subject.startsWith("host-fact:"))
      throw new Error("技术事实不能转交用户澄清");
    const choice = choices.find(
      (c) =>
        c.id === issue.clarificationChoice &&
        c.requirementId === issue.target?.subject,
    );
    if (!choice)
      throw new Error(
        "复核澄清缺少宿主业务选项目录绑定；自由文本及技术问题不能直接提问",
      );
    if ("obligationId" in choice) {
      const decision = review.fieldDecisions?.find(
        (d) => d.obligationId === choice.obligationId,
      );
      if (!decision) throw new Error("初始呈现提问缺少独立来源解释");
      if (decision.initial.kind !== "undetermined") continue;
    }
    question ??= choice.question;
  }
  for (const decision of review.fieldDecisions ?? [])
    if (decision.initial.kind === "undetermined")
      question ??= choices.find(
        (c) => "obligationId" in c && c.obligationId === decision.obligationId,
      )?.question;
  return question;
}
export function technicalFacts(
  plan: Pick<InvestigatedPlan, "workflowRules" | "binding">,
): TechnicalFact[] {
  const facts: Omit<TechnicalFact, "evidenceHash">[] = [
    {
      id: "host-fact:obligation-derivation",
      properties: {
        newField: "post-action-matrix-without-baseline-history",
        existingField: "exact-baseline-replay",
        uiIdentity: "baseline-identifiers-not-action-visibility",
        coverage: "generated-executable-cases-not-model-self-report",
      },
    },
    {
      id: "host-fact:workflow-text",
      properties: {
        normalization: workflowTextSemantics.normalization,
        lengthMetric: workflowTextSemantics.lengthMetric,
      },
    },
    {
      id: "host-fact:browser-error",
      properties: { emptyText: "visible-alert", nonemptyText: "substring" },
    },
    {
      id: "host-fact:browser-history",
      properties: {
        existing: "created-under-base",
        historicalFields: "explicit-baseline-replay",
        historicalVersion: "exact-recorded-base-version",
      },
    },
    {
      id: "host-fact:initial-field-presentation",
      properties: {
        workflowMissingField: "absent",
        auxiliaryMissingField: readOnlyFieldText(undefined),
        origin: "host-protection-not-business-requirement",
      },
    },
    {
      id: "host-fact:workflow-verification",
      properties: {
        mapping: "whole-checker-suite",
        association: "evidence-reference-not-action-restriction",
      },
    },
    {
      id: "host-fact:browser-generation",
      properties: {
        definition:"host-compiled-rules-and-obligations",
        requiredEmpty:"native-valueMissing-without-command-or-alert",
        whitespace:"business-feedback-after-submit",
        manualCases:"not-authorized-in-planning-tool",
      },
    },
    {
      id: "host-fact:write-scope",
      properties: {
        activation:"no-business-data-write",
        action:"explicit-command-only",
        historicalPreparation:"baseline-replay-not-candidate-action",
      },
    },
    ...plan.workflowRules.map((rule) => ({
      id: `host-fact:workflow-field:${rule.key}`,
      properties: {
        required: String(rule.required),
        minimum: String(rule.minLength),
        maximum: String(rule.maxLength),
        lengthMetric: workflowTextSemantics.lengthMetric,
      },
    })),
  ];
  return facts.map((f) => ({
    ...f,
    evidenceHash: hash({
      fact: f,
      checkers: plan.binding?.checkers ?? [],
      rules: plan.workflowRules,
    }),
  }));
}

/** A technical claim is an equality against a closed host fact, never prose voting. */
export function adjudicateTechnicalReview(
  review: RequirementReview,
  facts: TechnicalFact[],
): RequirementReview {
  const issues: RequirementReview["issues"] = [];
  const technicalDecisions: TechnicalDecision[] = [];
  for (const issue of review.issues) {
    const claim = issue.technical;
    const technicalTarget = issue.target?.subject.startsWith("host-fact:");
    if (!claim && !technicalTarget) {
      issues.push(issue);
      continue;
    }
    if (!claim || issue.target?.subject !== claim.factId)
      throw new Error(
        "技术复核必须引用精确宿主事实及结构化期望，不能转交用户澄清",
      );
    const fact = facts.find((f) => f.id === claim.factId);
    const actual = fact?.properties[claim.property];
    const outcome =
      actual === undefined
        ? "unsupported"
        : actual === claim.expected
          ? "satisfied"
          : "conflict";
    technicalDecisions.push({
      issue: structuredClone(issue),
      factId: claim.factId,
      factHash: fact?.evidenceHash ?? "",
      property: claim.property,
      expected: claim.expected,
      ...(actual === undefined ? {} : { actual }),
      outcome,
    });
    if (outcome !== "satisfied") {
      const { clarification: _question, ...blocked } = issue;
      issues.push({
        ...blocked,
        detail: `宿主技术事实裁决 ${outcome}：${claim.factId}.${claim.property} 期望 ${claim.expected}，实际 ${actual ?? "不支持"}；${issue.detail}`,
      });
    }
  }
  return { ...review, issues, technicalDecisions };
}
