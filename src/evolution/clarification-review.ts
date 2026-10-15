import type { TechnicalFact } from "./technical-facts.js";
export type ClarificationDecision = {
  kind: "business-ambiguity" | "unnecessary" | "scope-reduction" | "technical";
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
const text = { type: "string" };
export function clarificationSchema() {
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
    ...(v.kind === "technical" ? ["fact", "property", "expected"] : []),
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
    ].includes(String(v.kind))
  )
    throw new Error("澄清审查缺少可靠来源解释");
  const decision: ClarificationDecision = {
    kind: v.kind as ClarificationDecision["kind"],
    sourceRevision: source.id,
    sourceQuote: v.sourceQuote,
    detail: v.detail,
  };
  if (v.kind === "technical") {
    const fact = facts[Number(v.fact) - 1];
    if (
      !Number.isInteger(v.fact) ||
      !fact ||
      typeof v.property !== "string" ||
      !Object.hasOwn(fact.properties, v.property) ||
      typeof v.expected !== "string"
    )
      throw new Error("澄清技术事实引用不支持");
    decision.fact = {
      id: fact.id,
      hash: fact.evidenceHash,
      property: v.property,
      expected: v.expected,
      actual: fact.properties[v.property],
    };
  }
  return decision;
}
