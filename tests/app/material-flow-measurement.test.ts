import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeek } from "../../src/evolution/deepseek.js";
import {
  measureFlow,
  materialExperimentManifest,
  freezeMaterialExperiment,
  assertMaterialExperiment,
  evaluateMaterialPair,
  type MaterialResult,
} from "../../scripts/lib/stability-eval/material-experiment.js";
import { hash } from "../../src/release/storage.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materialExperimentStubDriver } from "../../scripts/lib/stability-eval/driver-fixture.js";
import { v1Requests } from "../../scripts/lib/v1-scenario.js";

const manifest = materialExperimentManifest("a".repeat(40));
const transport = (bytes: number) => ({
  http: {
    stage: "complete" as const,
    bodyBytes: 0,
    requestBodyBytes: bytes,
    whitespaceBytes: 0,
  },
});
const experiment = () =>
  freezeMaterialExperiment({
    manifest,
    baselineHash: "b".repeat(64),
    sourceHash: "c".repeat(64),
    preflightHash: "d".repeat(64),
    baselineDirectory: "/synthetic/baseline",
    baseCumulative: 134,
    globalLimit: 234,
  });

test("受控模型桩遵守原生信封和历史协议，继承标签拒绝不冒充已要求页面反馈", async () => {
  const driver = materialExperimentStubDriver(
    {
      async generate() {
        return {
          text: JSON.stringify({ errorDecisions: [{ feedback: "required" }] }),
          history: [],
          calls: [],
          usage: null,
          raw: { fixture: true },
        };
      },
    },
    () => {},
  );
  const reply = await driver.generate(
    {
      instruction: "synthetic",
      history: [],
      schema: { type: "object" },
      message: JSON.stringify({
        kind: "requirement-review/2",
        sources: [
          { id: "counter", text: v1Requests[1] },
          { id: "tags", text: v1Requests[0] },
        ],
        errorReviewTargets: [{ sources: [{ sourceRevision: "tags" }] }],
      }),
    },
    new AbortController().signal,
  );
  assert.equal(reply.transport?.envelopeValid, true);
  assert.deepEqual(JSON.parse(reply.text).errorDecisions, [
    {
      target: 1,
      source: 1,
      sourceQuote: v1Requests[0],
      feedback: "not-requested",
      effectQuote: "",
      text: "",
    },
  ]);
  assert.equal((reply.history.at(-1) as { role: string }).role, "assistant");
  assert.equal(reply.usage, null, "不能为合成响应捏造供应商用量");
});

test("实验清单使用克隆的已发布基线，不能被通用 dual 夹具替换", () => {
  assert.equal(manifest.scenarios.length, 1);
  assert.equal(manifest.scenarios[0].baseline, undefined);
  assert.match(manifest.scenarios[0].request, /保留已有标签/);
  assert.equal(manifest.runs.independentRunsPerScenario, 4);
});

test("实际 SDK 请求体按 UTF8 计量，含历史、工具及 schema，超时前保留输入而不改请求", async () => {
  let sent = "";
  let beforeDispatch = 0;
  const driver = new DeepSeek("synthetic-key", async (_url, init) => {
    sent = String(init?.body);
    assert.equal(beforeDispatch, Buffer.byteLength(sent));
    throw new Error("controlled transport failure");
  });
  await assert.rejects(
    driver.generate(
      {
        phase: "planning",
        instruction: "中文说明",
        history: [{ role: "user", content: "历史原文" }],
        message: "补读结果",
        tools: [
          {
            name: "read_acceptance",
            description: "原文",
            parameters: {
              type: "object",
              properties: { ref: { type: "string" } },
              required: ["ref"],
            },
          },
        ],
      },
      new AbortController().signal,
      (transport) => {
        beforeDispatch = transport.http?.requestBodyBytes ?? 0;
      },
    ),
    /controlled transport failure/,
  );
  assert.ok(beforeDispatch > sent.length);
  assert.match(sent, /历史原文/);
  assert.match(sent, /read_acceptance/);
});

test("完整计量包含所有阶段和重复输入，未知用量保留缺口；重复结束事件不重复计时", () => {
  const metrics = measureFlow({
    durationMs: 900,
    activeMilliseconds: 700,
    browserJourneyMs: 850,
    calls: [
      {
        phase: "planning",
        startedAt: "2026-01-01T00:00:00Z",
        endedAt: "2026-01-01T00:00:00.100Z",
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          prompt_cache_hit_tokens: 3,
          prompt_cache_miss_tokens: 7,
        },
        transport: transport(100),
      },
      {
        phase: "review",
        startedAt: "2026-01-01T00:00:00.100Z",
        endedAt: "2026-01-01T00:00:00.300Z",
        usage: null,
        transport: transport(80),
      },
      {
        phase: "generation",
        startedAt: "2026-01-01T00:00:00.300Z",
        endedAt: "2026-01-01T00:00:00.400Z",
        usage: { prompt_tokens: 20, completion_tokens: 6 },
        transport: transport(120),
      },
    ],
    events: [
      {
        sequence: 1,
        stepId: "b",
        attempt: 1,
        label: "构建",
        tool: "build_candidate",
        status: "started",
        at: "2026-01-01T00:00:00Z",
      },
      {
        sequence: 2,
        stepId: "b",
        attempt: 1,
        label: "构建",
        tool: "build_candidate",
        status: "succeeded",
        at: "2026-01-01T00:00:00.100Z",
      },
      {
        sequence: 3,
        stepId: "b",
        attempt: 1,
        label: "构建",
        tool: "build_candidate",
        status: "succeeded",
        at: "2026-01-01T00:00:00.300Z",
      },
    ],
  });
  assert.equal(metrics.input.requestBodyBytes, 300);
  assert.equal(metrics.input.promptTokens, null);
  assert.equal(metrics.input.knownPromptTokens, 30);
  assert.equal(metrics.input.callsMissingUsage, 1);
  assert.equal(metrics.input.cachedTokens, null);
  assert.equal(metrics.timing.modelByPhase.review, 200);
  assert.equal(metrics.timing.nativeChecks.build_candidate, 100);
  assert.equal(metrics.timing.userWaitMs, 0);
});

