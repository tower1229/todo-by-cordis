import test from "node:test";
import assert from "node:assert/strict";
import {
  STABILITY_EVAL_MANIFEST,
  freezeManifest,
  assertManifestFrozen,
} from "../../scripts/lib/stability-eval/manifest.js";
import { postchangeManifest } from "../../scripts/lib/stability-eval/postchange.js";

test("#46 后测沿用基线需求与预算，只预先改变截止时间成功标准", () => {
  const commit = "a".repeat(40);
  const post = postchangeManifest(commit);
  assert.equal(post.issue, 46);
  assert.equal(post.productCommit, commit);
  assert.deepEqual(post.model, STABILITY_EVAL_MANIFEST.model);
  assert.deepEqual(post.budget, STABILITY_EVAL_MANIFEST.budget);
  assert.deepEqual(post.runs, STABILITY_EVAL_MANIFEST.runs);
  assert.deepEqual(post.retry, STABILITY_EVAL_MANIFEST.retry);
  assert.deepEqual(post.scoring, STABILITY_EVAL_MANIFEST.scoring);
  assert.deepEqual(
    post.scenarios.map((scenario) => scenario.request),
    STABILITY_EVAL_MANIFEST.scenarios.map((scenario) => scenario.request),
  );
  const due = post.scenarios.find(
    (scenario) => scenario.id === "due-auto-expire",
  );
  assert.equal(due?.expectedOutcomeClass, "full-path-success");
  assert.equal(due?.requiresExperience, true);
  assert.equal(due?.requiresApply, true);
  assert.equal(
    STABILITY_EVAL_MANIFEST.scenarios.find(
      (scenario) => scenario.id === "due-auto-expire",
    )?.expectedOutcomeClass,
    "current-blocker",
  );
  assertManifestFrozen(freezeManifest(post));
  assert.throws(() => postchangeManifest("HEAD"), /固定/);
});
