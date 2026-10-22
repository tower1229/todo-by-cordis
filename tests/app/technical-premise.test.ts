import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { Evolution } from "../../src/evolution/evolution.js";
import {
  ModelTransportError,
  type ModelRequest,
  type ModelReply,
} from "../../src/evolution/driver.js";
import type { AssistantRun } from "../../src/shared/assistant.js";
import { PlanningDriver } from "./planning-fixture.js";

const response = (value: unknown): ModelReply => ({
  text: JSON.stringify(value),
  history: [],
  calls: [],
  usage: { fixture: true },
  raw: { fixture: value },
});
const source =
  "完成前必须填写复盘，去掉首尾空白后至少一个字、最多五千字；重新打开保留复盘。";
async function settle(e: Evolution) {
  const deadline = Date.now() + 30000;
  for (;;) {
    const run = (await e.observe()).run!;
    if (run.status !== "planning" && run.status !== "executing") return run;
    if (Date.now() >= deadline)
      throw new Error("语义前提集成测试超时：" + JSON.stringify(run));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
async function setup(
  t: test.TestContext,
  audit: (
    request: ModelRequest,
    signal: AbortSignal,
  ) => ModelReply | Promise<ModelReply>,
  options: { text?: string; calls?: number; repeat?: boolean } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "technical-premise-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  const fixture = new PlanningDriver();
  const requests: ModelRequest[] = [];
  let reviews = 0;
  const e = new Evolution(
    w.db,
    {
      async generate(request, signal) {
        requests.push(request);
        const input = JSON.parse(request.message ?? "{}");
        if (input.kind === "technical-premise-review/1")
          return audit(request, signal);
        const result = await fixture.generate(request);
        if (request.schema && input.technicalTargets) {
          reviews++;
          const review = JSON.parse(result.text);
          review.issues = [
            {
              kind: "extra-constraint",
              sourceRevision: input.sources[0].id,
              sourceQuote: input.sources[0].text,
              detail: "模型把仅校验去空白解释为必须保留原始输入",
              technical: {
                target: input.technicalTargets.find(
                  (target: { property: string }) =>
                    target.property === "persistenceNormalization",
                ).target,
                expected: "preserve",
              },
            },
          ];
          if (options.repeat && reviews === 1) {
            review.issues.push({
              kind: "omission",
              sourceRevision: input.sources[0].id,
              sourceQuote: input.sources[0].text,
              target: { subject: input.requirements[0].id, aspect: "coverage" },
              stance: "required",
              detail: "计划摘要应列明复盘",
            });
            fixture.finish.summary = "完成前必填复盘，并保留重新打开后的复盘";
          }
          result.text = JSON.stringify(review);
        }
        return result;
      },
    },
    new EvolutionDomain(w),
    options.calls === undefined
      ? undefined
      : { calls: options.calls, candidates: 3, milliseconds: 600000 },
  );
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: options.text ?? source,
    operationId: "request",
  });
  return { w, e, requests };
}
const verdict = (kind: "entailed" | "not-requested" | "uncertain") =>
  response({
    decisions: [
      { verdict: kind, detail: "模型桩来源解释，不构成真实模型证据" },
    ],
  });
const auditCalls = (requests: ModelRequest[]) =>
  requests.filter(
    (request) =>
      JSON.parse(request.message ?? "{}").kind === "technical-premise-review/1",
  );
const assertBudget = (run: AssistantRun, used: number) => {
  assert.equal(run.budget?.callsUsed, used);
  assert.equal(run.budget!.callsUsed + run.budget!.callsRemaining, 12);
  assert.equal(run.budget?.candidatesRemaining, 3);
};

test("生产规划链路：来源未要求的相反期望不再伪装成技术冲突，独立审查计入原预算（模型桩）", async (t) => {
  const { w, e, requests } = await setup(t, () => verdict("not-requested"));
  const run = await settle(e);
  assert.equal(run.status, "ready", JSON.stringify(run));
  assertBudget(run, 4);
  assert.equal(auditCalls(requests).length, 1);
  assert.deepEqual(auditCalls(requests)[0].history, []);
  assert.equal(auditCalls(requests)[0].tools, undefined);
  if (run.status !== "ready") return;
  assert.equal(
    run.plan.requirementGate!.review.technicalDecisions![0].outcome,
    "not-requested",
  );
  assert.equal(
    run.reviewLedger!.attempts[0].review.technicalPremiseAudit?.contract,
    "technical-premise/1",
  );
  const row = w.db
    .prepare("SELECT body FROM evolution_runs WHERE id=?")
    .get(run.id)!;
  const stored = JSON.parse(String(row.body));
  delete stored.run.plan.requirementGate.review.technicalPremiseAudit;
  w.db
    .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
    .run(JSON.stringify(stored), run.id);
  await assert.rejects(
    e.command({
      type: "start",
      runId: run.id,
      planId: run.plan.id,
      operationId: "tampered-proof",
    }),
    /技术|冻结/,
  );
  assert.equal((await e.observe()).candidates?.length ?? 0, 0);
});

