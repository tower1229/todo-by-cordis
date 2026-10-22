import {
  semanticQuestionKey,
  initialMeaningSchema,
  parseInitialMeaning,
  type InitialMeaning,
} from "./requirement-semantics.js";
import type { TechnicalFact } from "./technical-facts.js";
import {
  capabilityFactId,
  hostEffectIds,
  effectReviewResolved,
  type HostEffect,
} from "./capability-admission.js";
import { hash } from "../release/storage.js";
import { schemaProblems } from "./model-protocol.js";
import {
  clarificationChoiceQuestion,
  clarificationChoiceSchema,
  type ClarificationChoice,
} from "../shared/clarification-choice.js";
import {
  clarificationBlockers,
  type ClarificationDecision,
} from "./clarification-review.js";
import {
  fieldTargets,
  fieldReferenceSchema,
  bindFieldReference,
  type FieldTarget,
  type FieldReference,
} from "./field-identity.js";
import {
  sourceItems,
  sourceChoice,
  admissionChoiceProof,
  type AdmissionQuestionTarget,
  type AdmissionChoiceProof,
} from "./source-items.js";

type Source = { id: string; text: string };
type Citation = { sourceRevision: string; sourceQuote: string };
export const hostAdmissionContract = "host-admission/12" as const;
export const admissionSourceReviewContract = "admission-source-review/3" as const;
type SourceInterpretation =
  | { layer: "capability"; effect: HostEffect }
  | { layer: "initial-state"; meaningKind: "state"; targetId: string; field: string; value: string }
  | {
      layer: "initial-display";
      meaningKind: InitialMeaning["kind"];
      surface: "workflow" | "auxiliary" | "unbound";
      targetId: string;
      member: string;
      contribution: string;
      field: string;
      condition: "initial-missing-field";
      kind: "visible" | "absent";
      value: string;
    };
