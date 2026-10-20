import test from "node:test";
import assert from "node:assert/strict";
import { extendedTimeManifest } from "../../scripts/lib/stability-eval/resources.js";
import { freezeManifest } from "../../scripts/lib/stability-eval/manifest.js";
import {
  freezeResponsibilityExperiment,
  assertResponsibilityExperiment,
  selectResponsibilityTrial,
  observeResponsibility,
} from "../../scripts/lib/stability-eval/responsibility.js";
import { hash } from "../../src/release/storage.js";
import { Workspace } from "../../src/server/workspace.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CandidateAttempt } from "../../src/shared/assistant.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";

test("职责实验预注册8场景各3对，配对相邻且先后顺序平衡，两组共享同一业务与预算定义", () => {
  const manifest = freezeManifest(
    extendedTimeManifest("a".repeat(40)),
    "2030-01-01T00:00:00.000Z",
  );
  const experiment = freezeResponsibilityExperiment(
    manifest,
    "owner-test",
    "2030-01-01T00:00:00.000Z",
  );
  assertResponsibilityExperiment(experiment);
  assert.equal(experiment.trials.length, 48);
  assert.deepEqual(experiment.arms, ["model", "host"]);
  assert.deepEqual(experiment.manifest, manifest);
  assert.deepEqual(experiment.manifest.budget, {
    calls: 12,
    candidates: 3,
    milliseconds: 1_800_000,
  });
  assert.equal(new Set(experiment.trials.map((t) => t.trialId)).size, 48);
  for (const scenario of manifest.scenarios) {
    const trials = experiment.trials.filter(
      (t) => t.scenarioId === scenario.id,
    );
    assert.equal(trials.length, 6);
    for (const owner of ["model", "host"])
      assert.equal(trials.filter((t) => t.owner === owner).length, 3);
    const first = trials.filter(
      (t) => t.position === 1 && t.owner === "model",
    ).length;
    assert(first === 1 || first === 2);
  }
  for (let i = 0; i < 48; i += 2) {
    const [first, second] = experiment.trials.slice(i, i + 2);
    assert.equal(first.pairId, second.pairId);
    assert.equal(first.scenarioId, second.scenarioId);
    assert.equal(first.repetition, second.repetition);
    assert.notEqual(first.owner, second.owner);
  }
  assert.equal(
    experiment.trials.filter((t) => t.position === 1 && t.owner === "model")
      .length,
    12,
  );
  for (const trial of experiment.trials) {
    const selected = selectResponsibilityTrial(
      experiment,
      trial.trialId,
      trial.scenarioId,
      manifest,
    );
    assert.equal(selected.owner, trial.owner);
    assert.equal(selected.experimentHash, experiment.contentHash);
  }
  assert.equal(
    freezeResponsibilityExperiment(
      manifest,
      "owner-test",
      "2030-01-01T00:00:00.000Z",
    ).contentHash,
    experiment.contentHash,
  );
});

test("职责观测解析精确工作流提供者，区分实际改变、原样继承、错误分组与缺失产物", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "responsibility-provider-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const manifest = freezeManifest(extendedTimeManifest("a".repeat(40)));
  const experiment = freezeResponsibilityExperiment(manifest, "provider");
  const trial = experiment.trials.find((v) => v.owner === "host")!;
  const binding = selectResponsibilityTrial(
    experiment,
    trial.trialId,
    trial.scenarioId,
    manifest,
  );
  const planned = {
    owner: "host" as const,
    implementationHash: experiment.kernelHash,
  };
  const base = workspace.activeVersion();
  const { id: _id, entry: _entry, createdAt: _time, ...input } = base;
  const changed = workspace.release.record({
    ...input,
    code: base.code + "\n// changed workflow",
  });
  const host = workspace.release.record({
    ...input,
    workflowProtocol: {
      version: "host-workflow/1",
      definition: base.definition as WorkflowDefinition,
      rules: [],
    },
  });
  const inherited = workspace.release.record({
    ...input,
    members: [
      {
        pluginId: base.pluginId,
        versionId: base.id,
        enabled: true,
        role: "workflow",
      },
    ],
  });
  const candidate = (versionId: string | undefined): CandidateAttempt => ({
    id: "candidate",
    planId: "plan",
    baseVersion: base.id,
    attempt: 1,
    passed: true,
    sourceHash: "test",
    versionId,
  });
  const observe = (versionId: string | undefined) =>
    observeResponsibility(binding, planned, [candidate(versionId)], (id) =>
      workspace.release.get(id),
    );
  const wrong = observe(changed.id);
  assert.equal(wrong.consistent, false);
  assert.equal(wrong.issues[0].code, "candidate-owner");
  assert.equal(wrong.candidates[0].actualOwner, "model");
  const correct = observe(host.id);
  assert.equal(correct.consistent, true);
  assert.equal(correct.candidates[0].providerVersionId, host.id);
  assert.equal(correct.candidates[0].actualOwner, "host");
  assert.equal(correct.candidates[0].workflowChanged, true);
  const unchanged = observe(inherited.id);
  assert.equal(unchanged.consistent, true);
  assert.equal(unchanged.candidates[0].actualOwner, "model");
  assert.equal(
    unchanged.candidates[0].workflowChanged,
    false,
    "辅助变更不能冒充工作流职责已经改变",
  );
  assert.equal(observe(undefined).consistent, false);
  assert.equal(observe("missing-version").consistent, false);
});

test("职责选择不接受被篡改但沿用旧摘要的验收清单，也不允许换场景、分组或重排补跑", () => {
  const manifest = freezeManifest(extendedTimeManifest("a".repeat(40)));
  const experiment = freezeResponsibilityExperiment(manifest, "owner-negative");
  const trial = experiment.trials[0];
  const changed = structuredClone(manifest);
  changed.budget.calls = 13;
  assert.throws(
    () =>
      selectResponsibilityTrial(
        experiment,
        trial.trialId,
        trial.scenarioId,
        changed,
      ),
    /摘要|contentHash|预算/,
  );
  assert.throws(
    () =>
      selectResponsibilityTrial(
        experiment,
        undefined,
        trial.scenarioId,
        manifest,
      ),
    /预注册/,
  );
  assert.throws(
    () =>
      selectResponsibilityTrial(
        experiment,
        trial.trialId,
        "other-scenario",
        manifest,
      ),
    /预注册/,
  );
  for (const edit of [
    (e: typeof experiment) => {
      e.trials.pop();
    },
    (e: typeof experiment) => {
      e.trials.reverse();
    },
    (e: typeof experiment) => {
      e.trials[0].owner = e.trials[1].owner;
    },
  ]) {
    const altered = structuredClone(experiment);
    edit(altered);
    const { contentHash: _hash, ...body } = altered;
    altered.contentHash = hash(body);
    assert.throws(
      () => assertResponsibilityExperiment(altered),
      /分组|配对|顺序|样本/,
    );
  }
});
