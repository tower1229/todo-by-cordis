import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";
import { frozenClarificationAnswer, frozenClarificationReceiptMatches } from "../../scripts/lib/stability-eval/clarification.js";
import { PlanningDriver, noEffectsFixture } from "./planning-fixture.js";
import { settleEvolution } from "./evolution-adapter.js";
import { answerCurrent } from "./interaction-fixture.js";
import { compileSpec } from "../../src/evolution/specification.js";
import type { AssistantSnapshot } from "../../src/shared/assistant.js";

type WaitingRun = Extract<NonNullable<AssistantSnapshot["run"]>,{status:"awaiting-input"}>;

const scenario = currentManifest("a".repeat(40)).scenarios.find(s => s.id === "clarification-reflection")!;

/** Authored model stub: ordinary planning, an independent unresolved choice, then its source audit. */
function choiceDriver(requests: ModelRequest[]): Driver {
  const planning = new PlanningDriver();
  return {async generate(request) {
    requests.push(structuredClone(request));
    const input = JSON.parse(request.message ?? "{}");
    if (input.kind === "clarification-review/2")
      return {text:JSON.stringify({effects:noEffectsFixture(),decisions:[{
        kind:"business-ambiguity",source:1,sourceQuote:scenario.clarification!.sourceQuote,
        detail:"原文明确只将复盘必填性留待用户决定",
      }]}),history:[],calls:[],usage:null,raw:{fixture:"normal-choice-audit"}};
    const reply = await planning.generate(request);
    if (input.kind === "requirement-review/2" &&
        !input.sources.some((s:{text:string}) => s.text === scenario.clarification!.answer)) {
      const schema = request.schema as {properties:{unresolvedChoices:{items:{properties:{targetId:{enum:string[]}}}}}};
      const ids = schema.properties.unresolvedChoices.items.properties.targetId.enum;
      assert.equal(ids.length,1,"独立复核只选择宿主提供的唯一必填性目标");
      reply.text = JSON.stringify({...JSON.parse(reply.text),unresolvedChoices:[{
        targetId:ids[0],sourceRevision:input.sources[0].id,sourceQuote:scenario.clarification!.sourceQuote,
      }]});
    }
    return reply;
  }};
}

