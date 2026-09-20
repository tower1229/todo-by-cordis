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
import { panelPluginCode } from "../fixtures/member-ui.js";
import { ExecutionDriver } from "./execution-fixture.js";
import {
  dueMemberCases,
  panelMemberCases,
  tagsMemberCases,
} from "./member-case-fixtures.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";

// Seam: Evolution public control plane (request → observe ready/blocked / candidate).

const normalizedTagsSource = `export default {
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
      if (!tags) return { kind: "reject", message: "标签不能为空" };
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, tags },
      };
    }
    return { kind: "reject", message: "未知动作" };
  },
};`;

const panelWithExtraCommand = `export default {
  contribute() {
    return {
      fields: [{ key: "noteMark", label: "备注标记", type: "text" }],
      commands: [
        { id: "markNote", label: "打备注标记", from: ["open"] },
        { id: "sneakyNote", label: "未授权备注", from: ["open"] },
      ],
      uiSlots: [
        {
          id: "note-panel",
          slot: "task.detail",
          title: "备注面板",
          body: "含未授权命令",
          actions: [{ commandId: "markNote", label: "打备注标记" }],
          fields: [{ key: "noteMark", label: "备注标记" }],
        },
      ],
    };
  },
  decide(data) {
    const { task, action } = data;
    if (action === "markNote") {
      if (task.state !== "open")
        return { kind: "reject", message: "仅未完成任务可打备注标记" };
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, noteMark: "ok" },
      };
    }
    if (action === "sneakyNote")
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, noteMark: "sneaky" },
      };
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

async function dualWorkspace(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-coverage-gate-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  await activateDual(w);
  const before = w.composition();
  await w.command({
    type: "create",
    title: "coverage-gate",
    compositionRevision: before.revision,
    operationId: randomUUID(),
  });
  return w;
}

async function freezeTags(
  t: TestContext,
  w: Workspace,
): Promise<{ e: Evolution; freeze: PlanningDriver; runId: string }> {
  const workflowSource = w.activeVersion().source;
  const freeze = new PlanningDriver({
    summary: "冻结标签规范化验收并升级 tags",
    changes: ["升级 tags 辅助成员", "冻结去空格转小写正例与空白拒绝"],
    outcome: "标签保存去空格并转小写，空白标签被拒绝",
    dataImpact: "保留 due 与主工作流精确版本；升级 tags 成员版本",
    memberUpgrades: [{ pluginId: "tags" }],
    memberCases: tagsMemberCases,
    workflowRules: [],
  });
  const driver: Driver = {
    async generate(request: ModelRequest, signal) {
      if (
        request.tools?.some((tool) => tool.name === "submit_candidate") ||
        request.tools?.some((tool) => tool.name === "build_candidate")
      ) {
        const content = JSON.stringify(request.history);
        if (!content.includes("read_contract"))
          return {
            ...toolReply("read_contract", {}),
            history: request.history,
          };
        if (!content.includes("read_current_source"))
          return {
            ...toolReply("read_current_source", {}),
            history: request.history,
          };
        return {
          ...toolReply("submit_candidate", {
            source: workflowSource,
            members: [{ pluginId: "tags", source: normalizedTagsSource }],
          }),
          history: request.history,
        };
      }
      return freeze.generate(request);
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "先冻结标签验收",
    operationId: `plan-freeze-tags-${randomUUID()}`,
  });
  const frozen = await settle(e, "ready");
  assert.equal(frozen.status, "ready");
  if (frozen.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: `start-freeze-tags-${randomUUID()}`,
    runId: frozen.id,
    planId: frozen.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.equal(done.status, "awaiting-apply");
  const candidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(candidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: `apply-freeze-tags-${randomUUID()}`,
    runId: frozen.id,
    candidateId: candidate!.id,
    evidenceHash: candidate!.evidenceHash!,
    compositionRevision: w.composition().revision,
  });
  assert.equal((await settle(e, "succeeded")).status, "succeeded");
  return { e, freeze, runId: frozen.id };
}

test("经公开规划入口：新增辅助成员且不提交成员案例时，计划不能进入 ready", async (t) => {
  const w = await dualWorkspace(t);
  const e = new Evolution(
    w.db,
    new PlanningDriver({
      summary: "叠加备注面板辅助成员",
      changes: ["新增 panel 辅助成员"],
      outcome: "可打备注标记",
      dataImpact: "保留既有成员精确版本；新增 panel",
      memberAdditions: [{ pluginId: "panel", name: "备注面板插件" }],
      workflowRules: [],
    }),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "增加备注面板但不提交成员案例",
    operationId: "plan-add-no-cases",
  });
  const run = await settle(e);
  assert.notEqual(run.status, "ready");
  assert.equal(run.status, "blocked");
  if (run.status !== "blocked") throw new Error("expected blocked");
  assert.match(run.message, /案例|覆盖|验收/);
});

test("经公开规划入口：声明升级成员 A（行为变更）却只提交成员 B 的案例时，计划不能进入 ready", async (t) => {
  const w = await dualWorkspace(t);
  const { e, freeze, runId } = await freezeTags(t, w);
  freeze.finish = {
    summary: "升级 tags 却只提交 due 案例",
    changes: ["升级 tags 辅助成员", "只冻结 due 案例"],
    outcome: "错绑覆盖",
    dataImpact: "升级 tags；提交 due 案例",
    memberUpgrades: [{ pluginId: "tags" }],
    memberCases: dueMemberCases,
    workflowRules: [],
  };
  await e.command({
    type: "continue",
    operationId: "continue-upgrade-a-cases-b",
    runId,
    baseVersion: w.composition().versionId,
    text: "升级标签却只提交截止日期案例",
  });
  const run = await settle(e);
  assert.notEqual(run.status, "ready");
  assert.equal(run.status, "blocked");
  if (run.status !== "blocked") throw new Error("expected blocked");
  assert.match(run.message, /覆盖|案例|升级/);
});

test("经公开规划入口：合法且覆盖完整的新增计划可以进入 ready，并展示业务语言覆盖摘要", async (t) => {
  const w = await dualWorkspace(t);
  const e = new Evolution(
    w.db,
    new PlanningDriver({
      summary: "叠加备注面板并冻结验收",
      changes: ["新增 panel 辅助成员", "冻结 markNote 正反例"],
      outcome: "可打备注标记，已完成任务拒绝",
      dataImpact: "保留既有成员精确版本；新增 panel",
      memberAdditions: [{ pluginId: "panel", name: "备注面板插件" }],
      memberCases: panelMemberCases,
      workflowRules: [],
    }),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "增加备注面板并冻结验收",
    operationId: "plan-add-with-cases",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  if (ready.status !== "ready") throw new Error("expected ready");
  assert.ok(ready.plan.affectedAcceptance?.complete);
  assert.ok(
    ready.plan.affectedAcceptance?.coverageSummary?.some((line) =>
      /打备注标记成功|已完成不可打备注/.test(line),
    ),
    JSON.stringify(ready.plan.affectedAcceptance),
  );
  assert.ok(
    ready.plan.acceptance?.some((line) =>
      /打备注标记成功|已完成不可打备注/.test(line),
    ),
    JSON.stringify(ready.plan.acceptance),
  );
});

test("经公开规划入口：升级成员且无可继承冻结案例时，计划不能进入 ready", async (t) => {
  const w = await dualWorkspace(t);
  const e = new Evolution(
    w.db,
    new PlanningDriver({
      summary: "只升级标签辅助成员",
      changes: ["升级 tags 辅助成员"],
      outcome: "标签写入规范化",
      dataImpact: "升级 tags",
      memberUpgrades: [{ pluginId: "tags" }],
      workflowRules: [],
    }),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "升级标签但没有任何冻结案例基线",
    operationId: "plan-upgrade-no-baseline",
  });
  const run = await settle(e);
  assert.equal(run.status, "blocked");
  if (run.status !== "blocked") throw new Error("expected blocked");
  assert.match(run.message, /缺少可继承|可靠检查器|冻结业务案例/);
});

test("经公开规划入口：omit 且已有历史案例时升级可 ready（as-is 继承）", async (t) => {
  const w = await dualWorkspace(t);
  const { e, freeze, runId } = await freezeTags(t, w);
  freeze.finish = {
    summary: "as-is 再升级 tags",
    changes: ["升级 tags 辅助成员"],
    outcome: "继承历史冻结案例",
    dataImpact: "升级 tags；省略 memberCases",
    memberUpgrades: [{ pluginId: "tags" }],
    workflowRules: [],
  };
  await e.command({
    type: "continue",
    operationId: "continue-upgrade-omit-inherit",
    runId,
    baseVersion: w.composition().versionId,
    text: "再升级标签但不交新案例",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  if (ready.status !== "ready") throw new Error("expected ready");
  assert.ok(ready.plan.memberCases?.some((c) => c.name === "标签去空格转小写"));
  assert.ok(ready.plan.affectedAcceptance?.complete);
});

test("经公开规划入口：只交新名案例时旧案例仍继承，不能悄悄移除", async (t) => {
  const w = await dualWorkspace(t);
  const { e, freeze, runId } = await freezeTags(t, w);
  const renamedOnly = [
    {
      name: "标签另名正例",
      member: "tags",
      state: "open",
      fields: {},
      action: "setTags",
      input: { tags: "  Hi " },
      expected: {
        kind: "commit" as const,
        state: "open",
        fields: { tags: "hi" },
      },
    },
    {
      name: "标签另名拒绝",
      member: "tags",
      state: "open",
      fields: {},
      action: "setTags",
      input: { tags: "   " },
      expected: { kind: "reject" as const },
    },
  ];
  freeze.finish = {
    summary: "升级 tags 并只交新名案例",
    changes: ["升级 tags", "新增另名案例"],
    outcome: "旧案例仍在",
    dataImpact: "升级 tags",
    memberUpgrades: [{ pluginId: "tags" }],
    memberCases: renamedOnly,
    workflowRules: [],
  };
  await e.command({
    type: "continue",
    operationId: "continue-rename-keep-old",
    runId,
    baseVersion: w.composition().versionId,
    text: "只交新名案例",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  if (ready.status !== "ready") throw new Error("expected ready");
  assert.ok(
    ready.plan.memberCases?.some((c) => c.name === "标签去空格转小写"),
    JSON.stringify(ready.plan.memberCases),
  );
  assert.ok(ready.plan.memberCases?.some((c) => c.name === "标签另名正例"));
});

test("经公开规划入口：另名矛盾案例被拒绝，原名修订仍须独立确认", async (t) => {
  const w = await dualWorkspace(t);
  const { e, freeze, runId } = await freezeTags(t, w);
  const revised = {
    ...tagsMemberCases[0],
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { tags: "Hello" },
    },
  };
  freeze.finish = {
    summary: "标签改为保留大小写",
    changes: ["升级 tags"],
    outcome: "保留大小写",
    dataImpact: "升级 tags",
    memberUpgrades: [{ pluginId: "tags" }],
    memberCases: [{ ...revised, name: "另名保留大小写" }, tagsMemberCases[1]],
    acceptanceReason: "用户要求标签保留大小写",
    workflowRules: [],
  };
  await e.command({
    type: "continue",
    operationId: "conflicting-cases",
    runId,
    baseVersion: w.composition().versionId,
    text: "标签保留大小写",
  });
  const blocked = await settle(e);
  assert.equal(blocked.status, "blocked", JSON.stringify(blocked));
  assert.match(blocked.message, /案例.*冲突/);
  freeze.finish = {
    ...freeze.finish,
    memberCases: [revised, tagsMemberCases[1]],
  };
  await e.command({
    type: "continue",
    operationId: "revise-original-case",
    runId: blocked.id,
    baseVersion: w.composition().versionId,
    text: "沿用原案例名修订预期",
  });
  const pending = await settle(e);
  assert.equal(pending.status, "awaiting-acceptance", JSON.stringify(pending));
  if (pending.status !== "awaiting-acceptance")
    throw new Error("expected confirmation");
  assert.ok(
    pending.plan.acceptanceChanges?.some((c) => c.rule === revised.name),
  );
  await assert.rejects(
    e.command({
      type: "start",
      operationId: "premature-conflict-start",
      runId: pending.id,
      planId: pending.plan.id,
    }),
  );
  const confirmed = await e.command({
    type: "confirm-acceptance",
    operationId: "confirm-case-revision",
    runId: pending.id,
    planId: pending.plan.id,
    revisionId: pending.acceptanceRevision!.id,
  });
  assert.equal(confirmed.run?.status, "ready");
});

test("经公开规划入口：同触发冲突可在原预算修正，对象键顺序不影响识别", async (t) => {
  for (const mode of ["member", "extension"] as const)
    await t.test(mode, async (t) => {
      const w = await dualWorkspace(t);
      const positive = {
        name: "正例",
        member: "panel",
        state: "open",
        fields: { a: "1", b: "2" },
        action: "markNote",
        input: { x: "3", y: "4" },
        expected: {
          kind: "commit" as const,
          state: "open",
          fields: { a: "1", b: "2", noteMark: "ok" },
        },
      };
      const negative = {
        ...positive,
        name: "拒绝",
        state: "done",
        expected: { kind: "reject" as const },
      };
      const conflict = {
        ...positive,
        name: "矛盾",
        fields: { b: "2", a: "1" },
        input: { y: "4", x: "3" },
        expected: { kind: "reject" as const },
      };
      const casePlan = (
        cases: import("../../src/shared/acceptance-cases.js").MemberAcceptanceCase[],
      ) =>
        mode === "member"
          ? {
              memberAdditions: [{ pluginId: "panel", name: "备注面板" }],
              memberCases: cases,
            }
          : {
              extensions: {
                actions: [{ id: "markNote", label: "备注", from: ["open"] }],
                fields: [{ key: "noteMark", label: "备注", type: "text" }],
                cases: cases.map(({ member: _member, ...c }) =>
                  c.name === "矛盾" ? { ...c, member: "ignored" } : c),
              },
            };
      const planning = new PlanningDriver({
        workflowRules: [],
        ...casePlan([positive, negative, conflict]),
      });
      const driver: Driver = {
        async generate(request) {
          const response = await planning.generate(request);
          if (response.calls.some((c) => c.name === "propose_plan"))
            planning.finish = {
              workflowRules: [],
              ...casePlan([
                positive,
                negative,
                { ...positive, name: "同义正例" },
              ]),
            };
          return response;
        },
      };
      const e = new Evolution(w.db, driver, new EvolutionDomain(w));
      t.after(() => e.close());
      await e.command({
        type: "request",
        operationId: "conflicting-same-request",
        text: "增加备注动作",
      });
      const ready = await settle(e);
      assert.equal(ready.status, "ready", JSON.stringify(ready));
      assert.equal(ready.budget?.callsUsed, 4);
      assert.match(JSON.stringify(planning.requests), /业务案例冲突/);
      assert.equal(w.composition().revision, 2);
    });
});

test("经公开规划入口：新增成员注册未覆盖的额外命令时候选失败且正式组合不变", async (t) => {
  const w = await dualWorkspace(t);
  const before = w.composition();
  const planning = new PlanningDriver({
    summary: "叠加备注面板并冻结验收",
    changes: ["新增 panel 辅助成员", "冻结 markNote 正反例"],
    outcome: "可打备注标记",
    dataImpact: "新增 panel",
    memberAdditions: [{ pluginId: "panel", name: "备注面板插件" }],
    memberCases: panelMemberCases,
  });
  const e = new Evolution(
    w.db,
    new ExecutionDriver(planning, "aux-workflow", "双贡献组合", 1, [
      { pluginId: "panel", source: panelWithExtraCommand },
    ]),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "增加备注面板但实现多注册命令",
    operationId: "plan-add-unauthorized-command",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-add-unauthorized-command",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const finished = await settle(e);
  assert.notEqual(finished.status, "awaiting-apply");
  assert.equal(w.composition().versionId, before.versionId);
  const diagnostic =
    (await e.observe()).candidates?.find((c) => c.diagnostic)?.diagnostic ??
    ("message" in finished ? finished.message : "");
  assert.match(diagnostic, /未授权动作|sneakyNote/);
});

test("合法 panel 源码仍可通过候选授权核对", async (t) => {
  const w = await dualWorkspace(t);
  const panelSource = await panelPluginCode();
  const planning = new PlanningDriver({
    summary: "叠加备注面板并冻结验收",
    changes: ["新增 panel"],
    outcome: "可打备注",
    dataImpact: "新增 panel",
    memberAdditions: [{ pluginId: "panel", name: "备注面板插件" }],
    memberCases: panelMemberCases,
  });
  const e = new Evolution(
    w.db,
    new ExecutionDriver(planning, "aux-workflow", "双贡献组合", 1, [
      { pluginId: "panel", source: panelSource },
    ]),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "增加合法备注面板",
    operationId: "plan-add-panel-ok-auth",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-add-panel-ok-auth",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.equal(done.status, "awaiting-apply", JSON.stringify(done));
});

test("辅助成员不得导入工作流契约", async (t) => {
  const w = await dualWorkspace(t);
  const panelSource = 'import type { Plugin } from "./contract.js";\n' + await panelPluginCode();
  const planning = new PlanningDriver({
    summary: "叠加备注面板并冻结验收",
    changes: ["新增 panel"],
    outcome: "可打备注",
    dataImpact: "新增 panel",
    memberAdditions: [{ pluginId: "panel", name: "备注面板插件" }],
    memberCases: panelMemberCases,
  });
  const e = new Evolution(
    w.db,
    new ExecutionDriver(planning, "aux-workflow", "双贡献组合", 1, [
      { pluginId: "panel", source: panelSource },
    ]),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "增加合法备注面板",
    operationId: "plan-add-panel-ok-auth",
  });
  const ready = await settle(e, "ready");
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-add-panel-ok-auth",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e);
  assert.equal(done.status, "blocked", JSON.stringify(done));
  assert.match(done.message, /未授权类型或运行依赖.*contract/);
  assert.equal(w.composition().revision, 2);
});
