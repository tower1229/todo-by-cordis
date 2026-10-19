import { fieldTargetId } from "../../src/evolution/field-identity.js";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import { PlanningDriver, clarificationPayloadFixture, noEffectsFixture } from "./planning-fixture.js";
import { parseEffectReview, effectReviewResolved } from "../../src/evolution/capability-admission.js";
import {
  responseSchema,
  schemaProblems,
} from "../../src/evolution/model-protocol.js";
import { clarificationSchema } from "../../src/evolution/clarification-review.js";
import {
  parseAdmission,
  admissionSchema,
  admissionQuestionState,
  questionReviewKey,
  adjudicateAdmission,
  admissionResolved,
} from "../../src/evolution/request-admission.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import { BudgetScheduler } from "../../src/evolution/budget.js";
import { ModelTransportError } from "../../src/evolution/driver.js";
import { DeepSeek } from "../../src/evolution/deepseek.js";
import {fieldFacts} from "../../src/evolution/field-identity.js";
import {memberUiReleaseInput} from "../fixtures/member-ui.js";
import { compileSemantics } from "../../src/evolution/requirement-semantics.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";

const reply = (value: unknown) => ({
  text: JSON.stringify(value),
  calls: [],
  history: [],
  raw: { fixture: value },
  usage: { totalTokenCount: 7 },
});
const empty = () => ({ effects: [], initials: [], questions: [] });
const input = (r: ModelRequest) => JSON.parse(r.message ?? "{}");
test("业务初始值经独立分层后不接受渲染器裁决，显式初始显示仍受同一门禁保护", () => {
  const sources = [{ id: "s:1", text: "计数初始为零，未完成任务可以加一" }];
  const facts = technicalFacts({ workflowRules: [], binding: undefined });
  const proposed = parseAdmission(JSON.stringify({
    ...empty(), effects: [], initials: [{
      source: 1, sourceQuote: "计数初始为零", target: { kind: "new", name: "计数" },
      meaning: { kind: "literal", value: "0", conditionQuote: "初始", effectQuote: "为零" },
    }],
  }), "base", sources, facts);
  const admitted = adjudicateAdmission(JSON.stringify({ decisions: [{
    claim: 1, source: 1, sourceQuote: "计数初始为零", verdict: "entailed",
    layer: "initial-state", detail: "规定业务计数的初始逻辑值，没有规定未赋值字段如何显示",
  }] }), proposed, sources);
  assert.deepEqual(admitted.blockers, []);
  assert.ok(admissionResolved(admitted));
  assert.equal(admitted.technicalChecks[0].outcome, "not-applicable");
  const semantics = compileSemantics({ requirements: [], workflowRules: [], requestAdmission: admitted } as Pick<InvestigatedPlan, "requirements" | "workflowRules" | "requestAdmission">, sources);
  assert(semantics.entries.some(e => e.target.aspect === "initial-state" && e.value === "0"));
  assert(!semantics.entries.some(e => e.target.aspect === "initial-display" && e.status === "specified"));
  const displaySources = [{ id: "s:2", text: "未填写时初始显示0" }];
  const display = parseAdmission(JSON.stringify({ ...empty(), effects: [], initials: [{
    source: 1, sourceQuote: displaySources[0].text, target: { kind: "new", name: "计数" },
    meaning: { kind: "literal", value: "0", conditionQuote: "未填写时", effectQuote: "显示0" },
  }] }), "base", displaySources, facts);
  const blocked = adjudicateAdmission(JSON.stringify({ decisions: [{ claim: 1, source: 1,
    sourceQuote: displaySources[0].text, layer: "initial-display", verdict: "entailed", detail: "明确要求显示0",
  }] }), display, displaySources);
  assert.equal(blocked.blockers.length, 1);
  assert.equal(admissionResolved({ ...admitted, semanticReview: blocked.semanticReview }), false);
});
test("同一来源同一字段的业务值和显示值具有独立宿主身份，不能串用裁决", () => {
  const sources=[{id:"s:1",text:"逻辑初始为零，同时要求初始显示0"}],facts=technicalFacts({workflowRules:[],binding:undefined});
  const item={source:1,sourceQuote:sources[0].text,target:{kind:"new",name:"计数"},meaning:{kind:"state",value:"0",conditionQuote:"初始",effectQuote:"为零"}};
  const p=parseAdmission(JSON.stringify({...empty(),initials:[item,item,{...item,meaning:{...item.meaning,kind:"literal",effectQuote:"显示0"}}]}),"base",sources,facts);
  assert.equal(p.claims.length,2,"相同输入由宿主去重，不要求模型维护引用");
  const a=adjudicateAdmission(JSON.stringify({decisions:p.claims.map((c,i)=>({claim:i+1,source:1,sourceQuote:sources[0].text,layer:c.interpretation.layer,verdict:"entailed",detail:"两个分层命题均明确"}))}),p,sources);
  assert.equal(a.initialStates.length,1);assert.equal(a.presentations.length,1);
  assert.equal(a.technicalChecks[0].outcome,"unsupported");assert.equal(a.blockers.length,1);
  assert.notEqual(a.initialStates[0].intentId,a.presentations[0].intentId);
});
test("澄清的能力矩阵不能遗漏、重复、伪造来源或篡改宿主事实", () => {
  const sources=[{id:"s:1",text:"外部通知"}],facts=technicalFacts({workflowRules:[],binding:undefined});
  const matrix=noEffectsFixture();
  for(const value of [[],matrix.slice(1),[matrix[0],matrix[0],matrix[2]],[{effect:"external-delivery",verdict:"required",source:1,sourceQuote:"假来源"},...matrix.slice(1)]])
    assert.throws(()=>parseEffectReview(value,sources,facts),/矩阵|来源/);
  const receipt=parseEffectReview(matrix,sources,facts);assert(effectReviewResolved(receipt,sources,facts));
  assert(!effectReviewResolved({...receipt,checks:[{effect:"external-delivery",verdict:"required",sourceRevision:"s:1",sourceQuote:"外部通知",factId:"fake",factHash:"fake",outcome:"supported"}]},sources,facts));
  assert.throws(()=>parseAdmission(JSON.stringify({presentations:[],effects:[],questions:[]}),"base",sources,facts),/initials|未授权/);
});
test("已证实的外部和离线交付缺口先于渠道澄清，在原预算内阻塞且无候选", async t => {
  const { e } = await setup(t, { async generate(request) {
    const v = input(request);
    if (v.kind === "request-admission/2") return reply({ ...empty(), effects: [
      { source: 1, sourceQuote: "向外部推送通知", effect: "external-delivery" },
      { source: 1, sourceQuote: "离线时仍保证送达", effect: "offline-delivery" },
    ], questions: [{ source: 1, sourceQuote: "邮件或短信", question: "选择邮件还是短信，接收人是谁？" }] });
    assert.equal(v.kind, "admission-source-review/2", "不能先审查渠道或进入业务规划");
    return reply({ decisions: v.claims.map((c: { sourceQuote: string }, i: number) => ({
      claim: i + 1, source: 1, sourceQuote: c.sourceQuote, layer: "capability", verdict: "entailed", detail: "用户明确要求外部交付和离线保证",
    })) });
  } });
  await e.command({ type: "request", text: "任务到期时向外部推送通知（邮件或短信），离线时仍保证送达", operationId: "request" });
  const run = await settle(e);
  assert.equal(run.status, "blocked");
  assert.equal(run.budget?.callsUsed, 2);
  assert.equal(run.budget?.callsRemaining, 10);
  assert.equal(run.clarificationReviews?.length ?? 0, 0);
  assert.equal((await e.observe()).candidates?.length, 0);
  assert.equal(run.requestAdmissions?.[0].capabilityChecks.length, 2);
  assert.equal(run.stop?.code, "unsupported-host-effect");
});
test("预检遗漏能力也不能通过澄清绕过：独立来源能力矩阵先裁决再决定提问", async t => {
  const { e } = await setup(t, { async generate(request) {
    const v = input(request);
    if (v.kind === "request-admission/2") return reply({ ...empty(), questions: [{source:1,sourceQuote:"邮件或短信",question:"选择邮件还是短信？"}] });
    assert.equal(v.kind,"clarification-review/2");
    return reply({ decisions:[{kind:"business-ambiguity",source:1,sourceQuote:"邮件或短信",detail:"渠道还未选择"}], effects:[
      {effect:"external-delivery",verdict:"required",source:1,sourceQuote:"向外部推送通知"},
      {effect:"offline-delivery",verdict:"required",source:1,sourceQuote:"离线时仍保证送达"},
      {effect:"online-schedule",verdict:"not-requested"},
    ] });
  } });
  await e.command({type:"request",text:"任务到期时向外部推送通知（邮件或短信），离线时仍保证送达",operationId:"request"});
  const run=await settle(e);
  assert.equal(run.status,"blocked");
  assert.equal(run.stop?.kind,"capability");
  assert.equal(run.budget?.callsUsed,2);
});

