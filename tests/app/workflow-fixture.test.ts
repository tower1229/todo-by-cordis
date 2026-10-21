import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { verifyWorkflow } from "../../src/server/evolution-domain.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";
import {
  activateDual,
  activateWorkflowOnly,
} from "./dual-composition-fixture.js";
import { BusinessAssertionError } from "../../src/server/business-verification.js";

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
