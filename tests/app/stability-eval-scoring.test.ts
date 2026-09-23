import test from "node:test";
import assert from "node:assert/strict";
import {
  STABILITY_EVAL_MANIFEST,
  type StabilityScenario,
} from "../../scripts/lib/stability-eval/manifest.js";
import { scoreCapabilityAndBlocking } from "../../scripts/lib/stability-eval/scoring.js";
import { assertRealModelAuthorization } from "../../scripts/lib/stability-eval/authorization.js";

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
    message: "环境依赖不可用：uninstalled-notifier",
    plan: {
      summary: "可选提醒",
      unresolved: ["环境依赖不可用：uninstalled-notifier 暂不可用"],
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
    () => assertRealModelAuthorization(["node", "accept-stability-baseline.ts"]),
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
