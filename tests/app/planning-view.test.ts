import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { Evolution, settleEvolution } from "./evolution-adapter.js";
import { PlanningDriver } from "./planning-fixture.js";
import { InvestigationStore } from "../../src/evolution/investigation.js";
import { readInvestigation, compilePlanDraft, planBindingFailure } from "../../src/server/planning.js";
import type { Investigation, InvestigationDocument } from "../../src/server/planning.js";
import type { InvestigationState } from "../../src/shared/change-spec.js";
import type { PlanEvidence } from "../../src/shared/assistant.js";
import { hash } from "../../src/release/storage.js";

type View = InvestigationDocument & { source?: { ref: string; hash: string } };
const identity = (doc: View): PlanEvidence & { source?: {ref:string;hash:string} } => ({
  ref:doc.ref, hash:doc.hash, ...(doc.source ? {source:doc.source} : {}),
});

async function baseline(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "cordis-planning-view-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const domain = new EvolutionDomain(w);
  const e = new Evolution(w.db,new PlanningDriver(),domain);
  t.after(async()=>{await e.close();await w.close();await rm(dir,{recursive:true,force:true});});
  await e.command({type:"request",operationId:"native-freeze-fixture",text:"完成前填写复盘，其他行为不变"});
  const ready=await settleEvolution(e,"ready");
  if(ready.status!=="ready")throw new Error("fixture not ready");
  // A synthetic published-envelope fixture; native applied-candidate coverage is separate.
  const evidence={passed:true,changeSpec:ready.plan.changeSpec,requirementGate:ready.plan.requirementGate,
    requirements:ready.plan.requirements,browserCases:ready.plan.browserCases,memberCases:ready.plan.memberCases,
    rules:ready.plan.workflowRules,browser:{rawAudit:"retained on demand"},checks:["audit-only"],contextNote:"retain unknown context"};
  const context=domain.context();
  const content=JSON.stringify(evidence);
  context.files["active-acceptance"]={hash:hash(content),content};
  return {context,evidence};
}
function inspect(context: Investigation) {
  const result=readInvestigation("inspect_application",{},context,[]);
  if(!("ref" in result))throw new Error(result.message);
  return {result,documents:[result,...result.documents??[]] as View[]};
}

test("原生调查交付独立视图，保留完整业务定义及来源，不能冒充原文回执",async t=>{
  const {context,evidence}=await baseline(t);
  const {documents}=inspect(context);
  const view=documents.find(d=>d.source?.ref==="active-acceptance");
  assert.ok(view,"已审基线应以独立身份的业务视图交付");
  assert.notEqual(view.ref,"active-acceptance");
  assert.equal(view.hash,hash(view.content));
  assert.deepEqual(view.source,{ref:"active-acceptance",hash:context.files["active-acceptance"].hash});
  assert.equal(documents.some(d=>d.ref==="active-acceptance"),false);
  const content=view.content as {definition:unknown;requirementGate:unknown;context:Record<string,unknown>};
  assert.deepEqual(content.definition,evidence.changeSpec!.definition);
  assert.deepEqual(content.requirementGate,evidence.requirementGate);
  assert.equal(content.context.contextNote,evidence.contextNote);
  assert.equal(Object.hasOwn(content,"browser"),false);
  const raw=readInvestigation("read_acceptance",{ref:"active-acceptance"},context,documents.map(identity));
  assert.ok("ref" in raw && !raw.reused);
  assert.equal(raw.content,context.files["active-acceptance"].content);
  const legacy=readInvestigation("inspect_application",{},context,[{ref:raw.ref,hash:raw.hash}]);
  assert.ok("ref" in legacy);
  assert.equal(legacy.documents?.some(doc=>doc.source),false,"原文旧回执不能静默升级成未交付视图");
  assert.ok(legacy.documents?.some(doc=>doc.ref===raw.ref&&doc.reused));
});

