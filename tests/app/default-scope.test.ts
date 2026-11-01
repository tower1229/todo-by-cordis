import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { stabilityStubDriver } from "../../scripts/lib/stability-eval/driver-fixture.js";
import { settleEvolution } from "./evolution-adapter.js";
import type {
  DefaultDecision,
  DefaultReview,
} from "../../src/shared/evolution-interaction.js";
import {
  compileDefaults,
  parseDefaultReviews,
  defaultAuthorizes,
} from "../../src/evolution/interaction.js";
import type { Driver } from "../../src/evolution/driver.js";
import { toolReply } from "./planning-fixture.js";

const replay = JSON.parse(
  readFileSync(
    new URL("../fixtures/default-scope-review-replay.json", import.meta.url),
    "utf8",
  ),
) as {
  request: string;
  defaults: Omit<DefaultDecision, "id">[];
  defaultReviews: DefaultReview[];
};

function scopeReplay(
  mode: "original" | "withdraw" | "repeat",
  defaults: typeof replay.defaults,
) {
  const fixture = stabilityStubDriver("counter-add");
  const stats = { proposals: 0, reviews: 0 };
  let corrected = false;
  let originalProposal: Record<string, unknown> | undefined;
  const driver: Driver = {
    async generate(request, signal) {
      if (
        mode === "withdraw" &&
        JSON.stringify(request.history).includes("默认处理超出需求范围")
      )
        corrected = true;
      // Correction turns repeat the captured complete proposal. This keeps the
      // regression about default scope, without fresh legacy-fixture reads.
      const reply =
        originalProposal &&
        request.tools?.some((t) => t.name === "propose_plan")
          ? {
              ...toolReply("propose_plan", structuredClone(originalProposal)),
              history: request.history,
            }
          : await fixture.generate(request, signal);
      for (const call of reply.calls)
        if (call.name === "propose_plan") {
          stats.proposals++;
          // Replay a complete authored correction rather than the legacy
          // fixture's fresh planner, which loses sources after a rejection.
          originalProposal ??= structuredClone(call.args);
          call.args = structuredClone(originalProposal);
          call.args.defaults = defaults.filter(
            (d) => !corrected || d.scope !== "历史计数值的解析",
          );
        }
      const input = JSON.parse(request.message ?? "{}") as {
        kind?: string;
        defaults?: DefaultDecision[];
      };
      if (input.kind === "requirement-review/2") {
        stats.reviews++;
        const result = JSON.parse(reply.text) as Record<string, unknown>;
        // Authored counterfactual for the new wire option; the original real
        // receipt stays unchanged and is tested separately below.
        const canDeclineExtraScope =
          mode !== "original" &&
          JSON.stringify(request.schema).includes('"out-of-scope"');
        result.defaultReviews = input.defaults!.map((d) => {
          const raw = replay.defaultReviews.find((r) => r.id === d.id);
          assert.ok(
            raw,
            "stable default identity must match the captured failure",
          );
          return canDeclineExtraScope && raw.verdict === "requires-choice"
            ? {
                ...raw,
                verdict: "out-of-scope",
                detail:
                  "用户未要求修复异常历史文本；撤回这项覆盖默认，保留计数目标与全部已有行为。",
              }
            : raw;
        });
        reply.text = JSON.stringify(result);
      }
      return reply;
    },
  };
  return { driver, stats };
}