test("宿主已有只读详情和显式动作表单不再交给用户选择，真正业务歧义仍保留", async t => {
  const fixture = new PlanningDriver();
  const { e } = await setup(t, { async generate(request, signal) {
    const v = input(request);
    if (v.kind === "request-admission/2") return reply({ ...empty(), questions: [{ source: 1,
      sourceQuote: "重新打开保留复盘", question: "重新打开后保留的复盘是只读展示还是直接编辑？" }] });
    if (v.kind === "clarification-review/2") return reply(clarificationPayloadFixture({ kind: "implementation", source: 1,
      sourceQuote: "重新打开保留复盘", detail: "只规定保留数据，未要求改变宿主详情与输入交互",
      fact: v.facts.findIndex((f: {id:string}) => f.id === "host-fact:field-interaction") + 1, property: "detail" }));
    return fixture.generate(request, signal);
  } });
  await e.command({ type: "request", text: "完成前必填复盘，重新打开保留复盘，其他行为不变", operationId: "request" });
  const run = await settle(e);
  assert.equal(run.status, "ready");
  assert.equal(run.stop, undefined);
  assert.equal(run.budget?.callsUsed, 4);
  assert.equal(run.clarificationReviews?.[0].decision.fact?.actual, "read-only-display");
});
test("来源标签误判经独立裁决后继续必要澄清，完整原文及争议随同一运行和预算保留", async (t) => {
  const fixture = new PlanningDriver();
  const { e, w } = await setup(t, { async generate(r, signal) {
    const v = input(r);
    if (v.kind === "request-admission/2") return reply(v.sources.length === 1 ? {
      ...empty(),
      effects: [], initials: [{ source: 1, sourceQuote: "完成前填写复盘", target: {kind:"new",name:"复盘"}, meaning:{kind:"literal",value:"复盘",conditionQuote:"完成前填写复盘",effectQuote:"完成前填写复盘"} }],
      questions: [{ source: 1, sourceQuote: "是否必填尚未决定", question: "复盘是否必填？" }],
    } : empty());
    if (v.kind === "admission-source-review/2") {
      assert.deepEqual(r.history, []); assert.equal(r.tools, undefined);
      assert.equal(v.claims[0].interpretation.condition, "initial-missing-field");
      return reply({ decisions: [{ claim: 1, source: 1, sourceQuote: "完成前填写复盘", layer: "initial-display", verdict:"not-requested", detail: "复盘是待填写的字段，原文没有要求该字样作为初始值" }] });
    }
    return fixture.generate(r, signal);
  } });
  await e.command({ type: "request", text: "完成前填写复盘，是否必填尚未决定", operationId: "request" });
  const waiting = await settle(e); assert.equal(waiting.status, "awaiting-input");
  assert.equal(waiting.budget?.callsUsed, 3);
  assert.equal(waiting.requestAdmissions?.[0].claims.length, 1);
  assert.equal(waiting.requestAdmissions?.[0].semanticReview?.decisions[0].verdict, "not-requested");
  await e.command({ type: "answer", runId: waiting.id, text: "复盘必填，其他行为不变", operationId: "answer" });
  const ready = await settle(e); assert.equal(ready.status, "ready");
  assert.equal(ready.budget?.callsUsed, 6); assert.equal(ready.budget!.callsRemaining, 6);
  assert.equal(ready.requestAdmissions?.length, 2);
  assert.equal(w.db.prepare("SELECT count(*) n FROM evolution_calls").get()!.n, 6);
});

