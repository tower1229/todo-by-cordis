import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { gateFailure } from "../../src/server/requirement-coverage.js";
import { hash } from "../../src/release/storage.js";
import { PlanningDriver } from "./planning-fixture.js";
import { settleEvolution } from "./evolution-adapter.js";
import { requirementReviewInput } from "../../src/evolution/review-input.js";
import { compileSpec } from "../../src/evolution/specification.js";

test("无歧义原生规划只需规划和独立复核，完整来源与冻结保持有效", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-planning-flow-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  const driver = new PlanningDriver();
  const evolution = new Evolution(workspace.db, driver, new EvolutionDomain(workspace), undefined,
    { calls:12, candidates:3, milliseconds:600000 });
  t.after(async () => {
    await evolution.close();
    await workspace.close();
    await rm(directory, {recursive:true,force:true});
  });
  const original = "完成前填写复盘，其他行为不变";
  const before = {composition:workspace.composition(),tasks:workspace.query()};
  await evolution.command({type:"request",operationId:"planning-flow",text:original});
  const deadline = Date.now() + 10000;
  while ((await evolution.observe()).run?.status === "planning" && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  const run = (await evolution.observe()).run!;
  assert.equal(run.status, "ready", JSON.stringify(run));
  if (run.status !== "ready") throw new Error("missing native ready plan");
  const review = driver.requests.filter(request => request.phase === "review");
  assert.equal(review.length, 1);
  assert.deepEqual(review[0].history, [], "独立复核保持空历史");
  const input = JSON.parse(review[0].message!);
  assert.ok(input.sources.some((source:{text:string}) => source.text === original));
  assert.ok(run.plan.requirementGate?.sources.some(source => source.text === original));
  assert.deepEqual(run.plan.requirementGate!.review.reviewedIds.slice().sort(),
    run.plan.requirements!.map(requirement => requirement.id).sort());
  const frozen = workspace.db.prepare("SELECT body FROM evolution_requirement_freezes WHERE id=?").get(run.plan.id);
  assert.ok(frozen, "冻结须有宿主持久化的独立记录");
  assert.equal(gateFailure(run.plan, JSON.parse(String(frozen.body)), hash(run.revisions), run.reviewLedger), undefined);
  assert.deepEqual({composition:workspace.composition(),tasks:workspace.query()}, before);
  const candidates = (await evolution.observe()).candidates;
  assert.ok(candidates);
  assert.equal(candidates.length, 0, "尚未明确开始，不能生成候选");
  assert.deepEqual(driver.requests.map(request => request.phase), ["planning", "review"],
    "普通路径保留规划和独立复核两项职责");
  assert.equal(run.budget?.callsUsed, 2);
  assert.equal(run.requestAdmissions?.length??0,0,"普通路径不补造空准入回执");
  const views=["supported","unsupported"].map(availability=>{
    const plan=structuredClone(run.plan);
    plan.binding!.hostEffects=plan.binding!.hostEffects!.map(fact=>({
      ...fact,properties:{...fact.properties,availability},evidenceHash:hash([fact.id,availability]),
    }));
    plan.changeSpec=compileSpec(plan,run.id,"source");
    const {specification,...view}=requirementReviewInput(plan,run.plan.requirementGate!.sources);
    assert.ok(view.hostFacts.some(fact=>fact.id==="host-fact:field-interaction"));
    assert.ok(!view.hostFacts.some(fact=>fact.id.startsWith("host-fact:effect:")));
    return view;
  });
  assert.deepEqual(views[0],views[1],"需求复核的原意输入不随宿主支持结果变化；冻结身份仍由宿主独立核验");
  const missing = structuredClone(run.plan);
  delete missing.requirementGate!.review.sourceReview;
  assert.match(gateFailure(missing,JSON.parse(String(frozen.body)),hash(run.revisions),run.reviewLedger)??"",/来源复核/);
  const changed = structuredClone(run.plan);
  changed.requirementGate!.review.sourceReview!.effects.sourceHash="forged";
  assert.match(gateFailure(changed,JSON.parse(String(frozen.body)),hash(run.revisions),run.reviewLedger)??"",/来源复核/);
});

test("规划漏掉离线交付时，完整原文复核仍须给出可信能力阻塞且不能冻结", async t => {
  const directory=await mkdtemp(join(tmpdir(),"cordis-source-omission-"));
  const workspace=await Workspace.open(join(directory,"workspace.db"));
  const fixture=new PlanningDriver({defaults:[{scope:"通知渠道",behavior:"默认使用邮件",basis:"需核对用户取舍",impact:"影响外部送达渠道"}]});
  const original="完成前填写复盘；应用关闭后仍保证离线送达通知";
  const evolution=new Evolution(workspace.db,{async generate(request,signal){
    const reply=await fixture.generate(request);
    const input=JSON.parse(request.message??"{}");
    if(input.kind==="requirement-review/2") {
      assert.deepEqual(request.history,[]);
      assert.equal(request.tools,undefined);
      assert.ok(input.sources.some((source:{text:string})=>source.text===original));
      const review=JSON.parse(reply.text);
      review.defaultReviews=review.defaultReviews.map((decision:object)=>({...decision,verdict:"requires-choice",detail:"邮件还是短信需要用户选择"}));
      const technical=input.technicalTargets.find((target:{actual:string;expectedValues:string[]})=>target.expectedValues.some(value=>value!==target.actual));
      assert.ok(technical);
      review.issues.push({kind:"conflict",sourceRevision:input.sources[0].id,sourceQuote:input.sources[0].text,
        detail:"同时提出需核对来源前提的技术意见，已证实的能力缺口仍优先",technical:{target:technical.target,expected:technical.expectedValues.find((value:string)=>value!==technical.actual)}});
      review.sourceReview.effects=review.sourceReview.effects.map((row:{effect:string})=>row.effect==="offline-delivery"
        ? {...row,verdict:"required",source:input.sources.findIndex((source:{text:string})=>source.text===original)+1,sourceQuote:"应用关闭后仍保证离线送达通知"}:row);
      reply.text=JSON.stringify(review);
    }
    return reply;
  }},new EvolutionDomain(workspace));
  t.after(async()=>{await evolution.close();await workspace.close();await rm(directory,{recursive:true,force:true});});
  const before={composition:workspace.composition(),tasks:workspace.query()};
  await evolution.command({type:"request",operationId:"omitted-offline",text:original});
  const run=await settleEvolution(evolution);
  assert.equal(run.status,"blocked",JSON.stringify(run));
  assert.equal(run.stop?.kind,"capability");
  assert.equal(run.stop?.code,"unsupported-host-effect");
  assert.equal(workspace.db.prepare("SELECT count(*) AS n FROM evolution_requirement_freezes").get()?.n,0);
  assert.deepEqual({composition:workspace.composition(),tasks:workspace.query()},before);
  assert.equal((await evolution.observe()).candidates?.length,0);
  assert.deepEqual(fixture.requests.map(request=>request.phase),["planning","review"]);
});
