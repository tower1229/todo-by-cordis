import test from "node:test";
import assert from "node:assert/strict";
import { capabilityFacts, hostEffectIds, parseSourceReview, sourceReviewFailure, sourceReviewSchema } from "../../src/evolution/capability-admission.js";
import { schemaProblems } from "../../src/evolution/model-protocol.js";
import { hash } from "../../src/release/storage.js";

const sources = [{id:"request:1",text:"应用关闭后仍保证离线送达通知"},{id:"answer:2",text:"其他行为不变"}];
const noEffects = () => hostEffectIds.map(effect => ({effect,verdict:"not-requested"}));
const intent = () => ({reviewedSources:sources.map(source=>source.id),effects:noEffects().map(row=>row.effect==="offline-delivery"
  ? {...row,verdict:"required",source:1,sourceQuote:sources[0].text} : row)});

test("合并复核须覆盖全部原文及完整效果矩阵，不能靠空回执通过", () => {
  const valid = intent();
  const invalid = [undefined,{}, {...valid,reviewedSources:[sources[0].id]},
    {...valid,reviewedSources:[sources[0].id,sources[0].id]},
    {...valid,effects:[]}, {...valid,effects:[valid.effects[0],valid.effects[0],valid.effects[2]]}];
  for (const value of invalid) assert.throws(()=>parseSourceReview(value,sources,capabilityFacts()));
});

test("效果解释绑定原文和序号，模型不能提交宿主支持结论", () => {
  const valid = intent();
  for (const extra of [{source:3},{sourceQuote:"不存在的用户要求"},{outcome:"supported"}]) {
    const value = {...valid,effects:valid.effects.map(row=>row.effect==="offline-delivery"?{...row,...extra}:row)};
    assert.throws(()=>parseSourceReview(value,sources,capabilityFacts()));
    if (!Object.hasOwn(extra,"sourceQuote")) assert.ok(schemaProblems(value,sourceReviewSchema(sources)).length);
  }
});

test("同一来源判词在支持性翻转时保持原意，宿主独立改变裁决和身份", () => {
  const unsupported = capabilityFacts();
  const supported = unsupported.map(fact=>({...fact,properties:{...fact.properties,availability:"supported"},evidenceHash:hash([fact.id,"supported"])}));
  const blocked = parseSourceReview(intent(),sources,unsupported);
  const accepted = parseSourceReview(intent(),sources,supported);
  assert.deepEqual(blocked.effects.intents,accepted.effects.intents);
  assert.notEqual(blocked.effects.factsHash,accepted.effects.factsHash);
  assert.match(sourceReviewFailure(blocked,sources,unsupported)??"",/offline-delivery/);
  assert.equal(sourceReviewFailure(accepted,sources,supported),undefined);
  assert.ok(sourceReviewFailure(accepted,sources,unsupported));
});

test("已复核记录不接受来源漂移、支持性篡改或把不确定解释补签为通过", () => {
  const facts = capabilityFacts();
  const clear = parseSourceReview({reviewedSources:sources.map(source=>source.id),effects:noEffects()},sources,facts);
  assert.equal(sourceReviewFailure(clear,sources,facts),undefined);
  assert.ok(sourceReviewFailure(clear,[{...sources[0],text:"新要求"},sources[1]],facts));
  const tampered = parseSourceReview(intent(),sources,facts);
  tampered.effects.checks[0].outcome="supported";
  assert.ok(sourceReviewFailure(tampered,sources,facts));
  const uncertain = intent();
  uncertain.effects=uncertain.effects.map(row=>row.effect==="offline-delivery"?{...row,verdict:"uncertain"}:row);
  assert.match(sourceReviewFailure(parseSourceReview(uncertain,sources,facts),sources,facts)??"",/尚未裁决/);
});