test("来源裁决不能漏项、重复、伪造原文或将未裁决争议标为已解决", () => {
  const sources = [{ id: "source:1", text: "完成前填写复盘" }];
  const proposed = parseAdmission(JSON.stringify({ ...empty(), effects: [], initials: [{ source: 1, sourceQuote: sources[0].text, target: {kind:"new",name:"复盘"}, meaning:{kind:"literal",value:"复盘",conditionQuote:"完成前填写复盘",effectQuote:"完成前填写复盘"} }] }), "base", sources, technicalFacts({ workflowRules: [], binding: undefined }));
  assert.equal(admissionResolved(proposed), false);
  const decision = { claim: 1, source: 1, sourceQuote: sources[0].text, layer: "initial-display", verdict:"not-requested", detail: "只是字段标签" };
  for (const decisions of [[], [decision, decision], [{ ...decision, sourceQuote: "未填写时显示复盘" }], [{ ...decision, claim: 2 }]]) assert.throws(() => adjudicateAdmission(JSON.stringify({ decisions }), proposed, sources));
  const resolved = adjudicateAdmission(JSON.stringify({ decisions: [decision] }), proposed, sources);
  assert.ok(admissionResolved(resolved));
  assert.equal(admissionResolved({...resolved,initialMeanings:[]}),false);
  assert.equal(admissionResolved({ ...resolved, claims: [{ ...resolved.claims[0], interpretation: { value: "篡改" } }] }), false);
  assert.equal(admissionResolved({ ...resolved, semanticReview: undefined }), false);
  const uncertain = adjudicateAdmission(JSON.stringify({ decisions: [{ ...decision, layer: "initial-display", verdict:"uncertain" }] }), proposed, sources);
  assert.match(uncertain.blockers[0], /尚未裁决/);
  assert.equal(admissionResolved({ ...uncertain, blockers: [] }), false);
});

