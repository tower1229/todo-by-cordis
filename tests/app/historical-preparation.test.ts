import test from "node:test";
import assert from "node:assert/strict";
import {
  historicalPreparation,
  HistoricalPreparationBlocked,
} from "../../src/evolution/historical-preparation.js";
import { compileReferences } from "../../src/evolution/references.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import {
  coverage,
  parseBrowserCases,
  parseRequirements,
  freezeRequirements,
  gateFailure,
} from "../../src/server/requirement-coverage.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";
import { panelMemberCases } from "./member-case-fixtures.js";
import { hash } from "../../src/release/storage.js";
import { businessExpectationsSchema as obligationsSchema } from "../../src/evolution/plan-input.js";
import { compileSpec } from "../../src/evolution/specification.js";
import { schemaProblems } from "../../src/evolution/model-protocol.js";

const target = { member: "panel", field: "noteMark" };
const base = "a".repeat(64);
const workflow = {
  id: "default",
  actions: [{ id: "complete" }, { id: "reopen" }],
};
const sources = [
  { id: "run:1", text: "历史标记保留，新动作写reviewed，详情刷新重启保持" },
];
const legacy = { kind: "history", field: "noteMark" };
const display = {
  kind: "field",
  field: "noteMark",
  initial: { kind: "baseline" },
  scenarios: [
    {
      steps: [{ kind: "action", action: "markNote", input: {} }],
      value: "reviewed",
    },
  ],
};
const req = (id: string, obligations: unknown[]) => ({
  id,
  source: 1,
  sourceQuote: sources[0].text,
  description: sources[0].text,
  type: "interface",
  checks: [],
  obligations,
});
function compile(browserCases: unknown[] = []) {
  return compileReferences(
    {
      workflowRules: [],
      memberCases: panelMemberCases.map((c) =>
        c.expected.kind === "commit"
          ? {
              ...c,
              expected: { ...c.expected, fields: { noteMark: "reviewed" } },
            }
          : c,
      ),
      browserCases,
      requirements: [req("legacy", [legacy]), req("display", [display])],
    },
    sources,
    [],
    workflow,
    { memberCases: panelMemberCases, baseVersion: base },
  );
}
const plan = (c: ReturnType<typeof compile>) =>
  ({
    ...c,
    workflowRules: [],
    cases: [],
    memberCases: [],
    requirements: parseRequirements(c.requirements),
    browserCases: parseBrowserCases(c.browserCases),
  }) as InvestigatedPlan;

test("宿主推导多步真实动作，忽略不可达注入、拒绝案例及目录顺序", () => {
  const prepare: MemberAcceptanceCase = {
    name: "准备",
    member: "panel",
    state: "open",
    fields: {},
    action: "prepare",
    input: {},
    expected: { kind: "commit", state: "open", fields: { stage: "seed" } },
  };
  const mark: MemberAcceptanceCase = {
    ...panelMemberCases[0],
    fields: { stage: "seed" },
    expected: {
      kind: "commit",
      state: "open",
      fields: { stage: "seed", noteMark: "ok" },
    },
  };
  const injected: MemberAcceptanceCase = {
    ...mark,
    name: "不可达",
    fields: { noteMark: "injected" },
    expected: { kind: "commit", state: "open", fields: { noteMark: "wrong" } },
  };
  const catalog = [mark, injected, prepare, panelMemberCases[1]];
  const h = historicalPreparation(target, catalog, base);
  assert.deepEqual(
    h.actions.map((a) => a.action),
    ["prepare", "markNote"],
  );
  assert.deepEqual(h.expected, {
    state: "open",
    fields: { stage: "seed", noteMark: "ok" },
  });
  assert.equal(h.sourceHash, hash([prepare, mark]));
  assert.deepEqual(
    h,
    historicalPreparation(target, catalog.toReversed(), base),
  );
});

test("无路径、字段所有者不符、循环、矛盾成功结果和多历史状态都明确阻塞", () => {
  const other = { ...panelMemberCases[0], member: "other" };
  const cycle: MemberAcceptanceCase = {
    ...panelMemberCases[0],
    expected: { kind: "commit", state: "open", fields: {} },
  };
  const opposite: MemberAcceptanceCase = {
    ...panelMemberCases[0],
    name: "冲突",
    expected: {
      kind: "commit",
      state: "open",
      fields: { noteMark: "different" },
    },
  };
  for (const catalog of [
    [],
    [panelMemberCases[1]],
    [other],
    [cycle],
    [panelMemberCases[0], opposite],
    [panelMemberCases[0], { ...opposite, action: "another" }],
  ])
    assert.throws(
      () => historicalPreparation(target, catalog, base),
      HistoricalPreparationBlocked,
    );
  assert.throws(
    () => historicalPreparation(target, panelMemberCases, ""),
    /精确基础版本/,
  );
});

