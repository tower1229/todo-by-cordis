import test from "node:test";
import assert from "node:assert/strict";
import {
  admissionReviewRequest,
  admissionReviewSchema,
  admissionSchema,
  admissionResolved,
  adjudicateAdmission,
  parseAdmission,
  type RequestAdmission,
} from "../../src/evolution/request-admission.js";
import { semanticReuse } from "../../src/evolution/requirement-semantics.js";
import type { TechnicalFact } from "../../src/evolution/technical-facts.js";
import { hash } from "../../src/release/storage.js";
import { schemaProblems } from "../../src/evolution/model-protocol.js";

const sources = [{ id: "source:1", text: "任务到期时向外部推送通知（邮件或短信），并在离线时仍保证送达。" }];
const forbidden = ["outcome", "factId", "factHash"];
function proposed(outcome: "supported" | "unsupported") {
  const facts: TechnicalFact[] = ["external-delivery", "offline-delivery"].map((effect) => ({
    id: `host-fact:effect:${effect}`,
    properties: { availability: outcome },
    evidenceHash: hash({ effect, outcome }),
  }));
  return parseAdmission(JSON.stringify({
    initials: [], questions: [], effects: [
      { source: 1, sourceQuote: "向外部推送通知（邮件或短信）", effect: "external-delivery" },
      { source: 1, sourceQuote: "在离线时仍保证送达", effect: "offline-delivery" },
    ],
  }), "base", sources, facts);
}
function reviewed(admission: RequestAdmission, verdict: "entailed" | "uncertain" = "entailed") {
  return adjudicateAdmission(JSON.stringify({ decisions: admission.claims.map((claim, index) => ({
    claim: index + 1, source: 1, sourceQuote: claim.sourceQuote,
    layer: "capability", verdict, detail: verdict === "entailed" ? "原文明示外部和离线投递要求" : "来源命题仍未确定",
  })) }), admission, sources);
}
function reviewClaims(admission: RequestAdmission) {
  return (JSON.parse(admissionReviewRequest(admission, sources).message ?? "{}") as {
    claims: { sourceRevision: string; sourceQuote: string; interpretation: Record<string, unknown> }[];
  }).claims;
}

test("来源复核只接收原文命题，支持性和事实摘要留在宿主检查记录", () => {
  const admission = proposed("unsupported");
  assert.equal(JSON.parse(admissionReviewRequest(admission, sources).message ?? "{}").kind, "admission-source-review/3");
  const claims = reviewClaims(admission);
  assert.equal(claims.length, 2);
  for (const claim of claims) {
    assert.deepEqual(Object.keys(claim.interpretation).sort(), ["effect", "layer"]);
    for (const key of forbidden) assert.equal(Object.hasOwn(claim.interpretation, key), false);
  }
  assert.ok(admission.capabilityChecks.every((check) => check.outcome === "unsupported" && check.factHash));
});

test("宿主可用性变化不改变来源命题或身份，但事实绑定与最终阻塞必须变化（语义判词桩）", () => {
  const unsupported = proposed("unsupported"), supported = proposed("supported");
  assert.deepEqual(reviewClaims(unsupported), reviewClaims(supported));
  assert.deepEqual(unsupported.claims.map((claim) => claim.id), supported.claims.map((claim) => claim.id));
  assert.notEqual(unsupported.key, supported.key);
  assert.equal(reviewed(unsupported).blockers.length, 2);
  assert.deepEqual(reviewed(supported).blockers, []);
});

test("分离输入不会放行不支持的需求、覆盖不确定判词或接受篡改的技术裁决（语义判词桩）", () => {
  const supportedSource = reviewed(proposed("unsupported"));
  assert.ok(admissionResolved(supportedSource));
  assert.equal(supportedSource.blockers.length, 2);
  const uncertain = reviewed(proposed("unsupported"), "uncertain");
  assert.ok(uncertain.blockers.every((reason) => reason.startsWith("来源语义尚未裁决")));
  const tampered = structuredClone(supportedSource);
  tampered.capabilityChecks[0].outcome = "supported";
  assert.equal(admissionResolved(tampered), false);
});

test("复用的来源裁决不把宿主支持性重新带回模型上下文（语义判词桩）", () => {
  const reused = semanticReuse([reviewed(proposed("unsupported"))], sources);
  assert.equal(reused.length, 2);
  for (const entry of reused)
    for (const key of forbidden) assert.equal(Object.hasOwn(entry.target, key), false);
});

test("缺少来源与事实分离契约的旧预检不能补造为新门禁证据（语义判词桩）", () => {
  const old: unknown = { ...reviewed(proposed("unsupported")), contract: "host-admission/10" };
  assert.equal(admissionResolved(old as RequestAdmission), false);
});

test("发布给模型的预检契约包含宿主已知的来源上界，不能允许校验器必然拒绝的序号", () => {
  const admission = proposed("unsupported");
  const schema = admissionSchema(admission.factsSnapshot, admission.sources);
  const invalid = structuredClone(admission.intents);
  invalid.effects[0].source = 2;
  assert.deepEqual(schemaProblems(admission.intents, schema), []);
  assert.ok(schemaProblems(invalid, schema).length > 0);
  assert.throws(() => parseAdmission(JSON.stringify(invalid), "base", sources, admission.factsSnapshot));
});

test("发布给模型的来源复核契约也按当前来源目录限制序号", () => {
  const admission = proposed("unsupported");
  const value = { decisions: admission.claims.map((claim, index) => ({
    claim: index + 1, source: 1, sourceQuote: claim.sourceQuote,
    layer: "capability", verdict: "entailed", detail: "原文明确要求",
  })) };
  const invalid = structuredClone(value);
  invalid.decisions[0].source = 2;
  const schema = admissionReviewSchema(admission);
  assert.deepEqual(schemaProblems(value, schema), []);
  assert.ok(schemaProblems(invalid, schema).length > 0);
  assert.throws(() => adjudicateAdmission(JSON.stringify(invalid), admission, sources));
});
