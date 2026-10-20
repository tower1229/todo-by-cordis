import { hash } from "../release/storage.js";
import { schemaProblems } from "./model-protocol.js";
import type {
  InvestigatedPlan,
  RequirementReview,
} from "../shared/assistant.js";
import type { FieldExpectation } from "../shared/acceptance-obligations.js";
import { isInheritedAvailability } from "./action-availability.js";
import { admissionFieldTargets } from "./field-identity.js";

export const semanticQuestionKey = (
  question: string,
  sourceHash: string,
  factsHash: string,
) => hash({ question, sourceHash, factsHash });

export type SemanticSource = { id: string; text: string };
export type InitialMeaning =
  | { kind: "unspecified" }
  | { kind: "undetermined"; questionQuote: string }
  | { kind: "blank" | "hidden"; conditionQuote: string; effectQuote: string }
  | {
      kind: "literal" | "state";
      value: string;
      conditionQuote: string;
      effectQuote: string;
    };
export type InitialDecision =
  | FieldExpectation
  | { kind: "unspecified" | "undetermined" };
const text = { type: "string", minLength: 1, maxLength: 10000 };
const variant = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
/** Source intent is distinct from executable fields; blank has no model-authored value. */
export const initialMeaningSchema = {
  anyOf: [
    variant({ kind: { type: "string", enum: ["unspecified"] } }),
    variant({
      kind: { type: "string", enum: ["undetermined"] },
      questionQuote: text,
    }),
    ...["blank", "hidden"].map((kind) =>
      variant({
        kind: { type: "string", enum: [kind] },
        conditionQuote: text,
        effectQuote: text,
      }),
    ),
    variant({
      kind: { type: "string", enum: ["literal", "state"] },
      value: text,
      conditionQuote: text,
      effectQuote: text,
    }),
  ],
  description:
    "分层解释字段初始语义：state=业务初始逻辑值，不承诺字段存储或页面如何显示；literal=初始显示指定非空文字；blank=显示空白；hidden=不显示字段；unspecified=没有初始要求；undetermined=真实未决选择。字段名、必填性及动作后值不是初始呈现。明确要求分别引用条件与效果原文。",
};
export function parseInitialMeaning(
  value: unknown,
  source: string,
): { meaning: InitialMeaning; initial: InitialDecision } {
  const problems = schemaProblems(value, initialMeaningSchema);
  if (problems.length)
    throw new Error("初始语义缺少完整命题：" + problems.join("；"));
  const meaning = value as InitialMeaning;
  const quotes =
    meaning.kind === "undetermined"
      ? [meaning.questionQuote]
      : meaning.kind === "unspecified"
        ? []
        : [meaning.conditionQuote, meaning.effectQuote];
  if (quotes.some((q) => !source.includes(q)))
    throw new Error("初始语义引用不存在的条件或效果原文");
  const initial: InitialDecision =
    meaning.kind === "blank"
      ? { kind: "visible", value: "" }
      : meaning.kind === "hidden"
        ? { kind: "absent" }
        : meaning.kind === "literal"
          ? { kind: "visible", value: meaning.value }
          : meaning.kind === "state" ? { kind: "unspecified" } : { kind: meaning.kind };
  return { meaning, initial };
}
export type SemanticEntry = {
  id: string;
  target: {
    subject: string;
    aspect:
      | "label"
      | "required"
      | "initial-display"
      | "initial-state"
      | "post-action-value"
      | "preservation"
      | "action-availability"
      | "operation-rejection"
      | "error-feedback"
      | "choice";
  };
  status: "specified" | "unspecified" | "undetermined" | "conflicting";
  origin: "requirement" | "host" | "implementation";
  value?: unknown;
  evidence: { sourceRevision: string; sourceQuote: string }[];
};
export type SemanticState = {
  version: 1;
  sourceHash: string;
  dependencies: { id: string; hash: string }[];
  entries: SemanticEntry[];
};
export type SemanticPlan = Pick<
  InvestigatedPlan,
  | "requirements"
  | "workflowRules"
  | "requestAdmission"
  | "questionAdjudications"
  | "binding"