test("正常规划的结构化澄清在回答和重启后仍可重放，草稿不能提前执行或冻结", async t => {
  const directory = await mkdtemp(join(tmpdir(),"cordis-normal-choice-proof-"));
  const workspace = await Workspace.open(join(directory,"workspace.db"));
  const requests: ModelRequest[] = [];
  let evolution = new Evolution(workspace.db,choiceDriver(requests),new EvolutionDomain(workspace));
  t.after(async () => {await evolution.close();await workspace.close();await rm(directory,{recursive:true,force:true});});
  const before = {composition:workspace.composition(),tasks:workspace.query()};
  await evolution.command({type:"request",operationId:"normal-choice",text:scenario.request});
  const waiting = await settleEvolution(evolution);
  assert.equal(waiting.status,"awaiting-input",JSON.stringify({status:waiting.status,stop:waiting.stop}));
  if (waiting.status !== "awaiting-input") throw new Error("missing clarification");
  assert.deepEqual(requests.map(r => r.phase),["planning","review","review"]);
  assert.equal(waiting.budget!.callsUsed,3);
  assert.equal(waiting.requestAdmissions?.length ?? 0,0);
  assert.equal(waiting.plans?.length,1,"等待回答前必须保存与独立选择证明对应的草稿");
  assert.equal(waiting.plans![0].requirementGate,undefined,"未决草稿不能持有需求冻结");
  assert.equal(workspace.db.prepare("SELECT count(*) n FROM evolution_requirement_freezes").get()!.n,0);
  assert.equal((await evolution.observe()).candidates?.length,0);
  assert.deepEqual({composition:workspace.composition(),tasks:workspace.query()},before);
  await assert.rejects(() => evolution.command({type:"start",runId:waiting.id,
    planId:waiting.plans![0].id,operationId:"cannot-start-draft"}));
  const answer = frozenClarificationAnswer(scenario,waiting);
  const receipt = {runId:waiting.id,question:waiting.question!,...answer};
  assert.equal(answer.answer,scenario.clarification!.answer);
  assert.equal(answer.binding.choiceId,waiting.clarificationReviews![0].choice!.id);

  for (const mutate of [
    (run:WaitingRun) => {delete run.clarificationReviews![0].choice;},
    (run:WaitingRun) => {run.clarificationReviews![0].choice!.hash="forged";},
    (run:WaitingRun) => {run.clarificationReviews![0].decision.kind="unnecessary";},
    (run:WaitingRun) => {run.clarificationReviews![0].decision.sourceQuote="其他行为沿用现有工作流";},
    (run:WaitingRun) => {run.clarificationReviews![0].decision.effects!.sourceHash="forged";},
    (run:WaitingRun) => {run.clarificationReviews![0].decision.effects!.factsHash="forged";},
    (run:WaitingRun) => {run.revisions![0].text += "；复盘是否必填尚未决定";},
    (run:WaitingRun) => {
      const plan=run.plans![0],spec=plan.changeSpec!;
      plan.workflowRules[0].label="标签";
      plan.changeSpec=compileSpec(plan,spec.runId,spec.baseHash,spec.workflowDefinition);
    },
    (run:WaitingRun) => {
      const plan=run.plans![0],spec=plan.changeSpec!;
      plan.binding!.checkers[0].version="changed";
      plan.changeSpec=compileSpec(plan,spec.runId,spec.baseHash,spec.workflowDefinition);
    },
    (run:WaitingRun) => {run.reviewLedger!.attempts=[];},
  ]) {
    const changed: WaitingRun=structuredClone(waiting);
    mutate(changed);
    assert.throws(() => frozenClarificationAnswer(scenario,changed),/冻结|审查|来源|结构化/);
    assert.equal(frozenClarificationReceiptMatches(scenario,changed,receipt),false);
  }
  const wrongQuestion = {...waiting,question:waiting.question+"；标签是否必填？"};
  assert.throws(() => frozenClarificationAnswer(scenario,wrongQuestion),/冻结|结构化/);
  assert.equal(frozenClarificationReceiptMatches(scenario,waiting,{...receipt,question:wrongQuestion.question}),false);
  for (const choice of [
    {...scenario.clarification!.choice!,scope:"task-presence" as const},
    {...scenario.clarification!.choice!,scope:"action-input" as const,action:"reopen"},
    {...scenario.clarification!.choice!,field:{kind:"new" as const,name:"标签"}},
  ]) assert.throws(() => frozenClarificationAnswer({...scenario,clarification:{...scenario.clarification!,choice}},waiting),/冻结|结构化/);

  await evolution.close();
  evolution = new Evolution(workspace.db,choiceDriver(requests),new EvolutionDomain(workspace));
  const restored = (await evolution.observe(waiting.id)).run!;
  assert.deepEqual(frozenClarificationAnswer(scenario,restored),answer);
  assert.equal(requests.length,3,"重启不自动重放模型");
  await answerCurrent(evolution,{type:"answer",runId:waiting.id,operationId:"normal-choice-answer",text:answer.answer});
  const ready = await settleEvolution(evolution);
  assert.equal(ready.status,"ready",JSON.stringify({status:ready.status,stop:ready.stop}));
  assert.equal(ready.id,waiting.id);
  assert.deepEqual(requests.map(r=>r.phase),["planning","review","review","planning","review"]);
  assert.equal(ready.budget!.callsUsed,5);
  assert.equal(workspace.db.prepare("SELECT count(*) n FROM evolution_calls").get()!.n,5);
  assert.ok(requests.filter(r=>r.phase==="review").every(r=>r.history.length===0 && !r.tools));
  assert.equal(ready.requestAdmissions?.length??0,0);
  assert.equal(frozenClarificationReceiptMatches(scenario,ready,receipt),true);
  assert.equal((await evolution.observe()).candidates?.length,0);
  assert.deepEqual({composition:workspace.composition(),tasks:workspace.query()},before);
  await evolution.close();
  evolution = new Evolution(workspace.db,choiceDriver(requests),new EvolutionDomain(workspace));
  assert.equal(frozenClarificationReceiptMatches(scenario,(await evolution.observe(ready.id)).run!,receipt),true);
  assert.equal(requests.length,5);
});