test("ABBA 清单冻结预算、分组、基线与停止条件，未完成和零付费桩不能签发真实收益", () => {
  const frozen = freezeMaterialExperiment({
    manifest,
    baselineHash: "b".repeat(64),
    sourceHash: "c".repeat(64),
    preflightHash: "d".repeat(64),
    baselineDirectory: "/synthetic/baseline",
    baseCumulative: 134,
    globalLimit: 234,
  });
  assert.deepEqual(
    frozen.trials.map((t) => t.arm),
    ["raw", "view", "view", "raw"],
  );
  assert.equal(frozen.firstPairMaximum, 24);
  assert.equal(frozen.maximumCalls, 48);
  assert.throws(
    () => assertMaterialExperiment({ ...frozen, baselineHash: "tampered" }),
    /冻结/,
  );
  assert.throws(()=>assertMaterialExperiment({...frozen,preflightHash:"tampered"}),/冻结/);
  assert.equal(evaluateMaterialPair(frozen, []).decision, "incomplete");
  const row = {
    trialId: frozen.trials[0].trialId,
    arm: "raw" as const,
    evidenceKind: "model-stub" as const,
    passed: true,
    metrics: measureFlow({
      durationMs: 100,
      activeMilliseconds: 50,
      browserJourneyMs: 90,
      calls: [],
      events: [],
    }),
  };
  assert.equal(
    evaluateMaterialPair(frozen, [
      row,
      { ...row, trialId: frozen.trials[1].trialId, arm: "view" },
    ]).decision,
    "stub-only",
  );
});

test("预注册评估按完整输入和全流程耗时判定，失败、未知及未执行项不被剔除", () => {
  const frozen = experiment();
  const results: MaterialResult[] = frozen.trials.map((t) => ({
    ...t,
    evidenceKind: "real-model",
    passed: true,
    metrics: measureFlow({
      durationMs: t.arm === "raw" ? 100 : 80,
      browserJourneyMs: 80,
      events: [],
      calls: [
        {
          usage: {
            prompt_tokens: t.arm === "raw" ? 100 : 80,
            completion_tokens: 20,
          },
          transport: transport(200),
        },
      ],
    }),
  }));
  assert.equal(
    evaluateMaterialPair(frozen, results.slice(0, 2)).decision,
    "first-pair-eligible-for-confirmation",
  );
  assert.equal(
    evaluateMaterialPair(frozen, results).decision,
    "pilot-benefit-only",
  );
  assert.equal(
    evaluateMaterialPair(frozen, [results[0], { ...results[1], passed: false }])
      .decision,
    "stop-failure",
  );
  assert.deepEqual(
    evaluateMaterialPair(frozen, [
      { ...results[0], passed: false, metrics: null },
    ]).coverage,
    {
      planned: 4,
      started: 1,
      passed: 0,
      failed: 1,
      unrun: ["p1-view", "p2-view", "p2-raw"],
    },
  );
  assert.equal(
    evaluateMaterialPair(frozen, [{ ...results[0], metrics: null }]).decision,
    "stop-unknown-usage",
  );
  const unknown = structuredClone(results);
  unknown[1].metrics!.input.promptTokens = null;
  assert.equal(
    evaluateMaterialPair(frozen, unknown.slice(0, 2)).decision,
    "stop-unknown-usage",
  );
  const missingBytes = structuredClone(results);
  missingBytes[1].metrics!.input.requestBodyBytes = null;
  assert.equal(
    evaluateMaterialPair(frozen, missingBytes.slice(0, 2)).decision,
    "stop-missing-measurement",
  );
  const slow = structuredClone(results);
  slow[1].metrics!.timing.wallTotalMs = 101;
  assert.equal(
    evaluateMaterialPair(frozen, slow.slice(0, 2)).decision,
    "stop-no-benefit",
  );
  assert.throws(
    () => evaluateMaterialPair(frozen, [results[1], results[0]]),
    /ABBA/,
  );
  assert.throws(
    () => evaluateMaterialPair(frozen, [results[0], results[0]]),
    /重复/,
  );
  const { contentHash: _hash, frozen: _frozen, ...body } = frozen;
  const altered = { ...body, stop: { ...body.stop, automaticGrants: true } };
  assert.throws(
    () =>
      assertMaterialExperiment({
        ...altered,
        frozen: true,
        contentHash: hash(altered),
      } as typeof frozen),
    /停止条件/,
  );
});

test("零付费入口在创建证据或读取凭证之前拒绝真实授权和 dirty 绕过参数", async () => {
  const directory = await mkdtemp(join(tmpdir(), "material-cli-guard-"));
  try {
    for (const flag of [
      "--authorize-real-model",
      "--api-key=synthetic",
      "--allow-dirty",
    ]) {
      await assert.rejects(
        promisify(execFile)(process.execPath, [
          "--import",
          "tsx",
          "scripts/accept-material-view.ts",
          "--prepare-only",
          `--output=${join(directory, "output")}`,
          flag,
        ]),
        /仅允许零付费准备/,
      );
      assert.deepEqual(await readdir(directory), []);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
