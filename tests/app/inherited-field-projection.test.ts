import test from "node:test";
import assert from "node:assert/strict";
import { compileReferences, inheritBrowserCases } from "../../src/evolution/references.js";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import type { Requirement, RequirementGate } from "../../src/shared/assistant.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import { hash } from "../../src/release/storage.js";

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

for (const qualified of [false, true])
  test(`复制已接受字段的隐式投影保留派生来源，作用域=${qualified}`, () => {
    const f = fixture(qualified), before = structuredClone(f), result = compile(f);
    const owner = result.requirements.find(r => r.id === "accepted-tags")!;
    const projection = result.requirements.find(r => r.id === "counter-request")!
      .obligations!.find((o): o is Field => o.kind === "field")!;
    assert.deepEqual(projection.derivation, { checker: "workspace/1" });
    assert.equal(projection.id, f.field.id);
    assert.deepEqual(projection.scenarios, f.field.scenarios);
    assert.deepEqual(owner.obligations, [f.field], "原明确业务定义仍保持独立权威");
    assert.deepEqual(f, before);
  });

function projectedUpgrade(qualified: boolean) {
  const f = fixture(qualified);
  const first = compileReferences({ ...f.draft, requirements: [
    ...f.draft.requirements,
    { ...f.draft.requirements[0], id: "counter-preserve", sourceQuote: "已有标签不变", description: "已有标签不变" },
  ] }, sources, [], workflow, f.inherited);
  const inherited = { ...f.inherited, memberCases: f.draft.memberCases,
    requirements: first.requirements, browserCases: first.browserCases };
  const memberCases = structuredClone(inherited.memberCases);
  memberCases[1].expected = { kind: "commit", state: "open", fields: { tag: "beta" } };
  const draft = { ...f.draft, memberCases, requirements: [{ id: "accepted-tags", source: 3,
    sourceQuote: "保存标签统一小写，保留计数", description: "保存标签统一小写，保留计数", type: "behavior",
    checks: f.draft.requirements[0].checks, obligations: [
      { kind: "backend" } as Record<string, unknown>,
      { kind: "field", field: "tag", initial: { kind: "baseline" }, scenarios: [
        { steps: [{ kind: "action", action: "setTag", input: { tag: " Alpha " } }], value: "Alpha" },
        { steps: [{ kind: "action", action: "setTag", input: { tag: " Alpha " } }, { kind: "action", action: "setTag", input: { tag: " Beta " } }], value: "beta" },
      ] },
    ] }] };
  const nextSources = [...sources, { id: "request:3", text: "保存标签统一小写，保留计数" }];
  return { f, inherited, draft, nextSources };
}

for (const qualified of [false, true])
  test(`仅修订业务所有者即可刷新其他要求的派生字段，作用域=${qualified}`, () => {
    const p = projectedUpgrade(qualified), before = structuredClone(p);
    const result = compileReferences(p.draft, p.nextSources, [], workflow, p.inherited);
    const fields = result.requirements.flatMap(r => r.obligations ?? []).filter(o => o.kind === "field" && o.member === "tags");
    assert.deepEqual([...new Set(fields.map(o => o.id))], [p.f.field.id], "同一字段不因旧作用域产生重复案例");
    const preserved = result.requirements.find(r => r.id === "counter-request")!;
    const old = p.inherited.requirements.find(r => r.id === preserved.id)!;
    assert.equal(preserved.sourceQuote, old.sourceQuote);
    assert.equal(preserved.sourceRevision, old.sourceRevision);
    const field = preserved.obligations!.find((o): o is Field => o.kind === "field" && o.member === "tags")!;
    assert.deepEqual(field.scenarios.map(s => [s.steps.length, s.value]), [[1, "Alpha"], [2, "beta"]]);
    assert.equal(field.id, p.f.field.id);
    assert.equal(field.contribution, p.f.field.contribution);
    assert.deepEqual(field.derivation, { checker: "workspace/1" });
    const browsers = inheritBrowserCases(result, p.inherited, "按新要求修订标签保存结果");
    assert.deepEqual(browsers.blockers, []);
    for (const oldCase of p.inherited.browserCases.filter(c => c.classification === "system-protection"))
      assert.deepEqual(browsers.browserCases.find(c => c.id === oldCase.id), oldCase);
    assert.ok(browsers.changes.some(c => c.before.includes('Beta') && c.after.includes('beta')));
    assert.deepEqual(p, before);
  });

