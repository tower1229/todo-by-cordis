import test from "node:test";
import assert from "node:assert/strict";
import { compileReferences, inheritBrowserCases } from "../../src/evolution/references.js";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import type { Requirement, RequirementGate } from "../../src/shared/assistant.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";

type Field = Extract<AcceptanceObligation, { kind: "field" }>;
const sources = [
  { id: "accepted:1", text: "保存标签并保留大小写" },
  { id: "request:2", text: "新增计数，已有标签不变" },
];
const workflow = { id: "default", fields: [], actions: [{ id: "complete" }, { id: "reopen" }] };

function fixture(qualified = false) {
  const oldCases: MemberAcceptanceCase[] = [
    { member: "tags", name: "save", state: "open", fields: {}, action: "setTag", input: { tag: " Alpha " },
      expected: { kind: "commit", state: "open", fields: { tag: "Alpha" } } },
    { member: "tags", name: "overwrite", state: "open", fields: { tag: "Alpha" }, action: "setTag", input: { tag: " Beta " },
      expected: { kind: "commit", state: "open", fields: { tag: "Beta" } } },
  ];
  const field: Field = {
    version: 1, id: "accepted-tag-field", kind: "field", member: "tags", field: "tag",
    ...(qualified ? { contribution: "tag-detail" } : {}),
    initialOrigin: "host", initial: { kind: "visible", value: "（空）" },
    scenarios: oldCases.map((c, i) => ({
      id: c.name,
      steps: oldCases.slice(0, i + 1).map(previous => ({ kind: "action" as const, member: "tags", action: previous.action, input: previous.input })),
      value: c.expected.kind === "commit" ? String(c.expected.fields.tag) : "",
    })),
  };
  const accepted: Requirement = {
    id: "accepted-tags", description: sources[0].text, sourceRevision: sources[0].id, sourceQuote: sources[0].text,
    type: "behavior", checks: oldCases.map(c => ({ checker: "workspace/1", caseId: `member:${c.member}:${c.name}` })), obligations: [field],
  };
  // This fixture supplies an already accepted baseline at the reference compiler seam.
  const gate: RequirementGate = {
    gateVersion: "fixture", sources: [sources[0]], requestHash: "a".repeat(64), definitionHash: "b".repeat(64),
    review: { reviewedIds: [accepted.id], issues: [] }, coverage: [{ requirementId: accepted.id, reasons: [] }], seal: "c".repeat(64),
  };
  const inherited = {
    memberCases: oldCases, requirements: [accepted], browserCases: obligationCases(field), requirementGate: gate,
    fieldIdentities: [{ member: "tags", field: "tag", label: "标签", contribution: "tag-detail" }],
    uiContributions: [{ id: "tag-detail", providerId: "tags", fields: [{ key: "tag" }], actions: [{ commandId: "setTag" }] }],
  };
  const counter: MemberAcceptanceCase = { member: "counter", name: "increment", state: "open", fields: {}, action: "increment", input: {},
    expected: { kind: "commit", state: "open", fields: { count: "1" } } };
  const draft = {
    workflowRules: [], memberCases: [...structuredClone(oldCases), counter], browserCases: [],
    requirements: [{ id: "counter-request", source: 2, sourceQuote: sources[1].text, description: sources[1].text, type: "behavior",
      checks: [1, 2, 3].map(index => ({ kind: "member", index })), obligations: [{ kind: "backend" } as Record<string, unknown>] }],
  };
  return { draft, inherited, field };
}
const compile = (f: ReturnType<typeof fixture>) => compileReferences(f.draft, sources, [], workflow, f.inherited);

for (const qualified of [false, true])
  test(`无关成员新增沿用已接受字段的完整投影和身份，已有作用域=${qualified}`, () => {
    const f = fixture(qualified), before = structuredClone(f), result = compile(f);
    const fields = result.requirements.flatMap(r => r.obligations ?? []).filter(o => o.kind === "field");
    assert.deepEqual([...new Set(fields.map(o => o.id))], [f.field.id]);
    assert.ok(fields.every(o => o.kind === "field" && o.scenarios.length === 2), "不能按旧字段过滤规则丢弃覆盖场景");
    assert.deepEqual(result.browserCases, f.inherited.browserCases, "原已接受的保护、操作、输入和刷新重启断言逐项不变");
    const owner = result.requirements.find(r => r.id === "accepted-tags")!;
    assert.equal(owner.sourceRevision, sources[0].id);
    assert.equal(owner.sourceQuote, sources[0].text);
    assert.deepEqual(f, before, "不修改旧基线或提案");
  });

