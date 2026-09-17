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
import { activateWorkflowOnly } from "./dual-composition-fixture.js";
import { typedWorkflowMemberDriver } from "./member-driver-fixture.js";
import { candidateSource, source } from "./evolution-fixture.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import { tagsTrimOnlyMemberCases } from "./member-case-fixtures.js";
import {
  assertFormalFingerprintUnchanged,
  formalWorkspaceFingerprint,
} from "../../scripts/lib/shortened-real-model.js";

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

const tagsLowercaseSource = `export default {
  contribute() {
    return {
      fields: [{ key: "tags", label: "标签", type: "text" }],
      commands: [{ id: "setTags", label: "设标签", from: ["open", "done"] }],
    };
  },
  decide(data) {
    const { task, action, input } = data;
    if (action === "setTags") {
      const tags = String(input?.tags ?? "").trim().toLowerCase();
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

const tagsLowercaseRevisedCases = [
  {
    ...tagsTrimOnlyMemberCases[0],
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { tags: "hello" },
    },
  },
  tagsTrimOnlyMemberCases[1],
];

const businessWritableScope = [
  "business/entry.ts",
  "business/view.ts",
  "business/config.json",
  "business/compatibility.json",
];

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

async function openCtx(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-shortened-stub-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  await activateWorkflowOnly(w);
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

test("缩短试跑两阶段桩：新增 tags 去空格 → 确认修订后升级小写；跳过 experience", async (t) => {
  const ctx = await openCtx(t);
  let formalBefore = formalWorkspaceFingerprint({
    composition: ctx.w.composition(),
    tasks: ctx.w.query(),
  });
  let submitted = [{ pluginId: "tags", source: tagsTrimOnlySource }];
  const planning = new PlanningDriver({
    summary: "新增标签插件并去空格拒绝空白",
    changes: ["新增 tags 辅助成员", "冻结去空格正例与空白拒绝"],
    outcome: "标签保存去空格，空白标签被拒绝",
    dataImpact: "保留主工作流；新增 tags",
    memberAdditions: [{ pluginId: "tags", name: "标签插件" }],
    memberCases: tagsTrimOnlyMemberCases,
  });

  const phase1Driver = typedWorkflowMemberDriver(planning, () => submitted);
  const phase2Driver: Driver = {
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
        const workflowCode = source("aux-workflow", "双贡献组合", 1);
        return {
          ...toolReply("submit_candidate", {
            ...JSON.parse(candidateSource(workflowCode)),
            members: submitted,
          }),
          history: request.history,
        };
      }
      return planning.generate(request, signal);
    },
  };

  let activeDriver: Driver = phase1Driver;
  const router: Driver = {
    generate(request, signal) {
      return activeDriver.generate(request, signal);
    },
  };

  const e = new Evolution(ctx.w.db, router, new EvolutionDomain(ctx.w));
  t.after(async () => {
    await e.close();
  });

  const applyReady = async (operation: string) => {
    let observed = await e.observe();
    if (observed.run?.status === "awaiting-acceptance") {
      const pending = observed.run;
      await e.command({
        type: "confirm-acceptance",
        operationId: `${operation}-confirm`,
        runId: pending.id,
        planId: pending.plan.id,
        revisionId: pending.acceptanceRevision.id,
      });
    }
    const ready = await settle(e, "ready");
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") throw new Error("expected ready");
    assertFormalFingerprintUnchanged(
      `${operation}-planning`,
      formalBefore,
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
    assertFormalFingerprintUnchanged(
      `${operation}-before-apply`,
      formalBefore,
      formalWorkspaceFingerprint({
        composition: ctx.w.composition(),
        tasks: ctx.w.query(),
      }),
    );
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
    text: "新增标签插件：去空格，空白拒绝",
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

  formalBefore = formalWorkspaceFingerprint({
    composition: ctx.w.composition(),
    tasks: ctx.w.query(),
  });
  submitted = [{ pluginId: "tags", source: tagsLowercaseSource }];
  activeDriver = phase2Driver;
  planning.finish = {
    summary: "升级标签为统一小写",
    changes: ["升级 tags 辅助成员", "修订冻结验收为小写"],
    outcome: "标签保存去空格并转小写，空白标签被拒绝",
    dataImpact: "保留主工作流精确版本；升级 tags",
    memberUpgrades: [{ pluginId: "tags" }],
    memberCases: tagsLowercaseRevisedCases,
    acceptanceReason: "用户要求标签统一小写",
    writableScope: businessWritableScope,
  };
  await e.command({
    type: "continue",
    operationId: "phase2-plan",
    runId: first.id,
    baseVersion: ctx.w.composition().versionId,
    text: "标签统一小写",
  });
  const pending = await settle(e, "awaiting-acceptance");
  assert.equal(pending.status, "awaiting-acceptance", JSON.stringify(pending));
  await applyReady("phase2");
  await action({ tags: "  HeLLo " });
  assert.equal(ctx.w.read(ctx.taskId).fields.tags, "hello");
  await assert.rejects(action({ tags: "  " }));
});
