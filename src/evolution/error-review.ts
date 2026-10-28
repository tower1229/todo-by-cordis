import type {
  InvestigatedPlan,
  RequirementReview,
} from "../shared/assistant.js";
import { obligationCases } from "../shared/acceptance-obligations.js";
import { hash } from "../release/storage.js";
import { schemaProblems } from "./model-protocol.js";
type Sources = { id: string; text: string }[];
export type ErrorDecision = {
  obligationId: string;
  sourceRevision: string;
  sourceQuote: string;
  text: string;
  feedback: "required" | "not-requested" | "undetermined";
  effectQuote: string;
};
export function errorReviewTargets(
  plan: Pick<InvestigatedPlan, "requirements">,
  sources: Sources = [],
) {
  const targets = new Map<
    string,
    {
      obligationId: string;
      sources: { requirementId: string; revision: string; quote: string }[];
      planned: unknown;
    }
  >();
  for (const r of plan.requirements ?? [])
    for (const o of r.obligations ?? []) {
      if (
        o.kind !== "feedback" &&
        (o.kind !== "assertion" || o.expected.kind !== "error")
      )
        continue;
      const target = targets.get(o.id) ?? {
        obligationId: o.id,
        sources: [],
        planned: o,
      };
      if (!target.sources.some((s) => s.revision === r.sourceRevision))
        target.sources.push({
          requirementId: r.id,
          revision: r.sourceRevision,
          quote:
            sources.find((s) => s.id === r.sourceRevision)?.text ??
            r.sourceQuote,
        });
      targets.set(o.id, target);
    }
  return [...targets.values()];
}
export function errorReviewSchema(
  plan: Pick<InvestigatedPlan, "requirements">,
) {
  const targets = errorReviewTargets(plan);
  const decision = (index: number, sourceCount: number) => ({
    type: "object",
    additionalProperties: false,
    required: [
      "target",
      "source",
      "sourceQuote",
      "feedback",
      "effectQuote",
      "text",
    ],
    properties: {
      target: { type: "integer", enum: [index + 1] },
      source: { type: "integer", minimum: 1, maximum: sourceCount },
      sourceQuote: { type: "string", minLength: 1 },
      feedback: {
        type: "string",
        enum: ["required", "not-requested", "undetermined"],
      },
      effectQuote: { type: "string", maxLength: 10000 },
      text: { type: "string", maxLength: 10000 },
    },
  });
  return {
    type: "array",
    minItems: targets.length,
    maxItems: targets.length,
    items: targets.length
      ? { anyOf: targets.map((target, index) => decision(index, target.sources.length)) }
      : decision(0, 1),
    description:
      "逐项独立解释页面错误反馈是否来自用户要求。feedback=required 时 effectQuote 引用要求页面反馈的连续原文；只说不可执行或后端拒绝不能推出页面报错，未要求页面反馈用 not-requested，真实歧义用 undetermined。后两者 effectQuote/text 为空。required 且未限定具体文字时 text 为空，只检查可见错误；明确限定时返回原文字面文字。不能由计划反推来源、把字段标签当提示或用按钮隐藏代替后端拒绝。target 是 errorReviewTargets 一基序号；source 只选该目标 sources 中的 source 值，由 sourceRevision 查找完整原文，不使用顶层 sources 的全局位置。",
  };
}
export function parseErrorDecisions(
  value: unknown,
  plan: Pick<InvestigatedPlan, "requirements">,
  sources: Sources,
) {
  const targets = errorReviewTargets(plan, sources);
  if (!targets.length && value === undefined)
    return { decisions: [], issues: [] };
  const problems = schemaProblems(value, errorReviewSchema(plan));
  if (problems.length)
    throw new Error("独立错误文案解释不完整：" + problems.join("；"));
  const seen = new Set<number>();
  const issues: RequirementReview["issues"] = [];
  const decisions = (
    value as {
      target: number;
      source: number;
      sourceQuote: string;
      text: string;
      feedback: ErrorDecision["feedback"];
      effectQuote: string;
    }[]
  ).map((raw) => {
    const target = targets[raw.target - 1];
    const source = target?.sources[raw.source - 1];
    if (
      !source ||
      seen.has(raw.target) ||
      !raw.sourceQuote.trim() ||
      !source.quote.includes(raw.sourceQuote) ||
      (raw.text && !raw.sourceQuote.includes(raw.text)) ||
      (raw.feedback === "required"
        ? !raw.effectQuote.trim() || !raw.sourceQuote.includes(raw.effectQuote)
        : !!raw.effectQuote || !!raw.text)
    )
      throw new Error("独立错误文案解释来源无效或重复");
    seen.add(raw.target);
    const decision: ErrorDecision = {
      obligationId: target.obligationId,
      sourceRevision: source.revision,
      sourceQuote: raw.sourceQuote,
      text: raw.text,
      feedback: raw.feedback,
      effectQuote: raw.effectQuote,
    };
    for (const r of plan.requirements ?? [])
      for (const o of r.obligations ?? []) {
        if (o.id !== target.obligationId) continue;
        if (
          o.kind !== "feedback" &&
          (o.kind !== "assertion" || o.expected.kind !== "error")
        )
          continue;
        const plannedText =
          o.kind === "feedback"
            ? o.text
            : o.expected.kind === "error"
              ? o.expected.text
              : "";
        const mismatch =
          o.kind === "feedback" && o.resolution === "pending"
            ? (raw.feedback === "required" && plannedText !== raw.text) ||
              raw.feedback === "undetermined"
            : o.kind === "feedback"
              ? raw.feedback !== o.resolution ||
                (raw.feedback === "required" && plannedText !== raw.text)
              : raw.feedback !== "required" || plannedText !== raw.text;
        // Previously accepted feedback cannot disappear on a later interpretation.
        const frozenMismatch =
          o.kind === "feedback" &&
          o.resolution !== "pending" &&
          o.resolution !== raw.feedback;
        if (!mismatch && !frozenMismatch) continue;
        issues.push({
          kind:
            raw.feedback === "undetermined"
              ? "unverifiable"
              : frozenMismatch
                ? "conflict"
                : raw.text
                  ? "omission"
                  : "extra-constraint",
          sourceRevision: source.revision,
          sourceQuote: raw.sourceQuote,
          target: { subject: r.id, aspect: "meaning" },
          stance: "required",
          detail: `页面反馈或错误文案与独立来源解释不一致；反馈 ${raw.feedback}，来源文字 ${JSON.stringify(raw.text)}，计划 ${JSON.stringify(plannedText)}。空文字仅表示不限定错误文案，不能代替未要求反馈。`,
        });
      }
    return decision;
  });
  return { decisions, issues };
}

