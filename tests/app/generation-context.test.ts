import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "./evolution-adapter.js";
import {
  EvolutionDomain,
  contract,
} from "../../src/server/evolution-domain.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import { hash } from "../../src/release/storage.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import { source } from "./evolution-fixture.js";
import { activateDual } from "./dual-composition-fixture.js";
import { tagsMemberCases } from "./member-case-fixtures.js";
import { capabilityGuides } from "../../src/server/capability-guides.js";
import type { InvestigationDocument } from "../../src/server/planning.js";

type GenerationInput = {
  materials: {
    baseVersion: string;
    compositionRevision: number;
    documents: InvestigationDocument[];
  };
  budget: { callsRemaining: number };
};

async function settle(e: Evolution) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const run = (await e.observe()).run!;
    if (!["planning", "executing"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("run did not settle");
}

test("规划已用九次调用时，首轮精确资料支持直接修正，十一次内通过现有门禁（模型桩）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "generation-context-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const before = { composition: w.composition(), tasks: w.query() };
  const base = w.activeVersion();
  const planning = new PlanningDriver();
  let padding = 0;
  let generation = 0;
  const requests: ModelRequest[] = [];
  const driver: Driver = {
    async generate(request) {
      requests.push(request);
      if (!request.tools?.some((tool) => tool.name === "submit_candidate")) {
        const reply = await planning.generate(request);
        if (reply.calls[0]?.name === "propose_plan" && padding++ < 6)
          return {
            ...toolReply("read_source", { ref: "active-source" }),
            history: request.history,
          };
        return reply;
      }
      generation++;
      const reply = (name: string, args: Record<string, unknown>) => ({
        ...toolReply(name, args),
        history: request.history,
      });
      if (generation === 1) {
        const input = JSON.parse(request.message!) as GenerationInput;
        assert.ok(input.materials);
        assert.equal(input.materials.baseVersion, base.id);
        assert.equal(
          input.materials.compositionRevision,
          before.composition.revision,
        );
        const documents = input.materials.documents as {
          ref: string;
          hash: string;
          content: unknown;
        }[];
        assert.equal(
          documents.find((d) => d.ref === "active-source")?.content,
          base.source,
        );
        assert.ok(String(documents.find(d => d.ref === "candidate-contract")?.content).startsWith(contract));
        assert.match(String(documents.find(d => d.ref === "candidate-contract")?.content), /export const frozenWorkflow/);
        assert.ok(documents.find((d) => d.ref === "candidate-scaffold"));
        assert.ok(documents.every((d) => d.hash === hash(d.content)));
        assert.equal(input.budget.callsRemaining, 3);
        assert.match(request.instruction, /"callsRemaining":3/);
        assert.doesNotMatch(JSON.stringify(input), /previousPlans/);
        return reply("submit_candidate", {
          source: "invalid candidate source",
        });
      }
      assert.match(request.instruction, /"callsRemaining":2/);
      return reply("submit_candidate", {
        source: source(base.pluginId, base.name),
      });
    },
  };
  const domain = new EvolutionDomain(w);
  const e = new Evolution(w.db, driver, domain);
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘，其他行为不变",
    operationId: "request",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("not ready");
  assert.equal(ready.budget?.callsUsed, 9);
  const seal = ready.plan.requirementGate!.seal;
  await e.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "start",
  });
  const finished = await settle(e);
  assert.equal(finished.status, "awaiting-apply", JSON.stringify(finished));
  const candidates = (await e.observe()).candidates!;
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].passed, false);
  assert.equal(candidates[1].passed, true);
  assert.equal(candidates[1].requirementSeal, seal);
  assert.ok(candidates[1].browser?.results.every((r) => r.status === "passed"));
  domain.verifyAcceptance(candidates[1].versionId!, ready.plan);
  assert.equal(finished.budget?.callsUsed, 11);
  assert.equal(finished.budget?.callsRemaining, 1);
  assert.equal(requests.length + 1, 11, "独立预检由夹具适配器计入同一运行预算");
  assert.deepEqual({ composition: w.composition(), tasks: w.query() }, before);
});

