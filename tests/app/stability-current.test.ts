import test from "node:test";
import assert from "node:assert/strict";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";
import {
  freezeManifest,
  assertManifestFrozen,
} from "../../scripts/lib/stability-eval/manifest.js";

test("当前版本清单绑定产品、max策略、原预算及24个预注册运行，原文与独立判定同时冻结", () => {
  const current = currentManifest("609f8122fd0dc164932bcc31cebb70cfcd49c704");
  const frozen = freezeManifest(current);
  assert.equal(frozen.scenarios.length, 8);
  assert.equal(frozen.runs.independentRunsPerScenario, 3);
  assert.equal(
    frozen.scenarios.filter(
      (s) => s.expectedOutcomeClass === "full-path-success",
    ).length,
    6,
  );
  assert.deepEqual(frozen.budget, {
    calls: 12,
    candidates: 3,
    milliseconds: 600000,
  });
  assert.equal(frozen.model.outputPolicies?.review.reasoningEffort, "max");
  assert.equal(frozen.model.outputPolicies?.review.maxTokens, 131072);
  assert(frozen.scenarios.every((s) => s.oracle));
  for (const scenario of frozen.scenarios)
    assert(
      scenario.oracle!.sources.every((q) =>
        [scenario.request, scenario.clarification?.answer ?? ""].some((s) =>
          s.includes(q),
        ),
      ),
    );
  current.scenarios[0].request = "事后改写";
  assertManifestFrozen(frozen);
  const tampered = structuredClone(frozen);
  tampered.scenarios[0].oracle!.sources = [];
  assert.throws(() => assertManifestFrozen(tampered), /contentHash/);
});

test("缺少独立判定、无原文引用或放大预算的当前清单不能冻结后运行", () => {
  const original = currentManifest("a".repeat(40));
  for (const changed of [
    { ...original, budget: { ...original.budget, calls: 13 } },
    {
      ...original,
      scenarios: original.scenarios.map((s, i) =>
        i ? s : { ...s, oracle: undefined },
      ),
    },
    {
      ...original,
      scenarios: original.scenarios.map((s, i) =>
        i
          ? s
          : { ...s, oracle: { ...s.oracle!, sources: ["需求未提到的限制"] } },
      ),
    },
  ])
    assert.throws(
      () => assertManifestFrozen(freezeManifest(changed)),
      /当前|原文|预算|独立/,
    );
});

test("新批次预先确定计时业务边界，历史批次身份不能被覆盖", () => {
  const next = currentManifest("a".repeat(40));
  assert.equal(next.evaluation, "current/2");
  const due = next.scenarios.find(s => s.id === "due-auto-expire")!;
  for (const clause of ["修改或清除截止时清除原过期标记", "允许设置过去时间", "已经过期再完成时保留过期标记", "重新打开时截止已过则自动标记过期"])
    assert(due.request.includes(clause), clause);
  assert(due.oracle?.kind === "due" && due.oracle.lifecyclePolicy === "reset-on-edit-preserve-on-complete");
  assert(!next.scenarios.find(s => s.id === "counter-add")!.request.includes("显示0"), "初始逻辑值不补造成界面要求");
});
