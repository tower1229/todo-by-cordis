import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { createApp } from "../../src/server/app.js";
import { PlanningDriver } from "./planning-fixture.js";
import { source, candidateSource, candidateScope } from "./evolution-fixture.js";
import { ExecutionDriver } from "./execution-fixture.js";

async function settled(e: Evolution) {
  for (let i = 0; i < 1000; i++) {
    const s = await e.observe();
    if (s.run && !["planning", "executing", "applying"].includes(s.run.status)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("run did not settle");
}
async function setup(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "cordis-continue-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const planning = new PlanningDriver();
  const driver = { async generate(request: import("../../src/evolution/driver.js").ModelRequest) {
    const rules = planning.finish.workflowRules as { minLength: number }[] | undefined;
    const result = await new ExecutionDriver(planning, "default", "轻快完成", rules?.[0]?.minLength ?? 1).generate(request);
    if (result.calls[0]?.name === "submit_candidate" && w.activeVersion().bundle)
      result.calls[0].args = JSON.parse(candidateSource(String(result.calls[0].args.source))) as {files: unknown};
    return result;
  }};
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => { await e.close(); await w.close(); rmSync(dir, {recursive:true, force:true}); });
  const app = createApp(w, e);
  const command = async (body: Record<string, unknown>) => app.request("/api/assistant/commands", {
    method: "POST", headers: {"content-type":"application/json"}, body: JSON.stringify(body),
  });
  return { w, e, planning, command, driver };
}

test("continue explicitly links a stopped run to the exact published base and retains its budget and diagnostics", async (t) => {
  const {w, e, command} = await setup(t);
  await e.command({type:"request", operationId:"request", text:"完成前复盘"});
  const parent = (await settled(e)).run!;
  await e.command({type:"cancel", operationId:"cancel", runId:parent.id});
  const before = await e.observe(parent.id);
  const body = {type:"continue", operationId:"continue", runId:parent.id, baseVersion:w.activeVersion().id, text:"继续完善复盘"};
  const response = await command(body);
  assert.equal(response.status, 200, await response.clone().text());
  const receipt = await response.json();
  assert.notEqual(receipt.run.id, parent.id);
  assert.equal(receipt.run.parentRunId, parent.id);
  assert.equal(receipt.run.baseVersion, w.activeVersion().id);
  assert.equal(receipt.run.capabilityId, w.activeVersion().pluginId);
  assert.deepEqual(receipt.run.parent.budget, before.run?.budget);
  assert.equal(receipt.run.parent.status, "cancelled");
  assert.deepEqual(await (await command(body)).json(), receipt);
  await settled(e);
  assert.deepEqual(await e.observe(parent.id), before);
  await e.command({type:"cancel", operationId:"cancel-child", runId:receipt.run.id});
  assert.equal((await command({...body, operationId:"stale", baseVersion:"stale"})).status, 409);
});


test("A14: changed business rules require a separate exact confirmation and retain history across restart", async (t) => {
  const {w, e, planning, command, driver} = await setup(t);
  // Publish through the same public start/apply commands users invoke.
  await e.command({type:"request", operationId:"request", text:"完成前复盘"});
  const ready = (await settled(e)).run!;
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  await e.command({type:"start", operationId:"start", runId:ready.id, planId:ready.plan.id});
  const candidate = await settled(e);
  assert.equal(candidate.run?.status, "awaiting-apply");
  await e.command({type:"apply", operationId:"apply", runId:ready.id, candidateId:candidate.candidates![0].id,
    evidenceHash:candidate.candidates![0].evidenceHash!, compositionRevision:w.composition().revision});
  const published = (await settled(e)).run!;
  assert.equal(published.status, "succeeded");
  planning.finish = {
    workflowRules: [{key:"reflection", label:"复盘", required:true, minLength:3, maxLength:5000}],
    acceptanceReason:"用户要求复盘至少三个字",
    writableScope:["business/entry.ts", "business/view.ts", "business/config.json", "business/compatibility.json"],
  };
  assert.equal((await command({type:"continue", operationId:"continue", runId:published.id,
    baseVersion:published.versionId, text:"复盘至少三个字"})).status, 200);
  const pending = (await settled(e)).run!;
  assert.equal(pending.status, "awaiting-acceptance", JSON.stringify(pending));
  if (pending.status !== "awaiting-acceptance") return;
  assert.match(pending.plan.acceptanceChanges![0].before, /1/);
  assert.match(pending.plan.acceptanceChanges![0].after, /3/);
  assert.equal((await command({type:"start", operationId:"premature", runId:pending.id, planId:pending.plan.id})).status, 409);
  assert.equal((await command({type:"confirm-acceptance", operationId:"wrong", runId:pending.id, planId:pending.plan.id, revisionId:"wrong"})).status, 409);
  const confirm = {type:"confirm-acceptance", operationId:"confirm", runId:pending.id, planId:pending.plan.id, revisionId:pending.acceptanceRevision.id};
  const response = await command(confirm);
  assert.equal(response.status, 200);
  const confirmed = await response.json();
  assert.equal(confirmed.run.status, "ready");
  assert.equal(confirmed.run.acceptanceRevisions.length, 1);
  assert.ok(confirmed.run.acceptanceRevisions[0].confirmedAt);
  assert.deepEqual(await (await command(confirm)).json(), confirmed);
  assert.equal((await e.observe(published.id)).run?.status, "succeeded");
  await e.close();
  const reopened = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.observe(pending.id)).run, confirmed.run);
  await w.command({type:"create", title:"保留历史任务", operationId:"task", compositionRevision:w.composition().revision});
  const oldTask = w.query().tasks[0];
  const act = (input: string, op: string) => w.command({type:"action", taskId:oldTask.id, actionId:"complete", input:{reflection:input}, expectedRevision:oldTask.revision, operationId:op, compositionRevision:w.composition().revision});
  // Existing rules still apply until the new candidate is explicitly applied.
  const oldVersion = w.activeVersion().id;
  await reopened.command({type:"start", runId:pending.id, planId:pending.plan.id, operationId:"start-next"});
  await assert.rejects(reopened.command({type:"revise", runId:pending.id, operationId:"locked", text:"改成选填"}), /锁定/);
  const next = await settled(reopened);
  assert.equal(next.run?.status, "awaiting-apply", JSON.stringify(next));
  assert.equal(w.activeVersion().id, oldVersion);
  assert.deepEqual(w.query().tasks[0], oldTask);
  await reopened.command({type:"apply", runId:pending.id, operationId:"apply-next", candidateId:next.candidates![0].id, evidenceHash:next.candidates![0].evidenceHash!, compositionRevision:w.composition().revision});
  assert.equal((await settled(reopened)).run?.status, "succeeded");
  assert.equal(w.activeVersion().pluginId, "default");
  assert.equal(w.activeVersion().parentId, oldVersion);
  assert.deepEqual(w.query().tasks[0], oldTask);
  await assert.rejects(act("短", "too-short"), /字数/);
  await act("三个字", "complete-next");
  assert.equal(w.query("", "all").tasks[0].fields.reflection, "三个字");
  assert.equal(w.query("", "all").tasks[0].state, "done");
});


