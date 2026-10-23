import { defaultAuthorizes, parseDefaultReviews } from "./interaction.js";
import { hash } from "../release/storage.js";
import type {
  InvestigatedPlan,
  RequirementReview,
} from "../shared/assistant.js";
import { semanticChoiceTargets } from "./technical-facts.js";
import { schemaProblems } from "./model-protocol.js";
import { inheritedAvailability } from "./action-availability.js";

type Sources = { id: string; text: string }[];
export type DesignDecision = {
  targetId: string;
  targetHash: string;
  sourceRevision: string;
  sourceQuote: string;
  permission: "delegated" | "not-delegated";
  /** A binary visibility choice is the only design freedom supported by this contract. */
  allowed: boolean[];
};

/** Scope comes from executable identities and preparation, never from a reviewer's prose. */
export function designTargets(
  plan: Pick<InvestigatedPlan, "requirements" | "workflowRules" | "binding">,
) {
  return semanticChoiceTargets(plan).flatMap((choice) => {
    if (choice.aspect !== "action-availability") return [];
    const requirement = plan.requirements!.find(
      (r) => r.id === choice.requirementId,
    )!;
    const obligation = requirement.obligations?.find(
      (o) => o.id === choice.subject,
    );
    if (
      obligation?.kind !== "assertion" ||
      obligation.expected.kind !== "action-visible"
    )
      return [];
    const scope = {
      kind: "action-availability" as const,
      member: obligation.expected.member,
      action: obligation.expected.action,
      ...(obligation.expected.contribution
        ? { contribution: obligation.expected.contribution }
        : {}),
      preparation: structuredClone(obligation.steps),
    };
    const body = {
      id: choice.id,
      requirementId: requirement.id,
      baselineHash: hash(plan.binding),
      scope,
      selected: obligation.expected.visible,
    };
    return [{ ...body, hash: hash(body) }];
  });
}

export function designDecisionSchema(
  plan: Parameters<typeof designTargets>[0],
  sources: Sources,
) {
  const targets = designTargets(plan);
  return {
    type: "array",
    maxItems: targets.length,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["target", "source", "quote", "permission"],
      description:
        "只裁决原文明示的设计授权。delegated要求原文允许该作用域的两种可见性选择；未要求、没有禁止、技术事实和生成矩阵均不构成授权。",
      properties: {
        target: { type: "integer", minimum: 1, maximum: targets.length },
        source: { type: "integer", minimum: 1, maximum: sources.length },
        quote: { type: "string", minLength: 1, maxLength: 10000 },
        permission: { type: "string", enum: ["delegated", "not-delegated"] },
      },
    },
  };
}

export function parseDesignDecisions(
  value: unknown,
  plan: Parameters<typeof designTargets>[0],
  sources: Sources,
): DesignDecision[] {
  const raw: unknown = value ?? [];
  const problems = schemaProblems(raw, designDecisionSchema(plan, sources));
  if (problems.length)
    throw new Error("设计授权契约无效：" + problems.join("；"));
  const targets = designTargets(plan);
  const seen = new Set<string>();
  return (
    raw as {
      target: number;
      source: number;
      quote: string;
      permission: DesignDecision["permission"];
    }[]
  ).map((d) => {
    const target = targets[d.target - 1],
      source = sources[d.source - 1];
    if (
      !target ||
      !source ||
      !source.text.includes(d.quote) ||
      !d.quote.trim() ||
      seen.has(target.id)
    )
      throw new Error("设计授权缺少唯一作用域或真实来源");
    seen.add(target.id);
    return {
      targetId: target.id,
      targetHash: target.hash,
      sourceRevision: source.id,
      sourceQuote: d.quote,
      permission: d.permission,
      allowed: d.permission === "delegated" ? [false, true] : [],
    };
  });
}

export function designAuthorized(
  plan: Parameters<typeof designTargets>[0],
  review: Pick<RequirementReview, "designDecisions">,
  targetId: string,
) {
  const target = designTargets(plan).find((t) => t.id === targetId);
  return (
    !!target &&
    review.designDecisions?.some(
      (d) =>
        d.targetId === target.id &&
        d.targetHash === target.hash &&
        d.permission === "delegated" &&
        hash(d.allowed) === hash([false, true]),
    ) === true
  );
}