test("既有成员操作预期发生变化时，不能套用旧投影掩盖业务变化", () => {
  const f = fixture();
  f.draft.memberCases[0].expected = { kind: "commit", state: "open", fields: { tag: "changed" } };
  const fields = compile(f).requirements.flatMap(r => r.obligations ?? []).filter(o => o.kind === "field");
  assert.ok(fields.some(o => o.id === f.field.id));
  assert.ok(fields.some(o => o.id !== f.field.id), "当前不同值和旧冻结值保持不同，等待原修订及独立复核");
});

test("新显式字段预期不能被旧投影替换或自动修正", () => {
  const f = fixture();
  f.draft.requirements[0].obligations.push({ kind: "field", field: "tag", initial: { kind: "baseline" },
    scenarios: [{ steps: [{ kind: "action", action: "setTag", input: { tag: " Alpha " } }], value: "wrong" }] });
  const result = compile(f), current = result.requirements.find(r => r.id === "counter-request")!;
  const field = current.obligations!.find((o): o is Field => o.kind === "field")!;
  assert.equal(field.scenarios[0].value, "wrong");
  assert.notEqual(field.id, f.field.id);
});

test("实际界面作用域不唯一时不猜测绑定，旧冻结保护仍保留", () => {
  const f = fixture();
  f.inherited.uiContributions.push({ ...structuredClone(f.inherited.uiContributions[0]), id: "another-detail" });
  const result = compile(f), current = result.requirements.find(r => r.id === "counter-request")!;
  assert.ok(current.obligations!.every(o => o.kind !== "field"));
  assert.deepEqual(result.browserCases, f.inherited.browserCases);
});

test("未冻结的旧定义不作为已接受的规范投影", () => {
  const f = fixture();
  const { requirementGate: _gate, ...unfrozen } = f.inherited;
  const result = compileReferences(f.draft, sources, [], workflow, unfrozen);
  assert.ok(result.requirements.flatMap(r => r.obligations ?? []).every(o => o.id !== f.field.id));
});

test("已有明确但不同的界面作用域不能被唯一当前作用域替换", () => {
  const f = fixture(true);
  f.field.contribution = "another-detail";
  f.inherited.browserCases = obligationCases(f.field);
  const fields = compile(f).requirements.flatMap(r => r.obligations ?? []).filter(o => o.kind === "field");
  assert.ok(fields.some(o => o.id === f.field.id && o.kind === "field" && o.contribution === "another-detail"));
  assert.ok(fields.some(o => o.id !== f.field.id), "新旧不同作用域保持不同，不能任意合并");
});

test("浏览器案例仍限制30条，超限反馈明确指出实际数量和上限", () => {
  const cases = Array.from({ length: 31 }, (_, i) => ({ id: `case-${i}`, task: "new", steps: [{ kind: "refresh" }] }));
  assert.equal(parseBrowserCases(cases.slice(0, 30)).length, 30);
  assert.throws(() => parseBrowserCases(cases), /浏览器.*31.*30/);
});

function upgrade() {
  const f = fixture();
  f.draft.memberCases = structuredClone(f.inherited.memberCases);
  f.draft.memberCases[1].expected = { kind: "commit", state: "open", fields: { tag: "beta" } };
  f.draft.memberCases.push({ ...structuredClone(f.draft.memberCases[1]), name: "fresh-save", fields: {} });
  f.draft.requirements = [{ ...f.draft.requirements[0], id: "accepted-tags" }];
  return f;
}

