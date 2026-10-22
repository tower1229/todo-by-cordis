import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver } from "./planning-fixture.js";
import { stabilityStubDriver } from "../../scripts/lib/stability-eval/driver-fixture.js";
import { tagsTrimOnlyMemberCases } from "./member-case-fixtures.js";
import { settleEvolution } from "./evolution-adapter.js";
import { hash } from "../../src/release/storage.js";
import { gateFailure } from "../../src/server/requirement-coverage.js";

const request =
  "增加标签：保存时去掉首尾空格，拒绝空白，保留大小写。完成后显示或隐藏标签编辑动作都可以，由实现自行选择；其他行为不变。";

for (const { visible, valid } of [
  { visible: false, valid: true },
  { visible: true, valid: true },
  { visible: true, valid: false },
])
  test(`标签设计授权经过真实规划和冻结：完成后${visible ? "显示" : "隐藏"}，候选${valid ? "履行业务义务" : "拒绝所有操作"}（模型桩）`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "cordis-scoped-tag-"));
    const w = await Workspace.open(join(directory, "workspace.db"));
    const planner = new PlanningDriver({
      summary: "增加标签",
      outcome: "可设置标签",
      workflowRules: [],
      writableScope: [],
      memberAdditions: [{ pluginId: "tags", name: "标签" }],
      memberCases: tagsTrimOnlyMemberCases,
      capabilityChanges: [
        {
          capability: "command.register",
          provider: "member:tags",
          consumers: ["src/web/ActionForm.tsx"],
          change: "增加标签动作",
        },
      ],
      browserCases: [
        {
          id: "tag-after-complete",
          task: "new",
          steps: [
            { kind: "action", member: "workflow", action: "complete" },
            {
              kind: "action-visible",
              member: "tags",
              action: "setTags",
              visible,
            },
          ],
        },
      ],
    });
    const generator = stabilityStubDriver("tags-add");
    const e = new Evolution(
      w.db,
      {
        async generate(input, signal) {
          if (input.tools?.some((t) => t.name === "submit_candidate")) {
            const reply = await generator.generate(input, signal);
            for (const call of reply.calls) {
              const members = call.args.members as
                | { source: string }[]
                | undefined;
              for (const member of members ?? []) {
                if (!visible)
                  member.source = member.source.replace(
                    "from:['open','done']",
                    "from:['open']",
                  );
                if (!valid)
                  member.source = member.source.replace(
                    "if(action!=='setTags')",
                    "if(true)",
                  );
              }
            }
            return reply;
          }
          const reply = await planner.generate(input);
          const context = JSON.parse(input.message ?? "{}");
          if (context.designTargets) {
            const result = JSON.parse(reply.text);
            result.designDecisions = context.designTargets.map(
              (target: { target: number }) => ({
                target: target.target,
                source: 1,
                quote: "完成后显示或隐藏标签编辑动作都可以，由实现自行选择",
                permission: "delegated",
              }),
            );
            reply.text = JSON.stringify(result);
          }
          return reply;
        },
      },
      new EvolutionDomain(w),
    );
    t.after(async () => {
      await e.close();
      await w.close();
      await rm(directory, { recursive: true, force: true });
    });
    const original = hash({ composition: w.composition(), tasks: w.query() });
    await e.command({ type: "request", text: request, operationId: "request" });
    const ready = await settleEvolution(e, "ready");
    if (ready.status !== "ready") throw new Error("fixture");
    assert.ok(
      ready.plan.designDecisions?.some((d) => d.permission === "delegated"),
    );
    assert.ok(
      ready.plan.changeSpec?.authority.propositions.some(
        (p) => p.authority === "authorized-design",
      ),
    );
    const seal = ready.plan.requirementGate!.seal;
    assert.equal(
      gateFailure(
        ready.plan,
        ready.plan.requirementGate,
        undefined,
        ready.reviewLedger,
      ),
      undefined,
    );
    const altered = structuredClone(ready.plan);
    altered.designDecisions![0].allowed = [true];
    assert.match(
      gateFailure(
        altered,
        ready.plan.requirementGate,
        undefined,
        ready.reviewLedger,
      ) ?? "",
      /授权|冻结|作用域/,
    );
    const stored = w.db
      .prepare("SELECT body FROM evolution_runs WHERE id=?")
      .get(ready.id)!;
    const corrupted = JSON.parse(String(stored.body));
    corrupted.run.plan.designDecisions[0].allowed = [true];
    w.db
      .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
      .run(JSON.stringify(corrupted), ready.id);
    await assert.rejects(
      e.command({
        type: "start",
        runId: ready.id,
        planId: ready.plan.id,
        operationId: "tampered-start",
      }),
      /授权|冻结|作用域/,
    );
    w.db
      .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
      .run(stored.body, ready.id);
    await e.command({
      type: "start",
      runId: ready.id,
      planId: ready.plan.id,
      operationId: "start",
    });
    const done = await settleEvolution(e, valid ? "awaiting-apply" : undefined);
    if (valid) assert.equal(done.plan?.requirementGate?.seal, seal);
    const frozen = w.db.prepare("SELECT body FROM evolution_requirement_freezes WHERE id=?").get(ready.plan.id)!;
    assert.equal(JSON.parse(String(frozen.body)).seal, seal);
    assert.ok(done.budget!.callsUsed <= 12);
    assert.ok(done.budget!.candidatesRemaining >= 0);
    const candidates = (await e.observe()).candidates!;
    assert.ok(candidates.length >= 1 && candidates.length <= 3);
    assert.equal(
      candidates.some((c) => c.passed),
      valid,
    );
    if (!valid) assert.notEqual(done.status, "awaiting-apply");
    assert.equal(
      hash({ composition: w.composition(), tasks: w.query() }),
      original,
      "没有正式应用或写入正式任务",
    );
  });
