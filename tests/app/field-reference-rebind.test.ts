import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compileReferences } from "../../src/evolution/references.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";

type Args = Parameters<typeof compileReferences>;
type Frame = {
  draft: Args[0] & {
    requirements: { id: string; checks?: {kind:string;index?:number}[]; obligations: {
      kind: string; initial?: { kind: string; value?: string };
      scenarios?: { steps: unknown[]; value: string }[];
    }[] }[];
    memberCases: MemberAcceptanceCase[];
  };
  sources: Args[1]; workflowCases: Args[2]; workflow: Args[3];
  inherited: NonNullable<Args[4]>;
};
type Field = Extract<AcceptanceObligation, { kind: "field" }>;
const fixture = () => JSON.parse(readFileSync(
  new URL("../fixtures/field-reference-rebind-replay.json", import.meta.url), "utf8",
)) as Frame;
const compile = (f: Frame) => compileReferences(
  structuredClone(f.draft), f.sources, f.workflowCases, f.workflow, f.inherited,
);
function priorField(f: Frame) {
  const field = f.inherited.requirements!.flatMap(r => r.obligations ?? [])
    .find((o): o is Field => o.kind === "field" && !!o.derivation);
  assert.ok(field);
  return field;
}
function reboundField(f: Frame) {
  const owner = f.inherited.requirements!.find(r => r.obligations?.some(o => o.id === priorField(f).id))!;
  const result = compile(f);
  const inherited = result.requirements.find(r => r.id === owner.id)!;
  assert.ok(inherited);
  const field = inherited.obligations!.find((o): o is Field => o.kind === "field" && o.field === "tags");
  assert.ok(field);
  return { owner, inherited, field, result };
}

test("真实提案投影：派生字段按唯一字段身份重新绑定，保留宿主 ID、来源和派生标记", () => {
  const f = fixture(), before = structuredClone(f), old = priorField(f);
  const { owner, inherited, field, result } = reboundField(f);
  assert.equal(field.id, old.id);
  assert.deepEqual(field.derivation, old.derivation);
  assert.equal(inherited.sourceRevision, owner.sourceRevision);
  assert.equal(inherited.sourceQuote, owner.sourceQuote);
  assert.equal(field.scenarios[0].value, "alpha project");
  assert.deepEqual(field.scenarios[0].steps, old.scenarios[0].steps);
  const authoritative = result.requirements.find(r => r.id === f.draft.requirements[0].id)!;
  assert.equal(authoritative.sourceRevision, f.sources[2].id);
  const declared = authoritative.obligations!.find((o): o is Field => o.kind === "field")!;
  assert.equal(declared.id, field.id, "完全等价的字段投影共用稳定身份，来源仍由各自要求保存");
  assert.equal(result.browserCases.length,4,"同一字段投影不重复生成相同浏览器案例");
  assert.deepEqual(f, before, "不改写旧基线或原提案");
});

test("身份重新绑定保留原历史准备，不能丢弃旧任务验收", () => {
  const f = fixture();
  const history = { baseVersion: "a".repeat(64), actions: [{ kind: "action" as const, member: "tags", action: "setTags", input: { tags: "  Alpha Project  " } }], expected: { state: "open", fields: { tags: "Alpha Project" } }, sourceHash: "b".repeat(64) };
  priorField(f).history = history;
  assert.deepEqual(reboundField(f).field.history, history);
});

test("后续无关规划重编译既有投影时，案例和义务身份保持稳定",()=>{
  const first=compile(fixture()), f=fixture();
  f.inherited.requirements=structuredClone(first.requirements);
  f.draft.requirements=[];
  const next=compile(f);
  assert.deepEqual(next.requirements,first.requirements);
  assert.deepEqual(next.browserCases,first.browserCases);
});

test("重新绑定不解释业务原文或修正错误值，独立语义复核仍有责任", () => {
  const f = fixture();
  f.draft.requirements[0].obligations[0].scenarios![0].value = "MiXeD";
  const {field,result}=reboundField(f);
  assert.equal(field.scenarios[0].value, "MiXeD");
  const declared=result.requirements[0].obligations!.find((o):o is Field=>o.kind==='field')!;
  assert.notEqual(declared.id,field.id,"与后端投影不同的声明不能冒充同一规范义务");
});