test("需求预检的额外问题必须独立审查；不必要问题不打断规划，原问题和裁决随计划冻结",async(t)=>{
 const fixture=new PlanningDriver();
 const {w,e}=await setup(t,{async generate(r,s){
   const value=input(r);
   if(value.kind==="request-admission/2")return reply({...empty(),questions:[{source:1,sourceQuote:"已有数据不自动更改",question:"显式完成动作能否更新已有值？"}]});
   if(value.kind==="clarification-review/2")return reply(clarificationPayloadFixture({kind:"unnecessary",source:1,sourceQuote:"已有数据不自动更改",detail:"自动迁移与显式完成动作属于不同作用范围，未要求改变既有动作规则"}));
   return fixture.generate(r,s);
 }});
 await e.command({type:"request",text:"完成前必须填写复盘，已有数据不自动更改",operationId:"request"});
 const run=await settle(e);assert.equal(run.status,"ready");if(run.status!=="ready")return;
 assert.equal(run.budget?.callsUsed,4);assert.equal(run.requestAdmissions?.[0].questions.length,1);
 assert.equal(run.clarificationReviews?.[0].decision.kind,"unnecessary");
 assert.deepEqual(run.plan.questionAdjudications,run.clarificationReviews);
 assert.equal(w.db.prepare("SELECT count(*) n FROM evolution_calls").get()!.n,4);
});

test("多项预检问题一次合批审查，只向用户展示仍未决定的业务问题",async(t)=>{
 const {e}=await setup(t,{async generate(r){const v=input(r);
   if(v.kind==="request-admission/2")return reply({...empty(),questions:[{source:1,sourceQuote:"必填尚未决定",question:"复盘是否必填？"},{source:1,sourceQuote:"其他行为不变",question:"是否修改其他行为？"}]});
   assert.equal(v.kind,"clarification-review/2");assert.deepEqual(r.history,[]);assert.equal(r.tools,undefined);
   return reply(clarificationPayloadFixture([{kind:"business-ambiguity",source:1,sourceQuote:"必填尚未决定",detail:"尚未决定"},{kind:"unnecessary",source:1,sourceQuote:"其他行为不变",detail:"用户已明确"}]));
 }});
 await e.command({type:"request",text:"必填尚未决定，其他行为不变",operationId:"request"});
 const run=await settle(e);assert.equal(run.status,"awaiting-input");if(run.status==="awaiting-input")assert.equal(run.question,"复盘是否必填？");
 assert.equal(run.budget?.callsUsed,2);assert.equal(run.clarificationReviews?.length,2);
});

test("预检问题的裁决绑定精确来源与事实；伪造键、旧来源及冲突裁决不能清除待审问题",()=>{
 const sources=[{id:"s:1",text:"必填未决定"}],facts=technicalFacts({workflowRules:[],binding:undefined});
 const admission=parseAdmission(JSON.stringify({...empty(),questions:[{source:1,sourceQuote:"必填未决定",question:"是否必填？"}]}),"base",sources,facts);
 const decision={kind:"unnecessary" as const,sourceRevision:"s:1",sourceQuote:"必填未决定",detail:"测试裁决",effects:parseEffectReview(noEffectsFixture(),sources,facts)};
 const review={key:questionReviewKey("是否必填？",sources,facts),decision};
 assert.deepEqual(admissionQuestionState(admission,sources,facts,[review]),{pending:[],questions:[],blockers:[]});
 assert.equal(admissionQuestionState(admission,[{...sources[0],id:"s:2"}],facts,[review]).pending.length,1);
 assert.equal(admissionQuestionState(admission,sources,[...facts,{id:"new",properties:{x:"y"},evidenceHash:"new"}],[review]).pending.length,1);
 assert.equal(admissionQuestionState(admission,sources,facts,[{...review,key:"fake"}]).pending.length,1);
 assert.equal(admissionQuestionState(admission,sources,facts,[review,{...review,decision:{...decision,kind:"business-ambiguity"}}]).blockers.length,1);
});

