import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { compilePlanDraft, readInvestigation, readPlanningMaterials, planningTools, planBindingFailure } from "../../src/server/planning.js";
import { materialIdentity, InvestigationStore } from "../../src/evolution/investigation.js";
import { hash } from "../../src/release/storage.js";
import type { PlanEvidence } from "../../src/shared/assistant.js";
import { workspaceInterface, compactCapabilityInventory } from "../../src/server/host-interface.js";
import { readFile } from "node:fs/promises";

const sourceRef = "src/server/workspace.ts";

test("消费方接口替代实现全文并绑定来源，原文仍可补读；不暴露宿主维护入口", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-interface-test-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => { await w.close(); await rm(directory, { recursive:true, force:true }); });
  const context = new EvolutionDomain(w).context();
  const inspect = readPlanningMaterials("inspect_application", {}, context);
  assert.ok("ref" in inspect);
  const documents = [inspect, ...inspect.documents ?? []];
  assert.ok(documents.some(document => document.ref === "src/web/ActionForm.tsx"), "主工作流的必需消费方仍须首轮交付");
  assert.equal(documents.some(document => document.ref === "src/web/WorkspacePanel.tsx" || document.ref === "src/web/api.ts"), false);
  const primary = context.members.find(member => member.role === "workflow")!;
  const primarySource = `member-source/${primary.pluginId}@${primary.versionId}`;
  const primaryContract = `member-contract/${primary.pluginId}@${primary.versionId}`;
  for (const ref of [primarySource, primaryContract]) {
    assert.ok(context.files[ref], "省略的重复身份仍在完整目录中");
    assert.equal(documents.some(document => document.ref === ref), false);
  }
  const differentPrimary = structuredClone(context);
  const differentSource = context.files[primarySource].content + "\n// distinct primary artifact";
  differentPrimary.files[primarySource] = {content:differentSource,hash:hash(differentSource)};
  const distinct = readPlanningMaterials("inspect_application", {}, differentPrimary);
  assert.ok("ref" in distinct && distinct.documents?.some(document => document.ref === primarySource), "不同正文不得按主成员身份省略");
  const view = documents.find(document => document.source?.ref === sourceRef);
  assert.ok(view);
  assert.equal(documents.some(document => document.ref === sourceRef), false);
  assert.deepEqual(view.source, {ref:sourceRef,hash:context.files[sourceRef].hash});
  assert.equal(view.hash, hash(view.content));
  const content = JSON.stringify(view.content);
  for (const method of ["command", "composition", "read", "query"]) assert.match(content, new RegExp(method + "\\("));
  assert.doesNotMatch(content, /activateForAcceptance|seedAcceptanceTask|replicateAcceptanceTask|acceptanceProbe|private |\.prepare\(/);
  assert.ok(Buffer.byteLength(content) < Buffer.byteLength(context.files[sourceRef].content) * 0.1);
  const store = new InvestigationStore(w.db);
  const state = {version:2 as const,baseVersion:context.versionId,materials:[],deliveries:[]};
  store.capture(state, documents, context.files);
  const seen = documents.map(materialIdentity);
  assert.ok(w.db.prepare("SELECT body FROM evolution_materials WHERE hash=?").get(view.source!.hash));
  assert.ok(w.db.prepare("SELECT body FROM evolution_materials WHERE hash=?").get(context.files["src/web/api.ts"].hash), "省略交付的完整原文仍须归档");
  assert.equal(store.documents(state, seen).some(d=>d.ref==="src/web/api.ts"),false,"归档未交付的资料不能冒充已读");
  assert.equal(store.documents(state, seen).some(d=>d.ref===sourceRef), false, "归档不能冒充原文已交付");
  const memberRaw = readPlanningMaterials("read_materials", {refs:[primarySource,primaryContract]}, context, seen);
  assert.ok("ref" in memberRaw && memberRaw.documents?.every(document => !document.reused), "交付规范身份不冒充成员别名已读");
  assert.equal(memberRaw.documents?.find(document => document.ref === primarySource)?.content, context.files[primarySource].content);
  const raw = readInvestigation("read_source", {ref:sourceRef}, context, seen);
  assert.ok("ref" in raw && !raw.reused);
  assert.equal(raw.content, context.files[sourceRef].content);
  const legacy = readInvestigation("inspect_application", {}, context, [materialIdentity(raw)]);
  assert.ok("ref" in legacy);
  assert.ok(legacy.documents?.some(d=>d.ref===sourceRef && d.reused));
  assert.equal(legacy.documents?.some(d=>d.source?.ref===sourceRef), false);

  const text = "完成前填写复盘，其他行为不变";
  const proposal = {changes:[{target:"workflow",fields:[{key:"reflection",label:"复盘",required:true,minLength:1,maxLength:5000}]}],
    requirements:[{quote:text,type:"behavior",expectations:[{kind:"behavior"}]}]};
  const parsed = compilePlanDraft(proposal, context, seen, [{id:"request:1",text}]);
  assert.deepEqual(parsed.blockers, []);
  assert.ok(parsed.plan.binding!.materials.some(d=>d.ref===view.ref));
  assert.equal(planBindingFailure(parsed.plan.binding, context), undefined);
  for (const replacement of [{...materialIdentity(view),hash:"forged"},{ref:view.ref,hash:view.hash},
    {...materialIdentity(view),source:{ref:sourceRef,hash:"forged"}}]) {
    const forged: PlanEvidence[] = seen.map((d): PlanEvidence=>d.ref===view.ref ? replacement : d);
    assert.ok(compilePlanDraft(proposal,context,forged,[{id:"request:1",text}]).blockers.length);
  }
  const changed = structuredClone(context);
  changed.files[sourceRef] = {content:"changed",hash:hash("changed")};
  assert.match(planBindingFailure(parsed.plan.binding,changed) ?? "", /视图|来源|资料/);
  const batch=readPlanningMaterials("read_materials",{refs:[sourceRef,"guide/command.register"]},context,seen);
  assert.ok("ref" in batch);
  assert.equal(batch.hash,hash(batch.content));
  assert.equal(batch.documents?.find(d=>d.ref===sourceRef)?.content,context.files[sourceRef].content);
  assert.equal(batch.documents?.filter(d=>d.ref===sourceRef).length,1);
  assert.equal(Object.hasOwn(batch.content as object,"documents"),false,"批读元数据不能重复承载正文");
  for(const args of [{refs:[]},{refs:[sourceRef,sourceRef]},{refs:[sourceRef,"../../.env"]},{refs:[1]},
    {refs:[sourceRef],knownHashes:{[sourceRef]:"forged"}}])assert.ok("error" in readPlanningMaterials("read_materials",args,context,seen));
  assert.deepEqual(planningTools.map(tool=>tool.name).sort(),["inspect_application","read_materials","propose_plan","request_clarification","report_blocker","redirect_request"].sort());
});