test("相同来源与事实命题的复核随账本复用，不因另一个计划说明修正多花一次调用（模型桩）", async (t) => {
  const { e, requests } = await setup(t, () => verdict("not-requested"), {
    repeat: true,
  });
  const run = await settle(e);
  assert.equal(run.status, "ready", JSON.stringify(run));
  assertBudget(run, 6);
  assert.equal(auditCalls(requests).length, 1);
  assert.equal(run.reviewLedger?.attempts.length, 2);
  assert.deepEqual(
    run.reviewLedger!.attempts[0].review.technicalPremiseAudit,
    run.reviewLedger!.attempts[1].review.technicalPremiseAudit,
  );
});

test("用户明确要求与宿主冲突，或独立来源仍不确定，均阻塞且不新增技术澄清（模型桩）", async (t) => {
  for (const kind of ["entailed", "uncertain"] as const)
    await t.test(kind, async (t) => {
      const { e, requests } = await setup(t, () => verdict(kind), {
        text:
          kind === "entailed"
            ? source + "保存时必须保留原始首尾空白。"
            : source,
      });
      const run = await settle(e);
      assert.equal(run.status, "blocked", JSON.stringify(run));
      assertBudget(run, 4);
      assert.equal(run.stop?.kind, "planning-gate");
      assert.equal(auditCalls(requests).length, 1);
      assert.equal(
        run.reviewLedger?.attempts[0].review.technicalDecisions?.[0].outcome,
        kind === "entailed" ? "conflict" : "undetermined",
      );
      assert.equal((await e.observe()).candidates?.length ?? 0, 0);
    });
});

test("语义前提审查的传输、输出截断和无效结构分别停止，不以重新规划重试（模型桩）", async (t) => {
  const failures = [
    {
      name: "transport",
      calls: 4,
      attempts: 1,
      kind: "transport",
      audit: () => {
        throw new ModelTransportError("synthetic premise transport failed", {
          failure: {
            kind: "connection",
            elapsedMs: 1,
            causes: [{ code: "ECONNRESET", message: "fixture" }],
          },
        });
      },
    },
    {
      name: "output-budget",
      calls: 4,
      attempts: 1,
      kind: "output-budget",
      audit: () => ({ ...response({}), transport: { finishReason: "length" } }),
    },
    {
      name: "protocol",
      calls: 5,
      attempts: 2,
      kind: "protocol",
      audit: () => response({}),
    },
  ];
  for (const failure of failures)
    await t.test(failure.name, async (t) => {
      const { w, e, requests } = await setup(t, failure.audit);
      const run = await settle(e);
      assert.ok(
        run.status === "failed" || run.status === "blocked",
        JSON.stringify(run),
      );
      assertBudget(run, failure.calls);
      assert.equal(run.stop?.kind, failure.kind);
      assert.equal(run.stop?.phase, "review");
      assert.equal(auditCalls(requests).length, failure.attempts);
      assert.equal((await e.observe()).candidates?.length ?? 0, 0);
      const calls = w.db
        .prepare("SELECT body FROM evolution_calls WHERE runId=? ORDER BY id")
        .all(run.id)
        .map((row) => JSON.parse(String(row.body)));
      assert.equal(calls.length, failure.calls);
      assert.ok(calls.every((call) => call.endedAt));
      assert.ok(
        calls.at(-1).status === "returned" || calls.at(-1).status === "failed",
      );
    });
});

test("复核前预留不足时不调用模型、不签发可执行计划，沿用原预算调度（模型桩）", async (t) => {
  const { e, requests } = await setup(t, () => verdict("not-requested"), {
    calls: 6,
  });
  const run = await settle(e);
  assert.equal(run.status, "blocked", JSON.stringify(run));
  assert.equal(run.stop?.kind, "budget");
  assert.equal(run.budget?.callsUsed, 3);
  assert.equal(run.budget?.callsRemaining, 3);
  assert.equal(auditCalls(requests).length, 0);
});

test("取消独立来源审查会终止同一调用并保留失败回执，不签发门禁（模型桩）", async (t) => {
  let entered!: () => void;
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const { w, e, requests } = await setup(
    t,
    (_request, signal) =>
      new Promise<ModelReply>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
        entered();
      }),
  );
  await pending;
  const run = (await e.observe()).run!;
  await e.command({
    type: "cancel",
    runId: run.id,
    operationId: "cancel-premise",
  });
  const stopped = await settle(e);
  assert.equal(stopped.status, "cancelled");
  assertBudget(stopped, 4);
  assert.equal(auditCalls(requests).length, 1);
  const receipt = JSON.parse(
    String(
      w.db
        .prepare(
          "SELECT body FROM evolution_calls WHERE runId=? ORDER BY id DESC LIMIT 1",
        )
        .get(run.id)!.body,
    ),
  );
  assert.equal(receipt.phase, "review");
  assert.equal(receipt.status, "failed");
  assert.ok(receipt.endedAt);
  assert.equal(
    w.db
      .prepare("SELECT COUNT(*) AS count FROM evolution_requirement_freezes")
      .get()!.count,
    0,
  );
});