type AdmissionClaim = Citation & {
  id: string;
  intentId?: string;
  interpretation: SourceInterpretation;
  diagnostic: string;
};
type AdmissionDecision = Citation & {
  claimId: string;
  layer: "initial-display" | "initial-state" | "capability";
  verdict: "entailed" | "not-requested" | "uncertain";
  detail: string;
};
export const questionReviewKey = (
  question: string,
  sources: Source[],
  facts: TechnicalFact[],
) => semanticQuestionKey(question, hash(sources), hash(facts));
export function admissionQuestionState(
  admission: RequestAdmission,
  sources: Source[],
  facts: TechnicalFact[],
  reviews: { key: string; choice?:{id:string;hash:string}; admissionChoice?: AdmissionChoiceProof; decision: ClarificationDecision }[],
) {
  const pending: string[] = [],
    questions: string[] = [],
    blockers: string[] = [];
  const pendingTargets: AdmissionQuestionTarget[] = [];
  for (const q of admission.questions) {
    const matches = reviews.filter(
      (r) => !r.choice && r.key === questionReviewKey(q.question, sources, facts) &&
        hash(r.admissionChoice) === hash(admissionChoiceProof(q)),
    );
    if (new Set(matches.map((r) => hash(r.decision))).size > 1) {
      blockers.push("同一澄清裁决冲突，须重新调查");
      continue;
    }
    const decision = matches[0]?.decision;
    if (!decision) {
      pending.push(q.question);
      pendingTargets.push(q);
      continue;
    }
    if (!effectReviewResolved(decision.effects, sources, facts)) {
      blockers.push("澄清审查缺少来源及宿主能力的完整裁决");
      continue;
    }
    if (q.choice && (decision.sourceRevision !== q.sourceRevision || decision.sourceQuote !== q.sourceQuote)) {
      blockers.push("澄清审查的来源条目绑定已变化");
      continue;
    }
    const blocked = clarificationBlockers(decision);
    if (blocked.length) {
      blockers.push(...blocked);
      continue;
    }
    if (decision.kind === "business-ambiguity") questions.push(q.question);
  }
  return {
    pending: [...new Set(pending)],
    pendingTargets,
    questions: [...new Set(questions)],
    blockers: [...new Set(blockers)],
  };
}
type AdmissionIntent = {
  effects: { source: number; sourceQuote: string; effect: HostEffect }[];
  initials: {
    source: number;
    sourceQuote: string;
    target: FieldReference;
    meaning: InitialMeaning;
  }[];
  questions: (
    | { source: number; sourceQuote: string; question: string }
    | { sourceItem: number; choice: ClarificationChoice }
  )[];
};
type PresentationCheck = Citation & {
  claimId: string;
  intentId: string;
  field: string;
  target?: FieldTarget;
  factId: string;
  factHash: string;
  expected: import("../shared/acceptance-obligations.js").FieldExpectation;
  actual?: import("../shared/acceptance-obligations.js").FieldExpectation;
  possible?: import("../shared/acceptance-obligations.js").FieldExpectation[];
  outcome: "supported" | "unsupported" | "deferred" | "not-applicable";
};
export type RequestAdmission = {
  contract: typeof hostAdmissionContract;
  intents: AdmissionIntent;
  factsSnapshot: TechnicalFact[];
  technicalChecks: PresentationCheck[];
  capabilityChecks: (Citation & {
    claimId: string;
    effect: HostEffect;
    factId: string;
    factHash: string;
    outcome: "supported" | "unsupported" | "deferred";
  })[];
  key: string;
  baseVersion: string;
  sources: Source[];
  sourceHash: string;
  factsHash: string;
  fieldCatalog: FieldTarget[];
  initialMeanings: (Citation & {
    id: string;
    surface: "workflow" | "auxiliary" | "unbound";
    field: string;
    target?: FieldTarget;
    meaning: InitialMeaning;
    initial: import("./requirement-semantics.js").InitialDecision;
  })[];
  presentations: (Citation & {
    intentId: string;
    surface: "workflow" | "auxiliary" | "unbound";
    kind: "visible" | "absent";
    value: string;
  })[];
  initialStates: (Citation & {
    intentId: string;
    field: string;
    target?: FieldTarget;
    value: string;
  })[];
  questions: AdmissionQuestionTarget[];
  claims: AdmissionClaim[];
  semanticReview?: { claimsHash: string; decisions: AdmissionDecision[] };
  blockers: string[];
};
const text = { type: "string" };
const citation = (sourceCount: number) => ({
  source: { type: "integer", minimum: 1, ...(sourceCount ? { maximum: sourceCount } : {}) },
  sourceQuote: { ...text, minLength: 1 },
});
const list = (properties: Record<string, unknown>) => ({
  type: "array",
  maxItems: 20,
  items: {
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  },
});
/** Flat mandatory envelope; semantic references are bound and checked by the host. */
export function admissionSchema(facts: TechnicalFact[] = [], sources: Source[] = []) {
  const catalog = fieldTargets(facts);
  const items = sourceItems(sources);
  return {
    type: "object",
    additionalProperties: false,
    required: ["initials", "effects", "questions"],
    properties: {
      effects: list({
        ...citation(sources.length),
        effect: { type: "string", enum: hostEffectIds },
      }),
      initials: list({
        ...citation(sources.length),
        target: fieldReferenceSchema(catalog),
        meaning: initialMeaningSchema,
      }),
      questions: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          anyOf: [
            ...(items.length ? [list({
              sourceItem: { type: "integer", enum: items.map((_, index) => index + 1) },
              choice: clarificationChoiceSchema(fieldReferenceSchema(catalog)),
            }).items] : []),
            list({
              ...citation(sources.length),
              question: {
                ...text,
                minLength: 1,
                maxLength: 3000,
                description: "仅用于结构化选择尚不能表达的其他业务歧义。",
              },
            }).items,
          ],
        },
      },
    },
  };
}
export const admissionInstruction =
  "独立解释原始需求和回答，输出需求意图 JSON，空历史且禁止工具。initials 分层列出业务初始逻辑值(state)、明确的初始呈现要求或真实未决初始选择；没有要求则为空。字段名称、必填性、动作后保存值不属于初始呈现。initials 和 effects 引用连续原文；明确语义分别引用条件与效果。effects 提取需要外部交付、宿主离线交付、在线调度的要求，业务动作可实现的普通逻辑不属于宿主能力缺口；支持性由宿主判断。questions 集中列出影响业务结果且原文仍未决定的业务选择：必填性使用 sourceItems 的一基 sourceItem 序号和 choice，宿主生成引用、身份及问句；其他业务歧义使用来源引用和 question。条目仅是原文地址，需结合完整 sources 理解。实现自由度、技术条件和不支持的能力不得转为问题。target 引用 fieldTargets 的 targetId，新字段用 new/name。facts 是只读宿主上下文，禁止在输出中重述派生事实。此预检不替代完整规划和独立需求复核。";

