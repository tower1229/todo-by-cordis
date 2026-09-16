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

// Seam: Evolution public control plane (request → observe ready/blocked).
// Issue #31 PR1 — lock coverage gaps before the gate is repaired.

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

const panelCases = [
  {
    name: "打备注标记成功",
    member: "panel",
    state: "open",
    fields: {},
    action: "markNote",
    input: {},
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { noteMark: "ok" },
    },
  },
  {
    name: "已完成不可打备注",
    member: "panel",
    state: "done",
    fields: {},
    action: "markNote",
    input: {},
    expected: { kind: "reject" as const },
  },
];

const tagsMemberCases = [
  {
    name: "标签去空格转小写",
    member: "tags",
    state: "open",
    fields: {},
    action: "setTags",
    input: { tags: "  Hello " },
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { tags: "hello" },
    },
  },
  {
    name: "空白标签拒绝",
    member: "tags",
    state: "open",
    fields: {},
    action: "setTags",
    input: { tags: "   " },
    expected: { kind: "reject" as const },
  },
];

const dueMemberCases = [
  {
    name: "设置截止日期成功",
    member: "due",
    state: "open",
    fields: {},
    action: "setDue",
    input: { dueAt: "2026-09-20T00:00:00Z" },
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { dueAt: "2026-09-20T00:00:00Z" },
    },
  },
  {
    name: "已完成不可设截止",
    member: "due",
    state: "done",
    fields: {},
    action: "setDue",
    input: { dueAt: "2026-09-21T00:00:00Z" },
    expected: { kind: "reject" as const },
  },
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
  assert.notEqual(
    run.status,
    "ready",
    "缺口回归：无成员案例的新增不应进入 ready",
  );
  assert.equal(run.status, "blocked");
  if (run.status !== "blocked") throw new Error("expected blocked");
  assert.match(run.message, /案例|覆盖|验收/);
});

test("经公开规划入口：声明升级成员 A（行为变更）却只提交成员 B 的案例时，计划不能进入 ready", async (t) => {
  const w = await dualWorkspace(t);
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
          return { ...toolReply("read_contract", {}), history: request.history };
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
      return freeze.generate(request, signal);
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "先冻结标签验收",
    operationId: "plan-freeze-tags-for-mismatch",
  });
  const frozen = await settle(e, "ready");
  assert.equal(frozen.status, "ready");
  if (frozen.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-freeze-tags-for-mismatch",
    runId: frozen.id,
    planId: frozen.plan.id,
  });
  const done = await settle(e, "awaiting-apply");
  assert.equal(done.status, "awaiting-apply");
  const candidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(candidate?.evidenceHash);
  await e.command({
    type: "apply",
    operationId: "apply-freeze-tags-for-mismatch",
    runId: frozen.id,
    candidateId: candidate!.id,
    evidenceHash: candidate!.evidenceHash!,
    compositionRevision: w.composition().revision,
  });
  assert.equal((await settle(e, "succeeded")).status, "succeeded");

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
    runId: frozen.id,
    baseVersion: w.composition().versionId,
    text: "升级标签却只提交截止日期案例",
  });
  const run = await settle(e);
  assert.notEqual(
    run.status,
    "ready",
    "缺口回归：升级 A 却只提交 B 的案例不应进入 ready",
  );
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
      memberCases: panelCases,
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
