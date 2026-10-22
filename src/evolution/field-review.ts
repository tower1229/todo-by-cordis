import {
  initialMeaningSchema,
  parseInitialMeaning,
  type InitialMeaning,
} from "./requirement-semantics.js";
import type {
  InvestigatedPlan,
  RequirementReview,
} from "../shared/assistant.js";
import type { FieldExpectation } from "../shared/acceptance-obligations.js";
import { hash } from "../release/storage.js";

export type FieldDecision = {
  meaning?: InitialMeaning;
  obligationId: string;
  sourceRevision: string;
  sourceQuote: string;
  initial: FieldExpectation | { kind: "unspecified" | "undetermined" };
};
export function fieldReviewTargets(
  plan: Pick<InvestigatedPlan, "requirements">,
  sources: { id: string; text: string }[] = [],
) {
  const targets = new Map<
    string,
    {
      obligationId: string;
      field: string;
      sources: { requirementId: string; revision: string; quote: string }[];
    }
  >();
  for (const r of plan.requirements ?? [])
    for (const o of r.obligations ?? []) {
      if (o.kind !== "field") continue;
      const target = targets.get(o.id) ?? {
        obligationId: o.id,
        field: o.field,
        sources: [],
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
export function fieldReviewSchema(
  plan: Pick<InvestigatedPlan, "requirements">,
) {
  const count = fieldReviewTargets(plan).length;
  return {
    type: "array",
    minItems: count,
    maxItems: count,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["target", "source", "sourceQuote", "initial"],
      properties: {
        target: { type: "integer", minimum: 1, maximum: Math.max(count, 1) },
        source: { type: "integer", minimum: 1 },
        sourceQuote: { type: "string" },
        initial: initialMeaningSchema,
      },
    },
    description:
      "逐个 fieldReviewTargets 独立解释用户来源的初始呈现要求；state 只表示业务逻辑初始值，由宿主视为没有额外初始呈现要求；没有要求时用 unspecified，只有真实未决业务选择才用 undetermined。target/source 为各目录一基序号，不能从计划初始值反推用户要求。宿主比较该解释与可执行义务，issues=[]不能替代这些判断。",
  };
}
function row(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v))
    throw new Error("独立字段解释结构无效");
  return v as Record<string, unknown>;
}
export function parseFieldDecisions(
  value: unknown,
  plan: Pick<InvestigatedPlan, "requirements">,
  sources: { id: string; text: string }[] = [],
): { decisions: FieldDecision[]; issues: RequirementReview["issues"] } {
  const targets = fieldReviewTargets(plan, sources);
  if (!Array.isArray(value) || value.length !== targets.length)
    throw new Error("独立复核缺少逐字段初始语义解释，不能自报完整");
  const seen = new Set<number>();
  const issues: RequirementReview["issues"] = [];
  const decisions = value.map((v) => {
    const r = row(v);
    const index = Number(r.target) - 1;
    const sourceIndex = Number(r.source) - 1;
    if (
      Object.keys(r).some(
        (k) => !["target", "source", "sourceQuote", "initial"].includes(k),
      )
    )
      throw new Error("独立字段解释包含宿主派生字段");
    if (
      !Number.isInteger(r.target) ||
      !Number.isInteger(r.source) ||
      seen.has(index)
    )
      throw new Error("独立字段解释引用无效或重复");
    seen.add(index);
    const target = targets[index];
    const source = target?.sources[sourceIndex];
    if (
      !source ||
      typeof r.sourceQuote !== "string" ||
      !r.sourceQuote.trim() ||
      !source.quote.includes(r.sourceQuote)
    )
      throw new Error("独立字段解释来源不存在");
    const { initial, meaning } = parseInitialMeaning(r.initial, source.quote);
    const decision: FieldDecision = {
      obligationId: target.obligationId,
      sourceRevision: source.revision,
      sourceQuote: r.sourceQuote,
      initial,
      meaning,
    };
    for (const requirement of plan.requirements ?? [])
      for (const o of requirement.obligations ?? []) {
        if (o.kind !== "field" || o.id !== target.obligationId) continue;
        const matches =
          initial.kind === "unspecified"
            ? o.initialOrigin === "host"
            : o.initialOrigin === "requirement" &&
              hash(initial) === hash(o.initial);
        if (!matches)
          issues.push({
            kind:
              initial.kind === "undetermined"
                ? "unverifiable"
                : initial.kind === "unspecified"
                  ? "extra-constraint"
                  : "omission",
            sourceRevision: decision.sourceRevision,
            sourceQuote: decision.sourceQuote,
            sourceDecision: { kind: "field-initial", obligationId: o.id, interpretationHash: hash(decision) },
            target: { subject: requirement.id, aspect: "visibility" },
            stance: "required",
            detail: `宿主比较独立来源解释与字段义务不一致：${o.field}；来源初始语义 ${JSON.stringify(initial)}，计划 ${o.initialOrigin}:${JSON.stringify(o.initial)}`,
          });
      }
    return decision;
  });
  return { decisions, issues };
}
