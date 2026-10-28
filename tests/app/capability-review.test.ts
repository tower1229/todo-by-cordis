import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Evolution } from "../../src/evolution/evolution.js";
import type { PlanInput } from "../../src/evolution/plan-input.js";
import { Workspace } from "../../src/server/workspace.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { activateWorkflowOnly } from "./dual-composition-fixture.js";
import { PlanningDriver } from "./planning-fixture.js";
import { settleEvolution } from "./evolution-adapter.js";

const archive = JSON.parse(readFileSync(
  new URL("../fixtures/capability-review-replay.json", import.meta.url), "utf8",
)) as { request: string; proposal: PlanInput };

// Recorded business proposal, fresh run identities, synthetic reviews. No provider calls.
for (const repair of [false, true]) test(`归档字段提案的 UI 能力进入独立复核：${repair ? "修正默认后才可冻结" : "重复冲突不能进入执行"}`, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-capability-review-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  await activateWorkflowOnly(w);
  const baseline = w.composition();
  const fixture = new PlanningDriver();
  let proposals = 0;
  let reviews = 0;
  const e = new Evolution(w.db, {
    async generate(request) {
      const reply = await fixture.generate(request);
      const input = JSON.parse(request.message ?? "{}");
      if (input.kind === "requirement-review/2") {
        reviews++;
        assert.deepEqual(request.history, []);
        assert.equal(request.tools, undefined);
        assert.ok(input.capabilityChanges.some((c: { capability: string; provider: string }) =>
          c.capability === "ui.slot" && c.provider === "member:tags"));
        const result = JSON.parse(reply.text);
        result.defaultReviews = input.defaults.map((d: { id: string; behavior: string }) => ({
          id: d.id,
          verdict: d.behavior.includes("不新增 uiSlots") ? "conflict" : "safe-default",
          detail: "模型桩按已投影的 ui.slot 要求核对默认；不能用普通字段回退替代成员贡献",
          targets: [],
        }));
        reply.text = JSON.stringify(result);
      }
      for (const call of reply.calls) {
        if (call.name !== "propose_plan") continue;
        const proposal = structuredClone(archive.proposal);
        if (++proposals > 1 && repair) {
          const detail = proposal.defaults!.find(d => d.behavior.includes("不新增 uiSlots"))!;
          detail.behavior = "通过 uiSlots 的 task.detail 贡献呈现标签字段，沿用宿主的只读渲染与动作表单";
          detail.basis = "已编译的 ui.slot 接口要求及现有宿主呈现契约";
        }
        call.args = proposal as unknown as Record<string, unknown>;
      }
      return reply;
    },
  }, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  await e.command({ type: "request", operationId: randomUUID(), text: archive.request });
  const run = await settleEvolution(e);
  assert.equal(run.status, repair ? "ready" : "blocked", JSON.stringify(run));
  assert.equal(proposals, 2);
  assert.equal(reviews, 2);
  if (run.status === "ready") {
    assert.ok(run.plan.capabilityChanges.some(c => c.capability === "ui.slot"));
    assert.equal(run.plan.defaultReviews?.length, archive.proposal.defaults?.length);
    assert.ok(run.plan.defaultReviews?.every(d => d.verdict === "safe-default"));
    assert.ok(!run.plan.defaults?.some(d => d.behavior.includes("不新增 uiSlots")));
  } else if (run.status === "blocked") {
    assert.match(run.message, /默认处理与明确要求冲突/);
    assert.ok(run.plan);
    await assert.rejects(e.command({ type: "start", runId: run.id, planId: run.plan.id, operationId: randomUUID() }), /没有可开始的计划/);
  }
  assert.equal(run.requestRevision, 1);
  assert.equal((await e.observe()).candidates?.length, 0);
  assert.deepEqual(w.composition(), baseline);
});
