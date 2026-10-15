import type { TechnicalFact } from "./technical-facts.js";
import { hash } from "../release/storage.js";
import { schemaProblems } from "./model-protocol.js";
import type { ClarificationDecision } from "./clarification-review.js";

type Source = { id: string; text: string };
type Citation = { sourceRevision: string; sourceQuote: string };
export const questionReviewKey = (question:string,sources:Source[],facts:TechnicalFact[]) => hash({question,sources,facts});
export function admissionQuestionState(admission:RequestAdmission,sources:Source[],facts:TechnicalFact[],reviews:{key:string;decision:ClarificationDecision}[]) {
  const pending:string[]=[], questions:string[]=[], blockers:string[]=[];
  for(const q of admission.questions){
    const matches=reviews.filter(r=>r.key===questionReviewKey(q.question,sources,facts));
    if(new Set(matches.map(r=>hash(r.decision))).size>1){blockers.push("同一澄清裁决冲突，须重新调查");continue;}
    const decision=matches[0]?.decision;
    if(!decision){pending.push(q.question);continue;}
    if(decision.kind==="business-ambiguity")questions.push(q.question);
    else if(decision.kind==="scope-reduction" || (decision.kind==="technical"&&decision.fact?.expected!==decision.fact?.actual))blockers.push(`澄清审查确认需要维护者处理：${decision.detail}`);
  }
  return {pending:[...new Set(pending)],questions:[...new Set(questions)],blockers:[...new Set(blockers)]};
}
export type RequestAdmission = {
  key: string;
  baseVersion: string;
  sourceHash: string;
  factsHash: string;
  presentations: (Citation & {
    surface: "workflow" | "auxiliary";
    kind: "visible" | "absent";
    value: string;
  })[];
  questions: (Citation & { question: string })[];
  facts: (Citation & {
    id: string;
    property: string;
    expected: string;
    actual: string;
    evidenceHash: string;
  })[];
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
export const admissionSchema = {
  type: "object",
  additionalProperties: false,
  required: ["presentations", "questions", "facts"],
  properties: {
    presentations: {
      type: "array",
      maxItems: 20,
      items: {
        anyOf: [
          list({
            ...citation,
            surface: { ...text, enum: ["workflow", "auxiliary"] },
            kind: { ...text, enum: ["visible"] },
            value: text,
          }).items,
          list({
            ...citation,
            surface: { ...text, enum: ["workflow", "auxiliary"] },
            kind: { ...text, enum: ["absent"] },
          }).items,
        ],
      },
    },
    questions: list({
      ...citation,
      question: { ...text, minLength: 1, maxLength: 3000 },
    }),
    facts: list({
      ...citation,
      fact: { type: "integer", minimum: 1 },
      property: text,
      expected: text,
    }),
  },
};
export const admissionInstruction =
  "独立解释原始需求和回答，输出需求预检 JSON，禁止工具。presentations 只列用户明确要求的字段未填写时呈现（workflow=主工作流字段，auxiliary=独立成员任务详情字段）；没有初始呈现要求则为空，不能从宿主默认推导业务要求。questions 只列全部 sources 看完后仍未决定且影响实现的业务选择，集中提出；用户已明确的值、技术事实及需要维护者扩展的能力不是业务歧义，不能询问是否接受降级。facts 只列需求依赖的现有技术条件，使用宿主 facts 一基序号、property 和 required expected；由宿主比较实际值。每项引用 sources 一基序号及连续原文。facts 中不存在的未知实现细节留给后续调查，不凭猜测拒绝；此预检不替代完整规划及独立需求复核。";

export function admissionKey(
  baseVersion: string,
  sources: Source[],
  facts: TechnicalFact[],
) {
  return hash({ baseVersion, sources, facts });
}
export function parseAdmission(
  text: string,
  baseVersion: string,
  sources: Source[],
  facts: TechnicalFact[],
): RequestAdmission {
  const value: unknown = JSON.parse(text);
  const problems = schemaProblems(value, admissionSchema);
  if (problems.length) throw new Error(problems.join("；"));
  const raw = value as {
    presentations: {
      source: number;
      sourceQuote: string;
      surface: "workflow" | "auxiliary";
      kind: "visible" | "absent";
      value?: string;
    }[];
    questions: { source: number; sourceQuote: string; question: string }[];
    facts: {
      source: number;
      sourceQuote: string;
      fact: number;
      property: string;
      expected: string;
    }[];
  };
  function bind(v: { source: number; sourceQuote: string }): Citation {
    const s = sources[v.source - 1];
    if (!s || !v.sourceQuote.trim() || !s.text.includes(v.sourceQuote))
      throw new Error("需求预检引用不存在的来源原文");
    return { sourceRevision: s.id, sourceQuote: v.sourceQuote };
  }
  const blockers: string[] = [];
  const presentations = raw.presentations.map((v) => {
    const citation = bind(v);
    const value = v.kind === "visible" ? v.value! : "";
    const presentation = facts.find(
      (f) => f.id === "host-fact:initial-field-presentation",
    );
    const supported =
      v.surface === "workflow"
        ? v.kind === "absent" &&
          presentation?.properties.workflowMissingField === "absent"
        : v.kind === "visible" &&
          value === presentation?.properties.auxiliaryMissingField;
    if (!supported)
      blockers.push(
        `需求原文 ${JSON.stringify(v.sourceQuote)} 要求的 ${v.surface} 初始呈现 ${v.kind}:${JSON.stringify(value)} 无法由当前受保护渲染器表达，需要维护者扩展；不能替换期望或询问降级`,
      );
    return { ...citation, surface: v.surface, kind: v.kind, value };
  });
  const decisions = raw.facts.map((v) => {
    const citation = bind(v),
      f = facts[v.fact - 1];
    if (!f || !Object.hasOwn(f.properties, v.property))
      throw new Error("需求预检技术事实引用不存在");
    const actual = f.properties[v.property];
    if (actual !== v.expected)
      blockers.push(
        `需求原文 ${JSON.stringify(v.sourceQuote)} 所需技术条件 ${f.id}.${v.property}=${v.expected} 与宿主实际 ${actual} 不一致，需要维护者处理`,
      );
    return {
      ...citation,
      id: f.id,
      property: v.property,
      expected: v.expected,
      actual,
      evidenceHash: f.evidenceHash,
    };
  });
  return {
    key: admissionKey(baseVersion, sources, facts),
    baseVersion,
    sourceHash: hash(sources),
    factsHash: hash(facts),
    presentations,
    questions: raw.questions.map((v) => ({
      ...bind(v),
      question: v.question.trim(),
    })),
    facts: decisions,
    blockers,
  };
}
