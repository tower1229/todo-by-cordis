import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import { activateDual } from "./dual-composition-fixture.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import {
  tagsTrimOnlyMemberCases,
} from "./member-case-fixtures.js";
import {
  assertFormalFingerprintUnchanged,
  formalWorkspaceFingerprint,
} from "../../src/shared/shortened-real-model.js";

const tagsTrimOnlySource = `export default {
  contribute() {
    return {
      fields: [{ key: "tags", label: "标签", type: "text" }],
      commands: [{ id: "setTags", label: "设标签", from: ["open", "done"] }],
    };
  },
  decide(data) {
    const { task, action, input } = data;
    if (action === "setTags") {
      const tags = String(input?.tags ?? "").trim();
      if (!tags) return { kind: "reject", message: "标签为空" };
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, tags },
      };
    }
    return { kind: "reject", message: "未知动作" };
  },
};`;

async function settle(e: Evolution, status?: string) {
  for (let i = 0; i < 200; i++) {
    const run = (await e.observe()).run;
    if (!run) throw new Error("missing run");
    if (
      status
        ? run.status === status
        : !["planning", "executing", "applying"].includes(run.status)
    )
      return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout: ${JSON.stringify((await e.observe()).run)}`);
}

function pinnedMemberDriver(
  planning: PlanningDriver,
  workflowSource: () => string,
  members: () => { pluginId: string; source: string }[],
): Driver {
  return {
    async generate(request: ModelRequest, signal) {
      if (
        request.tools?.some((tool) => tool.name === "submit_candidate") ||
        request.tools?.some((tool) => tool.name === "build_candidate")
      ) {
        const content = JSON.stringify(request.history);
        if (!content.includes("read_contract"))
          return { ...toolReply("read_contract", {}), history: request.history };
        if (!content.includes("read_current_source"))
          return {
            ...toolReply("read_current_source", {}),
            history: request.history,
          };
        return {
          ...toolReply("submit_candidate", {
            source: workflowSource(),
            members: members(),
          }),
          history: request.history,
        };
      }
      return planning.generate(request, signal);
    },
  };
}

async function openCtx(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-shortened-stub-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  await activateDual(w);
  const task = (
    await w.command({
      type: "create",
      title: "stub-task",
      compositionRevision: w.composition().revision,
      operationId: randomUUID(),
    })
  ).task!;
  return { w, taskId: task.id };
}

test("缩短试跑阶段一桩（确定性）：去空格与空白拒绝；规划期正式数据不变且跳过 experience", async (t) => {
  const ctx = await openCtx(t);
  const formalBefore = formalWorkspaceFingerprint({
    composition: ctx.w.composition(),
    tasks: ctx.w.query(),
  });
  let submitted = [{ pluginId: "tags", source: tagsTrimOnlySource }];
  const planning = new PlanningDriver({
    summary: "标签去空格并拒绝空白",
    changes: ["升级 tags 辅助成员", "冻结去空格正例与空白拒绝"],
    outcome: "标签保存去空格，空白标签被拒绝",
    dataImpact: "保留 due 与主工作流；升级 tags",
    memberUpgrades: [{ pluginId: "tags" }],
    memberCases: tagsTrimOnlyMemberCases,
    workflowRules: [],
  });
  const workflowSource = ctx.w.activeVersion().source;
  const e = new Evolution(
    ctx.w.db,
    pinnedMemberDriver(planning, () => workflowSource, () => submitted),
    new EvolutionDomain(ctx.w),
  );
  t.after(async () => {
    await e.close();
  });

  const applyReady = async (operation: string, baseline = formalBefore) => {
    let observed = await e.observe();
    if (observed.run?.status === "awaiting-acceptance") {
      const pending = observed.run;
      await e.command({
        type: "confirm-acceptance",
        operationId: `${operation}-confirm`,
        runId: pending.id,
        planId: pending.plan.id,
        revisionId: pending.acceptanceRevision!.id,
      });
    }
    const ready = await settle(e, "ready");
    if (ready.status !== "ready") throw new Error("expected ready");
    assertFormalFingerprintUnchanged(
      `${operation}-planning`,
      baseline,
      formalWorkspaceFingerprint({
        composition: ctx.w.composition(),
        tasks: ctx.w.query(),
      }),
    );
    await e.command({
      type: "start",
      operationId: `${operation}-start`,
      runId: ready.id,
      planId: ready.plan.id,
    });
    const awaiting = await settle(e, "awaiting-apply");
    assert.equal(awaiting.status, "awaiting-apply");
    const candidate = (await e.observe()).candidates?.find((c) => c.passed);
    assert.ok(candidate?.evidenceHash);
    await e.command({
      type: "apply",
      operationId: `${operation}-apply`,
      runId: ready.id,
      candidateId: candidate!.id,
      evidenceHash: candidate!.evidenceHash!,
      compositionRevision: ctx.w.composition().revision,
    });
    assert.equal((await settle(e, "succeeded")).status, "succeeded");
    return ready;
  };

  await e.command({
    type: "request",
    text: "标签去空格，空白拒绝",
    operationId: "phase1-plan",
  });
  const first = await applyReady("phase1");

  const action = (input: Record<string, string>) =>
    ctx.w.command({
      type: "action",
      taskId: ctx.taskId,
      actionId: "setTags",
      expectedRevision: ctx.w.read(ctx.taskId).revision,
      input,
      operationId: randomUUID(),
      compositionRevision: ctx.w.composition().revision,
    });
  await action({ tags: "  Phase1 " });
  assert.equal(ctx.w.read(ctx.taskId).fields.tags, "Phase1");
  await assert.rejects(action({ tags: "   " }));
});
