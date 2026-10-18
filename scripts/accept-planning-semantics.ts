import { fieldTargetId } from "../src/evolution/field-identity.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Workspace } from "../src/server/workspace.js";
import { capture } from "../src/server/planning.js";
import { EvolutionDomain } from "../src/server/evolution-domain.js";
import { memberUiReleaseInput } from "../tests/fixtures/member-ui.js";
import { DeepSeek, DEEPSEEK_MODEL } from "../src/evolution/deepseek.js";
import {
  modelPolicy,
  type ModelOutputPolicy,
} from "../src/evolution/model-policy.js";
import { BudgetScheduler } from "../src/evolution/budget.js";
import { hash } from "../src/release/storage.js";
import type { ModelRequest, ModelReply } from "../src/evolution/driver.js";
import { schemaProblems } from "../src/evolution/model-protocol.js";
import {
  admissionRequest,
  parseAdmission,
  admissionReviewRequest,
  adjudicateAdmission,
  admissionResolved,
} from "../src/evolution/request-admission.js";

import {
  scoreSemanticReply,
  semanticFailure,
} from "./lib/semantic-evaluation.js";

const prepare = process.argv.includes("--prepare-only");
assert.ok(
  prepare || process.argv.includes("--authorize-real-model"),
  "需要明确授权真实模型外发与费用",
);
const receiptPath =
  process.argv[process.argv.indexOf("--verification-receipt") + 1];
assert.ok(
  prepare || (process.argv.includes("--verification-receipt") && receiptPath),
  "真实评估必须绑定最终全量验证收据",
);
const directory = await mkdtemp(resolve(".runtime/planning-semantics-"));
const temporary = await mkdtemp(
  join(tmpdir(), "cordis-semantic-qualification-"),
);
const save = (name: string, value: unknown) =>
  writeFileSync(join(directory, name), JSON.stringify(value, null, 2), {
    mode: 0o600,
  });
