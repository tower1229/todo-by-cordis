import test from "node:test";
import assert from "node:assert/strict";
import { parseReview } from "../../src/server/requirement-coverage.js";
import { technicalFacts, semanticChoiceTargets, semanticChoiceProof } from "../../src/evolution/technical-facts.js";
import { questionReviewKey } from "../../src/evolution/request-admission.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";

const sources=[{id:"run:1",text:"已完成任务不能增加计数，其他行为不变"}];
function plan():InvestigatedPlan {
  return {requirements:[{id:"r",description:sources[0].text,sourceRevision:"run:1",sourceQuote:sources[0].text,type:"behavior",checks:[],obligations:[{version:1,id:"visibility",kind:"assertion",steps:[],expected:{kind:"action-visible",member:"counter",action:"increment",visible:false}}]}],workflowRules:[],binding:{guideCatalog:{},materials:[],capabilities:[],checkers:[]}} as unknown as InvestigatedPlan;
}

test("相同来源和事实的非业务裁决消解派生未决问题，来源或检查器改变必须重新审查",()=>{
  const p=plan();
  const choice=semanticChoiceTargets(p)[0];
  const wire=JSON.stringify({reviewedIds:["r"],issues:[],fieldDecisions:[],unresolvedChoices:[{targetId:choice.id,sourceRevision:"run:1",sourceQuote:sources[0].text}]});
  assert.equal(parseReview(wire,p,sources).issues.length,1);
  p.questionAdjudications=[{key:questionReviewKey(choice.question,sources,technicalFacts(p)),question:choice.question,choice:semanticChoiceProof(p,choice.id).proof,call:5,decision:{kind:"unnecessary",sourceRevision:"run:1",sourceQuote:sources[0].text,detail:"只要求禁止增加，动作呈现属于实现自由度"}}];
  const resolved=parseReview(wire,p,sources);
  assert.deepEqual(resolved.unresolvedChoices,[]);
  assert.deepEqual(resolved.issues,[]);
  assert.equal(JSON.parse(wire).unresolvedChoices.length,1,"原始模型返回保持不变");
  assert.equal(parseReview(wire,p,[{...sources[0],text:sources[0].text+"；必须隐藏动作"}]).issues.length,1);
  p.binding!.checkers=[{id:"browser/1",version:"changed"}];
  assert.equal(parseReview(wire,p,sources).issues.length,1);
});

test("非业务裁决不能清除独立业务异议，真实歧义及伪造引用仍阻塞",()=>{
  const p=plan(),choice=semanticChoiceTargets(p)[0];
  p.questionAdjudications=[{key:questionReviewKey(choice.question,sources,technicalFacts(p)),question:choice.question,choice:semanticChoiceProof(p,choice.id).proof,call:5,decision:{kind:"unnecessary",sourceRevision:"run:1",sourceQuote:sources[0].text,detail:"实现自由度"}}];
  const issue={kind:"conflict",sourceRevision:"run:1",sourceQuote:sources[0].text,detail:"独立业务异议必须保留",target:{subject:"r",aspect:"meaning"},stance:"required"};
  const wire=JSON.stringify({reviewedIds:["r"],issues:[issue],fieldDecisions:[],unresolvedChoices:[{targetId:choice.id,sourceRevision:"run:1",sourceQuote:sources[0].text}]});
  assert.deepEqual(parseReview(wire,p,sources).issues,[issue]);
  p.questionAdjudications[0].decision.kind="business-ambiguity";
  assert.equal(parseReview(wire,p,sources).issues.length,2);
  p.questionAdjudications[0].decision.kind="unnecessary";
  p.questionAdjudications[0].decision.sourceQuote="不存在的来源";
  assert.equal(parseReview(wire,p,sources).issues.length,2);
});

test("相同问题文字不能跨成员复用，目标定义变化、重复选择及无目标裁决均不能放行",()=>{
  const p=plan();
  const other=structuredClone(p.requirements![0].obligations![0]);
  assert.equal(other.kind,"assertion");
  if(other.kind!=="assertion"||other.expected.kind!=="action-visible")throw new Error("fixture");
  other.id="other-visibility";other.expected.member="other-counter";
  p.requirements![0].obligations!.push(other);
  const [first,second]=semanticChoiceTargets(p);
  assert.equal(first.question,second.question);
  p.questionAdjudications=[{key:questionReviewKey(first.question,sources,technicalFacts(p)),question:first.question,choice:semanticChoiceProof(p,first.id).proof,call:5,decision:{kind:"unnecessary",sourceRevision:"run:1",sourceQuote:sources[0].text,detail:"仅裁决第一个目标"}}];
  const choices=[first,second].map(c=>({targetId:c.id,sourceRevision:"run:1",sourceQuote:sources[0].text}));
  const wire={reviewedIds:["r"],issues:[],fieldDecisions:[],unresolvedChoices:choices};
  assert.deepEqual(parseReview(JSON.stringify(wire),p,sources).unresolvedChoices,[choices[1]]);
  assert.throws(()=>parseReview(JSON.stringify({...wire,unresolvedChoices:[choices[0],choices[0]]}),p,sources),/重复/);
  other.expected.visible=true;
  assert.equal(parseReview(JSON.stringify(wire),p,sources).issues.length,2);
  delete p.questionAdjudications[0].choice;
  assert.equal(parseReview(JSON.stringify(wire),p,sources).issues.length,2);
});
