import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  STABILITY_EVAL_MANIFEST,
  freezeManifest,
  assertManifestFrozen,
  manifestContentHash,
} from "../../scripts/lib/stability-eval/manifest.js";

test("冻结清单覆盖标签、计数、截止时间、成员升级、规则修订、确实缺失与暂不可用", () => {
  const ids = STABILITY_EVAL_MANIFEST.scenarios.map((s) => s.id).sort();
  assert.deepEqual(ids, [
    "counter-add",
    "due-auto-expire",
    "member-upgrade-tags",
    "missing-capability-push",
    "rule-revision-reflection",
    "tags-add",
    "temporarily-unavailable-dependency",
  ]);
  for (const scenario of STABILITY_EVAL_MANIFEST.scenarios) {
    assert.ok(scenario.request.trim().length > 0, scenario.id);
    assert.ok(scenario.expectedOutcomeClass, scenario.id);
  }
  const due = STABILITY_EVAL_MANIFEST.scenarios.find(
    (s) => s.id === "due-auto-expire",
  );
  assert.equal(due?.expectedOutcomeClass, "current-blocker");
  assert.match(due?.request ?? "", /截止|到期|过期/);
});

test("运行前冻结后不得改动清单正文、预算、评分或重试规则", () => {
  const frozen = freezeManifest(STABILITY_EVAL_MANIFEST);
  assert.equal(frozen.frozen, true);
  assert.equal(frozen.sourceCommit, STABILITY_EVAL_MANIFEST.sourceCommit);
  assert.equal(
    frozen.contentHash,
    manifestContentHash(STABILITY_EVAL_MANIFEST),
  );
  assertManifestFrozen(frozen);

  const tampered = {
    ...frozen,
    scenarios: frozen.scenarios.map((s) =>
      s.id === "tags-add" ? { ...s, request: "事后改写的成功标准" } : s,
    ),
  };
  assert.throws(() => assertManifestFrozen(tampered), /选择性修改|contentHash/);
});

test("清单绑定固定产品提交且外部重试次数为零", () => {
  assert.match(STABILITY_EVAL_MANIFEST.productCommit, /^[0-9a-f]{40}$/);
  assert.equal(
    STABILITY_EVAL_MANIFEST.productCommit,
    STABILITY_EVAL_MANIFEST.sourceCommit,
  );
  assert.equal(STABILITY_EVAL_MANIFEST.retry.externalRetries, 0);
  assert.equal(STABILITY_EVAL_MANIFEST.retry.resetBudgetOnFailure, false);
  assert.equal(STABILITY_EVAL_MANIFEST.runs.independentRunsPerScenario, 1);
  assert.equal(STABILITY_EVAL_MANIFEST.budget.calls, 12);
  assert.equal(STABILITY_EVAL_MANIFEST.budget.candidates, 3);
  assert.ok(STABILITY_EVAL_MANIFEST.scoring.metrics.length >= 6);
  const digest = createHash("sha256")
    .update(JSON.stringify(STABILITY_EVAL_MANIFEST.scenarios))
    .digest("hex");
  assert.equal(digest.length, 64);
  const temp = STABILITY_EVAL_MANIFEST.scenarios.find(
    (s) => s.id === "temporarily-unavailable-dependency",
  );
  assert.ok(temp);
  assert.doesNotMatch(temp.scoringNote, /合成环境注入/);
  assert.match(temp.scoringNote, /dependencies|environment|依赖/);
});
