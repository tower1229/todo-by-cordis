import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { verifyWorkflow } from "../../src/server/workflow-acceptance.js";
import type { WorkflowDefinition, WorkflowDecision } from "../../src/shared/contracts.js";
import {
  activateDual,
  activateWorkflowOnly,
} from "./dual-composition-fixture.js";
import { BusinessAssertionError } from "../../src/server/business-verification.js";
import { contract, EvolutionDomain } from "../../src/server/evolution-domain.js";
import { Evolution } from "./evolution-adapter.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import { candidateScope, candidateSource } from "./evolution-fixture.js";
import type { Driver } from "../../src/evolution/driver.js";
import { ExperienceSessionHost } from "../../src/server/experience-session.js";

for (const activate of [activateWorkflowOnly, activateDual]) {
  test(`真实运行时夹具契约与既有工作流检查器一致：${activate.name}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-fixture-"));
    const w = await Workspace.open(join(dir, "workspace.db"));
    t.after(async () => {
      await w.close();
      await rm(dir, { recursive: true, force: true });
    });
    await activate(w);
    const base = w.activeVersion();
    const runtime = await w.release.start(base);
    t.after(() => runtime.close());
    const definition = await runtime.invoke<WorkflowDefinition>("describe");
    assert.equal(base.name, definition.name);
    assert.deepEqual(base.definition, definition);
    const checks = await verifyWorkflow(runtime, definition, base, {
      pluginId: base.pluginId,
      name: base.name,
      fields: [],
    });
    assert.deepEqual(checks, [
      "complete-preserve-fields",
      "reopen-preserve-fields",
      "invalid:done:complete",
      "invalid:open:reopen",
      "invalid:open:unknown",
    ]);
  });
}

test("工作流表单反例反馈保留确切输入、前置字段、期望与实际决策", async (t) => {
  const directory=await mkdtemp(join(tmpdir(),"workflow-failure-feedback-"));
  const workspace=await Workspace.open(join(directory,"workspace.db"));
  t.after(async()=>{await workspace.close();await rm(directory,{recursive:true,force:true});});
  const definition:WorkflowDefinition={
    id:"review",name:"复盘",version:"1",initialState:"open",
    states:{open:{label:"未完成",category:"open"},done:{label:"已完成",category:"done"}},
    actions:[{id:"complete",label:"完成",from:["open"]},{id:"reopen",label:"重新打开",from:["done"]}],
    fields:[{key:"review",label:"复盘",type:"text",required:true}],
  };
  const code=`export default {describe(){return ${JSON.stringify(definition)}},decide({task,action,input}){
    if(action==='complete'){
      if(input.review===undefined||input.review==='')return {kind:'input-required',fields:this.describe().fields};
      if(!input.review.trim())return {kind:'reject',message:'请填写复盘'};
      return {kind:'commit',state:'done',fields:{...task.fields,review:input.review.trim()}};
    }
    return {kind:'commit',state:'open',fields:task.fields};
  }};`;
  const version=workspace.release.record({pluginId:"review",name:"复盘",service:"workflow",contractVersion:"workflow/1",source:code,code,definition,evidence:{passed:true,origin:"test"}});
  const runtime=await workspace.release.start(version);
  t.after(()=>runtime.close());
  await assert.rejects(()=>verifyWorkflow(runtime,definition,version,{pluginId:"review",name:"复盘",fields:[{key:"review",label:"复盘",required:true,minLength:1,maxLength:5000}]}),(error:unknown)=>{
    assert.ok(error instanceof BusinessAssertionError);
    assert.ok(error.message.startsWith("行为验收失败：review:missing-input-form"));
    const detail=JSON.parse(error.message.slice(error.message.indexOf("；")+1));
    assert.deepEqual(detail.input,{review:"   "});
    assert.deepEqual(detail.expected,{kind:"input-required",field:"review"});
    assert.deepEqual(detail.actual,{kind:"reject",message:"请填写复盘"});
    assert.equal(detail.state,"open");
    assert.equal(detail.action,"complete");
    assert.equal(detail.fields.review,"已有历史文字");
    return true;
  });
});

test("候选按现有契约统一处理空白输入，复用既有写法且原业务验收仍有效", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-required-input-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const definition: WorkflowDefinition = {
    id: "review",
    name: "输入表单",
    version: "1",
    initialState: "open",
    states: {
      open: { label: "未完成", category: "open" },
      done: { label: "已完成", category: "done" },
    },
    actions: [
      { id: "complete", label: "完成", from: ["open"] },
      { id: "reopen", label: "重新打开", from: ["done"] },
    ],
    fields: [
      { key: "first", label: "第一项", type: "text", required: true },
      { key: "second", label: "第二项", type: "text", required: true },
      { key: "toString", label: "同名字段", type: "text", required: true },
      { key: "optional", label: "可选项", type: "text" },
    ],
  };
  const source = `import type { Plugin } from './contract.js';
const plugin: Plugin = {
  describe() { return ${JSON.stringify(definition)}; },
  decide({ task, action, input }) {
    if (!this.describe().actions.some(a => a.id === action && a.from.includes(task.state)))
      return { kind: 'reject', message: '当前动作不可用' };
    if (action === 'complete') {
      const fields = this.describe().fields;
      if (fields.some(field => field.required && (!Object.hasOwn(input, field.key) || !input[field.key].trim())))
        return {kind:'input-required',fields};
      if (Object.values(input).some(value => [...value.trim()].length > 4))
        return { kind: 'reject', message: '内容过长' };
      return { kind: 'commit', state: 'done', fields: {
        ...task.fields, ...Object.fromEntries(Object.entries(input).map(([key,value]) => [key,value.trim()]))
      } };
    }
    return { kind: 'commit', state: 'open', fields: { ...task.fields } };
  }
};
export default plugin;`;
  const bundle = await workspace.release.buildBundle(
    {
      "business/entry.ts": source,
      "business/view.ts":
        "export default {title:'输入表单',fields:['first','second','toString','optional']};",
      "business/config.json": "{}",
      "business/compatibility.json": '{"preserveUnknownFields":true}',
    },
    contract,
    new AbortController().signal,
  );
  const version = workspace.release.record({
    pluginId: definition.id,
    name: definition.name,
    service: "workflow",
    contractVersion: "workflow/1",
    source,
    code: bundle.outputs["business/entry.js"],
    bundle,
    definition,
    evidence: { passed: true, origin: "synthetic-interface-probe" },
  });
  const runtime = await workspace.release.start(version);
  t.after(() => runtime.close());
  const task = {
    id: "test",
    state: "open",
    fields: { retained: "history", first: "历史值" },
  };
  for (const input of [
    {},
    { first: "", second: "好" },
    { first: "好", second: "\u3000\t " },
    { first: "好", second: "好" },
  ]) {
    const decision = await runtime.invoke<WorkflowDecision>("decide", {
      task,
      action: "complete",
      input,
    });
    assert.deepEqual(decision, {
      kind: "input-required",
      fields: definition.fields,
    });
  }
  const valid = await runtime.invoke<WorkflowDecision>("decide", {
    task,
    action: "complete",
    input: { first: " 0 ", second: "😀", toString: "值" },
  });
  assert.deepEqual(valid, {
    kind: "commit",
    state: "done",
    fields: { ...task.fields, first: "0", second: "😀", toString: "值" },
  });
  const checks = await verifyWorkflow(runtime, definition, version, {
    pluginId: definition.id,
    name: definition.name,
    fields: definition.fields.map((f) => ({
      key: f.key,
      label: f.label,
      required: !!f.required,
      minLength: f.required ? 1 : 0,
      maxLength: 4,
    })),
  });
  assert.ok(checks.includes("first:missing-input-form"));
  assert.ok(checks.includes("second:missing-input-form"));
  assert.ok(checks.includes("first:maximum"));
  assert.ok(checks.includes("invalid:open:unknown"));
});

test("模型协议候选复用既有写法修正表单失败，同一冻结运行通过独立浏览器验收后仍等待应用", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "workflow-input-full-gate-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  const sessions = new ExperienceSessionHost(workspace);
  const domain = new EvolutionDomain(workspace);
  const planner = new PlanningDriver();
  planner.finish = {
    workflowRules: [
      {
        key: "reflection",
        label: "复盘",
        required: true,
        minLength: 1,
        maxLength: 5000,
      },
    ],
    writableScope: candidateScope,
  };
  let generated = 0;
  const driver: Driver = {
    async generate(request) {
      if (!request.tools?.some((tool) => tool.name === "submit_candidate"))
        return planner.generate(request);
      generated++;
      if (generated === 1)
        assert.match(
          request.message ?? "",
          /omitted keys.*trim-empty values/,
        );
      if (generated > 1)
        assert.match(JSON.stringify(request), /reflection:missing-input-form/);
      const source = `import { frozenWorkflow } from './contract.js';
import type { Plugin } from './contract.js';
const plugin: Plugin = {
  describe() { return frozenWorkflow; },
  decide({ task, action, input }) {
    if (!frozenWorkflow.actions.some(a => a.id === action && a.from.includes(task.state)))
      return { kind: 'reject', message: '当前动作不可用' };
    if (action === 'reopen') return { kind: 'commit', state: 'open', fields: task.fields };
    ${
      generated === 1
        ? `if (!Object.hasOwn(input, 'reflection')) return { kind: 'input-required', fields: frozenWorkflow.fields };`
        : `if (frozenWorkflow.fields.some(field => field.required && (!Object.hasOwn(input, field.key) || !input[field.key].trim())))
      return {kind:'input-required',fields:frozenWorkflow.fields};`
    }
    const value = input.reflection.trim();
    if (!value || [...value].length > 5000) return { kind: 'reject', message: '复盘字数不符合要求' };
    return { kind: 'commit', state: 'done', fields: { ...task.fields, reflection: value } };
  }
};
export default plugin;`;
      return toolReply("submit_candidate", JSON.parse(candidateSource(source)));
    },
  };
  const evolution = new Evolution(workspace.db, driver, domain, sessions);
  t.after(async () => {
    await evolution.close();
    await sessions.close();
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const settle = async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const run = (await evolution.observe()).run;
      if (run && !["planning", "executing", "applying"].includes(run.status))
        return run;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("输入表单回归运行未结束");
  };
  const before = {
    composition: workspace.composition(),
    tasks: workspace.query(),
  };
  await evolution.command({
    type: "request",
    operationId: "request",
    text: "完成前必须填写复盘，去掉首尾空格后至少1个最多5000个Unicode码点，重新打开保留，其他行为不变",
  });
  const ready = await settle();
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  if (ready.status !== "ready") return;
  assert.equal(ready.plan.binding?.workflowProtocol?.owner, "model");
  const seal = ready.plan.requirementGate!.seal;
  await evolution.command({
    type: "start",
    operationId: "start",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle();
  assert.equal(done.status, "awaiting-apply", JSON.stringify(done));
  const candidates = (await evolution.observe()).candidates!;
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].passed, false);
  assert.match(candidates[0].diagnostic!, /reflection:missing-input-form/);
  const passed = candidates[1];
  assert.equal(passed.passed, true);
  assert.ok(
    passed.browser?.results.every((result) => result.status === "passed"),
  );
  assert.equal(candidates[0].requirementSeal, seal);
  assert.equal(passed.requirementSeal, seal);
  domain.verifyAcceptance(passed.versionId!, ready.plan);
  assert.equal(
    workspace.release.get(passed.versionId!).workflowProtocol,
    undefined,
  );
  assert.deepEqual(
    { composition: workspace.composition(), tasks: workspace.query() },
    before,
  );
  await evolution.command({
    type: "experience",
    operationId: "experience",
    runId: done.id,
    candidateId: passed.id,
  });
  assert.equal((await evolution.observe()).run!.status, "awaiting-apply");
  assert.deepEqual(workspace.composition(), before.composition);
  await evolution.command({
    type: "apply",
    operationId: "apply",
    runId: done.id,
    candidateId: passed.id,
    evidenceHash: passed.evidenceHash!,
    compositionRevision: before.composition.revision,
  });
  assert.equal((await settle()).status, "succeeded");
  assert.equal(workspace.composition().versionId, passed.versionId);
  assert.deepEqual(workspace.query().tasks, before.tasks.tasks);
  assert.deepEqual(workspace.query().counts, before.tasks.counts);
});
