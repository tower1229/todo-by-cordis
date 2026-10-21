import type {
  InvestigatedPlan,
  RequirementReview,
} from "../shared/assistant.js";
import { workflowTextSemantics, scheduleCheckSemantics } from "../shared/checker-semantics.js";
import { hash } from "../release/storage.js";
import { readOnlyFieldText } from "../shared/field-presentation.js";
import {isInheritedAvailability,availabilityFacts,type ActionAvailability} from "./action-availability.js";
import {fieldFacts,type FieldIdentity} from "./field-identity.js";
import { workflowCheckerRules } from "./checker-rules.js";
import { capabilityFacts } from "./capability-admission.js";
import { schedulePolicySemantics } from "../shared/schedule-policy.js";
import type { BrowserStep } from "../shared/browser-cases.js";

function clarificationStep(step: BrowserStep): string {
  if (step.kind === "action")
    return `执行成员“${step.member}”的“${step.action}”动作${step.input ? `（输入 ${JSON.stringify(step.input)}）` : ""}`;
  if (step.kind === "open") return "打开任务详情";
  if (step.kind === "refresh") return "刷新页面";
  if (step.kind === "restart") return "重启服务后打开任务";
  if (step.kind === "edit") return `编辑任务 ${JSON.stringify({ title: step.title, description: step.description })}`;
  return `检查 ${JSON.stringify(step)}`;
}

export type TechnicalFact = {
  id: string;
  properties: Record<string, string>;
  /** Only declared semantic alternatives can contradict a fact. Identity metadata is read-only. */
  expectations?: Record<string, readonly string[]>;
  evidenceHash: string;
};

