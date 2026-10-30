import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { ExperienceSessionHost } from "../../src/server/experience-session.js";
import { settleEvolution } from "./evolution-adapter.js";
import { PlanningViewDriver } from "./planning-view-fixture.js";
import type { InvestigationState } from "../../src/shared/change-spec.js";
import type { AssistantRun, InvestigatedPlan } from "../../src/shared/assistant.js";
import { hash } from "../../src/release/storage.js";
import { gateFailure } from "../../src/server/requirement-coverage.js";

test("原生视图规划、原文补读、跨重启预算续行和冻结；过期拒绝追加且保留证据",async t=>{
  const directory=await mkdtemp(join(tmpdir(),"cordis-native-view-"));
  const filename=join(directory,"workspace.db");
  let w=await Workspace.open(filename);
  let domain=new EvolutionDomain(w);
  let driver=new PlanningViewDriver({invalidConclusion:true});
  let sessions=new ExperienceSessionHost(w);
  let e=new Evolution(w.db,driver,domain,sessions,{calls:7,candidates:3,milliseconds:600000});
  t.after(async()=>{
    await e.close();await sessions.close();await w.close();
    if(!t.passed&&process.env.CORDIS_MATERIAL_EVIDENCE)
      await cp(directory,join(process.env.CORDIS_MATERIAL_EVIDENCE,`native-failure-${randomUUID()}`),{recursive:true});
    await rm(directory,{recursive:true,force:true});
  });
  const command=(value:Parameters<Evolution["command"]>[0])=>e.command(value);
  await command({type:"request",operationId:randomUUID(),text:"完成前填写复盘，其他行为不变"});
  const first=await settleEvolution(e,"ready");if(first.status!=="ready")throw new Error("fixture");
  await command({type:"start",operationId:randomUUID(),runId:first.id,planId:first.plan.id});
  const done=await settleEvolution(e,"awaiting-apply");
  const candidate=(await e.observe()).candidates!.find(item=>item.passed)!;
  await command({type:"apply",operationId:randomUUID(),runId:done.id,candidateId:candidate.id,evidenceHash:candidate.evidenceHash!,compositionRevision:w.composition().revision});
  await settleEvolution(e,"succeeded");
  const base=w.composition();
  if(process.env.CORDIS_MATERIAL_EVIDENCE)
    await writeFile(join(process.env.CORDIS_MATERIAL_EVIDENCE,`published-baseline-${randomUUID()}.json`),JSON.stringify(w.activeVersion().evidence,null,2));
  await command({type:"continue",operationId:randomUUID(),runId:done.id,baseVersion:base.versionId,text:"复盘至少三个字，其他行为不变"});
  const paused=await settleEvolution(e,"awaiting-budget");if(paused.status!=="awaiting-budget")throw new Error("not paused");
  assert.equal(paused.pause.resume,"plan");assert.equal(paused.budget?.callsUsed,3);
  const stored=()=>JSON.parse(String(w.db.prepare("SELECT body FROM evolution_runs WHERE id=?").get(paused.id)!.body)) as {run:AssistantRun;investigation:InvestigationState};
  const before=stored();
  if(process.env.CORDIS_MATERIAL_EVIDENCE)
    await writeFile(join(process.env.CORDIS_MATERIAL_EVIDENCE,`planning-pause-${randomUUID()}.json`),JSON.stringify(before,null,2));
  const delivered=before.investigation.deliveries.flatMap(receipt=>receipt.materials);
  const view=delivered.find(material=>material.source?.ref==="active-acceptance");assert.ok(view);
  assert.equal(delivered.some(material=>material.ref==="active-acceptance"),true,"已处理的原文补读已随下一次提案发送");
  assert.ok(w.db.prepare("SELECT body FROM evolution_materials WHERE hash=?").get(view.source!.hash));
  const callsBefore=Number(w.db.prepare("SELECT count(*) AS n FROM evolution_calls WHERE runId=?").get(paused.id)!.n);
  await e.close();await sessions.close();await w.close();
  w=await Workspace.open(filename);domain=new EvolutionDomain(w);driver=new PlanningViewDriver();sessions=new ExperienceSessionHost(w);
  e=new Evolution(w.db,driver,domain,sessions,{calls:99,candidates:99,milliseconds:9999999});
  assert.equal((await e.observe()).run?.status,"awaiting-budget");
  assert.equal(driver.requests.length,0,"重开不能自动调用模型");
  const resume={type:"resume-budget" as const,operationId:randomUUID(),runId:paused.id,pauseRevision:paused.pause.revision,amounts:paused.pause.suggested};
  const persisted=String(w.db.prepare("SELECT body FROM evolution_runs WHERE id=?").get(paused.id)!.body);
  for(const mutation of ["view-hash","source-hash","missing-source"] as const){
    const changed=JSON.parse(persisted) as typeof before;
    const material=changed.investigation.materials.find(item=>item.source)!;
    if(mutation==="view-hash")material.hash="forged";
    if(mutation==="source-hash")material.source!.hash="forged";
    if(mutation==="missing-source")delete material.source;
    w.db.prepare("UPDATE evolution_runs SET body=? WHERE id=?").run(JSON.stringify(changed),paused.id);
    await assert.rejects(command(resume),/视图|来源|变化/);
    assert.equal(stored().run.budget?.grants?.length,0);
    assert.equal(driver.requests.length,0);
    w.db.prepare("UPDATE evolution_runs SET body=? WHERE id=?").run(persisted,paused.id);
  }
  const context=domain.context.bind(domain);
  domain.context=()=>({...context(),versionId:"expired-base"});
  await assert.rejects(command(resume),/基础版本/);
  assert.equal(driver.requests.length,0);
  domain.context=()=>{const value=context();const content="{}";value.files["active-acceptance"]={content,hash:hash(content)};return value;};
  await assert.rejects(command(resume),/视图|来源|变化/);
  assert.equal(stored().run.budget?.grants?.length,0);
  assert.equal(driver.requests.length,0);
  assert.equal(Number(w.db.prepare("SELECT count(*) AS n FROM evolution_calls WHERE runId=?").get(paused.id)!.n),callsBefore);
  domain.context=context;
  const snapshot=await command(resume);assert.deepEqual(await command(resume),snapshot);
  const reviewed=await settleEvolution(e,"awaiting-acceptance");
  if(reviewed.status!=="awaiting-acceptance")throw new Error("missing rule confirmation");
  assert.equal(reviewed.id,paused.id);assert.equal(reviewed.budget?.callsUsed,5);
  assert.equal(reviewed.budget?.efficiencyTarget,7);assert.equal(reviewed.budget?.authorized?.calls,13);
  assert.equal(reviewed.budget?.grants?.length,1);
  assert.ok(reviewed.plan.binding!.materials.some(material=>hash(material)===hash(view)));
  assert.ok(reviewed.plan.binding!.materials.some(material=>material.ref==="active-acceptance"&&material.hash===view.source!.hash));
  assert.equal(driver.requests.filter(request=>request.phase==="review").length,1);
  assert.equal(driver.requests.some(request=>request.phase==="admission"),false,"已完成准入不能重放");
  assert.equal(driver.requests.filter(request=>request.phase==="planning").length,1,"已完成原文补读不能重放");
  assert.equal(gateFailure(reviewed.plan,reviewed.plan.requirementGate,undefined,reviewed.reviewLedger),undefined);
  for(const mutation of ["view-hash","source-hash","missing-source"] as const){
    const changed:InvestigatedPlan=structuredClone(reviewed.plan);
    const material=changed.binding!.materials.find(item=>item.source)!;
    if(mutation==="view-hash")material.hash="forged";
    if(mutation==="source-hash")material.source!.hash="forged";
    if(mutation==="missing-source")delete material.source;
    assert.ok(gateFailure(changed,reviewed.plan.requirementGate,undefined,reviewed.reviewLedger),mutation);
  }
  await command({type:"confirm-acceptance",operationId:randomUUID(),runId:reviewed.id,planId:reviewed.plan.id,revisionId:reviewed.acceptanceRevision.id});
  const ready=await settleEvolution(e,"ready");if(ready.status!=="ready")throw new Error("not ready");
  const frozenHash=hash(ready.plan);
  const original=domain.admission.bind(domain);
  domain.admission=value=>{const inputs=original(value);return {...inputs,facts:inputs.facts.map((fact,index)=>index?fact:{...fact,evidenceHash:"changed"})};};
  await assert.rejects(command({type:"start",operationId:randomUUID(),runId:ready.id,planId:ready.plan.id}),/事实|来源/);
  assert.equal((await e.observe()).run?.status,"ready");
  domain.admission=original;
  // No stale plan is re-signed. Removing the controlled change restores the same frozen basis.
  const stable=(await e.observe()).run;
  assert.ok(stable&&"plan" in stable);
  assert.equal(hash(stable.plan),frozenHash);
  assert.deepEqual(w.composition(),base);
});
