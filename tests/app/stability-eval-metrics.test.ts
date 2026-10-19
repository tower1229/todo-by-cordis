import test from "node:test";
import assert from "node:assert/strict";
import {
  computeStabilityMetrics,
  classifyFailure,
  failureFromEvidence,
  runIncidents,
  type ScenarioRunRecord,
} from "../../scripts/lib/stability-eval/metrics.js";

const base = (
  partial: Partial<ScenarioRunRecord> & Pick<ScenarioRunRecord, "scenarioId">,
): ScenarioRunRecord => ({
  evidenceKind: "model-stub",
  expectedOutcomeClass: "full-path-success",
  observedOutcomeClass: "full-path-success",
  capabilitySelectionCorrect: true,
  errorBlockingCorrect: null,
  firstPlanPassed: true,
  firstCandidatePassed: true,
  fullPathSucceeded: true,
  repairedInOriginalBudget: false,
  durationMs: 1000,
  usage: { promptTokens: 10, completionTokens: 5 },
  failureClass: null,
  ...partial,
});

test("当前失败按调用证据定位阶段；未知原因不因出现宿主或资料文字而归类", () => {
  assert.deepEqual(failureFromEvidence({ calls: [] }), {
    classification: "unknown",
    phase: "unknown",
    code: "unresolved",
    evidence: [],
  });
  const failure = failureFromEvidence({
    calls: [
      {
        phase: "review",
        status: "failed",
        transport: { failure: { kind: "timeout", elapsedMs: 100, causes: [] } },
      },
    ],
  });
  assert.equal(failure.classification, "transport");
  assert.equal(failure.phase, "review");
  assert.equal(failure.code, "transport:timeout");
  assert.deepEqual(failure.evidence, ["model-call:1"]);
});

test("最终等待回答不被已经恢复的协议错误覆盖；事件与终因分开", () => {
  const failure = failureFromEvidence({
    calls: [{ phase: "admission", status: "returned" }, { phase: "review", status: "returned" }, { phase: "review", status: "returned" }],
    protocolFailures: [{ phase: "review", call: 2 }],
    run: { status: "awaiting-input", stop: { kind: "clarification", phase: "admission", code: "business-answer-required", evidence: ["run.question", "run.clarificationReviews"] } },
  });
  assert.equal(failure.classification, "unknown");
  assert.equal(failure.code, "business-answer-required");
  assert.deepEqual(failure.evidence, ["run.question", "run.clarificationReviews"]);
});

test("活动时间耗尽、未收敛协议与不完整归档按宿主最终事实归因", () => {
  const calls = [{ phase: "generation", status: "returned" }];
  const budget = { status: "failed", stop: { kind: "budget" as const, phase: "execution", code: "active-time-budget", evidence: ["run.budget"] } };
  assert.equal(failureFromEvidence({ calls, run: budget }).code, "active-time-budget");
  assert.equal(failureFromEvidence({ calls, run: budget, archiveComplete: false }).classification, "evaluator");
  assert.equal(failureFromEvidence({ calls, protocolFailures: [{ phase: "generation", call: 1 }], run: { status: "blocked", stop: { kind: "protocol", phase: "generation", code: "invalid-model-protocol", evidence: ["model-call:1"] } } }).classification, "tool-protocol");
  assert.equal(failureFromEvidence({ calls, protocolFailures: [{ phase: "generation", call: 1 }], run: { status: "awaiting-input" } }).code, "business-answer-required", "旧记录亦按最终状态解释，不能将历史事件冒充终因");
});

test("HTTP已返回不代表协议已恢复，只有同阶段后续有效响应才计为恢复事件", () => {
  const calls = [{phase:"review",status:"returned"},{phase:"review",status:"returned"}];
  assert.deepEqual(runIncidents(calls,[{phase:"review",call:1},{phase:"review",call:2}]).map(i=>i.recovered),[false,false]);
  assert.deepEqual(runIncidents([...calls,{phase:"review",status:"returned"}],[{phase:"review",call:1},{phase:"review",call:2}]).map(i=>i.recovered),[true,true]);
  assert.equal(failureFromEvidence({calls,protocolFailures:[{phase:"review",call:1}]}).classification,"unknown");
});

