import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BudgetScheduler } from "../../src/evolution/budget.js";
import { InvestigationStore } from "../../src/evolution/investigation.js";
import { recordReview } from "../../src/evolution/review.js";
import {
  assembleCandidate,
  deltaBasis,
  candidateDifference,
} from "../../src/evolution/candidate-delta.js";
import {
  compileSpec,
  specificationFailure,
} from "../../src/evolution/specification.js";
import type {
  InvestigatedPlan,
  RequirementReview,
} from "../../src/shared/assistant.js";
import type {
  InvestigationState,
  ReviewLedger,
} from "../../src/shared/change-spec.js";
import { hash } from "../../src/release/storage.js";

const plan = () =>
  ({
    id: "p",
    requestRevision: 1,
    baseVersion: "base",
    compositionRevision: 1,
    requirements: [],
    browserCases: [],
    workflowRules: [],
    cases: [],
    writableScope: ["business/view.ts"],
    evidence: [],
    summary: "展示备注",
    changes: ["展示字段"],
    outcome: "显示备注",
    dataImpact: "保留字段",
    excluded: [],
    compatibility: "保留其他行为",
    steps: [],
    dependencies: [],
  }) as unknown as InvestigatedPlan;

test("宿主预算为执行保留3次调用，规划及复核共享原12次上限", () => {
  const scheduler = new BudgetScheduler({
    calls: 12,
    candidates: 3,
    milliseconds: 600000,
  });
  scheduler.admit(7, "planning");
  assert.throws(() => scheduler.admit(8, "planning"), /预算不足/);
  scheduler.admit(8, "review");
  assert.throws(() => scheduler.admit(9, "review"), /预算不足/);
  assert.equal(scheduler.ready(9), true);
  assert.equal(scheduler.ready(10), false);
  assert.equal(scheduler.canClarify(7), true);
  assert.equal(scheduler.canClarify(8), false);
  scheduler.admit(11, "generation");
  assert.throws(() => scheduler.admit(12, "generation"), /调用上限/);
});

test("统一规格拒绝投影替换，材料与模型历史独立并校验实际内容", () => {
  const p = plan();
  p.changeSpec = compileSpec(p, "run", hash("base"));
  assert.equal(specificationFailure(p), undefined);
  p.cases.push({
    checker: "workflow/1",
    given: "a",
    when: "b",
    then: "changed",
  });
  assert.match(specificationFailure(p)!, /冻结需求/);
  const db = new DatabaseSync(":memory:");
  try {
    const store = new InvestigationStore(db);
    const state: InvestigationState = {
      version: 2,
      baseVersion: "base",
      materials: [],
      deliveries: [],
    };
    const doc = { ref: "source", hash: hash("content"), content: "content" };
    store.capture(state, [doc]);
    assert.equal(state.deliveries.length, 0);
    assert.deepEqual(store.documents(state, [doc]), [doc]);
    assert.deepEqual(
      store.documents(state, [{ ref: "source", hash: hash("changed") }]),
      [],
    );
    store.delivered(state, "planning", 4, [doc]);
    assert.equal(state.deliveries[0].call, 4);
    assert.throws(
      () => store.capture(state, [{ ...doc, content: null }]),
      /摘要无效/,
    );
  } finally {
    db.close();
  }
});

const issue = (
  stance: "required" | "forbidden",
): RequirementReview["issues"][number] => ({
  kind: "extra-constraint",
  sourceRevision: "run:1",
  sourceQuote: "可编辑",
  detail: "状态限制",
  target: { subject: "note.edit", aspect: "availability" },
  stance,
});
test("复核相反立场阻塞，空issues不抹除历史，仅新澄清与有引用的消解可解除冲突", () => {
  const ledger: ReviewLedger = { version: 2, findings: [], attempts: [] };
  recordReview(
    ledger,
    { reviewedIds: [], issues: [issue("required")] },
    1,
    "spec-a",
  );
  assert.equal(
    recordReview(
      ledger,
      { reviewedIds: [], issues: [issue("forbidden")] },
      1,
      "spec-b",
    ).halt,
    true,
  );
  assert.ok(
    recordReview(ledger, { reviewedIds: [], issues: [] }, 1, "spec-b").blockers
      .length,
  );
  const resolutions = ledger.findings.map((f) => ({
    issueId: f.id,
    sourceRevision: "run:2",
    sourceQuote: "所有状态可编辑",
    reason: "用户消解歧义",
  }));
  assert.ok(
    recordReview(
      ledger,
      { reviewedIds: [], issues: [], resolutions },
      1,
      "spec-b",
    ).blockers.length,
  );
  assert.deepEqual(
    recordReview(
      ledger,
      { reviewedIds: [], issues: [], resolutions },
      2,
      "spec-c",
    ).blockers,
    [],
  );
});
test("同一复核问题改写说明仍无新证据，停止重复规划", () => {
  const ledger: ReviewLedger = { version: 2, findings: [], attempts: [] };
  recordReview(
    ledger,
    { reviewedIds: [], issues: [issue("required")] },
    1,
    "same",
  );
  const repeated = { ...issue("required"), detail: "换一种说法" };
  assert.equal(
    recordReview(ledger, { reviewedIds: [], issues: [repeated] }, 1, "same")
      .halt,
    true,
  );
});