for (const { minimal, mode } of [
  { minimal: false, mode: "original" },
  { minimal: true, mode: "original" },
  { minimal: false, mode: "withdraw" },
  { minimal: true, mode: "withdraw" },
  { minimal: false, mode: "repeat" },
  { minimal: false, mode: "resume" },
] as const) {
  const originalReceipt = mode === "original";
  test(
    originalReceipt
      ? `第148次原始默认裁决仍必须追问，不能把数据损失默认为安全（${minimal ? "最小" : "完整"}零付费回放）`
      : `额外危险默认经独立审查退回规划（${minimal ? "最小" : "完整"}，${mode}，零付费）`,
    async (t) => {
      const defaults = replay.defaults.filter(
        (d) => !minimal || d.scope === "历史计数值的解析",
      );
      const dir = await mkdtemp(join(tmpdir(), "cordis-default-scope-"));
      const w = await Workspace.open(join(dir, "workspace.db"));
      const { driver, stats } = scopeReplay(
        mode === "resume" ? "withdraw" : mode,
        defaults,
      );
      let e = new Evolution(w.db, driver, new EvolutionDomain(w), {
        calls: mode === "resume" ? 7 : 12,
        candidates: 3,
        milliseconds: 600000,
      });
      t.after(async () => {
        await e.close();
        await w.close();
        await rm(dir, { recursive: true, force: true });
      });
      await e.command({
        type: "request",
        operationId: "request",
        text: replay.request,
      });
      let run = await settleEvolution(e);
      if (mode === "resume") {
        assert.equal(run.status, "awaiting-budget");
        if (run.status !== "awaiting-budget") throw new Error("not paused");
        assert.equal(stats.reviews, 1);
        assert.equal(
          w.db
            .prepare("SELECT count(*) n FROM evolution_requirement_freezes")
            .get()!.n,
          0,
        );
        const paused = run;
        await e.close();
        e = new Evolution(w.db, driver, new EvolutionDomain(w), {
          calls: 99,
          candidates: 99,
          milliseconds: 9999999,
        });
        assert.equal((await e.observe()).run?.budget?.efficiencyTarget, 7);
        await e.command({
          type: "resume-budget",
          operationId: "grant",
          runId: paused.id,
          pauseRevision: paused.pause.revision,
          amounts: paused.pause.suggested,
        });
        run = await settleEvolution(e);
        assert.equal(run.id, paused.id);
        assert.equal(run.budget?.grants?.length, 1);
      }
      assert.equal(
        run.status,
        originalReceipt
          ? "awaiting-input"
          : mode === "repeat"
            ? "blocked"
            : "ready",
        JSON.stringify({
          status: run.status,
          ...stats,
          ...(run.status === "blocked"
            ? { message: run.message, stop: run.stop }
            : {}),
        }),
      );
      assert.equal((await e.observe()).candidates?.length, 0);
      if (run.status === "awaiting-input") {
        assert.equal(run.questions?.length, 1);
        assert.match(run.question, /历史计数值的解析/);
        assert.equal(stats.proposals, 1);
        assert.equal(stats.reviews, 1);
        assert.ok(run.budget!.callsRemaining > 0);
        assert.equal(run.protocolFailures?.length ?? 0, 0);
      } else if (run.status === "ready") {
        assert.equal(stats.proposals, 2);
        assert.equal(
          stats.reviews,
          2,
          "corrected proposal must undergo independent review again",
        );
        assert.equal(run.plan.defaults?.length, defaults.length - 1);
        assert.ok(
          run.plan.defaultReviews?.every((r) => r.verdict === "safe-default"),
        );
        assert.equal(
          run.plan.requirements?.at(-1)?.sourceQuote,
          replay.request,
        );
        assert.ok(
          run.plan.memberCases?.some(
            (c) => c.state === "done" && c.expected.kind === "reject",
          ),
          "explicit rejection behavior must remain",
        );
        assert.equal(
          w.db
            .prepare("SELECT count(*) n FROM evolution_requirement_freezes")
            .get()!.n,
          1,
        );
        assert.ok(
          run.plans?.[0].defaultReviews?.some(
            (r) => r.verdict === "out-of-scope",
          ),
          "keep the rejected review as evidence",
        );
      } else if (run.status === "blocked") {
        assert.equal(
          stats.proposals,
          2,
          JSON.stringify({ stats, message: run.message, stop: run.stop }),
        );
        assert.equal(stats.reviews, 2);
        assert.match(run.message, /默认处理超出需求范围/);
        assert.equal(
          w.db
            .prepare("SELECT count(*) n FROM evolution_requirement_freezes")
            .get()!.n,
          0,
        );
        await assert.rejects(
          e.command({
            type: "start",
            runId: run.id,
            planId: run.plan!.id,
            operationId: "start",
          }),
          /没有可开始/,
        );
      }
    },
  );
}

test("相同计数需求不附加异常历史修复时可形成方案（零付费对照）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cordis-default-scope-control-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const e = new Evolution(
    w.db,
    stabilityStubDriver("counter-add"),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    operationId: "request",
    text: replay.request,
  });
  assert.equal((await settleEvolution(e)).status, "ready");
});

test("额外范围裁决不能授权或移除已绑定的业务选择", () => {
  const defaults = compileDefaults([replay.defaults[2]]);
  const receipt = {
    id: defaults[0].id,
    verdict: "out-of-scope",
    detail: "没有对应用户要求",
    targets: [],
  };
  const parsed = parseDefaultReviews([receipt], defaults, ["choice"]);
  assert.equal(defaultAuthorizes(parsed, "choice"), false);
  assert.throws(
    () =>
      parseDefaultReviews([{ ...receipt, targets: ["choice"] }], defaults, [
        "choice",
      ]),
    /额外|范围/,
  );
});
