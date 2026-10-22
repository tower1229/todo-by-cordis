import type { TechnicalFact } from "./technical-facts.js";
import { assertTechnicalExpectation, technicalExpectationValues } from "./technical-facts.js";
import {
  effectReviewSchema,
  parseEffectReview,
  effectBlockers,
  type EffectReview,
} from "./capability-admission.js";
import { schemaProblems } from "./model-protocol.js";
import {
  assertAdmissionTargets,
  admissionChoiceProof,
  type AdmissionQuestionTarget,
} from "./source-items.js";
export type ClarificationDecision = {
  effects?: EffectReview;
  kind:
    | "business-ambiguity"
    | "unnecessary"
    | "scope-reduction"
    | "technical"
    | "implementation";
  sourceRevision: string;
  sourceQuote: string;
  detail: string;
  fact?: {
    id: string;
    hash: string;
    property: string;
    expected: string;
    actual: string;
  };
};
export function clarificationBlockers(
  decision: ClarificationDecision,
): string[] {
  const blockers = effectBlockers(decision.effects);
  if (
    decision.kind === "scope-reduction" ||
    (decision.kind === "technical" &&
      decision.fact?.expected !== decision.fact?.actual)
  )
    blockers.push(`澄清审查确认需要维护者处理：${decision.detail}`);
  return blockers;
}
function boundClarificationSchema(facts?: TechnicalFact[]) {
  const schema = clarificationSchema(facts);
  return {
    ...schema,
    anyOf: schema.anyOf.map((branch) => ({
      ...branch,
      required: branch.required.filter((key) => key !== "source" && key !== "sourceQuote"),
      properties: Object.fromEntries(Object.entries(branch.properties).filter(([key]) => key !== "source" && key !== "sourceQuote")),
    })),
  };
}
function clarificationReviewSchema(count: number, facts?: TechnicalFact[], targets?: AdmissionQuestionTarget[]) {
  const branches = [
    ...(!targets || targets.some((target) => !target.choice) ? [clarificationSchema(facts)] : []),
    ...(targets?.some((target) => target.choice) ? [boundClarificationSchema(facts)] : []),
  ];
  return {
    type: "object",
    additionalProperties: false,
    required: ["effects", "decisions"],
    properties: {
      effects: effectReviewSchema,
      decisions: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: branches.length === 1 ? branches[0] : { anyOf: branches },
      },
    },
  };
}
export function clarificationRequest(
  questions: string[],
  sources: { id: string; text: string }[],
  facts: TechnicalFact[],
  questionTargets?: ReturnType<typeof import("./technical-facts.js").semanticChoiceProof>[],
  admissionTargets?: AdmissionQuestionTarget[],
): import("./driver.js").ModelRequest {
  if(questionTargets && questionTargets.length!==questions.length)throw new Error("澄清问题与宿主目标数量不一致");
  if (questionTargets && admissionTargets) throw new Error("不同阶段的澄清目标不能混用");
  if (admissionTargets) assertAdmissionTargets(questions, admissionTargets, sources);
  return {
    history: [],
    schema: clarificationReviewSchema(questions.length, facts, admissionTargets),
    instruction:
      "独立审查完整 sources 和 questions，空历史且禁止工具。先独立核对 effects 中每项宿主效果是否 required、not-requested 或 uncertain，完整覆盖目录一次，不依赖规划者是否提到；offline-delivery 指宿主离线仍保证交付，关闭浏览器不等于宿主离线。支持性由宿主绑定，不能把能力缺口转为渠道、收件人或降级问题。然后按 questions 顺序逐项返回 decisions，不维护索引。business-ambiguity 只用于影响业务结果且来源仍未决定的选择；unnecessary 用于已明确或未要求的细节；implementation 只用于未要求改变的宿主 field-interaction，引用 fact/property，由宿主绑定实际行为；scope-reduction 表示请求降级；technical 引用 facts 序号、property、expected，由宿主裁决。来源和事实使用一基序号。admissionTargets 中含 choice 的问题已绑定来源条目，决策只返回 kind、detail 及该种类允许的事实引用；不得重写 source、sourceQuote 或目标身份。",
    message: JSON.stringify({
      kind: "clarification-review/2",
      questions,
      sources,
      facts,
      ...(admissionTargets ? { admissionTargets: admissionTargets.map((target) => target.choice ? { choice: target.choice } : null) } : {}),
      ...(questionTargets?{
        questionTargets:questionTargets.map(({proof,requirement,aspect,subject})=>({...proof,requirementId:requirement.id,aspect,subject})),
        requirements:[...new Map(questionTargets.map(t=>[t.requirement.id,t.requirement])).values()],
      }:{}),
    }),
  };
}
export function parseClarificationReview(
  text: string,
  questions: string[],
  sources: { id: string; text: string }[],
  facts: TechnicalFact[],
  admissionTargets?: AdmissionQuestionTarget[],
) {
  if (admissionTargets) assertAdmissionTargets(questions, admissionTargets, sources);
  const raw: unknown = JSON.parse(text);
  const problems = schemaProblems(
    raw,
    clarificationReviewSchema(questions.length, facts, admissionTargets),
  );
  if (problems.length) throw new Error(problems.join("；"));
  const value = raw as { effects: unknown; decisions: unknown[] };
  const effects = parseEffectReview(value.effects, sources, facts);
  return value.decisions.map((v, i) => {
    const target = admissionTargets?.[i];
    const bound = target?.choice;
    const issues = schemaProblems(v, bound ? boundClarificationSchema(facts) : clarificationSchema(facts));
    if (issues.length) throw new Error(issues.join("；"));
    const wire = bound ? {
      ...(v as Record<string, unknown>),
      source: sources.findIndex((source) => source.id === target.sourceRevision) + 1,
      sourceQuote: target.sourceQuote,
    } : v;
    return {
      question: questions[i],
      decision: {
        ...parseClarificationDecision(JSON.stringify(wire), sources, facts),
        effects,
      },
      ...(target?.choice ? { admissionChoice: admissionChoiceProof(target) } : {}),
    };
  });
}
const text = { type: "string" };
export function clarificationSchema(facts?: TechnicalFact[]) {
  const common = {
    source: { type: "integer", minimum: 1 },
    sourceQuote: text,
    detail: text,
  };
  return {
    type: "object",
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", ...Object.keys(common), "fact", "property"],
        properties: {
          kind: { type: "string", enum: ["implementation"] },
          ...common,
          fact: { type: "integer", minimum: 1 },
          property: { type: "string", enum: ["detail", "editing"] },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", ...Object.keys(common)],
        properties: {
          kind: {
            type: "string",
            enum: ["business-ambiguity", "unnecessary", "scope-reduction"],
          },
          ...common,
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: [
          "kind",
          ...Object.keys(common),
          "fact",
          "property",
          "expected",
        ],
        ...(facts ? {anyOf: facts.flatMap((fact,index)=>Object.keys(fact.properties).map(property=>({
          properties:{fact:{enum:[index+1]},property:{enum:[property]},expected:{enum:technicalExpectationValues(fact,property)}},
        })))}:{}),
        properties: {
          kind: { type: "string", enum: ["technical"] },
          ...common,
          fact: { type: "integer", minimum: 1 },
          property: text,
          expected: text,
        },
      },
    ],
  };
}
export function parseClarificationDecision(
  text: string,
  sources: { id: string; text: string }[],
  facts: TechnicalFact[],
): ClarificationDecision {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("澄清审查结构无效");
  const v = raw as Record<string, unknown>;
  const keys = [
    "kind",
    "source",
    "sourceQuote",
    "detail",
    ...(v.kind === "technical"
      ? ["fact", "property", "expected"]
      : v.kind === "implementation"
        ? ["fact", "property"]
        : []),
  ];
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw new Error("澄清审查包含宿主派生字段");
  const source = sources[Number(v.source) - 1];
  if (
    !Number.isInteger(v.source) ||
    !source ||
    typeof v.sourceQuote !== "string" ||
    !v.sourceQuote.trim() ||
    !source.text.includes(v.sourceQuote) ||
    typeof v.detail !== "string" ||
    !v.detail.trim() ||
    v.detail.length > 10000 ||
    ![
      "business-ambiguity",
      "unnecessary",
      "scope-reduction",
      "technical",
      "implementation",
    ].includes(String(v.kind))
  )
    throw new Error("澄清审查缺少可靠来源解释");
  const decision: ClarificationDecision = {
    kind: v.kind as ClarificationDecision["kind"],
    sourceRevision: source.id,
    sourceQuote: v.sourceQuote,
    detail: v.detail,
  };
  if (v.kind === "technical" || v.kind === "implementation") {
    const fact = facts[Number(v.fact) - 1];
    if (
      !Number.isInteger(v.fact) ||
      !fact ||
      typeof v.property !== "string" ||
      !Object.hasOwn(fact.properties, v.property) ||
      (v.kind === "technical" && typeof v.expected !== "string") ||
      (v.kind === "implementation" &&
        (fact.id !== "host-fact:field-interaction" ||
          !["detail", "editing"].includes(String(v.property))))
    )
      throw new Error("澄清技术事实引用不支持");
    if (v.kind === "technical") assertTechnicalExpectation(fact, v.property, v.expected);
    decision.fact = {
      id: fact.id,
      hash: fact.evidenceHash,
      property: v.property,
      expected:
        v.kind === "implementation"
          ? fact.properties[v.property]
          : String(v.expected),
      actual: fact.properties[v.property],
    };
  }
  return decision;
}