test("已接受字段的隐式更新投影保留覆盖前置，额外单次保存案例不能取代两次保存", () => {
  const f = upgrade(), before = structuredClone(f), compiled = compile(f);
  const field = compiled.requirements[0].obligations!.find((o): o is Field => o.kind === "field")!;
  assert.deepEqual(field.scenarios.map(s => [s.steps.length, s.value]), [[1, "Alpha"], [2, "beta"], [1, "beta"]]);
  const result = inheritBrowserCases(compiled, f.inherited, "明确修订标签保存后的大小写");
  const oldOverwrite = f.inherited.browserCases.filter(c => c.id.includes("after-overwrite"));
  assert.equal(oldOverwrite.length, 2);
  for (const old of oldOverwrite) {
    const change = result.changes.find(c => c.rule === `浏览器案例 ${old.id}`);
    assert.ok(change, "连续操作进入显式修订，不继承过时的结果预期");
    const after = JSON.parse(change.after);
    assert.deepEqual(after.steps.filter((s: { kind: string }) => s.kind === "action"), old.steps.filter(s => s.kind === "action"));
    assert.ok(after.steps.filter((s: { kind: string }) => s.kind === "field").every((s: { value: string }) => s.value === "beta"));
    assert.equal(after.steps.filter((s: { kind: string }) => s.kind === "refresh" || s.kind === "restart").length, 2);
    assert.ok(!result.browserCases.some(c => c.id === old.id));
  }
  for (const old of f.inherited.browserCases.filter(c => c.classification === "system-protection"))
    assert.deepEqual(result.browserCases.find(c => c.id === old.id), old);
  assert.deepEqual(f, before);
});

test("隐式更新有完整操作路径仍须提供修订原因，旧冻结断言不能静默消失", () => {
  const f = upgrade(), result = inheritBrowserCases(compile(f), f.inherited, undefined);
  assert.ok(result.blockers.some(b => b.includes("after-overwrite") && b.includes("修订原因")));
  for (const old of f.inherited.browserCases.filter(c => c.id.includes("after-overwrite")))
    assert.deepEqual(result.browserCases.find(c => c.id === old.id), old);
});

test("已接受字段的隐式更新前置不可达时必须阻断，不能退回单次保存以省略覆盖", () => {
  const f = upgrade();
  f.draft.memberCases[1].fields = { tag: "unreachable" };
  f.draft.memberCases[1].action = "appendTag";
  assert.throws(() => compile(f), /前置状态.*无法|可达/);
});

test("没有冻结基线时不扩大隐式既有字段更新范围", () => {
  const f = upgrade(), { requirementGate: _gate, ...unfrozen } = f.inherited;
  const result = compileReferences(f.draft, sources, [], workflow, unfrozen);
  const field = result.requirements[0].obligations!.find((o): o is Field => o.kind === "field")!;
  assert.ok(field.scenarios.every(s => s.steps.length === 1));
});

test("有明确不同贡献作用域的冻结字段不授权当前作用域的隐式更新", () => {
  const f = upgrade();
  f.field.contribution = "another-detail";
  const field = compile(f).requirements[0].obligations!.find((o): o is Field => o.kind === "field")!;
  assert.ok(field.scenarios.every(s => s.steps.length === 1));
});

test("一个冻结字段不扩大其他已有字段的隐式更新范围", () => {
  const f = upgrade();
  f.inherited.uiContributions.push({ id: "count-detail", providerId: "counter", fields: [{ key: "count" }], actions: [{ commandId: "increment" }] });
  f.inherited.fieldIdentities.push({ member: "counter", field: "count", label: "计数", contribution: "count-detail" });
  f.draft.memberCases.push(
    { member: "counter", name: "first", state: "open", fields: {}, action: "increment", input: {}, expected: { kind: "commit", state: "open", fields: { count: "1" } } },
    { member: "counter", name: "second", state: "open", fields: { count: "1" }, action: "increment", input: {}, expected: { kind: "commit", state: "open", fields: { count: "2" } } },
  );
  f.draft.requirements[0].checks.push({ kind: "member", index: 4 }, { kind: "member", index: 5 });
  const field = compile(f).requirements[0].obligations!.find((o): o is Field => o.kind === "field" && o.member === "counter")!;
  assert.deepEqual(field.scenarios.map(s => [s.steps.length, s.value]), [[1, "1"]]);
});