test("删除宿主输入义务并同步删案例与映射仍不能通过开始门禁",async(t)=>{
 const {w,e}=await setup(t,new PlanningDriver());
 await e.command({type:"request",text:"完成前必填复盘",operationId:"request"});const ready=await settle(e);assert.equal(ready.status,"ready");if(ready.status!=="ready")return;
 const before=w.composition();const stored=JSON.parse(String(w.db.prepare("SELECT body FROM evolution_runs WHERE id=?").get(ready.id)!.body));
 const plan=structuredClone(ready.plan);const ids=plan.requirements!.flatMap(r=>r.obligations??[]).filter(o=>o.kind==="workflow-input").map(o=>o.id);assert.ok(ids.length);
 const removed=plan.browserCases!.filter(c=>ids.includes(c.obligationId??"")).map(c=>c.id);
 plan.browserCases=plan.browserCases!.filter(c=>!removed.includes(c.id));for(const r of plan.requirements!){r.obligations=r.obligations!.filter(o=>o.kind!=="workflow-input");r.checks=r.checks.filter(c=>!removed.includes(c.caseId));}
 stored.plan=plan;stored.run.plan=plan;w.db.prepare("UPDATE evolution_runs SET body=? WHERE id=?").run(JSON.stringify(stored),ready.id);
 await assert.rejects(e.command({type:"start",runId:ready.id,planId:plan.id,operationId:"start"}),/冻结|需求|验收|规格/);
 assert.deepEqual(w.composition(),before);assert.equal((await e.observe()).candidates?.length,0);
});
async function setup(t: test.TestContext, driver: Driver, calls = 12, milliseconds = 600000) {
  const dir = await mkdtemp(join(tmpdir(), "cordis-admission-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const e = new Evolution(w.db, driver, new EvolutionDomain(w), {
    calls,
    candidates: 3,
    milliseconds,
  });
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { w, e };
}
test("活动时间截止由宿主记录最终预算原因，迟到模型结果不能恢复运行", async t => {
  const { e } = await setup(t, { generate(_request, signal) {
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), {once:true}));
  } }, 12, 30);
  await e.command({type:"request",text:"增加标签",operationId:"request"});
  const run = await settle(e);
  assert.equal(run.status,"failed");
  assert.equal(run.stop?.kind,"budget");
  assert.equal(run.stop?.code,"active-time-budget");
  assert.equal(run.budget?.callsUsed,1);
  assert.equal(run.budget?.millisecondsRemaining,0);
});
async function settle(e: Evolution) {
  for (let i = 0; i < 1000; i++) {
    const r = (await e.observe()).run!;
    if (r.status !== "planning") return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("模型桩规划未结束");
}

test("供应商投影显式声明根必填及分支字段；宿主仍拒绝空对象和跨分支伪造", () => {
  const strict = clarificationSchema();
  const wire = (responseSchema(strict).properties as Record<string, unknown>)
    .result as Record<string, unknown>;
  assert.ok(Array.isArray(wire.anyOf));
  assert.ok(schemaProblems({}, wire).length);
  assert.ok(schemaProblems({}, strict).length);
  const valid = {
    kind: "business-ambiguity",
    source: 1,
    sourceQuote: "未决定",
    detail: "未决定",
  };
  assert.deepEqual(schemaProblems(valid, strict), []);
  assert.deepEqual(schemaProblems(valid, wire), []);
  assert.ok(
    schemaProblems(
      { ...valid, fact: 1, property: "lengthMetric", expected: "x" },
      wire,
    ).some((p) => p.includes("fact")),
  );
  assert.ok(
    schemaProblems(
      { ...valid, fact: 1, property: "lengthMetric", expected: "x" },
      strict,
    ).length,
  );
  assert.deepEqual(strict, clarificationSchema(), "投影不能改写原验收契约");
  const strings = { type: "string", minLength: 1, maxLength: 8, pattern: "^a" };
  assert.deepEqual(
    (responseSchema(strings).properties as Record<string, unknown>).result,
    strings,
  );
  assert.ok(schemaProblems("", strings).length);
  assert.ok(schemaProblems("wrong", strings).length);
  const bounded = {
    type: "array",
    minItems: 1,
    maxItems: 20,
    items: { type: "integer", minimum: 1, maximum: 5 },
  };
  assert.deepEqual(
    (responseSchema(bounded).properties as Record<string, unknown>).result,
    bounded,
  );
  assert.ok(schemaProblems([], bounded).length);
  assert.ok(schemaProblems([6], bounded).length);
});

test("互斥步骤不能因供应商投影而混填字段，错误反馈绑定实际kind和具体字段", () => {
  const original = {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { type: "string", enum: ["open"] } },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: {
          kind: { type: "string", enum: ["field"] },
          value: { type: "string" },
        },
      },
    ],
  };
  const wire = (responseSchema(original).properties as Record<string, unknown>)
    .result as Record<string, unknown>;
  assert.ok(Array.isArray(wire.anyOf));
  assert.deepEqual(schemaProblems({ kind: "open" }, wire), []);
  assert.ok(
    schemaProblems({ kind: "open", value: "非法混填" }, wire).some((p) =>
      p.includes("value: 未授权字段"),
    ),
  );
  assert.ok(
    schemaProblems({ kind: "field" }, wire).some((p) =>
      p.includes("value: 缺少必填字段"),
    ),
  );
});

test("预检不存在状态只提交kind，空值由宿主派生；禁止混入其他分支的value", () => {
  const sources = [{ id: "source", text: "未填写时显示空白" }];
  const facts = [...technicalFacts({ workflowRules: [], binding: undefined }),...fieldFacts([{member:"panel",field:"备注",label:"备注"}])];
  const presentation = {
    source: 1,
    sourceQuote: sources[0].text,
    target: {kind:"existing",targetId:fieldTargetId({member:"panel",field:"备注"})},
    meaning:{kind:"hidden",conditionQuote:sources[0].text,effectQuote:sources[0].text},
  };
  const admitted = parseAdmission(
    JSON.stringify({ ...empty(), effects: [], initials: [presentation] }),
    "base",
    sources,
    facts,
  );
  assert.equal(admitted.presentations[0].value, "");
  assert.equal(admissionResolved(admitted), false);
  const reviewed = adjudicateAdmission(JSON.stringify({ decisions: [{ claim: 1, source: 1, sourceQuote: sources[0].text, layer: "initial-display", verdict:"entailed", detail: "原文明确要求未填写呈现" }] }), admitted, sources);
  assert.ok(reviewed.blockers.length);
  assert.ok(admissionResolved(reviewed));
  assert.throws(
    () =>
      parseAdmission(
        JSON.stringify({
          ...empty(),
          effects: [], initials: [{ ...presentation, value: "（空）" }],
        }),
        "base",
        sources,
        facts,
      ),
    /契约分支|未授权字段/,
  );
});