test("规格变化更新同一稳定问题，消解不会遗留重复ID；新澄清后已消解的旧立场不再冲突", () => {
  const ledger: ReviewLedger = { version: 2, findings: [], attempts: [] };
  recordReview(
    ledger,
    { reviewedIds: [], issues: [issue("required")] },
    1,
    "a",
  );
  const id = ledger.findings[0].id;
  recordReview(
    ledger,
    { reviewedIds: [], issues: [issue("required")] },
    1,
    "b",
  );
  assert.equal(ledger.findings.length, 1);
  assert.equal(ledger.findings[0].id, id);
  assert.equal(ledger.findings[0].definitionHash, "b");
  assert.equal(ledger.attempts.length, 2);
  const resolutions = [
    {
      issueId: id,
      sourceRevision: "run:2",
      sourceQuote: "所有状态可编辑",
      reason: "新的业务澄清",
    },
  ];
  assert.deepEqual(
    recordReview(ledger, { reviewedIds: [], issues: [], resolutions }, 2, "c")
      .blockers,
    [],
  );
  assert.equal(
    recordReview(
      ledger,
      { reviewedIds: [], issues: [issue("forbidden")] },
      2,
      "d",
    ).halt,
    false,
  );
  assert.equal(ledger.findings[0].status, "resolved");
});

test("宿主选取当前修正基线并计算摘要；模型不能伪造控制身份或旧摘要", () => {
  const baseline = JSON.stringify({
    files: [
      { path: "business/entry.ts", content: "main" },
      { path: "business/view.ts", content: "old" },
    ],
  });
  const p = plan();
  p.changeSpec = compileSpec(p, "run", hash(baseline));
  p.requirementGate = { seal: "seal" } as InvestigatedPlan["requirementGate"];
  const delta = {
    files: [{ path: "business/view.ts", content: "bad" }],
    members: [],
  };
  const first = assembleCandidate(delta, p, baseline);
  const second = assembleCandidate(
    { files: [{ path: "business/view.ts", content: "good" }], members: [] },
    p,
    baseline,
    { id: "failed", source: first },
  );
  const receipt = candidateDifference(p, baseline, first);
  assert.equal(hash(receipt), hash(JSON.parse(JSON.stringify(receipt))));
  assert.equal(
    candidateDifference(p, baseline, second, { id: "failed", source: first })
      .parentCandidateId,
    "failed",
  );
  assert.deepEqual(deltaBasis(second).files, [
    { path: "business/entry.ts", hash: hash("main") },
    { path: "business/view.ts", hash: hash("good") },
  ]);
  for (const control of [
    "baseVersion",
    "baseHash",
    "requirementSeal",
    "parentCandidateId",
  ])
    assert.throws(
      () => assembleCandidate({ ...delta, [control]: "forged" }, p, baseline),
      /控制参数/,
    );
  assert.throws(
    () =>
      assembleCandidate(
        { files: [{ ...delta.files[0], before: "forged" }], members: [] },
        p,
        baseline,
      ),
    /身份/,
  );
  assert.throws(
    () => assembleCandidate(delta, p, "changed baseline"),
    /摘要不匹配/,
  );
  assert.throws(
    () =>
      assembleCandidate(
        { files: [{ path: "src/server/app.ts", content: "x" }], members: [] },
        p,
        baseline,
      ),
    /冻结范围/,
  );
});

test("单一字段定义生成宿主视图，原字段断言仍可拒绝错误 describe；派生文件不能由模型覆盖", () => {
  const baseline = "baseline";
  const p = plan();
  p.writableScope = [
    "business/entry.ts",
    "business/view.ts",
    "business/config.json",
    "business/compatibility.json",
  ];
  p.workflowRules = [
    {
      key: "review",
      label: "复盘",
      required: true,
      minLength: 1,
      maxLength: 100,
    },
  ];
  p.changeSpec = compileSpec(p, "run", hash(baseline), {
    id: "default",
    name: "Todo",
    version: "1",
    initialState: "open",
    states: {
      open: { label: "未完成", category: "open" },
      done: { label: "完成", category: "done" },
    },
    actions: [],
    fields: [],
  });
  p.requirementGate = { seal: "seal" } as InvestigatedPlan["requirementGate"];
  const source = assembleCandidate(
    {
      files: [{ path: "business/entry.ts", content: "business" }],
      members: [],
    },
    p,
    baseline,
  );
  const files = JSON.parse(source).files as { path: string; content: string }[];
  assert.deepEqual(p.changeSpec.workflowDefinition!.fields, [
    { key: "review", label: "复盘", type: "text", required: true },
  ]);
  assert.match(
    files.find((f) => f.path === "business/view.ts")!.content,
    /"fields":\["review"\]/,
  );
  assert.equal(
    files.find((f) => f.path === "business/compatibility.json")!.content,
    '{"preserveUnknownFields":true}',
  );
  assert.throws(
    () =>
      assembleCandidate(
        {
          files: [{ path: "business/view.ts", content: "forged" }],
          members: [],
        },
        p,
        baseline,
      ),
    /派生产物/,
  );
});
