import test from "node:test";
import assert from "node:assert/strict";
import {
  STABILITY_EVAL_MANIFEST,
  type StabilityScenario,
} from "../../scripts/lib/stability-eval/manifest.js";
import { observeOutcome, scoreCapabilityAndBlocking } from "../../scripts/lib/stability-eval/scoring.js";
import { assertRealModelAuthorization } from "../../scripts/lib/stability-eval/authorization.js";
import { postchangeManifest } from "../../scripts/lib/stability-eval/postchange.js";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";

test("独立阻塞判定缺失或失败时，终态 blocked 不得被标为准确阻塞", () => {
  const boundary = currentManifest("a".repeat(40)).scenarios.find(
    (s) => s.id === "unsupported-blank-presentation",
  )!;
  for (const proof of [undefined, false]) {
    const observed = observeOutcome(boundary, "blocked-observed", "blocked", proof);
    assert.equal(
      observed,
      "failed",
    );
    const score = scoreCapabilityAndBlocking({
      scenario: boundary,
      observedOutcomeClass: observed,
      reachedReadyOnFirstPlan: false,
      blockedWithoutReady: true,
    });
    assert.equal(score.firstPlanPassed, false);
  }
  assert.equal(
    observeOutcome(boundary, "blocked-observed", "blocked", true),
    "accurate-block",
  );
  for (const blockedWithoutReady of [true, false]) {
    assert.equal(scoreCapabilityAndBlocking({
      scenario: boundary,
      observedOutcomeClass: observeOutcome(boundary, "blocked-observed", "blocked", true),
      reachedReadyOnFirstPlan: false,
      blockedWithoutReady,
    }).firstPlanPassed, blockedWithoutReady);
  }
  assert.equal(
    observeOutcome(boundary, "failed", "blocked", true),
    "failed",
  );
  assert.equal(
    observeOutcome({ ...boundary, expectedOutcomeClass: "full-path-success" },
      "blocked-observed", "blocked", true),
    "failed",
  );
});

const scenario = (id: string): StabilityScenario => {
  const found = STABILITY_EVAL_MANIFEST.scenarios.find((s) => s.id === id);
  assert.ok(found, id);
  return found;
};

test("能力选择与 outcome 解耦：outcome 命中但 provider 错误时 accuracy 为 false", () => {
  const scored = scoreCapabilityAndBlocking({
    scenario: scenario("tags-add"),
    observedOutcomeClass: "full-path-success",
    plan: {
      summary: "看起来成功",
      capabilityChanges: [
        {
          capability: "command.register",
          provider: "member:counter",
          change: "错选计数",
        },
      ],
    },
    reachedReadyOnFirstPlan: true,
    blockedWithoutReady: false,
  });
  assert.equal(scored.capabilitySelectionCorrect, false);
  assert.equal(scored.firstPlanPassed, true);
});

test("准确阻塞计分看 blockReason/依赖文案，而非仅 observed===expected", () => {
  const ok = scoreCapabilityAndBlocking({
    scenario: scenario("temporarily-unavailable-dependency"),
    observedOutcomeClass: "accurate-block",
    blockReason: "investigation",
    message: "环境依赖不可用：@types/node",
    plan: {
      summary: "可选提醒",
      unresolved: ["环境依赖不可用：@types/node 暂不可用"],
      capabilityChanges: [
        {
          capability: "workflow",
          provider: "active-source",
          change: "仅记录",
        },
      ],
    },
    reachedReadyOnFirstPlan: false,
    blockedWithoutReady: true,
  });
  assert.equal(ok.capabilitySelectionCorrect, true);
  assert.equal(ok.errorBlockingCorrect, true);
  assert.equal(ok.firstPlanPassed, true);

  const wrong = scoreCapabilityAndBlocking({
    scenario: scenario("temporarily-unavailable-dependency"),
    observedOutcomeClass: "accurate-block",
    blockReason: "other",
    message: "笼统失败",
    plan: { summary: "无相关说明", capabilityChanges: [] },
    reachedReadyOnFirstPlan: false,
    blockedWithoutReady: true,
  });
  assert.equal(wrong.errorBlockingCorrect, false);
  assert.equal(wrong.firstPlanPassed, false);
});

test("缺失推送阻塞要求 maintainer-capability 或推送相关文案", () => {
  const scored = scoreCapabilityAndBlocking({
    scenario: scenario("missing-capability-push"),
    observedOutcomeClass: "accurate-block",
    blockReason: "maintainer-capability",
    message: "外部推送尚不可用",
    plan: {
      unresolved: ["因不能真实调用外部 IO 及通知交付"],
      capabilityChanges: [
        {
          capability: "notification-delivery",
          provider: "business/notify.ts",
          change: "缺失",
        },
      ],
    },
    reachedReadyOnFirstPlan: false,
    blockedWithoutReady: true,
  });
  assert.equal(scored.capabilitySelectionCorrect, true);
  assert.equal(scored.errorBlockingCorrect, true);
});

test("无 --authorize-real-model 时拒绝真模型意图", () => {
  assert.throws(
    () =>
      assertRealModelAuthorization(["node", "accept-stability-baseline.ts"]),
    /显式授权|authorize-real-model/,
  );
  assert.doesNotThrow(() =>
    assertRealModelAuthorization([
      "node",
      "accept-stability-baseline.ts",
      "--authorize-real-model",
    ]),
  );
});

test("#46 截止时间计划须选择宿主调度和成员业务注册，且成功路径不按阻塞计分", () => {
  const due = postchangeManifest("a".repeat(40)).scenarios.find(
    (item) => item.id === "due-auto-expire",
  );
  assert.ok(due);
  const score = (providers: string[], hostRuntime = true) =>
    scoreCapabilityAndBlocking({
      scenario: due,
      observedOutcomeClass: "full-path-success",
      plan: {
        requiredCapabilities: hostRuntime
          ? [
              {
                interfaceId: "schedule.runtime",
                providerId: "host:online-scheduler",
              },
            ]
          : [],
        capabilityChanges: providers.map((provider) => ({
          provider,
          capability: "schedule.register",
          change: "按截止执行",
        })),
      },
      reachedReadyOnFirstPlan: true,
      blockedWithoutReady: false,
    });
  assert.equal(score([]).capabilitySelectionCorrect, false);
  assert.equal(score(["member:due"], false).capabilitySelectionCorrect, false);
  const correct = score(["member:due"]);
  assert.equal(correct.capabilitySelectionCorrect, true);
  assert.equal(correct.errorBlockingCorrect, null);
  assert.equal(correct.firstPlanPassed, true);
});