/** Resolve only newly proposed feedback; frozen obligations never lose assertions. */
export function resolveErrorFeedback(
  plan: Pick<InvestigatedPlan, "requirements" | "browserCases">,
  review: RequirementReview,
) {
  for (const r of plan.requirements ?? [])
    for (const o of r.obligations ?? []) {
      if (o.kind !== "feedback" || o.resolution !== "pending") continue;
      const decision = review.errorDecisions?.find(
        (d) => d.obligationId === o.id,
      );
      if (!decision || decision.feedback === "undetermined") continue;
      o.resolution = decision.feedback;
      for (const c of obligationCases(o)) {
        const old = plan.browserCases?.find((b) => b.id === c.id);
        if (old && hash(old) !== hash(c))
          throw new Error("页面反馈案例身份冲突");
        if (!old) (plan.browserCases ??= []).push(c);
        if (
          !r.checks.some(
            (ref) => ref.checker === "browser/1" && ref.caseId === c.id,
          )
        )
          r.checks.push({ checker: "browser/1", caseId: c.id });
      }
    }
}
export function feedbackConflicts(
  plan: Pick<InvestigatedPlan, "requirements">,
) {
  return (plan.requirements ?? []).flatMap((r) =>
    (r.obligations ?? []).flatMap((o) =>
      o.kind === "feedback" && o.resolution !== "not-requested"
        ? (o.unavailable.length
            ? o.unavailable
            : o.scenarios.length
              ? []
              : [{ code: "missing-rejection" as const }]
          ).map((d) => ({
            requirementId: r.id,
            obligationId: o.id,
            action: o.action,
            ...d,
          }))
        : [],
    ),
  );
}