test("旧冻结字段副本没有派生来源时仍须显式修订，不能猜测降级为投影", () => {
  const p = projectedUpgrade(false);
  const old = p.inherited.requirements.find(r => r.id === "counter-request")!;
  for (const o of old.obligations ?? []) if (o.kind === "field") delete o.derivation;
  const before = structuredClone(p);
  assert.throws(() => compileReferences(p.draft, p.nextSources, [], workflow, p.inherited), /同一字段.*冲突/);
  assert.deepEqual(p, before);
});

test("遗漏原明确业务所有者的修订时，不能以其他要求的派生投影替代它", () => {
  const p = projectedUpgrade(true);
  p.draft.requirements[0].id = "new-tag-request";
  assert.throws(() => compileReferences(p.draft, p.nextSources, [], workflow, p.inherited), /同一字段.*冲突/);
});

test("派生副本具有不同明确作用域时，不能借无作用域兼容规则重新绑定", () => {
  const p = projectedUpgrade(false);
  const old = p.inherited.requirements.find(r => r.id === "counter-request")!;
  for (const o of old.obligations ?? []) if (o.kind === "field") o.contribution = "another-detail";
  assert.throws(() => compileReferences(p.draft, p.nextSources, [], workflow, p.inherited), /无法重新绑定/);
});

test("派生新场景缩短操作路径时，旧连续操作断言及修订原因门禁仍保留", () => {
  const p = projectedUpgrade(false);
  const field = p.draft.requirements[0].obligations[1] as { scenarios: { steps: unknown[]; value: string }[] };
  field.scenarios[1].steps.shift();
  const result = compileReferences(p.draft, p.nextSources, [], workflow, p.inherited);
  const browsers = inheritBrowserCases(result, p.inherited, undefined);
  for (const old of p.inherited.browserCases.filter(c => c.id.includes("after-overwrite")))
    assert.deepEqual(browsers.browserCases.find(c => c.id === old.id), old);
  const unchanged = projectedUpgrade(false);
  const replacement = compileReferences(unchanged.draft, unchanged.nextSources, [], workflow, unchanged.inherited);
  const missingReason = inheritBrowserCases(replacement, unchanged.inherited, undefined);
  assert.ok(missingReason.blockers.some(b => b.includes("after-overwrite") && b.includes("修订原因")));
});

test("继承和新生成的 browserCases 按内容去重，防止累积超过 30 条上限", () => {
  // Regression test for phase-3 planning-gate failure: browserCases 34 > 30.
  // When multiple phases inherit and generate obligations for the same fields,
  // obligationCases can produce browser cases with identical content but different obligation IDs.
  // Without deduplication, this accumulates beyond the 30-case limit.
  const f = fixture();
  const baseCases = f.inherited.browserCases;
  // Duplicate the inherited cases with different IDs to simulate accumulation across phases (6 copies each)
  const duplicated = baseCases.flatMap((c, i) => 
    Array.from({ length: 6 }, (_, copy) => 
      copy === 0 ? c : { ...structuredClone(c), id: `dup${copy}-${i}-${c.id}` }
    )
  );
  // Each duplicate has the same content (steps, member, field, value) but a different ID
  assert.ok(duplicated.length > 30, `Test setup should create > 30 cases: got ${duplicated.length}`);
  f.inherited.browserCases = duplicated;
  // compileReferences should deduplicate by content hash, keeping only unique cases
  const result = compile(f);
  assert.ok(result.browserCases.length <= 30, `browserCases should be deduplicated: got ${result.browserCases.length}, max 30`);
  // Verify all deduplicated cases are unique by content
  const hashes = new Set(result.browserCases.map(c => hash(c)));
  assert.equal(hashes.size, result.browserCases.length, "All deduplicated browserCases should be unique by content");
  // parseBrowserCases should accept the deduplicated result
  assert.doesNotThrow(() => parseBrowserCases(result.browserCases));
  // Verify that the first occurrence (by ID) is preserved
  for (const original of baseCases) {
    assert.ok(result.browserCases.some(c => c.id === original.id), `Original case ID ${original.id} should be preserved`);
  }
  assertNoDanglingBrowserChecks(result);
});

