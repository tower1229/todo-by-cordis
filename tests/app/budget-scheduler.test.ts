import test from "node:test";
import assert from "node:assert/strict";
import {
  BudgetScheduler,
  BudgetExhaustedError,
} from "../../src/evolution/budget.js";
import { evolutionBudget } from "../../src/server/evolution-budget.js";

test("正式入口的资源策略由宿主配置，默认宽时间且不能通过模型改候选上限", () => {
  assert.deepEqual(evolutionBudget({}),{calls:12,candidates:3,milliseconds:1800000});
  assert.deepEqual(evolutionBudget({EVOLUTION_MAX_CALLS:"24",EVOLUTION_ACTIVE_MINUTES:"45"}),{calls:24,candidates:3,milliseconds:2700000});
  for(const value of ["0","-1","NaN","1.5",""])
    assert.throws(()=>evolutionBudget({EVOLUTION_ACTIVE_MINUTES:value}),/活动时间/);
  assert.throws(()=>evolutionBudget({EVOLUTION_MAX_CALLS:"Infinity"}),/调用/);
});

test("还有调用额度也不能在验收时间已不足时发起新付费规划请求", () => {
  const scheduler = new BudgetScheduler({
    calls: 12,
    candidates: 3,
    milliseconds: 600000,
  });
  assert.throws(
    () => scheduler.admit(6, "planning", 900),
    (error) =>
      error instanceof BudgetExhaustedError &&
      error.resource === "milliseconds",
  );
  assert.equal(scheduler.ready(6, 20000), false);
});

test("各阶段预留同一时间池，澄清和开始门禁准确区分时间与调用不足", () => {
  const scheduler = new BudgetScheduler({
    calls: 12,
    candidates: 3,
    milliseconds: 600000,
  });
  assert.equal(scheduler.modelWindow("planning", 600000), 375000);
  assert.equal(scheduler.modelWindow("review", 300000), 165000);
  assert.equal(scheduler.modelWindow("generation", 180000), 135000);
  assert.throws(
    () => scheduler.requireClarification(3, false, 200000),
    (e) => e instanceof BudgetExhaustedError && e.resource === "milliseconds",
  );
  assert.throws(
    () => scheduler.requireReady(7, 20000),
    (e) => e instanceof BudgetExhaustedError && e.resource === "milliseconds",
  );
  assert.throws(
    () => scheduler.requireReady(10, 600000),
    (e) => e instanceof BudgetExhaustedError && e.resource === "calls",
  );
  assert.equal(scheduler.limits.milliseconds, 600000);
});
