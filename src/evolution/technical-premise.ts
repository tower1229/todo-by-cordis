import { hash } from "../release/storage.js";
import type {
  InvestigatedPlan,
  RequirementReview,
} from "../shared/assistant.js";
import type { TechnicalFact } from "./technical-facts.js";
import type { ModelRequest } from "./driver.js";
import { schemaProblems } from "./model-protocol.js";

type Source = { id: string; text: string };
export type TechnicalPremiseContext = {
  sources: Source[];
  scope: {
    baseVersion: string;
    workflowFields: { key: string; label: string }[];
  };
};
type Claim = {
  id: string;
  sourceRevision: string;
  factId: string;
  property: string;
  expected: string;
};
type Verdict = "entailed" | "not-requested" | "uncertain";
export type TechnicalPremiseAudit = {
  contract: "technical-premise/1";
  key: string;
  sourceHash: string;
  factsHash: string;
  scopeHash: string;
  claims: Claim[];
  decisions: { claimId: string; verdict: Verdict; detail: string }[];
};

export function technicalPremiseContext(
  plan: Pick<InvestigatedPlan, "baseVersion" | "workflowRules">,
  sources: Source[],
): TechnicalPremiseContext {
  if (!plan.baseVersion) throw new Error("技术语义前提复核缺少冻结基础版本");
  return {
    sources,
    scope: {
      baseVersion: plan.baseVersion,
      workflowFields: plan.workflowRules.map(({ key, label }) => ({
        key,
        label,
      })),
    },
  };
}

/** Citations support a claim; their wording is not its identity. */
function claimsFor(review: RequirementReview, facts: TechnicalFact[]): Claim[] {
  const claims = new Map<string, Claim>();
  for (const issue of review.issues) {
    const claim = issue.technical;
    if (!claim) continue;
    const actual = facts.find((fact) => fact.id === claim.factId)?.properties[
      claim.property
    ];
    if (actual === undefined || actual === claim.expected) continue;
    const body = { sourceRevision: issue.sourceRevision, ...claim };
    const id = "technical-premise:" + hash(body).slice(0, 24);
    claims.set(id, { id, ...body });
  }
  return [...claims.values()].sort((a, b) => a.id.localeCompare(b.id));
}

export function technicalPremiseBasis(
  review: RequirementReview,
  facts: TechnicalFact[],
  context: TechnicalPremiseContext,
) {
  const claims = claimsFor(review, facts);
  if (
    claims.some(
      (claim) =>
        !context.sources.some((source) => source.id === claim.sourceRevision),
    )
  )
    throw new Error("技术语义前提引用不存在的需求修订");
  const body = {
    contract: "technical-premise/1" as const,
    sourceHash: hash(context.sources),
    factsHash: hash(
      facts.filter((fact) => claims.some((claim) => claim.factId === fact.id)),
    ),
    scopeHash: hash(context.scope),
    claims,
  };
  return { ...body, key: hash(body) };
}

function premiseSchema(count: number) {
  return {
    type: "object",
    additionalProperties: false,
    required: ["decisions"],
    properties: {
      decisions: {
        type: "array",
        minItems: count,
        maxItems: count,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["verdict", "detail"],
          properties: {
            verdict: {
              type: "string",
              enum: ["entailed", "not-requested", "uncertain"],
            },
            detail: { type: "string", minLength: 1, maxLength: 5000 },
          },
        },
      },
    },
  };
}

export function technicalPremiseRequest(
  review: RequirementReview,
  facts: TechnicalFact[],
  context: TechnicalPremiseContext,
): ModelRequest {
  const basis = technicalPremiseBasis(review, facts, context);
  if (!basis.claims.length) throw new Error("没有需要独立复核的技术语义前提");
  return {
    phase: "review",
    history: [],
    schema: premiseSchema(basis.claims.length),
    instruction:
      "独立复核来源命题，禁止工具。按 claims 顺序判断完整 sources 是否明确或必然要求指定作用域内的 property=expected：entailed、not-requested、uncertain。只返回 verdict 和来源理由 detail；身份及引用由宿主绑定。只裁决用户要求，不判断技术支持性，不从未提及某行为推出相反行为也被要求。宿主当前实际值和前次复核意见不作为来源。persistenceNormalization 是完成字段实际保存值的规范化，validationNormalization 仅作用于校验值，两者不可互相推导。",
    message: JSON.stringify({
      kind: "technical-premise-review/1",
      sources: context.sources,
      scope: context.scope,
      claims: basis.claims.map(
        ({ sourceRevision, factId, property, expected }) => ({
          sourceRevision,
          factId,
          property,
          expected,
        }),
      ),
    }),
  };
}

export function parseTechnicalPremises(
  text: string,
  review: RequirementReview,
  facts: TechnicalFact[],
  context: TechnicalPremiseContext,
): TechnicalPremiseAudit {
  const basis = technicalPremiseBasis(review, facts, context);
  const value: unknown = JSON.parse(text);
  const problems = schemaProblems(value, premiseSchema(basis.claims.length));
  if (problems.length) throw new Error(problems.join("；"));
  const raw = value as { decisions: { verdict: Verdict; detail: string }[] };
  return {
    ...basis,
    decisions: raw.decisions.map((decision, index) => ({
      ...decision,
      claimId: basis.claims[index].id,
    })),
  };
}

export function technicalPremisesResolved(
  audit: TechnicalPremiseAudit,
  review: RequirementReview,
  facts: TechnicalFact[],
  context: TechnicalPremiseContext,
) {
  try {
    const replay = parseTechnicalPremises(
      JSON.stringify({
        decisions: audit.decisions.map(({ verdict, detail }) => ({
          verdict,
          detail,
        })),
      }),
      review,
      facts,
      context,
    );
    return hash(audit) === hash(replay);
  } catch {
    return false;
  }
}

export function technicalPremiseDecision(
  audit: TechnicalPremiseAudit,
  issue: RequirementReview["issues"][number],
) {
  const claim = audit.claims.find(
    (claim) =>
      claim.sourceRevision === issue.sourceRevision &&
      claim.factId === issue.technical?.factId &&
      claim.property === issue.technical.property &&
      claim.expected === issue.technical.expected,
  );
  return claim
    ? audit.decisions.find((decision) => decision.claimId === claim.id)
    : undefined;
}
