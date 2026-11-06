import test from "node:test";
import assert from "node:assert/strict";
import {
  realChainCallGrant,
  realChainCallGrantLimit,
} from "../../scripts/lib/v1-scenario.js";
import type { BudgetPause } from "../../src/shared/evolution-interaction.js";

const observedPause = (): BudgetPause => ({
  revision: 1,
  resource: "calls",
  resume: "plan",
  phase: "plan",
  minimum: { calls: 2, candidates: 0, milliseconds: 0 },
  suggested: { calls: 6, candidates: 0, milliseconds: 0 },
  message:
    "预算不足：剩余调用无法容纳完整需求复核与候选执行，保留原预算并停止规划",
});

test("真实六步链只追加暂停单的最小调用，不用建议值 6", () => {
  const grant = realChainCallGrant(observedPause(), 0);
  assert.deepEqual(grant, { calls: 2, candidates: 0, milliseconds: 0 });
  assert.equal(realChainCallGrant(observedPause(), realChainCallGrantLimit - 1)?.calls, 2);
  assert.equal(realChainCallGrant(observedPause(), realChainCallGrantLimit), undefined);
});

test("时间或候选暂停不从这条调用追加路径放行", () => {
  const time = observedPause();
  time.resource = "milliseconds";
  time.minimum = { calls: 0, candidates: 0, milliseconds: 128000 };
  assert.equal(realChainCallGrant(time, 0), undefined);
  const candidates = observedPause();
  candidates.resource = "candidates";
  candidates.minimum = { calls: 0, candidates: 1, milliseconds: 0 };
  assert.equal(realChainCallGrant(candidates, 0), undefined);
});