/** Both production and qualification use the exact same native request contract. */
export function admissionRequest(
  sources: Source[],
  facts: TechnicalFact[],
  priorSemantics: unknown[] = [],
): import("./driver.js").ModelRequest {
  return {
    phase: "admission",
    history: [],
    instruction: admissionInstruction,
    schema: admissionSchema(facts, sources),
    message: JSON.stringify({
      kind: "request-admission/2",
      sources,
      sourceItems: sourceItems(sources),
      facts,
      fieldTargets: fieldTargets(facts),
      priorSemantics,
    }),
  };
}
export function admissionReviewRequest(
  admission: RequestAdmission,
  sources: Source[],
  priorSemantics: unknown[] = [],
): import("./driver.js").ModelRequest {
  return {
    phase: "review",
    history: [],
    instruction: admissionReviewInstruction,
    schema: admissionReviewSchema(admission),
    message: JSON.stringify({
      kind: admissionSourceReviewContract,
      sources,
      claims: admission.claims.map(
        ({ sourceRevision, sourceQuote, interpretation }) => ({
          sourceRevision,
          sourceQuote,
          interpretation,
        }),
      ),
      priorSemantics,
    }),
  };
}

export function admissionKey(
  baseVersion: string,
  sources: Source[],
  facts: TechnicalFact[],
) {
  return hash({ contract: hostAdmissionContract, baseVersion, sources, facts });
}
export function parseAdmission(
  text: string,
  baseVersion: string,
  sources: Source[],
  facts: TechnicalFact[],
): RequestAdmission {
  const value: unknown = JSON.parse(text);
  const problems = schemaProblems(value, admissionSchema(facts, sources));
  if (problems.length) throw new Error(problems.join("；"));
  const raw = value as AdmissionIntent;
  const items = sourceItems(sources);
  const structuredItems = raw.questions.flatMap((question) => "sourceItem" in question ? [question.sourceItem] : []);
  if (new Set(structuredItems).size !== structuredItems.length)
    throw new Error("同一宿主来源条目不能重复提交结构化澄清");
  function bind(v: { source: number; sourceQuote: string }): Citation {
    const s = sources[v.source - 1];
    if (!s || !v.sourceQuote.trim() || !s.text.includes(v.sourceQuote))
      throw new Error("需求预检引用不存在的来源原文");
    return { sourceRevision: s.id, sourceQuote: v.sourceQuote };
  }
  const claims: AdmissionClaim[] = [];
  const technicalChecks: PresentationCheck[] = [];
  const fieldCatalog = fieldTargets(facts);
  function claim(
    citation: Citation,
    interpretation: SourceInterpretation,
    diagnostic: string,
    intentId?: string,
  ) {
    const value = {
      ...citation,
      interpretation,
      diagnostic,
      ...(intentId ? { intentId } : {}),
      id: hash({ citation, interpretation, ...(intentId ? { intentId } : {}) }),
    };
    claims.push(value);
    return value.id;
  }
  const boundInitials = raw.initials.map((v) => {
    const bound = {
      ...bind(v),
      ...bindFieldReference(v.target, fieldCatalog),
      ...parseInitialMeaning(v.meaning, sources[v.source - 1]?.text ?? ""),
    };
    return { ...bound, id: "initial-" + hash(bound).slice(0, 24) };
  });
  const initialMeanings = [
    ...new Map(boundInitials.map((v) => [v.id, v])).values(),
  ];
  const presentations = initialMeanings.flatMap((v) => {
    const citation = {
      sourceRevision: v.sourceRevision,
      sourceQuote: v.sourceQuote,
    };
    if (v.meaning.kind === "state") {
      claim(
        citation,
        {
          layer: "initial-state",
          meaningKind: "state",
          targetId: v.target?.targetId ?? "",
          field: v.field,
          value: v.meaning.value,
        },
        "业务初始逻辑值须由冻结业务案例验证，不由渲染器裁决",
        v.id,
      );
      return [];
    }
    if (v.initial.kind !== "visible" && v.initial.kind !== "absent") return [];
    const kind = v.initial.kind;
    const value = v.initial.kind === "visible" ? v.initial.value : "";
    const presentation = facts.find(
      (f) => f.id === "host-fact:initial-field-presentation",
    );
    const expected = v.initial;
    const actual: PresentationCheck["actual"] =
      v.surface === "workflow"
        ? presentation?.properties.workflowMissingField === "absent"
          ? { kind: "absent" }
          : undefined
        : v.surface === "auxiliary" &&
            presentation?.properties.auxiliaryMissingField !== undefined
          ? {
              kind: "visible",
              value: presentation.properties.auxiliaryMissingField,
            }
          : undefined;
    // A new field has no owner yet. Only a complete, incompatible renderer set
    // proves early rejection; a possible match still requires exact plan binding.
    const possible: PresentationCheck["possible"] =
      v.surface === "unbound" &&
      presentation?.properties.workflowMissingField === "absent" &&
      presentation.properties.auxiliaryMissingField !== undefined
        ? [
            { kind: "absent" },
            {
              kind: "visible",
              value: presentation.properties.auxiliaryMissingField,
            },
          ]
        : undefined;
    const outcome =
      v.surface === "unbound"
        ? possible && !possible.some((value) => hash(value) === hash(expected))
          ? "unsupported"
          : "deferred"
        : actual && hash(actual) === hash(expected)
          ? "supported"
          : "unsupported";
    const claimId = claim(
      citation,
      {
        layer: "initial-display",
        meaningKind: v.meaning.kind,
        surface: v.surface,
        targetId: v.target?.targetId ?? "",
        member: v.target?.member ?? "",
        contribution: v.target?.contribution ?? "",
        field: v.field,
        condition: "initial-missing-field",
        kind,
        value,
      },
      outcome === "unsupported"
        ? `需求原文 ${JSON.stringify(v.sourceQuote)} 要求的 ${v.surface} 初始呈现 ${kind}:${JSON.stringify(value)} 无法由当前受保护渲染器表达，需要维护者扩展；不能替换期望或询问降级`
        : `需求原文 ${JSON.stringify(v.sourceQuote)} 要求的初始呈现 ${kind}:${JSON.stringify(value)}，宿主检查结果为 ${outcome}`,
      v.id,
    );
    technicalChecks.push({
      ...citation, claimId, intentId: v.id, field: v.field,
      ...(v.target ? { target: v.target } : {}),
      factId: "host-fact:initial-field-presentation",
      factHash: presentation?.evidenceHash ?? "", expected,
      ...(actual ? { actual } : {}), ...(possible ? { possible } : {}), outcome,
    });
    return [{ ...citation, intentId: v.id, surface: v.surface, kind, value }];
  });
  const capabilityChecks = [
    ...new Map(raw.effects.map((v) => [hash(v), v])).values(),
  ].map((v) => {
    const citation = bind(v);
    const factId = capabilityFactId(v.effect);
    const fact = facts.find((f) => f.id === factId);
    if (
      !fact ||
      !["supported", "unsupported", "deferred"].includes(
        fact.properties.availability,
      )
    )
      throw new Error("需求能力检查缺少可信宿主边界事实");
    const outcome = fact.properties.availability as
      | "supported"
      | "unsupported"
      | "deferred";
    const claimId = claim(
      citation,
      {
        layer: "capability",
        effect: v.effect,
      },
      outcome === "unsupported"
        ? `需求原文 ${JSON.stringify(v.sourceQuote)} 需要 ${v.effect}，宿主服务及检查器不支持，须维护者扩展；不向用户询问渠道或接受降级`
        : `需求原文 ${JSON.stringify(v.sourceQuote)} 需要 ${v.effect}，宿主检查结果为 ${outcome}`,
    );
    return {
      ...citation,
      claimId,
      effect: v.effect,
      factId,
      factHash: fact.evidenceHash,
      outcome,
    };
  });
  return {
    contract: hostAdmissionContract,
    intents: structuredClone(raw),
    factsSnapshot: structuredClone(facts),
    technicalChecks,
    capabilityChecks,
    key: admissionKey(baseVersion, sources, facts),
    baseVersion,
    sources: structuredClone(sources),
    sourceHash: hash(sources),
    factsHash: hash(facts),
    fieldCatalog,
    presentations,
    initialStates: [],
    initialMeanings,
    questions: [
      ...raw.questions.map((v) => {
        if ("question" in v) return { ...bind(v), question: v.question.trim() };
        const item = items[v.sourceItem - 1];
        return {
          sourceRevision: item.sourceRevision,
          sourceQuote: item.text,
          question: clarificationChoiceQuestion(v.choice, item.text, item.ordinal),
          choice: sourceChoice(item, v.choice),
        };
      }),
      ...initialMeanings
        .filter((v) => v.initial.kind === "undetermined")
        .map((v) => ({
          sourceRevision: v.sourceRevision,
          sourceQuote: v.sourceQuote,
          question: `尚未填写 ${v.field} 时，应显示什么？`,
        })),
    ],
    claims,
    blockers: [],
  };
}