test("消费方接口只解析已捕获源码，无工程配置依赖；无法可靠提取显式类型时交付原文",async()=>{
  const content=await readFile("src/server/workspace.ts","utf8");
  const document={ref:sourceRef,content:content+"\n// cold snapshot",hash:hash(content+"\n// cold snapshot")};
  const view=workspaceInterface(document,"base");assert.ok(view);
  const declarations=(view.content as {declaration:string}).declaration;
  assert.match(declarations,/query\(search\?: string, category\?: string, offset\?: number\): TaskList;/);
  assert.match(declarations,/command\(command: Command, complete\?: \(\) => void\): Promise<CommandResult>;/);
  const unsupported=content.replace('query(search = "", category = "open", offset = 0): TaskList','query(search = String(""), category = "open", offset = 0): TaskList');
  assert.notEqual(unsupported,content);assert.equal(workspaceInterface({ref:sourceRef,content:unsupported,hash:hash(unsupported)},"base"),undefined);
  assert.throws(()=>workspaceInterface({...document,hash:"forged"},"base"),/来源|变化/);
});

test("能力共同身份可还原，每项状态、覆盖和不一致版本均保留",()=>{
  const state={installed:true,enabled:false,healthy:true,authorized:false,ready:false,inUse:false,count:0,status:"declared",checkerCoverage:["workspace/1"]};
  const members: {pluginId:string;versionId:string;enabled:boolean;materials?:Record<string,string>}[] = [{pluginId:"tags",versionId:"v1",enabled:false}];
  const capabilities: (typeof state & {providerId:string;interfaceId:string;providerVersion:string;artifactVersion:string;source?:string;contract?:string;acceptance?:string})[] = [
    {providerId:"tags",interfaceId:"fields.register",providerVersion:"v1",artifactVersion:"v1",source:"source/tags",contract:"contract/tags",acceptance:"acceptance/tags",...state},
    {providerId:"tags",interfaceId:"ui.slot",providerVersion:"v1",artifactVersion:"v1",source:"source/tags",contract:"contract/tags",acceptance:"acceptance/tags",...state,checkerCoverage:[]},
    {providerId:"host:scheduler",interfaceId:"schedule.runtime",providerVersion:"host-v1",artifactVersion:"base-v1",...state},
  ];
  const projected=compactCapabilityInventory(members,capabilities);
  assert.deepEqual(projected.capabilities.map(cap=>{
    const member=projected.members.find(member=>member.pluginId===cap.providerId);
    return member ? {providerVersion:member.versionId,artifactVersion:member.versionId,...member.materials,...cap} : cap;
  }),capabilities);
  assert.deepEqual(projected.capabilities[2],capabilities[2]);
  const mismatch=structuredClone(capabilities);mismatch[1].providerVersion="different";mismatch[1].source="different-source";
  const kept=compactCapabilityInventory(members,mismatch);
  assert.equal(kept.capabilities[1].providerVersion,"different");assert.equal(kept.capabilities[0].source,"source/tags");assert.equal(kept.capabilities[1].source,"different-source");
});

test("压缩目录按实际模型身份复用，旧完整目录回执不能造成空正文投影", async t => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-inspect-reuse-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => { await w.close(); await rm(directory, {recursive:true,force:true}); });
  const context = new EvolutionDomain(w).context();
  const first = readPlanningMaterials("inspect_application", {}, context);
  const legacy = readInvestigation("inspect_application", {}, context);
  assert.ok("ref" in first && "ref" in legacy);
  await t.test("已交付压缩目录只返回复用回执", () => {
    const seen = [first, ...first.documents ?? []].map(materialIdentity);
    const repeated = readPlanningMaterials("inspect_application", {}, context, seen);
    assert.ok("ref" in repeated);
    assert.equal(repeated.hash, first.hash);
    assert.equal(repeated.reused, true);
    assert.equal(repeated.content, null);
    assert.ok(repeated.documents?.every(document => document.reused && document.content === null));
  });
  await t.test("旧完整目录身份须交付新的压缩正文", () => {
    assert.notEqual(legacy.hash, first.hash);
    const current = readPlanningMaterials("inspect_application", {}, context, [materialIdentity(legacy)]);
    assert.ok("ref" in current);
    assert.equal(current.hash, first.hash);
    assert.deepEqual(current.content, first.content);
    assert.equal(current.reused, undefined);
  });
});