test("视图身份进入原生必读依据及冻结绑定，来源和视图均须精确匹配",async t=>{
  const {context}=await baseline(t);
  const {documents}=inspect(context);
  const view=documents.find(d=>d.source?.ref==="active-acceptance");assert.ok(view);
  const text="完成前填写复盘，其他行为不变";
  const proposal={changes:[{target:"workflow",fields:[{key:"reflection",label:"复盘",required:true,minLength:1,maxLength:5000}]}],
    requirements:[{quote:text,type:"behavior",expectations:[{kind:"behavior"}]}]};
  const parse=(seen:PlanEvidence[])=>compilePlanDraft(proposal,context,seen,[{id:"request:1",text}]);
  const seen=documents.map(identity);
  const parsed=parse(seen);
  assert.deepEqual(parsed.blockers,[]);
  assert.ok(parsed.plan.binding!.materials.some(m=>hash(m)===hash(identity(view))));
  assert.equal(planBindingFailure(parsed.plan.binding,context),undefined);
  const forged=seen.map(m=>m.ref===view.ref?{...m,source:{ref:"active-acceptance",hash:"forged"}}:m);
  assert.ok(parse(forged).blockers.length,"伪造来源不能满足必读依据");
  const stripped=seen.map(({ref,hash})=>({ref,hash}));
  assert.ok(parse(stripped).blockers.length,"丢失来源元数据不能视为已读原文");
  const changed=structuredClone(context);changed.files["active-acceptance"]={hash:hash("{}"),content:"{}"};
  assert.match(planBindingFailure(parsed.plan.binding,changed)??"",/资料|视图|来源/);
  const tampered=structuredClone(parsed.plan.binding!);
  tampered.materials=tampered.materials.map(m=>m.ref===view.ref?{...m,hash:"changed"}:m);
  assert.match(planBindingFailure(tampered,context)??"",/资料|视图|来源/);
});

test("现有材料表归档原文而不记原文交付，重开状态保留来源，损坏和过期拒绝复用",async t=>{
  const {context}=await baseline(t);const {documents}=inspect(context);
  const view=documents.find(d=>d.source?.ref==="active-acceptance");assert.ok(view);
  const db=new DatabaseSync(":memory:");t.after(()=>db.close());
  const store=new InvestigationStore(db);
  const state:InvestigationState={version:2,baseVersion:context.versionId,materials:[],deliveries:[]};
  store.capture(state,documents,context.files);
  assert.ok(db.prepare("SELECT body FROM evolution_materials WHERE hash=?").get(view.source!.hash));
  assert.equal(state.materials.some(m=>m.ref==="active-acceptance"),false);
  store.delivered(state,"planning",1,documents.map(identity));
  assert.equal(state.deliveries[0].materials.some(m=>m.ref==="active-acceptance"),false);
  const restored=JSON.parse(JSON.stringify(state)) as InvestigationState;
  assert.deepEqual(store.documents(restored,documents.map(identity)).find(d=>d.ref===view.ref),view);
  const stale=documents.map(d=>d.ref===view.ref?{...identity(d),hash:"stale"}:identity(d));
  assert.throws(()=>store.documents(restored,stale),/过期|变化/);
  const stripped=structuredClone(restored);delete stripped.materials.find(m=>m.source)!.source;
  assert.throws(()=>store.documents(stripped,documents.map(identity)),/变化/);
  db.prepare("UPDATE evolution_materials SET body=? WHERE hash=?").run(JSON.stringify("corrupt"),view.source!.hash);
  assert.throws(()=>store.documents(restored,documents.map(identity)),/损坏/);
});

test("旧记录、无效冻结及冲突别名完整回退，不发明可靠视图",async t=>{
  const {context,evidence}=await baseline(t);
  for(const invalid of [{}, {...evidence,passed:false}, {...evidence,requirementGate:undefined},
    {...evidence,requirementGate:{...evidence.requirementGate,seal:"forged"}}, {...evidence,requirements:[]}]){
    const content=JSON.stringify(invalid);context.files["active-acceptance"]={content,hash:hash(content)};
    const {documents}=inspect(context);
    assert.ok(documents.some(d=>d.ref==="active-acceptance"&&d.content===content));
    assert.equal(documents.some(d=>d.source),false);
  }
});