for (const stale of [false, true])
  test(
    stale
      ? "交付源码与冻结摘要不一致时在模型调用前拒绝"
      : "首轮复用全部已冻结成员资料及指南，不交付未绑定版本（模型桩）",
    async (t) => {
      const dir = await mkdtemp(join(tmpdir(), "generation-materials-"));
      const w = await Workspace.open(join(dir, "workspace.db"));
      const { tags } = await activateDual(w);
      const planning = new PlanningDriver({
        workflowRules: [],
        memberUpgrades: [{ pluginId: "tags" }],
        memberCases: tagsMemberCases,
      });
      class TestDomain extends EvolutionDomain {
        override generation(
          target: Parameters<EvolutionDomain["generation"]>[0],
        ) {
          const context = super.generation(target);
          return stale
            ? { ...context, source: context.source + "\nchanged" }
            : context;
        }
      }
      const domain = new TestDomain(w);
      let guideRead = false;
      let generationCalls = 0;
      const driver: Driver = {
        async generate(request) {
          if (
            !request.tools?.some((tool) => tool.name === "submit_candidate")
          ) {
            const reply = await planning.generate(request);
            if (reply.calls[0]?.name === "propose_plan" && !guideRead) {
              guideRead = true;
              return {
                ...toolReply("read_guides", {
                  refs: ["guide/command.register"],
                }),
                history: request.history,
              };
            }
            return reply;
          }
          generationCalls++;
          const input = JSON.parse(request.message!) as GenerationInput;
          const documents = input.materials.documents as {
            ref: string;
            hash: string;
            content: unknown;
          }[];
          const exact = domain.readMember("tags", tags.id);
          for (const [kind, content] of [
            ["source", exact.source],
            ["contract", exact.contract],
            ["acceptance", exact.acceptance],
          ]) {
            assert.equal(
              documents.find((d) => d.ref === `member-${kind}/tags@${tags.id}`)
                ?.content,
              content,
            );
          }
          assert.equal(
            documents.find((d) => d.ref === "guide/command.register")?.content,
            capabilityGuides["guide/command.register"],
          );
          assert.ok(documents.every((d) => d.hash === hash(d.content)));
          const plan = JSON.parse(request.message!).plan;
          for (const doc of documents.filter(d=>d.ref.startsWith("member-source/")))
            assert.ok(plan.binding.materials.some((m:{ref:string;hash:string})=>m.ref===doc.ref && m.hash===doc.hash));
          for(const ref of Object.keys(plan.binding.guideCatalog))
            assert.equal(documents.find(d=>d.ref===ref)?.hash,plan.binding.guideCatalog[ref]);
          return {
            ...toolReply("report_blocker", {
              reason: "模型桩检查交付后停止，不生成候选",
            }),
            history: request.history,
          };
        },
      };
      const e = new Evolution(w.db, driver, domain);
      t.after(async () => {
        await e.close();
        await w.close();
        await rm(dir, { recursive: true, force: true });
      });
      await e.command({
        type: "request",
        text: "只升级标签规范化",
        operationId: "request",
      });
      const ready = await settle(e);
      assert.equal(
        ready.status,
        "ready",
        "message" in ready ? ready.message : ready.status,
      );
      if (ready.status !== "ready") throw new Error("not ready");
      await e.command({
        type: "start",
        runId: ready.id,
        planId: ready.plan.id,
        operationId: "start",
      });
      const finished = await settle(e);
      assert.equal(
        finished.status,
        stale ? "failed" : "blocked",
        "message" in finished ? finished.message : finished.status,
      );
      assert.equal(generationCalls, stale ? 0 : 1);
      assert.equal(
        finished.budget?.callsUsed,
        ready.budget!.callsUsed + generationCalls,
      );
      if (stale)
        assert.match(
          "message" in finished ? finished.message : "",
          /执行资料已变化/,
        );
    },
  );