>;
/** Host projections give each aspect a separate identity; no inference from label to initial value. */
export function compileSemantics(
  plan: SemanticPlan,
  sources: SemanticSource[],
  review?: RequirementReview,
): SemanticState {
  const entries: SemanticEntry[] = [];
  const add = (
    target: SemanticEntry["target"],
    status: SemanticEntry["status"],
    origin: SemanticEntry["origin"],
    value: unknown,
    evidence: SemanticEntry["evidence"],
  ) => {
    const id = "semantic-" + hash(target).slice(0, 24);
    const old = entries.find((e) => e.id === id);
    if (old) {
      if (
        hash({ status: old.status, value: old.value }) !==
        hash({ status, value })
      )
        old.status = "conflicting";
      for (const e of evidence)
        if (!old.evidence.some((p) => hash(p) === hash(e)))
          old.evidence.push(e);
    } else
      entries.push({
        id,
        target,
        status,
        origin,
        ...(value === undefined ? {} : { value }),
        evidence,
      });
  };
  for (const interpretation of plan.requestAdmission?.initialMeanings ?? []) {
    const claim = plan.requestAdmission?.claims.find(
      (c) =>
        c.interpretation.intentId === interpretation.id,
    );
    const judgment = plan.requestAdmission?.semanticReview?.decisions.find(
      (d) => d.claimId === claim?.id,
    );
    if (judgment?.verdict === "entailed" && judgment.layer === "initial-state") {
      const value = interpretation.meaning;
      if (value.kind !== "literal" && value.kind !== "state")
        throw new Error("业务初始状态缺少逻辑值");
      add({ subject: interpretation.target?.targetId ?? `source:${interpretation.field}`, aspect: "initial-state" }, "specified", "requirement", value.value,
        [{ sourceRevision: interpretation.sourceRevision, sourceQuote: interpretation.sourceQuote }]);
      continue;
    }
    let initial: InitialDecision =
      judgment?.verdict === "not-requested"
        ? { kind: "unspecified" }
        : interpretation.initial;
    if (initial.kind === "undetermined") {
      const key = semanticQuestionKey(
        `尚未填写 ${interpretation.field} 时，应显示什么？`,
        plan.requestAdmission!.sourceHash,
        plan.requestAdmission!.factsHash,
      );
      if (
        plan.questionAdjudications?.some(
          (d) => !d.choice && d.key === key && (d.decision.kind === "unnecessary" || d.decision.kind === "implementation"),
        )
      )
        initial = { kind: "unspecified" };
    }
    const identities = admissionFieldTargets(
      plan,
      interpretation,
      plan.requestAdmission!.fieldCatalog,
    );
    const subject =
      identities.length === 1
        ? identities[0]
        : `source:${interpretation.surface}:${interpretation.field}`;
    const status =
      judgment?.verdict === "uncertain" ||
      (initial.kind !== "unspecified" &&
        initial.kind !== "undetermined" &&
        identities.length !== 1)
        ? "conflicting"
        : initial.kind === "unspecified"
          ? "unspecified"
          : initial.kind === "undetermined"
            ? "undetermined"
            : "specified";
    add(
      { subject, aspect: "initial-display" },
      status,
      "requirement",
      status === "specified" ? initial : undefined,
      [
        {
          sourceRevision: interpretation.sourceRevision,
          sourceQuote: interpretation.sourceQuote,
        },
      ],
    );
  }
  for (const q of plan.requestAdmission?.questions ?? []) {
    const judgment = plan.questionAdjudications?.find(
      (d) =>
        !d.choice &&
        d.key ===
        semanticQuestionKey(
          q.question,
          plan.requestAdmission!.sourceHash,
          plan.requestAdmission!.factsHash,
        ),
    )?.decision;
    add(
      { subject: hash(q.question), aspect: "choice" },
      judgment?.kind === "unnecessary" || judgment?.kind === "implementation"
        ? "unspecified"
        : judgment?.kind === "business-ambiguity"
          ? "undetermined"
          : judgment?.kind === "technical" &&
              judgment.fact?.expected === judgment.fact?.actual
            ? "specified"
            : "conflicting",
      "requirement",
      q.question,
      [{ sourceRevision: q.sourceRevision, sourceQuote: q.sourceQuote }],
    );
  }
  for (const field of plan.workflowRules) {
    add(
      { subject: `workflow:${field.key}`, aspect: "label" },
      "specified",
      "implementation",
      field.label,
      [],
    );
    add(
      { subject: `workflow:${field.key}`, aspect: "required" },
      "specified",
      "requirement",
      field.required,
      (plan.requirements ?? [])
        .filter((r) =>
          r.obligations?.some(
            (o) =>
              o.kind === "workflow-input" &&
              o.rules.some((f) => f.key === field.key),
          ),
        )
        .map((r) => ({
          sourceRevision: r.sourceRevision,
          sourceQuote: r.sourceQuote,
        })),
    );
  }
  for (const r of plan.requirements ?? []) {
    const evidence = [
      { sourceRevision: r.sourceRevision, sourceQuote: r.sourceQuote },
    ];
    for (const o of r.obligations ?? []) {
      if (o.kind === "field") {
        const subject = `${o.member}:${o.contribution ?? ""}:${o.field}`;
        const decision = review?.fieldDecisions?.find(
          (d) => d.obligationId === o.id,
        );
        const initial = decision?.initial;
        const status =
          initial?.kind === "undetermined"
            ? "undetermined"
            : initial?.kind === "unspecified" ||
                (!initial && o.initialOrigin === "host")
              ? "unspecified"
              : "specified";
        add(
          { subject, aspect: "initial-display" },
          status,
          o.initialOrigin === "host" ? "host" : "requirement",
          status === "specified" ? (initial ?? o.initial) : undefined,
          decision
            ? [
                {
                  sourceRevision: decision.sourceRevision,
                  sourceQuote: decision.sourceQuote,
                },
              ]
            : evidence,
        );
        for (const s of o.scenarios)
          add(
            { subject: `${subject}:${s.id}`, aspect: "post-action-value" },
            "specified",
            "requirement",
            { steps: s.steps, value: s.value },
            evidence,
          );
        if (o.history)
          add(
            { subject, aspect: "preservation" },
            "specified",
            "requirement",
            o.history,
            evidence,
          );
      } else if (o.kind === "backend-rejection")
        add(
          {
            subject: `${o.action.member}:${o.action.action}:${o.id}`,
            aspect: "operation-rejection",
          },
          "specified",
          "requirement",
          o.cases,
          evidence,
        );
      else if (o.kind === "feedback") {
        const decision = review?.errorDecisions?.find(
          (d) => d.obligationId === o.id,
        );
        const status =
          decision?.feedback === "not-requested"
            ? "unspecified"
            : decision?.feedback === "required"
              ? "specified"
              : "undetermined";
        add(
          { subject: o.id, aspect: "error-feedback" },
          status,
          "requirement",
          status === "specified"
            ? { action: o.action, text: o.text }
            : undefined,
          decision
            ? [
                {
                  sourceRevision: decision.sourceRevision,
                  sourceQuote: decision.sourceQuote,
                },
              ]
            : evidence,
        );
      } else if (o.kind === "history")
        add(
          { subject: `${o.member}:${o.field}`, aspect: "preservation" },
          "specified",
          "requirement",
          o.history,
          evidence,
        );
      else if (o.kind === "assertion" && o.expected.kind === "action-visible")
        add(
          {
            subject: `${o.expected.member}:${o.expected.action}:${hash(o.steps)}`,
            aspect: "action-availability",
          },
          "specified",
          isInheritedAvailability(o, plan.binding?.actionAvailability)
            ? "host"
            : "requirement",
          isInheritedAvailability(o, plan.binding?.actionAvailability)
            ? {
                visible: o.expected.visible,
                state: o.availability!.state,
                baselineHash: plan.binding!.actionAvailability!.hash,
              }
            : o.expected.visible,
          evidence,
        );
    }
  }
  for (const choice of review?.unresolvedChoices ?? []) {
    add(
      { subject: choice.targetId, aspect: "choice" },
      "undetermined",
      "requirement",
      undefined,
      [
        {
          sourceRevision: choice.sourceRevision,
          sourceQuote: choice.sourceQuote,
        },
      ],
    );
  }
  if (
    entries.some((e) =>
      e.evidence.some(
        (c) =>
          !sources.some(
            (s) => s.id === c.sourceRevision && s.text.includes(c.sourceQuote),
          ),
      ),
    )
  )
    throw new Error("需求语义依赖失效或来源引用不存在");
  return {
    version: 1,
    sourceHash: hash(sources),
    dependencies: sources.map((s) => ({ id: s.id, hash: hash(s.text) })),
    entries,
  };
}
/** Merge audit context without ever treating a historical receipt as current approval. */
export function semanticReuse(
  previous: {
    sources?: SemanticSource[];
    claims: { id: string; interpretation: Record<string, string> }[];
    semanticReview?: {
      decisions: {
        claimId: string;
        sourceRevision: string;
        sourceQuote: string;
        verdict: string;
        meaning?: InitialMeaning;
      }[];
    };
  }[],
  sources: SemanticSource[],
) {
  return previous.flatMap((p) =>
    (p.semanticReview?.decisions ?? []).flatMap((d) => {
      const old = p.sources?.find((s) => s.id === d.sourceRevision);
      if (!old || !sources.some((s) => s.id === old.id && s.text === old.text))
        return [];
      const c = p.claims.find((c) => c.id === d.claimId);
      return c
        ? [
            {
              target: c.interpretation,
              decision: d,
              dependency: { id: old.id, hash: hash(old.text) },
            },
          ]
        : [];
    }),
  );
}
