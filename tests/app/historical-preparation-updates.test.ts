import test from "node:test";
import assert from "node:assert/strict";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import { hash } from "../../src/release/storage.js";
import {
  historicalPreparation,
  HistoricalPreparationBlocked,
} from "../../src/evolution/historical-preparation.js";
import { compileReferences } from "../../src/evolution/references.js";

const target = { member: "panel", field: "noteMark" };
const baseVersion = "a".repeat(64);
const create: MemberAcceptanceCase = {
  name: "首次建立标记",
  member: "panel",
  state: "open",
  fields: {},
  action: "setMark",
  input: { value: "first" },
  expected: { kind: "commit", state: "open", fields: { noteMark: "first" } },
};
const update: MemberAcceptanceCase = {
  name: "更新已有标记",
  member: "panel",
  state: "open",
  fields: { noteMark: "first" },
  action: "setMark",
  input: { value: "updated" },
  expected: { kind: "commit", state: "open", fields: { noteMark: "updated" } },
};

test("已有字段的合法更新不制造第二个历史初建状态", () => {
  const baseline = [create, update];
  const before = structuredClone(baseline);
  const preparation = historicalPreparation(target, baseline, baseVersion);
  assert.deepEqual(preparation, {
    baseVersion,
    sourceHash: hash([create]),
    actions: [
      {
        kind: "action",
        member: "panel",
        action: "setMark",
        input: create.input,
      },
    ],
    expected: { state: "open", fields: { noteMark: "first" } },
  });
  assert.deepEqual(
    historicalPreparation(target, baseline.toReversed(), baseVersion),
    preparation,
  );
  assert.deepEqual(baseline, before);
});

test("字段建立后保留原值并更新其他字段也不改变历史来源", () => {
  const retain: MemberAcceptanceCase = {
    ...update,
    action: "retainMark",
    expected: {
      kind: "commit",
      state: "open",
      fields: { noteMark: "first", other: "kept" },
    },
  };
  const preparation = historicalPreparation(
    target,
    [create, retain],
    baseVersion,
  );
  assert.equal(preparation.sourceHash, hash([create]));
  assert.deepEqual(preparation.expected.fields, { noteMark: "first" });
});

test("两个独立可达的字段初建结果降级为最短路径，顺序无关", () => {
  // #54：与 historical-preparation.test 同裁决——多历史取最短路径，不阻塞。
  const another: MemberAcceptanceCase = { ...update, fields: {} };
  const baseline1 = [create, update, another];
  const baseline2 = [another, update, create];
  const h1 = historicalPreparation(target, baseline1, baseVersion);
  const h2 = historicalPreparation(target, baseline2, baseVersion);
  // Both should pick shortest path (1 action)
  assert.equal(h1.actions.length, 1);
  assert.equal(h2.actions.length, 1);
  // Results should be deterministic (same hash regardless of input order)
  assert.equal(h1.sourceHash, h2.sourceHash);
});

test("找到历史初建状态后仍检查后续冻结转换矛盾", () => {
  const contradiction: MemberAcceptanceCase = {
    ...update,
    name: "同一输入的相反结果",
    expected: {
      kind: "commit",
      state: "open",
      fields: { noteMark: "opposite" },
    },
  };
  assert.throws(
    () =>
      historicalPreparation(
        target,
        [create, update, contradiction],
        baseVersion,
      ),
    /同一动作的冻结成功期望不唯一/,
  );
});

test("原生引用编译保留全部冻结更新案例并绑定精确历史准备", () => {
  const text = "保留已有标记及其他行为。";
  const baseline = [create, update];
  const before = structuredClone(baseline);
  const compiled = compileReferences(
    {
      workflowRules: [],
      memberCases: baseline,
      browserCases: [],
      requirements: [
        {
          id: "keep-mark",
          source: 1,
          sourceQuote: text,
          description: text,
          type: "behavior",
          checks: [],
          obligations: [{ kind: "history", field: "noteMark" }],
        },
      ],
    },
    [{ id: "run:1", text }],
    [],
    { id: "default", actions: [{ id: "complete" }, { id: "reopen" }] },
    { memberCases: baseline, baseVersion },
  );
  assert.deepEqual(baseline, before);
  const obligation = compiled.requirements[0].obligations.find(
    (o) => o.kind === "history",
  );
  assert.equal(obligation?.kind, "history");
  if (obligation?.kind !== "history") throw new Error("缺少历史义务");
  assert.equal(obligation.history.sourceHash, hash([create]));
  assert.deepEqual(obligation.history.expected.fields, { noteMark: "first" });
  assert.ok(
    compiled.browserCases.some((c) => c.prepare?.sourceHash === hash([create])),
  );
});
