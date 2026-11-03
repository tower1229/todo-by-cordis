import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {parseFieldDecisions} from "../../src/evolution/field-review.js";
import {recordReview,reviewDefinitionHash,reviewEvidence} from "../../src/evolution/review.js";
import type {InvestigatedPlan,RequirementReview} from "../../src/shared/assistant.js";
import type {ReviewLedger} from "../../src/shared/change-spec.js";

type Frame={
  plan:Pick<InvestigatedPlan,"requirements"|"workflowRules">;
  sources:{id:string;text:string}[];
  rawReview:{reviewedIds:string[];issues:RequirementReview["issues"];fieldDecisions:unknown};
};
const fixture=()=>JSON.parse(readFileSync(new URL("../fixtures/field-review-stance-replay.json",import.meta.url),"utf8")) as Frame;
const emptyLedger=():ReviewLedger=>({version:2,findings:[],attempts:[]});
function reviewed(f:Frame){
  const fields=parseFieldDecisions(f.rawReview.fieldDecisions,f.plan,f.sources);
  const review:RequirementReview={reviewedIds:f.rawReview.reviewedIds,issues:[...f.rawReview.issues,...fields.issues],fieldDecisions:fields.decisions};
  return {fields,review};
}
function record(f:Frame,ledger:ReviewLedger,review:RequirementReview){
  // The captured projection retains the fields read for this requirement target.
  const plan=f.plan as InvestigatedPlan;
  return recordReview(ledger,review,1,reviewDefinitionHash(plan),i=>reviewEvidence(plan,f.sources,i));
}

for(const reverse of [false,true])test(`真实第201次复核投影：同向的额外约束意见不构成反向停止（${reverse?"宿主先":"模型先"}）`,()=>{
  const f=fixture(),before=structuredClone(f),{fields,review}=reviewed(f),ledger=emptyLedger();
  assert.equal(fields.issues.length,1);
  assert.equal(fields.issues[0].kind,"extra-constraint");
  assert.equal(fields.issues[0].stance,"forbidden");
  assert.equal(fields.issues[0].sourceDecision?.kind,"field-initial");
  if(reverse)review.issues.reverse();
  assert.deepEqual(record(f,ledger,review),{blockers:[],halt:false});
  assert.equal(review.issues.length,2,"业务问题仍保留，不能据此批准方案");
  assert.equal(ledger.attempts[0].review.issues.length,2,"模型和宿主原意见分别留证");
  assert.ok(ledger.findings.every(x=>x.status==="open"));
  assert.deepEqual(f,before,"不能自动修正业务值或改写原回执");
});

test("模型确实坚持相反立场时，原冲突停止保护保持有效",()=>{
  const f=fixture();f.rawReview.issues[0].stance="required";
  const {review}=reviewed(f),ledger=emptyLedger(),result=record(f,ledger,review);
  assert.equal(result.halt,true);
  assert.ok(result.blockers.some(x=>x.includes("相反立场")));
  assert.ok(ledger.findings.some(x=>x.status==="conflicting"));
});

test("原文明确要求初始显示而方案不符时，仍产生必须补齐的遗漏",()=>{
  const f=fixture(),quote="未填写标签时显示“待设置”。";
  f.sources[0].text=quote;f.plan.requirements![0].sourceQuote=quote;
  const fields=parseFieldDecisions([{target:1,source:1,sourceQuote:quote,initial:{kind:"literal",value:"待设置",conditionQuote:"未填写标签时",effectQuote:"显示“待设置”"}}],f.plan,f.sources);
  assert.equal(fields.issues.length,1);
  assert.equal(fields.issues[0].kind,"omission");
  assert.equal(fields.issues[0].stance,"required");
});

test("同向问题在没有新证据的后续复核中重复，仍须停止",()=>{
  const f=fixture(),{review}=reviewed(f),ledger=emptyLedger();
  assert.equal(record(f,ledger,structuredClone(review)).halt,false);
  const repeated=record(f,ledger,structuredClone(review));
  assert.equal(repeated.halt,true);
  assert.ok(repeated.blockers.some(x=>x.includes("重复且没有新的规格或需求证据")));
});

test("来源更正后仍须显式消解旧问题，不能静默清空历史",()=>{
  const f=fixture(),{review}=reviewed(f),ledger=emptyLedger();
  assert.equal(record(f,ledger,review).halt,false);
  const corrected=fixture(),field=corrected.plan.requirements![0].obligations!.find(o=>o.kind==="field")!;
  assert.equal(field.kind,"field");if(field.kind!=="field")throw new Error("Missing field");
  field.initialOrigin="host";
  const fields=parseFieldDecisions(corrected.rawReview.fieldDecisions,corrected.plan,corrected.sources);
  assert.deepEqual(fields.issues,[]);
  const fixed:RequirementReview={reviewedIds:corrected.rawReview.reviewedIds,issues:[],fieldDecisions:fields.decisions};
  assert.ok(record(corrected,ledger,fixed).blockers.some(x=>x.includes("历史问题尚未有来源支持的消解")));
  assert.ok(ledger.findings.every(x=>x.status==="open"));
  const resolved=record(corrected,ledger,{...fixed,resolutions:[{issueId:ledger.findings[0].id,sourceRevision:corrected.sources[0].id,sourceQuote:corrected.sources[0].text,reason:"仅更正来源归属，保留字段值和操作断言"}]});
  assert.deepEqual(resolved,{blockers:[],halt:false});
  assert.ok(ledger.findings.every(x=>x.status==="resolved"));
});