export function technicalExpectationValues(fact: TechnicalFact, property: string) {
  const actual = fact.properties[property];
  return actual === undefined ? [] : [...new Set([actual, ...(fact.expectations?.[property] ?? [])])];
}
export function assertTechnicalExpectation(fact: TechnicalFact | undefined, property: string, expected: unknown): asserts expected is string {
  if (!fact || typeof expected !== "string" || !technicalExpectationValues(fact, property).includes(expected))
    throw new Error("技术期望缺少宿主属性和值类型绑定；身份与基线元数据不能证明业务能力冲突");
}
export type TechnicalDecision = {
  issue: RequirementReview["issues"][number];
  factId: string;
  factHash: string;
  property: string;
  expected: string;
  actual?: string;
  outcome: "satisfied" | "conflict" | "unsupported";
};
/** Known aspects are facts, not pending questions. Only independent unresolved judgments create choices. */
export function semanticChoiceTargets(
  plan: Pick<InvestigatedPlan, "requirements" | "workflowRules" | "binding">,
) {
  return (plan.requirements ?? []).flatMap((r) => [
    ...plan.workflowRules.map((f) => ({
      id: `business-choice:input-required:${r.id}:${f.key}`,
      requirementId: r.id,
      aspect: "required" as const,
      subject: `workflow:${f.key}`,
      question: `${f.label}是必填还是选填？`,
    })),
    ...(r.obligations ?? []).flatMap((o) =>
      o.kind === "assertion" && o.expected.kind === "action-visible" && !isInheritedAvailability(o,plan.binding?.actionAvailability)
        ? [
            {
              id: `business-choice:action-availability:${o.id}`,
              requirementId: r.id,
              aspect: "action-availability" as const,
              subject: o.id,
              question: `从新建任务开始${o.steps.length ? `，依次${o.steps.map(clarificationStep).join("，再")}` : "，尚未执行任何动作"}；此时成员“${o.expected.member}”${o.expected.contribution ? `的界面“${o.expected.contribution}”` : ""}是否应显示“${o.expected.action}”动作？`,
            },
          ]
        : [],
    ),
  ]);
}
export function businessChoices(
  plan: Pick<InvestigatedPlan, "requirements" | "workflowRules" | "binding">,
  review?: Pick<RequirementReview, "fieldDecisions" | "unresolvedChoices">,
): {
  id: string;
  requirementId: string;
  question: string;
  obligationId?: string;
}[] {
  const targets = semanticChoiceTargets(plan);
  return [
    ...(review?.unresolvedChoices ?? []).map((c) => {
      const target = targets.find((t) => t.id === c.targetId);
      if (!target) throw new Error("未决语义目标不存在");
      return target;
    }),
    ...(plan.requirements ?? []).flatMap((r) =>
      (r.obligations ?? []).flatMap((o) =>
        o.kind === "field" &&
        review?.fieldDecisions?.some(
          (d) => d.obligationId === o.id && d.initial.kind === "undetermined",
        )
          ? [
              {
                id: `business-choice:initial-display:${r.id}:${o.id}`,
                requirementId: r.id,
                obligationId: o.id,
                question: `尚未填写 ${o.field} 时，详情应显示什么？`,
              },
            ]
          : [],
      ),
    ),
  ];
}
/** The wording is not an identity: identical questions can concern different operations. */
export function semanticChoiceProof(plan:Pick<InvestigatedPlan,"requirements"|"workflowRules"|"binding">,id:string) {
  const target=semanticChoiceTargets(plan).find(t=>t.id===id);
  if(!target)throw new Error("业务选择缺少宿主目标");
  const requirement=plan.requirements!.find(r=>r.id===target.requirementId)!;
  return {proof:{id,hash:hash({target,requirement,rules:plan.workflowRules})},requirement,aspect:target.aspect,subject:target.subject};
}
/** A review cannot send arbitrary wording to the user. Questions are host projections. */
export function reviewQuestion(
  review: RequirementReview,
  plan: Pick<InvestigatedPlan, "requirements" | "workflowRules" | "binding">,
): string | undefined {
  const choices = businessChoices(plan, review);
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
    if (
      !choice &&
      (plan.requirements ?? []).some(
        (r) =>
          r.id === issue.target?.subject &&
          (r.obligations ?? []).some(
            (o) =>
              o.kind === "field" &&
              issue.clarificationChoice ===
                `business-choice:initial-display:${r.id}:${o.id}` &&
              review.fieldDecisions?.some(
                (d) =>
                  d.obligationId === o.id && d.initial.kind !== "undetermined",
              ),
          ),
      )
    )
      continue;
    if (!choice)
      throw new Error(
        "复核澄清缺少宿主业务选项目录绑定；自由文本及技术问题不能直接提问",
      );
    if (choice.obligationId) {
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
        (c) => c.obligationId === decision.obligationId,
      )?.question;
  return question;
}
export function technicalFacts(
  plan: Pick<InvestigatedPlan, "workflowRules" | "binding"> & Partial<Pick<InvestigatedPlan,"requirements" | "requestAdmission">> & {actionAvailability?:ActionAvailability;fieldIdentities?:FieldIdentity[]; capabilities?: import("../server/planning.js").Investigation["capabilities"]},
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
      properties: Object.fromEntries(workflowCheckerRules.map((rule) => [rule.property, rule.value])),
      expectations: {
        validationNormalization: ["trim", "none"],
        persistenceNormalization: ["trim", "preserve"],
        lengthMetric: ["unicode-code-point", "utf16-code-unit", "grapheme-cluster", "utf8-byte"],
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
      expectations: { auxiliaryMissingField: [readOnlyFieldText(undefined), ""] },
    },
    {
      id: "host-fact:field-interaction",
      properties: {
        detail: "read-only-display",
        editing: "explicit-action-input-form",
        source: "TaskEditor-and-TaskDetailContributions-and-ActionForm",
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
        definition: "host-compiled-rules-and-obligations",
        requiredEmpty: "native-valueMissing-without-command-or-alert",
        whitespace: "business-feedback-after-submit",
        manualCases: "not-authorized-in-planning-tool",
      },
    },
    {
      id: "host-fact:write-scope",
      properties: {
        activation: "no-business-data-write",
        action: "explicit-command-only",
        historicalPreparation: "baseline-replay-not-candidate-action",
      },
    },
    ...(plan.binding?.checkers.filter(c => c.id === "schedule/1").map(checker => ({
      id: "host-fact:checker:schedule/1",
      properties: {
        checker: checker.id,
        checkerHash: checker.version,
        stage: "candidate-verification-required",
        execution: scheduleCheckSemantics.execution,
        scope: "实际候选登记的每个字段型调度；须绑定设置截止与到期动作的冻结成功案例；此事实不代表候选已通过",
        ...Object.fromEntries(Object.entries(scheduleCheckSemantics.assertions).map(([id, meaning]) => [`assert:${id}`, meaning])),
        ...Object.fromEntries(Object.entries(schedulePolicySemantics).map(([id, meaning]) => [`policy:${id}`, `仅绑定对应冻结时序义务时执行：${meaning}`])),
        limits: scheduleCheckSemantics.limits,
      },
      expectations: {execution: [scheduleCheckSemantics.execution, "manual-action-only"]},
    })) ?? []),
    ...plan.workflowRules.map((rule) => ({
      id: `host-fact:workflow-field:${rule.key}`,
      properties: {
        required: String(rule.required),
        minimum: String(rule.minLength),
        maximum: String(rule.maxLength),
        lengthMetric: workflowTextSemantics.lengthMetric,
      },
    })),
    ...(plan.requirements??[]).flatMap(r=>(r.obligations??[]).flatMap(o=>o.kind==="feedback" ? [{
      id:`host-fact:feedback:${o.id}`,
      properties:{executable:String(o.scenarios.length>0&&!o.unavailable.length),failureCodes:o.unavailable.map(d=>d.code).join(","),sourceDecision:"independent-review-required",backendRejection:"separate-frozen-checker"},
    }] : [])),
    ...(plan.requirements??[]).flatMap(r=>(r.obligations??[]).flatMap(o=>o.kind==="assertion"&&o.expected.kind==="action-visible"&&isInheritedAvailability(o,plan.binding?.actionAvailability)?[{
      id:`host-fact:action-availability:${o.id}`,
      properties:{visible:String(o.expected.visible),state:o.availability!.state,origin:"host-baseline-preservation",baselineHash:plan.binding!.actionAvailability!.hash},
    }]:[])),
  ];
  return [...facts.map((f) => ({
    ...f,
    evidenceHash: hash({
      fact: f,
      checkers: plan.binding?.checkers ?? [],
      rules: plan.workflowRules,
    }),
  })),...availabilityFacts(plan.binding?.actionAvailability??plan.actionAvailability),...fieldFacts(plan.binding?.fieldIdentities??plan.fieldIdentities??[]),...(plan.capabilities ? capabilityFacts(plan.capabilities) : plan.requestAdmission?.factsSnapshot.filter(f => f.id.startsWith("host-fact:effect:")) ?? capabilityFacts())];
}

/** The host binds each property once; reviewers cannot construct fact/property pairs. */
export function technicalReviewTargets(plan: Parameters<typeof technicalFacts>[0]) {
  return technicalFacts(plan).flatMap((fact) =>
    Object.entries(fact.properties)
      .filter(([property])=>technicalExpectationValues(fact,property).length>1)
      .map(([property, actual]) => ({
      factId: fact.id,
      property,
      actual,
      expectedValues: technicalExpectationValues(fact, property),
      evidenceHash: fact.evidenceHash,
    })),
  ).map((target, index) => ({ target: index + 1, ...target }));
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
    if (actual !== undefined) assertTechnicalExpectation(fact, claim.property, claim.expected);
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