test("JSON合法但来源绑定非法时也在同一交换内有界纠正，不重开运行或丢弃usage", async (t) => {
  const fixture = new PlanningDriver();
  let attempts = 0;
  const { w, e } = await setup(t, {
    async generate(request, signal) {
      if (input(request).kind === "request-admission/2") {
        if (++attempts === 1)
          return reply({
            ...empty(),
            questions: [
              { source: 1, sourceQuote: "伪造引用", question: "是否必填？" },
            ],
          });
        assert.ok(
          input(request)
            .protocolCorrection.problems.join(";")
            .includes("来源原文"),
        );
        assert.ok(
          input(request).protocolCorrection.rejected.text.includes("伪造引用"),
        );
        return reply(empty());
      }
      return fixture.generate(request, signal);
    },
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const r = await settle(e);
  assert.equal(r.status, "ready");
  assert.equal(r.budget?.callsUsed, 4);
  assert.equal(r.protocolFailures?.length, 1);
  assert.equal(
    w.db.prepare("SELECT count(*) AS n FROM evolution_calls").get()!.n,
    4,
  );
});

test("传输断连仅消耗一次预算并持久化根因，不重试或转交模型修正业务", async (t) => {
  let calls = 0;
  const { w, e } = await setup(
    t,
    new DeepSeek("synthetic-key", async () => {
      calls++;
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("other side closed"), {
          code: "UND_ERR_SOCKET",
        }),
      });
    }),
  );
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const r = await settle(e);
  assert.equal(r.status, "failed");
  assert.equal(r.budget?.callsUsed, 1);
  assert.equal(calls, 1);
  const rows = w.db.prepare("SELECT body FROM evolution_calls").all();
  assert.equal(rows.length, 1);
  const call = JSON.parse(String(rows[0].body));
  assert.equal(call.status, "failed");
  assert.equal(call.transport.failure.kind, "connection");
  assert.equal(call.transport.failure.causes[1].code, "UND_ERR_SOCKET");
  assert.equal((await e.observe()).candidates?.length ?? 0, 0);
});