test("停用成员后多继承投影仍不超 30 案例上限（beca405 round-7 disable-tags 路径）", () => {
  // Regression for bounded-probe-beca405 33>30 failure on disable-tags request.
  // When a member (tags) is disabled but its frozen field obligations are inherited by other
  // requirements (counter-preserve), obligationCases generates new cases with different
  // obligation IDs. These accumulate with system-protection and other inherited cases.
  // Strong content-hash dedupe must prevent this from exceeding 30.
  const f = fixture(true);
  const firstCompile = compileReferences({ ...f.draft, requirements: [
    ...f.draft.requirements,
    { ...f.draft.requirements[0], id: "counter-preserve", sourceQuote: "已有标签不变", description: "已有标签不变" },
  ] }, sources, [], workflow, f.inherited);
  
  // Simulate multi-phase with more inherited requirements projecting the same field
  const inherited = { 
    ...f.inherited, 
    memberCases: firstCompile.memberCases ?? f.draft.memberCases,
    requirements: firstCompile.requirements, 
    browserCases: firstCompile.browserCases,
  };
  
  // Add more requirements that will inherit and project the tags field
  const multiInherit = { 
    ...f.draft, 
    memberCases: inherited.memberCases,
    requirements: [
      { id: "req-1", source: 1, sourceQuote: "需求1", description: "需求1", type: "behavior",
        checks: [{ kind: "member", index: 1 }], 
        obligations: [{ kind: "backend" } as Record<string, unknown>] },
      { id: "req-2", source: 1, sourceQuote: "需求2", description: "需求2", type: "behavior",
        checks: [{ kind: "member", index: 2 }],
        obligations: [{ kind: "backend" } as Record<string, unknown>] },
      { id: "req-3", source: 1, sourceQuote: "需求3", description: "需求3", type: "behavior",
        checks: [{ kind: "member", index: 3 }],
        obligations: [{ kind: "backend" } as Record<string, unknown>] },
    ]
  };
  
  const result = compileReferences(multiInherit, sources, [], workflow, inherited);
  
  assert.ok(result.browserCases.length <= 30, 
    `browserCases 在多成员继承路径应≤30，实际 ${result.browserCases.length}`);
  
  // Verify content uniqueness after dedupe
  const contentHashes = new Set(result.browserCases.map(c => 
    hash({ task: c.task, steps: c.steps, prepare: c.prepare, classification: c.classification })
  ));
  assert.equal(contentHashes.size, result.browserCases.length, 
    "所有去重后的案例内容应唯一");
  
  // Should not throw on parseBrowserCases
  assert.doesNotThrow(() => parseBrowserCases(result.browserCases));
  assertNoDanglingBrowserChecks(result);
});

function assertNoDanglingBrowserChecks(result: {
  requirements: { id: string; checks: { checker: string; caseId: string }[]; obligations?: AcceptanceObligation[] }[];
  browserCases: { id: string }[];
}) {
  const dangling = result.requirements.flatMap((r) =>
    r.checks
      .filter(
        (c) =>
          c.checker === "browser/1" &&
          !result.browserCases.some((b) => b.id === c.caseId),
      )
      .map((c) => `${r.id}:${c.caseId}`),
  );
  assert.deepEqual(dangling, [], `悬空案例引用: ${dangling.join(",")}`);
  const missingGenerated = result.requirements.flatMap((r) =>
    (r.obligations ?? []).flatMap((o) =>
      obligationCases(o)
        .filter((c) => !result.browserCases.some((b) => b.id === c.id))
        .map((c) => `${r.id}:${o.kind}:${c.id}`),
    ),
  );
  assert.deepEqual(
    missingGenerated,
    [],
    `义务生成案例缺失: ${missingGenerated.join(",")}`,
  );
}

test("同一字段身份的派生副本不能另起 after-action ID，去重后检查仍指向存活案例", () => {
  const f = fixture();
  const first = compile(f);
  const owner = first.requirements.find((r) => r.id === "accepted-tags");
  assert.ok(owner);
  const field = owner.obligations?.find((o) => o.kind === "field");
  assert.ok(field && field.kind === "field");
  const derivedReq = {
    ...structuredClone(owner),
    id: "derived-copy",
    obligations: [
      { ...structuredClone(field), derivation: { checker: "workspace/1" as const } },
    ],
  };
  const result = compileReferences(
    f.draft,
    sources,
    [],
    workflow,
    {
      ...f.inherited,
      requirements: [...first.requirements, derivedReq],
      browserCases: first.browserCases,
    },
  );
  assertNoDanglingBrowserChecks(result);
  const afterIds = (cases: { id: string }[]) =>
    [...new Set(cases.filter((c) => c.id.startsWith(`${f.field.id}-after-`)).map((c) => c.id))].sort();
  assert.deepEqual(
    afterIds(result.browserCases),
    afterIds(first.browserCases),
    "派生副本不得另编一套 after-action 案例 ID",
  );
  assert.ok(result.browserCases.length <= 30);
  assert.doesNotThrow(() => parseBrowserCases(result.browserCases));
});