test("已接受历史准备保持原精确版本、动作、旧值及摘要，不随下一次升级改写", () => {
  const c = compile();
  const old = c.requirements[0].obligations[0];
  assert.equal(old.kind, "history");
  const updated = panelMemberCases.map((c) =>
    c.expected.kind === "commit"
      ? { ...c, expected: { ...c.expected, fields: { noteMark: "reviewed" } } }
      : c,
  );
  const receipt = historicalPreparation(target, updated, "b".repeat(64), [old]);
  if (old.kind !== "history") return;
  assert.deepEqual(receipt, old.history);
  receipt.expected.fields.noteMark = "tampered";
  assert.equal(old.history.expected.fields.noteMark, "ok");
});

test("历史期望自动绑定补充案例；新任务初始值与已有任务动作矩阵分别验证", () => {
  const c = compile([
    {
      id: "old",
      task: "existing",
      steps: [
        { kind: "field", field: "noteMark", value: "ok" },
        { kind: "refresh" },
        { kind: "field", field: "noteMark", value: "ok" },
      ],
    },
  ]);
  const supplemental = c.browserCases[0];
  assert.equal(supplemental.prepare?.expected.fields.noteMark, "ok");
  const field = c.requirements[1].obligations[0];
  const matrix = c.browserCases.filter((c) => c.obligationId === field.id);
  assert.ok(
    matrix.filter((c) => c.id.includes("initial-")).every((c) => !c.prepare),
  );
  assert.ok(
    matrix
      .filter((c) => c.id.includes("after-") && c.task === "existing")
      .every((c) => c.prepare?.expected.fields.noteMark === "ok"),
  );
  assert.ok(
    matrix
      .filter((c) => c.id.includes("after-") && c.task === "new")
      .every((c) => !c.prepare),
  );
  assert.deepEqual(
    coverage(plan(c), sources, ["browser/1"]).flatMap((c) => c.reasons),
    [],
  );
});

test("删准备、伪造摘要、更换旧值、冒充新任务或调换义务身份均不能通过覆盖门禁", () => {
  const original = plan(compile());
  for (const change of [
    (c: NonNullable<InvestigatedPlan["browserCases"]>[number]) => {
      delete c.prepare;
    },
    (c: NonNullable<InvestigatedPlan["browserCases"]>[number]) => {
      c.prepare!.sourceHash = "f".repeat(64);
    },
    (c: NonNullable<InvestigatedPlan["browserCases"]>[number]) => {
      c.prepare!.expected.fields.noteMark = "reviewed";
    },
    (c: NonNullable<InvestigatedPlan["browserCases"]>[number]) => {
      c.task = "new";
    },
    (c: NonNullable<InvestigatedPlan["browserCases"]>[number]) => {
      c.obligationId = "unrelated";
    },
  ]) {
    const p = structuredClone(original);
    const c = p.browserCases!.find((c) =>
      c.obligationId?.startsWith("history-"),
    )!;
    change(c);
    assert.ok(
      coverage(p, sources, ["browser/1"]).some((r) => r.reasons.length),
    );
  }
});

test("模型契约只允许声明历史字段，不再接受准备动作、候选值或宿主元数据", () => {
  assert.deepEqual(schemaProblems([legacy], obligationsSchema), []);
  for (const extra of [
    { history: { actions: [{ action: "markNote", input: {} }] } },
    { sourceHash: base },
    { baseVersion: base },
    { expected: { fields: { noteMark: "reviewed" } } },
  ]) {
    const obligation = { ...legacy, ...extra };
    assert.ok(schemaProblems([obligation], obligationsSchema).length);
    assert.throws(
      () =>
        compileReferences(
          {
            memberCases: panelMemberCases,
            requirements: [req("bad", [obligation])],
          },
          sources,
          [],
          workflow,
          { memberCases: panelMemberCases, baseVersion: base },
        ),
      /派生字段/,
    );
  }
});

test("同步替换义务与案例的旧值仍不能绕过原冻结身份检查", () => {
  const p = {
    ...plan(compile()),
    id: "frozen-history",
    requestRevision: 1,
    baseVersion: base,
    compositionRevision: 1,
    binding: {
      guideCatalog: {},
      materials: [],
      capabilities: [],
      checkers: [{ id: "browser/1", version: "fixture" }],
    },
  };
  p.changeSpec = compileSpec(p, "run", hash("base"));
  p.requirementGate = freezeRequirements(
    p,
    sources,
    "request",
    { reviewedIds: p.requirements!.map((r) => r.id), issues: [] },
    ["browser/1"],
  );
  const trusted = structuredClone(p.requirementGate);
  assert.equal(gateFailure(p, trusted, "request"), undefined);
  for (const r of p.requirements!)
    for (const o of r.obligations ?? [])
      if ((o.kind === "history" || o.kind === "field") && o.history)
        o.history.expected.fields.noteMark = "reviewed";
  for (const c of p.browserCases!) {
    if (c.prepare) c.prepare.expected.fields.noteMark = "reviewed";
    for (const s of c.steps)
      if (s.kind === "field" && s.value === "ok") s.value = "reviewed";
  }
  p.changeSpec = compileSpec(p, "run", hash("base"));
  assert.deepEqual(
    coverage(p, sources, ["browser/1"]).flatMap((r) => r.reasons),
    [],
  );
  assert.match(gateFailure(p, trusted, "request")!, /冻结需求/);
});