/** Only source entailment is reviewed here; supported capabilities are still host facts. */
export const admissionReviewInstruction =
  "独立裁决 claims 是否由完整 sources 要求，空历史且禁止工具。每项同时给出 layer 与 verdict。layer=initial-state 仅表示业务初始逻辑值，不推出字段存储或界面显示；initial-display 表示明确的初始显示；capability 表示受保护宿主效果。不能从逻辑值推出页面文字。verdict=entailed 为原文明确或必然要求；not-requested 为原文未要求，包括标签、必填性或动作后值误作初始语义；uncertain 为来源不足或冲突。不得依据宿主能力改变原意。逐项引用原文，不重写值或期望。此裁决不替代完整需求及逐字段遗漏复核。";
export function admissionReviewSchema(admission: RequestAdmission) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["decisions"],
    properties: {
      decisions: {
        type: "array",
        minItems: admission.claims.length,
        maxItems: admission.claims.length,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "claim",
            "source",
            "sourceQuote",
            "layer",
            "verdict",
            "detail",
          ],
          properties: {
            claim: {
              type: "integer",
              minimum: 1,
              maximum: Math.max(1, admission.claims.length),
            },
            ...citation(admission.sources.length),
            layer: {
              type: "string",
              enum: ["initial-display", "initial-state", "capability"],
            },
            verdict: {
              type: "string",
              enum: ["entailed", "not-requested", "uncertain"],
            },
            detail: { type: "string", minLength: 1 },
          },
        },
      },
    },
  };
}
function decisionBlockers(admission: RequestAdmission) {
  return (admission.semanticReview?.decisions ?? []).flatMap((d) => {
    const claim = admission.claims.find((c) => c.id === d.claimId);
    if (!claim) return ["来源语义裁决引用不存在"];
    if (d.verdict === "uncertain") return [`来源语义尚未裁决：${d.detail}`];
    if (d.verdict !== "entailed" || d.layer === "initial-state") return [];
    const checks = claim.interpretation.layer === "capability"
      ? admission.capabilityChecks : admission.technicalChecks;
    const check = checks.find((item) => item.claimId === claim.id);
    if (!check) return ["来源命题缺少宿主技术裁决绑定"];
    return check.outcome === "unsupported" ? [claim.diagnostic] : [];
  });
}
export function adjudicateAdmission(
  text: string,
  admission: RequestAdmission,
  sources: Source[],
): RequestAdmission {
  const raw: unknown = JSON.parse(text);
  const problems = schemaProblems(raw, admissionReviewSchema(admission));
  if (problems.length) throw new Error(problems.join("；"));
  const value = raw as {
    decisions: {
      claim: number;
      source: number;
      sourceQuote: string;
      verdict: AdmissionDecision["verdict"];
      layer: AdmissionDecision["layer"];
      detail: string;
    }[];
  };
  const seen = new Set<string>();
  const decisions = value.decisions.map((d) => {
    const c = admission.claims[d.claim - 1],
      s = sources[d.source - 1];
    if (
      !c ||
      seen.has(c.id) ||
      !s ||
      !s.text.includes(d.sourceQuote) ||
      !d.sourceQuote.trim()
    )
      throw new Error("来源语义裁决遗漏、重复或引用无效");
    seen.add(c.id);
    const meaningKind = c.interpretation.layer === "capability" ? undefined : c.interpretation.meaningKind;
    if (
      (c.interpretation.layer === "capability") !==
        (d.layer === "capability") ||
      (d.layer === "initial-state" &&
        (!meaningKind || !["literal", "state"].includes(meaningKind))) ||
      (c.interpretation.layer === "initial-state" &&
        d.layer === "initial-display")
    )
      throw new Error("来源分层不能改写命题的业务值或宿主能力目标");
    return {
      claimId: c.id,
      layer: d.layer,
      sourceRevision: s.id,
      sourceQuote: d.sourceQuote,
      verdict: d.verdict,
      detail: d.detail,
    };
  });
  const decisionFor = (intentId: string) =>
    decisions.find((d) =>
      admission.claims.some(
        (c) => c.id === d.claimId && c.intentId === intentId,
      ),
    );
  const initialStates = admission.initialMeanings.flatMap((m) => {
    const decision = decisionFor(m.id);
    return decision?.layer === "initial-state" &&
      decision.verdict === "entailed" &&
      (m.meaning.kind === "literal" || m.meaning.kind === "state")
      ? [
          {
            intentId: m.id,
            sourceRevision: m.sourceRevision,
            sourceQuote: m.sourceQuote,
            field: m.field,
            ...(m.target ? { target: m.target } : {}),
            value: m.meaning.value,
          },
        ]
      : [];
  });
  const resolved = {
    ...admission,
    presentations: admission.presentations.filter(
      (p) =>
        decisionFor(p.intentId)?.layer === "initial-display" &&
        decisionFor(p.intentId)?.verdict === "entailed",
    ),
    initialStates,
    technicalChecks: admission.technicalChecks.map((check) =>
      decisionFor(check.intentId)?.layer === "initial-state" &&
      decisionFor(check.intentId)?.verdict === "entailed"
        ? { ...check, outcome: "not-applicable" as const }
        : check,
    ),
    semanticReview: { claimsHash: hash(admission.claims), decisions },
  };
  return { ...resolved, blockers: decisionBlockers(resolved) };
}
export function admissionResolved(admission: RequestAdmission): boolean {
  // Canonical host replay verifies every derived reference and check; old pending evidence is never upgraded.
  try {
    if (
      admission.contract !== hostAdmissionContract ||
      !Array.isArray(admission.factsSnapshot)
    )
      return false;
    const canonical = parseAdmission(
      JSON.stringify(admission.intents),
      admission.baseVersion,
      admission.sources,
      admission.factsSnapshot,
    );
    if (!admission.semanticReview)
      return hash(admission) === hash(canonical) && !canonical.claims.length;
    if (admission.semanticReview.claimsHash !== hash(canonical.claims))
      return false;
    const decisions = admission.semanticReview.decisions.map((d) => ({
      claim: canonical.claims.findIndex((c) => c.id === d.claimId) + 1,
      source: canonical.sources.findIndex((s) => s.id === d.sourceRevision) + 1,
      sourceQuote: d.sourceQuote,
      verdict: d.verdict,
      layer: d.layer,
      detail: d.detail,
    }));
    return (
      hash(admission) ===
      hash(
        adjudicateAdmission(
          JSON.stringify({ decisions }),
          canonical,
          admission.sources,
        ),
      )
    );
  } catch {
    return false;
  }
}
