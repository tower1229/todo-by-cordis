import {
  semanticQuestionKey,
  initialMeaningSchema,
  parseInitialMeaning,
  type InitialMeaning,
} from "./requirement-semantics.js";
import type { TechnicalFact } from "./technical-facts.js";
import { hash } from "../release/storage.js";
import { schemaProblems } from "./model-protocol.js";
import type { ClarificationDecision } from "./clarification-review.js";
import {
  fieldTargets,
  fieldReferenceSchema,
  bindFieldReference,
  type FieldTarget,
  type FieldReference,
} from "./field-identity.js";

type Source = { id: string; text: string };
type Citation = { sourceRevision: string; sourceQuote: string };
type AdmissionClaim = Citation & {
  id: string;
  interpretation: Record<string, string>;
  diagnostic: string;
};
type AdmissionDecision = Citation & {
  claimId: string;
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
  reviews: { key: string; decision: ClarificationDecision }[],
) {
  const pending: string[] = [],
    questions: string[] = [],
    blockers: string[] = [];
  for (const q of admission.questions) {
    const matches = reviews.filter(
      (r) => r.key === questionReviewKey(q.question, sources, facts),
    );
    if (new Set(matches.map((r) => hash(r.decision))).size > 1) {
      blockers.push("同一澄清裁决冲突，须重新调查");
      continue;
    }
    const decision = matches[0]?.decision;
    if (!decision) {
      pending.push(q.question);
      continue;
    }
    if (decision.kind === "business-ambiguity") questions.push(q.question);
    else if (
      decision.kind === "scope-reduction" ||
      (decision.kind === "technical" &&
        decision.fact?.expected !== decision.fact?.actual)
    )
      blockers.push(`澄清审查确认需要维护者处理：${decision.detail}`);
  }
  return {
    pending: [...new Set(pending)],
    questions: [...new Set(questions)],
    blockers: [...new Set(blockers)],
  };
}
type AdmissionIntent = {
  presentations: {
    source: number;
    sourceQuote: string;
    target: FieldReference;
    meaning: InitialMeaning;
  }[];
  questions: { source: number; sourceQuote: string; question: string }[];
};
type PresentationCheck = Citation & {
  field: string;
  target?: FieldTarget;
  factId: string;
  factHash: string;
  expected: import("../shared/acceptance-obligations.js").FieldExpectation;
  actual?: import("../shared/acceptance-obligations.js").FieldExpectation;
  possible?: import("../shared/acceptance-obligations.js").FieldExpectation[];
  outcome: "supported" | "unsupported" | "deferred";
};
export type RequestAdmission = {
  contract: "host-admission/6";
  intents: AdmissionIntent;
  factsSnapshot: TechnicalFact[];
  technicalChecks: PresentationCheck[];
  key: string;
  baseVersion: string;
  sources: Source[];
  sourceHash: string;
  factsHash: string;
  fieldCatalog: FieldTarget[];
  initialMeanings: (Citation & {
    surface: "workflow" | "auxiliary" | "unbound";
    field: string;
    target?: FieldTarget;
    meaning: InitialMeaning;
    initial: import("./requirement-semantics.js").InitialDecision;
  })[];
  presentations: (Citation & {
    surface: "workflow" | "auxiliary" | "unbound";
    kind: "visible" | "absent";
    value: string;
  })[];
  questions: (Citation & { question: string })[];
  claims: AdmissionClaim[];
  semanticReview?: { claimsHash: string; decisions: AdmissionDecision[] };
  blockers: string[];
};
const text = { type: "string" };
const citation = {
  source: { type: "integer", minimum: 1 },
  sourceQuote: { ...text, minLength: 1 },
};
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
export function admissionSchema(facts: TechnicalFact[] = []) {
  const catalog = fieldTargets(facts);
  return {
    type: "object",
    additionalProperties: false,
    required: ["presentations", "questions"],
    properties: {
      presentations: list({
        ...citation,
        target: fieldReferenceSchema(catalog),
        meaning: initialMeaningSchema,
      }),
      questions: list({
        ...citation,
        question: { ...text, minLength: 1, maxLength: 3000 },
      }),
    },
  };
}
export const admissionInstruction =
  "独立解释原始需求和回答，输出需求意图 JSON，空历史且禁止工具。presentations 只列明确的初始呈现要求或真实未决初始选择；没有要求则为空。meaning 使用规定的互斥类型，字段名称、必填性、动作后保存值不属于初始呈现。每项引用连续原文；明确呈现分别引用条件与效果。questions 集中列出影响实现且原文仍未决定的业务选择；技术条件和不支持的能力不得转为降级问题。target 按契约引用 fieldTargets 中的已有 targetId；尚未安装的新字段用 new/name 表达，身份由宿主在计划编译后绑定。facts 仅为只读宿主上下文，技术事实、属性、期望及字段归属由宿主绑定，禁止在输出中重述。此预检不替代完整规划和独立需求复核。";

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
    schema: admissionSchema(facts),
    message: JSON.stringify({
      kind: "request-admission/1",
      sources,
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
      kind: "admission-source-review/1",
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
  return hash({ contract: "host-admission/6", baseVersion, sources, facts });
}
export function parseAdmission(
  text: string,
  baseVersion: string,
  sources: Source[],
  facts: TechnicalFact[],
): RequestAdmission {
  const value: unknown = JSON.parse(text);
  const problems = schemaProblems(value, admissionSchema(facts));
  if (problems.length) throw new Error(problems.join("；"));
  const raw = value as AdmissionIntent;
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
    interpretation: Record<string, string>,
    diagnostic: string,
  ) {
    claims.push({
      ...citation,
      interpretation,
      diagnostic,
      id: hash({ citation, interpretation }),
    });
  }
  const initialMeanings = raw.presentations.map((v) => ({
    ...bind(v),
    ...bindFieldReference(v.target, fieldCatalog),
    ...parseInitialMeaning(v.meaning, sources[v.source - 1]?.text ?? ""),
  }));
  const presentations = initialMeanings.flatMap((v) => {
    const citation = {
      sourceRevision: v.sourceRevision,
      sourceQuote: v.sourceQuote,
    };
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
    technicalChecks.push({
      ...citation,
      field: v.field,
      ...(v.target ? { target: v.target } : {}),
      factId: "host-fact:initial-field-presentation",
      factHash: presentation?.evidenceHash ?? "",
      expected,
      ...(actual ? { actual } : {}),
      ...(possible ? { possible } : {}),
      outcome,
    });
    const supported = outcome === "supported";
    if (!supported)
      claim(
        citation,
        {
          surface: v.surface,
          outcome,
          targetId: v.target?.targetId ?? "",
          member: v.target?.member ?? "",
          contribution: v.target?.contribution ?? "",
          field: v.field,
          condition: "initial-missing-field",
          kind,
          value,
        },
        `需求原文 ${JSON.stringify(v.sourceQuote)} 要求的 ${v.surface} 初始呈现 ${kind}:${JSON.stringify(value)} 无法由当前受保护渲染器表达，需要维护者扩展；不能替换期望或询问降级`,
      );
    return [{ ...citation, surface: v.surface, kind, value }];
  });
  return {
    contract: "host-admission/6",
    intents: structuredClone(raw),
    factsSnapshot: structuredClone(facts),
    technicalChecks,
    key: admissionKey(baseVersion, sources, facts),
    baseVersion,
    sources: structuredClone(sources),
    sourceHash: hash(sources),
    factsHash: hash(facts),
    fieldCatalog,
    presentations,
    initialMeanings,
    questions: [
      ...raw.questions.map((v) => ({
        ...bind(v),
        question: v.question.trim(),
      })),
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
  "独立裁决每个 claims 原子命题是否由完整 sources 要求，空历史且禁止工具。只返回 verdict：entailed=原文明确或必然要求；not-requested=原文未要求该命题，包括把标签、必填性或动作后值误作初始呈现；uncertain=来源不足或存在真实冲突。不得依据宿主能力改变原意。逐项引用连续原文并说明判断，不重写 meaning、不改期望。priorSemantics 仅复用来源仍一致的具体历史判断，此裁决不替代完整需求及逐字段遗漏复核。";
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
          required: ["claim", "source", "sourceQuote", "verdict", "detail"],
          properties: {
            claim: {
              type: "integer",
              minimum: 1,
              maximum: Math.max(1, admission.claims.length),
            },
            ...citation,
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
    return !claim
      ? ["来源语义裁决引用不存在"]
      : d.verdict === "entailed"
        ? claim.interpretation.outcome === "deferred"
          ? []
          : [claim.diagnostic]
        : d.verdict === "uncertain"
          ? [`来源语义尚未裁决：${d.detail}`]
          : [];
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
    return {
      claimId: c.id,
      sourceRevision: s.id,
      sourceQuote: d.sourceQuote,
      verdict: d.verdict,
      detail: d.detail,
    };
  });
  const resolved = {
    ...admission,
    semanticReview: { claimsHash: hash(admission.claims), decisions },
  };
  return { ...resolved, blockers: decisionBlockers(resolved) };
}
export function admissionResolved(admission: RequestAdmission): boolean {
  // Canonical host replay verifies every derived reference and check; old pending evidence is never upgraded.
  try {
    if (
      admission.contract !== "host-admission/6" ||
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