test("供应商400作为模型契约故障独立阻塞，保留精确传输摘要且不重试或转交业务澄清", async (t) => {
  const { w, e } = await setup(t, {
    async generate() {
      throw new ModelTransportError(
        "synthetic invalid contract",
        { profile: "gemini-3.1-shape/1", schemaHash: "synthetic-wire" },
        400,
      );
    },
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const r = await settle(e);
  assert.equal(r.status, "blocked");
  assert.equal(r.budget?.callsUsed, 1);
  const rows = w.db.prepare("SELECT body FROM evolution_calls").all();
  assert.equal(rows.length, 1);
  const call = JSON.parse(String(rows[0].body));
  assert.equal(call.httpStatus, 400);
  assert.equal(call.transport.schemaHash, "synthetic-wire");
  assert.match("message" in r ? r.message : "", /供应商拒绝.*HTTP 400/);
});

for (const twice of [false, true])
  test(`空对象复核由协议模块统一处理，共用原预算且有界：${twice ? "重复阻塞" : "一次纠正"}`, async (t) => {
    const fixture = new PlanningDriver();
    let intake = 0;
    const { w, e } = await setup(t, {
      async generate(r, s) {
        if (input(r).kind === "request-admission/2") {
          intake++;
          assert.deepEqual(r.history, []);
          assert.equal(r.tools, undefined);
          return reply(twice || intake === 1 ? {} : empty());
        }
        return fixture.generate(r, s);
      },
    });
    await e.command({
      type: "request",
      text: "完成前填写复盘",
      operationId: "request",
    });
    const run = await settle(e);
    assert.equal(run.status, twice ? "blocked" : "ready");
    assert.equal(run.budget?.callsUsed, twice ? 2 : 4);
    assert.equal(run.protocolFailures?.length, twice ? 2 : 1);
    assert.equal(run.budget!.callsUsed + run.budget!.callsRemaining, 12);
    const calls = w.db
      .prepare("SELECT body FROM evolution_calls")
      .all()
      .map((r) => JSON.parse(String(r.body)));
    assert.equal(calls.length, run.budget!.callsUsed);
    assert.deepEqual(
      calls.slice(0, 2).map((c) => c.usage.totalTokenCount),
      [7, 7],
    );
    if (!twice) assert.equal(run.requestAdmissions?.length, 1);
  });

for (const malformed of ["empty", "unknown-tool"])
  test(`无效工具响应在执行任何工具前校验，原调用预算内最多纠正一次：${malformed}`, async (t) => {
    const fixture = new PlanningDriver();
    let failed = false;
    const { e } = await setup(t, {
      async generate(r, s) {
        if (input(r).kind === "request-admission/2") return reply(empty());
        if (r.tools && !failed) {
          failed = true;
          return {
            ...reply({}),
            text: "",
            calls:
              malformed === "empty"
                ? []
                : [{ name: "not-authorized", args: {} }],
          };
        }
        return fixture.generate(r, s);
      },
    });
    await e.command({
      type: "request",
      text: "完成前填写复盘",
      operationId: "request",
    });
    const run = await settle(e);
    assert.equal(run.status, "ready");
    assert.equal(run.budget?.callsUsed, 4);
    assert.equal(run.protocolFailures?.length, 1);
  });

test("已知字段明确但无法支持的空白初始呈现在源码调查前阻塞，不能改成降级提问", async (t) => {
  const { w, e } = await setup(t, {
    async generate(r) {
      const v = input(r);
      if (v.kind === "admission-source-review/2") {
        assert.deepEqual(r.history, []);
        assert.equal(r.tools, undefined);
        return reply({ decisions: [{ claim: 1, source: 1, sourceQuote: "尚未填写时显示空白", layer: "initial-display", verdict:"entailed", detail: "原文明确指定未填写时的空白显示" }] });
      }
      assert.equal(v.kind, "request-admission/2");
      assert.equal(v.materials, undefined);
      return reply({
        effects: [], initials: [
          {
            source: 1,
            sourceQuote: "尚未填写时显示空白",
            target: {kind:"existing",targetId:fieldTargetId({member:"panel",contribution:"note-panel",field:"noteMark"})},
            meaning:{kind:"blank",conditionQuote:"尚未填写时显示空白",effectQuote:"尚未填写时显示空白"},
          },
        ],
        questions: [
          {
            source: 1,
            sourceQuote: "尚未填写时显示空白",
            question: "可否改成（空）？",
          },
        ],
      });
    },
  });
  const fixture=await memberUiReleaseInput("intake-known-field");
  w.release.record(fixture.panel);
  const version=w.release.record(fixture.composition);
  await w.activate({versionId:version.id,compositionRevision:w.composition().revision,operationId:"known-field"},()=>undefined);
  const before = JSON.stringify({
    tasks: w.query(),
    composition: w.composition(),
  });
  await e.command({
    type: "request",
    text: "独立备注面板尚未填写时显示空白",
    operationId: "request",
  });
  const run = await settle(e);
  assert.equal(run.status, "blocked");
  assert.equal(run.budget?.callsUsed, 2);
  assert.match("message" in run ? run.message : "", /维护者.*不能替换/);
  assert.equal((await e.observe()).candidates?.length, 0);
  assert.equal(
    JSON.stringify({ tasks: w.query(), composition: w.composition() }),
    before,
  );
  const stored = JSON.parse(
    String(w.db.prepare("SELECT body FROM evolution_runs").get()!.body),
  );
  assert.deepEqual(stored.investigation.deliveries, []);
});

test("必要澄清经过独立审查，回答使旧预检失效，同一运行5次调用ready", async (t) => {
  const fixture = new PlanningDriver();
  const seen: ModelRequest[] = [];
  const { e } = await setup(t, {
    async generate(r, s) {
      seen.push(r);
      const v = input(r);
      if (v.kind === "request-admission/2")
        return reply({
          ...empty(),
          questions:
            v.sources.length === 1
              ? [
                  {
                    source: 1,
                    sourceQuote: "复盘是否必填尚未决定",
                    question: "复盘是否必填？",
                  },
                ]
              : [],
        });
      return fixture.generate(r, s);
    },
  });
  await e.command({
    type: "request",
    text: "复盘是否必填尚未决定",
    operationId: "request",
  });
  const waiting = await settle(e);
  assert.equal(waiting.status, "awaiting-input");
  assert.equal(waiting.budget?.callsUsed, 2);
  await e.command({
    type: "answer",
    runId: waiting.id,
    text: "复盘必填",
    operationId: "answer",
  });
  const ready = await settle(e);
  assert.equal(ready.id, waiting.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.budget?.callsUsed, 5);
  assert.equal(ready.requestAdmissions?.length, 2);
  assert.notEqual(
    ready.requestAdmissions![0].sourceHash,
    ready.requestAdmissions![1].sourceHash,
  );
  assert.deepEqual(
    seen
      .filter((r) => input(r).kind === "request-admission/2")
      .map((r) => r.history),
    [[], []],
  );
});

test("澄清预留包含回答后的预检，未达到完整路径预算即阻塞且不提问", async (t) => {
  const { e } = await setup(
    t,
    {
      async generate() {
        return reply({
          ...empty(),
          questions: [
            { source: 1, sourceQuote: "必填未决定", question: "是否必填？" },
          ],
        });
      },
    },
    6,
  );
  await e.command({
    type: "request",
    text: "必填未决定",
    operationId: "request",
  });
  const r = await settle(e);
  assert.equal(r.status, "blocked");
  assert.equal(r.budget?.callsUsed, 1);
  const s = new BudgetScheduler({
    calls: 12,
    candidates: 3,
    milliseconds: 600000,
  });
  assert.equal(s.canClarify(6, true), true);
  assert.equal(s.canClarify(7, true), false);
});

test("预检不能伪造来源和技术事实；环境缺失在模型调用前阻塞", async (t) => {
  const facts = technicalFacts({ workflowRules: [], binding: undefined });
  assert.throws(
    () =>
      parseAdmission(
        JSON.stringify({
          ...empty(),
          questions: [{ source: 1, sourceQuote: "不存在", question: "问题" }],
        }),
        "base",
        [{ id: "s", text: "原文" }],
        facts,
      ),
    /来源/,
  );
  assert.throws(
    () =>
      parseAdmission(
        JSON.stringify({
          ...empty(),
          facts: [
            {
              source: 1,
              sourceQuote: "原文",
              fact: 999,
              property: "p",
              expected: "v",
            },
          ],
        }),
        "base",
        [{ id: "s", text: "原文" }],
        facts,
      ),
    /未授权/,
  );
  assert.ok(schemaProblems({}, admissionSchema()).length);
  const { w, e } = await setup(t, {
    async generate() {
      throw new Error("不能调用模型");
    },
  });
  // The same public domain seam is exercised with a missing installed checker.
  const domain = new EvolutionDomain(w);
  domain.admission = () => ({ facts, missing: ["Chromium"] });
  await e.close();
  const blocked = new Evolution(
    w.db,
    {
      async generate() {
        throw new Error("不能调用模型");
      },
    },
    domain,
  );
  t.after(() => blocked.close());
  await blocked.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const r = await settle(blocked);
  assert.equal(r.status, "blocked");
  assert.equal(r.budget?.callsUsed, 0);
});

test("回答只修改必填性，重复标签误读通过同一语义契约纠正；旧判断可调查复用但旧通过证据失效",async t=>{
  const fixture=new PlanningDriver();
  let reused=0;
  const {w,e}=await setup(t,{async generate(request,signal){
    const v=input(request);
    if(v.kind==="request-admission/2"){
      const source=v.sources.length,quote=source===1?"完成前填写复盘":"复盘必填";
      if(source===2){assert.equal(v.priorSemantics.length,1);assert.equal(v.priorSemantics[0].target.field,"复盘");reused++;}
      return reply({effects: [], initials:[{source,sourceQuote:quote,target: {kind:"new",name:"复盘"},meaning:{kind:"literal",value:"复盘",conditionQuote:quote,effectQuote:quote}}],questions:source===1?[{source:1,sourceQuote:"是否必填尚未决定",question:"复盘是否必填？"}]:[]});
    }
    if(v.kind==="admission-source-review/2"){
      const source=v.sources.length,quote=source===1?"完成前填写复盘":"复盘必填";
      return reply({decisions:[{claim:1,source,sourceQuote:quote,layer: "initial-display", verdict:"not-requested",detail:"填写对象或必填字段名称，不是初始内容"}]});
    }
    return fixture.generate(request,signal);
  }});
  await e.command({type:"request",text:"完成前填写复盘，是否必填尚未决定",operationId:"request"});
  const waiting=await settle(e);assert.equal(waiting.status,"awaiting-input");
  await e.command({type:"answer",runId:waiting.id,text:"复盘必填",operationId:"answer"});
  const ready=await settle(e);assert.equal(ready.status,"ready","message" in ready?ready.message:ready.status);
  assert.equal(ready.id,waiting.id);assert.equal(ready.budget?.callsUsed,7);assert.equal(reused,1);
  assert.notEqual(ready.requestAdmissions![0].key,ready.requestAdmissions![1].key);
  if(ready.status!=="ready")return;
  assert.equal(ready.plan.semanticState!.entries.filter(e=>e.target.aspect==="initial-display").length,1);
  assert.equal(ready.plan.semanticState!.entries.find(e=>e.target.aspect==="initial-display")!.status,"unspecified");
  const before=w.composition(),stored=JSON.parse(String(w.db.prepare("SELECT body FROM evolution_runs WHERE id=?").get(ready.id)!.body));
  const plan=structuredClone(ready.plan);plan.semanticState!.entries[0].value="篡改";stored.plan=plan;stored.run.plan=plan;
  w.db.prepare("UPDATE evolution_runs SET body=? WHERE id=?").run(JSON.stringify(stored),ready.id);
  await assert.rejects(e.command({type:"start",runId:ready.id,planId:plan.id,operationId:"start"}),/语义|冻结|规格/);
  assert.deepEqual(w.composition(),before);assert.equal((await e.observe()).candidates?.length,0);
});