test("指标列出分母并区分能力选择、错误阻塞、首个计划/候选、完整路径与预算内纠错", () => {
  const metrics = computeStabilityMetrics([
    base({ scenarioId: "tags-add" }),
    base({
      scenarioId: "counter-add",
      firstCandidatePassed: false,
      repairedInOriginalBudget: true,
      fullPathSucceeded: true,
    }),
    base({
      scenarioId: "due-auto-expire",
      expectedOutcomeClass: "current-blocker",
      observedOutcomeClass: "current-blocker",
      capabilitySelectionCorrect: false,
      errorBlockingCorrect: true,
      firstPlanPassed: false,
      firstCandidatePassed: null,
      fullPathSucceeded: false,
      failureClass: "documentation-gap",
    }),
    base({
      scenarioId: "missing-capability-push",
      expectedOutcomeClass: "accurate-block",
      observedOutcomeClass: "accurate-block",
      capabilitySelectionCorrect: true,
      errorBlockingCorrect: true,
      firstPlanPassed: false,
      firstCandidatePassed: null,
      fullPathSucceeded: false,
      failureClass: null,
    }),
    base({
      scenarioId: "transport-fail",
      expectedOutcomeClass: "full-path-success",
      observedOutcomeClass: "failed",
      capabilitySelectionCorrect: null,
      errorBlockingCorrect: null,
      firstPlanPassed: null,
      firstCandidatePassed: null,
      fullPathSucceeded: false,
      failureClass: "transport",
      usage: null,
    }),
  ]);

  assert.equal(metrics.capabilitySelectionAccuracy.numerator, 3);
  assert.equal(metrics.capabilitySelectionAccuracy.denominator, 4);
  assert.equal(metrics.errorBlockingAccuracy.numerator, 2);
  assert.equal(metrics.errorBlockingAccuracy.denominator, 2);
  assert.equal(metrics.firstPlanPassRate.numerator, 2);
  assert.equal(metrics.firstPlanPassRate.denominator, 4);
  assert.equal(metrics.firstCandidatePassRate.numerator, 1);
  assert.equal(metrics.firstCandidatePassRate.denominator, 2);
  assert.equal(metrics.fullPathSuccessRate.numerator, 2);
  assert.equal(metrics.fullPathSuccessRate.denominator, 5);
  assert.equal(metrics.inBudgetRepairRate.numerator, 1);
  assert.equal(metrics.inBudgetRepairRate.denominator, 1);
  assert.equal(metrics.durationMs.total, 5000);
  assert.equal(metrics.costUsage.promptTokens, 40);
  assert.equal(metrics.costUsage.completionTokens, 20);
  assert.deepEqual(metrics.failureClassCounts, {
    "model-understanding-or-generation": 0,
    "documentation-gap": 1,
    "host-defect": 0,
    "tool-protocol": 0,
    transport: 1,
    evaluator: 0,
    unknown: 0,
  });
});

test("恢复浏览器的耗时不能混入完整场景耗时统计", () => {
  const metrics = computeStabilityMetrics([
    base({ scenarioId: "fresh" }),
    base({
      scenarioId: "recovered",
      durationScope: "recovery-only",
      durationMs: 123,
      fullPathSucceeded: false,
      recoveredBrowserSucceeded: true,
      observedOutcomeClass: "failed",
      failureClass: "evaluator",
    }),
  ]);
  assert.deepEqual(metrics.durationMs, { total: 1000, samples: 1 });
  assert.equal(metrics.fullPathSuccessRate.numerator, 1);
  assert.equal(metrics.failureClassCounts.evaluator, 1);
});

test("无法唯一定位注册 UI 时归类评估器错误", () => {
  assert.equal(
    classifyFailure({
      message: "locator.click: strict mode violation: resolved to 2 elements",
    }),
    "evaluator",
  );
  assert.equal(
    classifyFailure({ message: "locator.click: Timeout 30000ms exceeded" }),
    "evaluator",
  );
});

test("读取工具参数错误归类工具协议，不冒充业务生成失败", () => {
  for (const message of [
    "读取源码参数无效",
    "读取契约参数无效",
    "INVALID_CURRENT_SOURCE_READ",
    "INVALID_CONTRACT_READ",
  ])
    assert.equal(classifyFailure({ message }), "tool-protocol");
});

test("正向成功与正确阻塞分开计分，错误阻塞和错误放行不能抵消", () => {
  const metrics = computeStabilityMetrics([
    base({ scenarioId: "supported-pass", evidenceComplete: true }),
    base({
      scenarioId: "supported-block",
      evidenceComplete: true,
      observedOutcomeClass: "accurate-block",
      fullPathSucceeded: false,
    }),
    base({
      scenarioId: "boundary-pass",
      evidenceComplete: true,
      expectedOutcomeClass: "accurate-block",
      observedOutcomeClass: "accurate-block",
      fullPathSucceeded: false,
      errorBlockingCorrect: true,
    }),
    base({
      scenarioId: "boundary-false-accept",
      evidenceComplete: true,
      expectedOutcomeClass: "accurate-block",
      candidatePassed: true,
    }),
    base({
      scenarioId: "transport",
      observedOutcomeClass: "failed",
      fullPathSucceeded: false,
      failureClass: "transport",
      usage: null,
    }),
  ]);
  assert.deepEqual(metrics.positiveSuccessRate, {
    numerator: 1,
    denominator: 3,
    rate: 1 / 3,
  });
  assert.deepEqual(metrics.correctBlockingRate, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
  });
  assert.deepEqual(metrics.falseBlockingRate, {
    numerator: 1,
    denominator: 3,
    rate: 1 / 3,
  });
  assert.deepEqual(metrics.falseAcceptanceRate, {
    numerator: 1,
    denominator: 2,
    rate: 0.5,
  });
});