test("显式初始值不会被宿主默认投影覆盖或合并",()=>{
  const f=fixture();
  f.draft.requirements[0].obligations[0].initial={kind:'visible',value:'显式初始值'};
  const {field,result}=reboundField(f);
  const declared=result.requirements[0].obligations!.find((o):o is Field=>o.kind==='field')!;
  assert.equal(declared.initial.kind,'visible');
  assert.deepEqual(declared.initial,{kind:'visible',value:'显式初始值'});
  assert.notEqual(declared.id,field.id);
});

test("其他显式字段义务不会被派生字段重新绑定覆盖", () => {
  const f = fixture();
  const protectedField: Field = { version: 1, id: "accepted-count", kind: "field", member: "counter", field: "count", initialOrigin: "requirement", initial: { kind: "visible", value: "0" }, scenarios: [{ id: "increment", steps: [{ kind: "action", member: "counter", action: "increment", input: {} }], value: "1" }] };
  f.inherited.requirements![0].obligations!.push(protectedField);
  assert.deepEqual(reboundField(f).inherited.obligations!.find(o => o.id === protectedField.id), protectedField);
});

test("重新生成派生案例时同步更新其引用，其他冻结浏览器引用保持原样",()=>{
  const f=fixture(), old=priorField(f), owner=f.inherited.requirements![0];
  const generated=obligationCases(old).map(c=>({checker:'browser/1',caseId:c.id}));
  const unrelated={checker:'browser/1',caseId:'unrelated-frozen-case'};
  owner.checks.push(...generated,unrelated);
  const {inherited,field,result}=reboundField(f);
  const current=new Set(result.browserCases.map(c=>c.id));
  assert.ok(inherited.checks.some(c=>c.caseId===unrelated.caseId));
  assert.ok(inherited.checks.filter(c=>c.checker==='browser/1'&&c.caseId!==unrelated.caseId).every(c=>current.has(c.caseId)));
  for(const c of obligationCases(field))assert.ok(inherited.checks.some(ref=>ref.checker==='browser/1'&&ref.caseId===c.id));
});

test("没有显式规范义务时，原宿主派生身份仍按原路径重新生成", () => {
  const f = fixture();
  f.draft.requirements[0].obligations = [{ kind: "backend" }];
  f.draft.requirements[0].checks = [{kind:"member",index:1}];
  const field = reboundField(f).field;
  assert.equal(field.id, priorField(f).id);
  assert.deepEqual(field.derivation, priorField(f).derivation);
});

test("原字段再无可推导的成功动作时保持阻断", () => {
  const f = fixture();
  f.draft.memberCases[0].expected = { kind: "reject" };
  assert.throws(() => compile(f), /既有字段的宿主派生义务无法重新绑定/);
});

for (const [name, change] of [
  ["成员", (field: Field) => { field.member = "another-member"; }],
  ["界面作用域", (field: Field) => { field.contribution = "another-detail"; }],
] as const) test(`不同${name}不能以相同字段键重新绑定`, () => {
  const f = fixture(); change(priorField(f));
  assert.throws(() => compile(f), /既有字段的宿主派生义务无法重新绑定/);
});

test("当前有多个同身份规范义务时不能任意选取", () => {
  const f = fixture(), duplicate = structuredClone(f.draft.requirements[0]);
  duplicate.id = "another-current-requirement";
  duplicate.obligations[0].initial = { kind: "visible", value: "（空）" };
  f.draft.requirements.push(duplicate);
  assert.throws(() => compile(f), /既有字段的宿主派生义务无法重新绑定/);
});

test("两个旧派生身份不能不经修订合并为一个", () => {
  const f = fixture(), duplicate = structuredClone(priorField(f));
  duplicate.id = "another-accepted-derived-field";
  f.inherited.requirements![0].obligations!.push(duplicate);
  assert.throws(() => compile(f), /既有字段的宿主派生义务无法重新绑定/);
});