const w = await Workspace.open(join(temporary, "workspace.db"));
type Sample = {
  id: string;
  request: ModelRequest;
  grade: (text: string) => boolean;
  valid: unknown;
  invalid: unknown;
};
try {
  const fixture = await memberUiReleaseInput("semantic-qualification");
  w.release.record(fixture.panel);
  const base = w.release.record(fixture.composition);
  await w.activate(
    {
      versionId: base.id,
      compositionRevision: w.composition().revision,
      operationId: "synthetic-baseline",
    },
    () => undefined,
  );
  const facts = new EvolutionDomain(w).admission(capture(w)).facts;
  const baseline = JSON.stringify({
    composition: w.composition(),
    tasks: w.query(),
  });
  const archive = JSON.parse(
    readFileSync(
      new URL(
        "../tests/fixtures/planning-compiler-replay.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as { requests: { id: string; request: string }[] };
  const after = archive.requests.find((r) => r.id === "upgrade")!.request;
  const empty =
    "请只修改现有 panel 备注面板的 noteMark 展示：尚未填写时显示空白。原动作、其他字段和行为不变。";
  const afterSources = [{ id: "qualification:after", text: after }],
    emptySources = [{ id: "qualification:empty", text: empty }];
  const meaning = {
    kind: "blank",
    conditionQuote: "尚未填写时",
    effectQuote: "显示空白",
  };
  const afterMeaning = {
    kind: "literal",
    value: "reviewed",
    conditionQuote: "未完成任务点击原 markNote 动作后",
    effectQuote: "将 noteMark 写入值从 ok 改为 reviewed",
  };
  const payload = (quote: string, m: unknown) => ({
    presentations: [
      {
        source: 1,
        sourceQuote: quote,
        target: {
          kind: "existing",
          targetId: fieldTargetId({
            member: "panel",
            contribution: "note-panel",
            field: "noteMark",
          }),
        },
        meaning: m,
      },
    ],
    questions: [],
  });
  const requested = payload("尚未填写时显示空白", meaning);
  const mistaken = payload(
    "将 noteMark 写入值从 ok 改为 reviewed",
    afterMeaning,
  );
  const afterAdmission = parseAdmission(
    JSON.stringify(mistaken),
    base.id,
    afterSources,
    facts,
  );
  const emptyAdmission = parseAdmission(
    JSON.stringify(requested),
    base.id,
    emptySources,
    facts,
  );
  assert.equal(afterAdmission.claims.length, 1);
  assert.equal(emptyAdmission.claims.length, 1);
  const review = (sourceQuote: string, verdict: string) => ({
    decisions: [
      {
        claim: 1,
        source: 1,
        sourceQuote,
        verdict,
        detail: "固定资格样本的结构化来源判定",
      },
    ],
  });
  const input = (
    sources: typeof afterSources,
    admission?: typeof afterAdmission,
  ): ModelRequest =>
    admission
      ? admissionReviewRequest(admission, sources)
      : admissionRequest(sources, facts);
  const samples: Sample[] = [
    {
      id: "admission-after-action",
      request: input(afterSources),
      valid: { presentations: [], questions: [] },
      invalid: mistaken,
      grade: (text) => {
        const r = parseAdmission(text, base.id, afterSources, facts);
        return (
          r.presentations.length === 0 &&
          r.questions.length === 0 &&
          r.claims.length === 0 &&
          r.initialMeanings.every((m) => m.initial.kind === "unspecified")
        );
      },
    },
    {
      id: "admission-explicit-empty",
      request: input(emptySources),
      valid: requested,
      invalid: { presentations: [], questions: [] },
      grade: (text) => {
        const r = parseAdmission(text, base.id, emptySources, facts);
        return (
          r.questions.length === 0 &&
          r.initialMeanings.length === 1 &&
          r.fieldCatalog.some(
            (f) =>
              f.member === "panel" &&
              f.field === "noteMark" &&
              (r.initialMeanings[0].field === f.field ||
                r.initialMeanings[0].field === f.label),
          ) &&
          r.initialMeanings[0].surface === "auxiliary" &&
          r.presentations[0]?.kind === "visible" &&
          r.presentations[0].value === "" &&
          r.claims.length === 1
        );
      },
    },
    {
      id: "review-after-action",
      request: input(afterSources, afterAdmission),
      valid: review("将 noteMark 写入值从 ok 改为 reviewed", "not-requested"),
      invalid: review("将 noteMark 写入值从 ok 改为 reviewed", "entailed"),
      grade: (text) => {
        const r = adjudicateAdmission(text, afterAdmission, afterSources);
        return (
          admissionResolved(r) &&
          r.semanticReview?.decisions[0].verdict === "not-requested" &&
          r.blockers.length === 0
        );
      },
    },
    {
      id: "review-explicit-empty",
      request: input(emptySources, emptyAdmission),
      valid: review("尚未填写时显示空白", "entailed"),
      invalid: review("尚未填写时显示空白", "not-requested"),
      grade: (text) => {
        const r = adjudicateAdmission(text, emptyAdmission, emptySources);
        return (
          admissionResolved(r) &&
          r.semanticReview?.decisions[0].verdict === "entailed" &&
          r.blockers.length === 1
        );
      },
    },
  ];
  for (const { id, text, meaning, expected } of [
    {
      id: "admission-literal-empty-word",
      text: "请只修改 panel 的 noteMark 初始展示：尚未填写时显示文字“空白”。原动作和其他行为不变。",
      meaning: {
        kind: "literal",
        value: "空白",
        conditionQuote: "尚未填写时",
        effectQuote: "显示文字“空白”",
      },
      expected: { kind: "visible", value: "空白" },
    },
    {
      id: "admission-hidden-field",
      text: "请只修改 panel 的 noteMark 初始展示：尚未填写时不显示 noteMark 字段。原动作和其他行为不变。",
      meaning: {
        kind: "hidden",
        conditionQuote: "尚未填写时",
        effectQuote: "不显示 noteMark 字段",
      },
      expected: { kind: "absent" },
    },
  ]) {
    const sources = [{ id: "qualification:" + id, text }];
    samples.push({
      id,
      request: input(sources),
      valid: payload(text, meaning),
      invalid: payload(text, {
        kind: "blank",
        conditionQuote: "尚未填写时",
        effectQuote: meaning.effectQuote,
      }),
      grade: (text) => {
        const r = parseAdmission(text, base.id, sources, facts);
        return (
          r.questions.length === 0 &&
          r.initialMeanings.length === 1 &&
          hash(r.initialMeanings[0].initial) === hash(expected) &&
          r.initialMeanings[0].surface === "auxiliary" &&
          r.claims.length === 1
        );
      },
    });
  }
  const valid = (sample: Sample, text: string) => {
    try {
      return (
        !schemaProblems(JSON.parse(text), sample.request.schema!).length &&
        sample.grade(text)
      );
    } catch {
      return false;
    }
  };
  for (const sample of samples) {
    assert.ok(valid(sample, JSON.stringify(sample.valid)));
    assert.ok(!valid(sample, JSON.stringify(sample.invalid)));
  }
  save(
    "fixtures.json",
    samples.map(({ grade: _grade, ...sample }) => ({
      ...sample,
      inputHash: hash(sample.request),
    })),
  );
  save("grading-preflight.json", {
    validFixtures: samples.length,
    invalidFixturesRejected: samples.length,
    apiCalls: 0,
  });
  if (prepare) {
    console.log(JSON.stringify({ directory, prepared: true, apiCalls: 0 }));
  } else {
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as {
      sourceUnchanged: boolean;
      results: { status: string }[];
    };
    assert.ok(
      receipt.sourceUnchanged &&
        receipt.results.length === 4 &&
        receipt.results.every((r) => r.status === "passed"),
    );
    const sourceManifest = JSON.parse(
      readFileSync(join(dirname(receiptPath), "source-manifest.json"), "utf8"),
    ) as Record<string, string>;
    const unchanged = () =>
      Object.entries(sourceManifest).every(
        ([path, digest]) =>
          createHash("sha256").update(readFileSync(path)).digest("hex") ===
          digest,
      );
    assert.ok(unchanged());
    if (existsSync(".env")) process.loadEnvFile(".env");
    const key = process.env.DEEPSEEK_API_KEY?.trim();
    assert.ok(key);
    const modes = ["disabled", "enabled"] as const;
    const sequence = samples.flatMap((sample, index) =>
      (index % 2 ? [...modes].reverse() : modes).map((mode) => ({
        sample,
        mode,
      })),
    );
    const results: {
      id: string;
      mode: (typeof modes)[number];
      passed: boolean;
      requests: number;
      phase: ModelRequest["phase"];
      category:
        | "pending"
        | "passed"
        | "protocol"
        | "semantics"
        | "transport"
        | "evaluator"
        | "budget";
      problems?: string[];
      error?: string;
      transport?: ModelReply["transport"];
      usage?: ModelReply["usage"];
      startedAt: string;
      elapsedMs?: number;
    }[] = [];
    const report = {
      kind: "planning-semantic-qualification/1",
      scope:
        "fixed production admission/source-review interfaces; no candidate generation or full E2E",
      directory,
      verificationReceipt: receiptPath,
      sequence: sequence.map(({ sample, mode }) => ({
        id: sample.id,
        mode,
        inputHash: hash(sample.request),
      })),
      timeoutMs: 60000,
      maxNativeRequests: sequence.length,
      limits: { calls: 12, candidates: 3, milliseconds: 600000 },
      externalRetries: 0,
      productionPolicyChanged: false,
      startedAt: new Date().toISOString(),
      results,
    };
    save("report.json", report);
    let totalRequests = 0;
    const evaluationStarted = performance.now();
    const scheduler = new BudgetScheduler(report.limits);
    for (const { sample, mode } of sequence) {
      assert.ok(unchanged());
      const record: (typeof results)[number] = {
        id: sample.id,
        mode,
        passed: false,
        category: "pending",
        requests: 0,
        phase: sample.request.phase,
        startedAt: new Date().toISOString(),
      };
      results.push(record);
      save("report.json", report);
      const policy = (phase: ModelRequest["phase"]): ModelOutputPolicy => {
        const { hash: _hash, ...body } = modelPolicy(phase);
        const next =
          mode === "enabled"
            ? {
                ...body,
                thinking: "enabled" as const,
                reasoningEffort: "max" as const,
              }
            : {
                ...body,
                thinking: "disabled" as const,
                reasoningEffort: "none" as const,
              };
        return { ...next, hash: hash(next) };
      };
      const stem = `${sample.id}-${mode}`;
      const http: typeof fetch = async (url, init) => {
        record.requests++;
        totalRequests++;
        assert.equal(record.requests, 1);
        assert.ok(
          totalRequests <= report.maxNativeRequests &&
            totalRequests <= report.limits.calls,
        );
        save(stem + "-native-request.json", {
          url,
          body: JSON.parse(String(init?.body)),
        });
        return fetch(url, init);
      };
      const remainingMs =
        report.limits.milliseconds - (performance.now() - evaluationStarted);
      if (remainingMs <= 0 || scheduler.remaining(totalRequests) <= 0) {
        Object.assign(record, {
          category: "budget",
          error: "固定评测预算耗尽，未发起该请求",
        });
        save("report.json", report);
        continue;
      }
      const started = performance.now();
      try {
        const { configureModelNetwork } = await import(
          "../src/evolution/model-network.js"
        );
        configureModelNetwork();
        const response = await new DeepSeek(
          key,
          http,
          undefined,
          policy,
        ).generate(
          sample.request,
          AbortSignal.timeout(
            Math.max(1, Math.floor(Math.min(report.timeoutMs, remainingMs))),
          ),
          (transport) => {
            record.transport = transport;
            save("report.json", report);
          },
        );
        save(stem + "-response.json", response);
        record.transport = response.transport;
        record.usage = response.usage;
        Object.assign(
          record,
          scoreSemanticReply(
            sample.request,
            response,
            DEEPSEEK_MODEL,
            sample.grade,
          ),
        );
      } catch (error) {
        Object.assign(record, semanticFailure(error, record.transport));
      }
      record.elapsedMs = Math.round(performance.now() - started);
      assert.ok(unchanged());
      assert.equal(
        JSON.stringify({ composition: w.composition(), tasks: w.query() }),
        baseline,
      );
      save("report.json", report);
      console.log(JSON.stringify(record));
    }
    const scores = modes.map((mode) => ({
      mode,
      passed: results.filter((r) => r.mode === mode && r.passed).length,
      total: results.filter((r) => r.mode === mode).length,
    }));
    const completed = {
      ...report,
      scores,
      phaseScores: modes.flatMap((mode) =>
        ["admission", "review"].map((phase) => {
          const rows = results.filter(
            (r) => r.mode === mode && r.phase === phase,
          );
          return {
            mode,
            phase,
            total: rows.length,
            completed: rows.filter(
              (r) => r.transport?.http?.stage === "complete",
            ).length,
            passed: rows.filter((r) => r.passed).length,
            semanticFailures: rows.filter((r) => r.category === "semantics")
              .length,
            transportFailures: rows.filter((r) => r.category === "transport")
              .length,
          };
        }),
      ),
      nativeRequests: totalRequests,
      sourceUnchanged: unchanged(),
      formalSyntheticUnchanged:
        JSON.stringify({ composition: w.composition(), tasks: w.query() }) ===
        baseline,
      passed: results.every((r) => r.passed),
      completedAt: new Date().toISOString(),
    };
    save("report.json", completed);
    const secretMatches = JSON.stringify(completed).includes(key);
    assert.ok(!secretMatches);
    console.log(
      JSON.stringify({
        directory,
        scores,
        nativeRequests: totalRequests,
        externalRetries: 0,
        sourceUnchanged: completed.sourceUnchanged,
      }),
    );
    if (!completed.passed) process.exitCode = 1;
  }
} finally {
  await w.close();
  await rm(temporary, { recursive: true, force: true });
}