/** A small, host-compiled authority ledger; this is not a proof of natural-language entailment. */
export function compileAuthority(plan: InvestigatedPlan) {
  const targets = designTargets(plan);
  const decisions = plan.designDecisions ?? [];
  for (const d of decisions) {
    const target = targets.find((t) => t.id === d.targetId);
    if (
      !target ||
      target.hash !== d.targetHash ||
      hash(d.allowed) !==
        hash(d.permission === "delegated" ? [false, true] : [])
    )
      throw new Error("设计授权的作用域、取值范围或基础版本已变化");
  }
  return {
    version: "scoped-contract/1" as const,
    propositions: [
      ...plan.workflowRules.map((rule) => ({
        id:
          "proposition-" +
          hash({
            member: "workflow",
            action: "complete",
            field: rule.key,
          }).slice(0, 24),
        scope: {
          kind: "action-input" as const,
          member: "workflow",
          action: "complete",
          field: rule.key,
        },
        predicate: {
          required: rule.required,
          minLength: rule.minLength,
          maxLength: rule.maxLength,
        },
        authority: "business-specification" as const,
      })),
      ...targets.map((t) => ({
        id: t.id,
        scope: t.scope,
        predicate: { visible: t.selected },
        authority: defaultAuthorizes(plan.defaultReviews, t.id) ? ("reviewed-default" as const) : designAuthorized(plan, { designDecisions: decisions }, t.id)
          ? ("authorized-design" as const)
          : ("business-specification" as const),
      })),
    ],
    defaultReviews: structuredClone(plan.defaultReviews ?? []),
    designDecisions: structuredClone(decisions),
    inputObligations: (plan.memberCases ?? []).map((c) => ({
      scope: {
        kind: "action-input" as const,
        member: c.member,
        action: c.action,
        state: c.state,
        fields: Object.keys(c.input).sort(),
      },
      check: {
        checker: "workspace/1",
        caseId: `member:${c.member}:${c.name}`,
        definitionHash: hash(c),
      },
      requirements: (plan.requirements ?? [])
        .filter((r) =>
          r.checks.some(
            (ref) =>
              ref.checker === "workspace/1" &&
              ref.caseId === `member:${c.member}:${c.name}`,
          ),
        )
        .map((r) => r.id),
      meaning: "frozen-input-case-not-global-field-presence" as const,
    })),
    factDerivations: (plan.requirements ?? []).flatMap((r) =>
      (r.obligations ?? []).flatMap((o) => {
        const derived = inheritedAvailability(
          o,
          plan.binding?.actionAvailability,
        );
        if (
          !derived ||
          o.kind !== "assertion" ||
          o.expected.kind !== "action-visible"
        )
          return [];
        const body = {
          rule: "baseline-action-preservation/1" as const,
          obligationId: o.id,
          baselineHash: plan.binding!.actionAvailability!.hash,
          scope: {
            member: o.expected.member,
            action: o.expected.action,
            state: derived.state,
          },
          conclusion: { visible: o.expected.visible },
        };
        return [{ ...body, hash: hash(body) }];
      }),
    ),
    factPolicy:
      "facts-require-scoped-derivation;mechanism-is-not-business-authority" as const,
  };
}

export function authorityFailure(
  plan: InvestigatedPlan,
  sources: Sources,
  review: RequirementReview,
) {
  try {
    if (hash(plan.defaultReviews ?? []) !== hash(review.defaultReviews ?? [])) return "默认处理与冻结独立复核不一致，请重新规划";
    if (plan.defaults?.length) {
      const defaults = parseDefaultReviews(review.defaultReviews, plan.defaults, [...new Set((review.defaultReviews ?? []).flatMap(r => r.targets))]);
      if (defaults.some(d => d.verdict !== "safe-default")) return "默认处理尚未通过独立复核";
    }
    if (hash(plan.designDecisions ?? []) !== hash(review.designDecisions ?? []))
      return "设计授权与冻结独立复核不一致，请重新规划";
    const targets = designTargets(plan);
    const replay = parseDesignDecisions(
      (review.designDecisions ?? []).map((d) => ({
        target: targets.findIndex((t) => t.id === d.targetId) + 1,
        source: sources.findIndex((s) => s.id === d.sourceRevision) + 1,
        quote: d.sourceQuote,
        permission: d.permission,
      })),
      plan,
      sources,
    );
    if (
      hash(replay) !== hash(review.designDecisions ?? []) ||
      hash(compileAuthority(plan)) !== hash(plan.changeSpec?.authority)
    )
      return "冻结命题作用域或设计授权证据失效，请重新规划";
  } catch {
    return "命题作用域、设计授权或来源已变化，请重新规划";
  }
}
