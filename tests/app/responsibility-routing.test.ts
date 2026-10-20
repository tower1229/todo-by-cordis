import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extendedTimeManifest } from "../../scripts/lib/stability-eval/resources.js";
import { freezeManifest } from "../../scripts/lib/stability-eval/manifest.js";
import { freezeResponsibilityExperiment } from "../../scripts/lib/stability-eval/responsibility.js";
import {
  runStabilityScenario,
  runFrozenBaselineSuite,
} from "../../scripts/lib/stability-eval/scenario.js";
import type { AssistantSnapshot } from "../../src/shared/assistant.js";

test("冻结分组通过公开采样入口选择宿主职责并归档，规划探针不冒充候选或浏览器通过", async () => {
  const directory = await mkdtemp(join(tmpdir(), "responsibility-route-"));
  try {
    const manifest = freezeManifest(extendedTimeManifest("a".repeat(40)));
    const experiment = freezeResponsibilityExperiment(manifest, "routing");
    const trial = experiment.trials.find(
      (t) => t.owner === "host" && t.scenarioId === "rule-revision-reflection",
    )!;
    const scenario = manifest.scenarios.find((s) => s.id === trial.scenarioId)!;
    let plannedOwner: string | undefined;
    const result = await runStabilityScenario({
      directory,
      manifest,
      scenario,
      trialId: trial.trialId,
      responsibilityExperiment: experiment,
      evidenceKind: "model-stub",
      browserRun: async ({ app }) => {
        await app.request("/api/assistant/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "request",
            text: scenario.request,
            operationId: "request",
          }),
        });
        const deadline = Date.now() + 10_000;
        let snapshot: AssistantSnapshot;
        do {
          snapshot = (await (
            await app.request("/api/assistant")
          ).json()) as AssistantSnapshot;
          if (snapshot.run?.status !== "planning") break;
          await new Promise((r) => setTimeout(r, 10));
        } while (Date.now() < deadline);
        assert.equal(snapshot.run?.status, "ready");
        if (snapshot.run?.status === "ready")
          plannedOwner = snapshot.run.plan.binding?.workflowProtocol?.owner;
        return {
          status: "failed",
          viewport: { width: 390, height: 844 },
          openedImprovePanel: true,
          recoveryEntryVisible: true,
          screenshot: "",
          pageErrors: [],
          message: "控制面规划探针，不执行候选，不计为浏览器通过",
        };
      },
    });
    assert.equal(plannedOwner, "host");
    assert.equal(result.record.responsibility?.owner, "host");
    assert.equal(
      result.record.responsibility?.experimentHash,
      experiment.contentHash,
    );
    assert.equal(result.record.responsibility?.plannedOwner, "host");
    assert.equal(result.record.responsibility?.consistent, true);
    assert.deepEqual(result.record.responsibility?.candidates, []);
    assert.equal(result.record.fullPathSucceeded, false);
    assert.equal(result.record.candidatePassed, false);
    assert.equal(result.record.resources?.candidates, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("配对批次按预注册顺序串行运行48次，失败原样保留，不筛选场景或续跑", async () => {
  const directory = await mkdtemp(join(tmpdir(), "responsibility-suite-"));
  try {
    const manifest = freezeManifest(extendedTimeManifest("a".repeat(40)));
    const experiment = freezeResponsibilityExperiment(manifest, "suite");
    const observed: string[] = [];
    const result = await runFrozenBaselineSuite({
      root: directory,
      manifest,
      evidenceKind: "model-stub",
      harnessCommit: "a".repeat(40),
      responsibilityExperiment: experiment,
      browserRun: async ({ directory: trialDirectory }) => {
        observed.push(trialDirectory.split("/").at(-1)!);
        return {
          status: "failed",
          viewport: { width: 390, height: 844 },
          openedImprovePanel: false,
          recoveryEntryVisible: false,
          screenshot: "",
          pageErrors: [],
          message: "控制面分组探针，不执行浏览器或调用模型",
        };
      },
    });
    assert.equal(result.records.length, 48);
    assert.deepEqual(
      result.records.map((r) => r.trialId),
      experiment.trials.map((t) => t.trialId),
    );
    assert(
      result.records.every(
        (r) => r.observedOutcomeClass === "failed" && !r.fullPathSucceeded,
      ),
    );
    assert(
      result.records.every(
        (r, i) => r.responsibility?.owner === experiment.trials[i].owner,
      ),
    );
    assert(
      observed.every((name, i) =>
        name.startsWith(experiment.trials[i].trialId + "-"),
      ),
    );
    for (const forbidden of [
      { scenarioFilter: ["rule-revision-reflection"] },
      { continuationRoot: directory },
    ])
      await assert.rejects(
        runFrozenBaselineSuite({
          root: directory,
          manifest,
          evidenceKind: "model-stub",
          harnessCommit: "a".repeat(40),
          responsibilityExperiment: experiment,
          ...forbidden,
        }),
        /筛选|续跑|配对/,
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