test("A15: a repair with no reproducible old-version assertion failure is blocked before generation", async (t) => {
  const {w, e, command, planning} = await setup(t);
  // The default workflow has no reflection rule: exercise unchanged baseline checks.
  planning.finish = { workflowRules: [], intent: "repair" };
  const response = await command({type:"request", operationId:"repair", text:"修复完成失败", intent:"repair"});
  assert.equal(response.status, 200);
  const result = await settled(e);
  assert.equal(result.run?.status, "blocked");
  assert.match(result.run && "message" in result.run ? result.run.message : "", /无法复现|unreproduced/);
  assert.equal(result.candidates?.length, 0);
  assert.equal(w.composition().revision, 1);
});

test("A15: old published Unicode failure and candidate pass use identical assertions with protection regression", async (t) => {
  const {w, e, planning, command} = await setup(t);
  const rules = [{key:"reflection", label:"复盘", required:true, minLength:1, maxLength:5000}];
  // Fault injection at the persisted artifact boundary: simulate a historical release
  // whose validator missed UTF-16 counting. No production task data is used.
  const brokenSource = source("default", "轻快完成").replaceAll("[...value].length", "value.length");
  const files = Object.fromEntries((JSON.parse(candidateSource(brokenSource)) as {files:{path:string;content:string}[]}).files.map((f) => [f.path,f.content]));
  const {contract} = await import("../../src/server/evolution-domain.js");
  const bundle = await w.release.buildBundle(files, contract, AbortSignal.timeout(15000));
  const old = w.activeVersion();
  const faulty = w.release.record({pluginId:old.pluginId, name:old.name, service:"workflow", contractVersion:"workflow/1", parentId:old.id,
    source:JSON.stringify({files:Object.entries(files).map(([path,content])=>({path,content}))}), code:bundle.outputs["business/entry.js"], bundle,
    definition:{...(old.definition as object), fields:[{key:"reflection", label:"复盘", type:"text", required:true}]}, evidence:{passed:true,rules,origin:"historical-fault-fixture"}});
  await w.activate({versionId:faulty.id, compositionRevision:w.composition().revision, operationId:"fault-fixture"}, () => undefined);
  planning.finish = {workflowRules:rules, writableScope:candidateScope, intent:"repair"};
  assert.equal((await command({type:"request", operationId:"repair", text:"修复表情字符长度误判", intent:"repair"})).status, 200);
  const ready = (await settled(e)).run!;
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  if (ready.status !== "ready") return;
  assert.equal(ready.plan.repairEvidence?.baseVersion, faulty.id);
  assert.match(ready.plan.repairEvidence?.diagnostic ?? "", /reflection:unicode-boundary/);
  await e.command({type:"start", operationId:"start-repair", runId:ready.id, planId:ready.plan.id});
  const candidate = await settled(e);
  assert.equal(candidate.run?.status, "awaiting-apply", JSON.stringify(candidate));
  const evidence = w.release.get(candidate.run!.versionId!).evidence as {definitionHash:string; repairEvidence:unknown; checks:string[]; systemChecks:string[]};
  assert.equal(evidence.definitionHash, ready.plan.repairEvidence!.definitionHash);
  assert.deepEqual(evidence.repairEvidence, ready.plan.repairEvidence);
  assert.ok(evidence.checks.includes("reflection:unicode-boundary"));
  assert.ok(evidence.systemChecks.includes("unknown-method-rejected"));
  assert.equal(w.activeVersion().id, faulty.id);
});
