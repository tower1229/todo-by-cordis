import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { verifyViaIsolatedWorkspace } from "../../src/server/workspace-acceptance.js";
import {
  BrowserAssertionError,
  BrowserEnvironmentError,
  browserEnvironment,
  verifyBrowser,
} from "../../src/server/browser-acceptance.js";
import { Evolution } from "./evolution-adapter.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import type { BrowserCase } from "../../src/shared/browser-cases.js";
import type { Requirement, AssistantRun } from "../../src/shared/assistant.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import type { Driver } from "../../src/evolution/driver.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import { activateWorkflowOnly } from "./dual-composition-fixture.js";
import { panelMemberCases } from "./member-case-fixtures.js";
import { panelPluginCode } from "../fixtures/member-ui.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import { ExecutionDriver } from "./execution-fixture.js";

async function workspace(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "browser-gate-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  await activateWorkflowOnly(w);
  t.after(async () => {
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  return w;
}
async function settle(e: Evolution): Promise<AssistantRun> {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const run = (await e.observe()).run!;
    if (!["planning", "executing", "applying"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timeout: ${JSON.stringify((await e.observe()).run)}`);
}

test("归档真实重要标记候选：后端通过，默认普通的真实页面断言失败并保留截图", async (t) => {
  const w = await workspace(t);
  const base = w.activeVersion();
  const before = { tasks: w.query(), composition: w.composition() };
  const source = await readFile(
    new URL("../fixtures/important-marker-archived.mjs", import.meta.url),
    "utf8",
  );
  const archived = JSON.parse(
    await readFile(
      new URL("../fixtures/important-marker-cases.json", import.meta.url),
      "utf8",
    ),
  ) as { cases: MemberAcceptanceCase[] };
  const member = w.release.record({
    pluginId: "important-marker",
    name: "重要标记",
    service: "plugin:important-marker",
    contractVersion: "extensions/1",
    source,
    code: source,
    definition: {},
    evidence: { passed: true, origin: "real-api-archive-regression" },
  });
  const candidate = w.release.record({
    pluginId: base.pluginId,
    name: base.name,
    source: base.source,
    code: base.code,
    definition: base.definition,
    service: base.service,
    contractVersion: base.contractVersion,
    parentId: base.id,
    evidence: { passed: false },
    members: [
      { pluginId: base.pluginId, role: "workflow", enabled: true },
      {
        pluginId: member.pluginId,
        versionId: member.id,
        role: "auxiliary",
        enabled: true,
      },
    ],
  });
  const checks = await verifyViaIsolatedWorkspace(
    w,
    candidate,
    archived.cases,
    new AbortController().signal,
  );
  assert.ok(checks.length > 0);
  const cases: BrowserCase[] = ["existing", "new"].map((task) => ({
    id: `default-${task}`,
    task: task as "existing" | "new",
    steps: [
      {
        kind: "field",
        member: "important-marker",
        contribution: "important-detail",
        field: "isImportant",
        value: "普通",
      },
    ],
  }));
  let screenshots: string[] = [];
  await assert.rejects(
    verifyBrowser(
      w,
      candidate,
      base,
      cases,
      [],
      "archived-default-ordinary",
      new AbortController().signal,
    ),
    (error: unknown) => {
      assert.ok(error instanceof BrowserAssertionError);
      const failed = error.evidence.results.filter(
        (r) => r.status === "failed",
      );
      assert.equal(failed.length, 4);
      assert.ok(failed.every((r) => r.actual === "（空）"));
      screenshots = failed.map((r) => r.screenshot!);
      return true;
    },
  );
  for (const path of screenshots) await access(path);
  assert.deepEqual({ tasks: w.query(), composition: w.composition() }, before);
  await assert.rejects(
    w.activate({
      versionId: candidate.id,
      compositionRevision: before.composition.revision,
      operationId: "cannot-apply",
    }),
    /验收|验证|已发布/,
  );
});

for (const candidateLimit of [3, 1])
  test(
    candidateLimit === 3
      ? "模型桩修正闭环：首候选后端通过但字段未展示，第二候选在同一冻结要求和预算内通过浏览器"
      : "浏览器业务失败耗尽候选预算后保留失败证据，不重置预算或开放应用（模型桩）",
    async (t) => {
      const w = await workspace(t);
      const before = { tasks: w.query(), composition: w.composition() };
      const good = await panelPluginCode();
      const bad = good.replace(
        'fields: [{ key: "noteMark", label: "备注标记" }]',
        "fields: []",
      );
      const browserCases: BrowserCase[] = [
        {
          id: "panel-display",
          task: "existing",
          steps: [
            {kind: "task"},
            {
              kind: "action-visible",
              member: "panel",
              contribution: "note-panel",
              action: "markNote",
              visible: true,
            },
            { kind: "action", member: "panel", action: "markNote", input: {} },
            {
              kind: "field",
              member: "panel",
              contribution: "note-panel",
              field: "noteMark",
              value: "ok",
            },
            {
              kind: "edit",
              title: "修改后的任务",
              description: "隔离验收备注",
            },
            { kind: "refresh" },
            { kind: "restart" },
            {
              kind: "field",
              member: "panel",
              contribution: "note-panel",
              field: "noteMark",
              value: "ok",
            },
            {
              kind: "task",
              title: "修改后的任务",
              description: "隔离验收备注",
            },
          ],
        },
      ];
      const planning = new PlanningDriver({
        workflowRules: [],
        writableScope: ["active-source"],
        memberAdditions: [{ pluginId: "panel", name: "备注面板" }],
        memberCases: panelMemberCases,
        browserCases,
      });
      const definition = {
        ...(w.activeVersion().definition as Record<string, unknown>),
        name: w.activeVersion().name,
      };
      const workflow = `import type { Plugin } from "./contract.js";
  const plugin: Plugin = { describe: () => (${JSON.stringify(definition)}), decide({task, action}) {
    if ((action === "complete" && task.state !== "open") || (action === "reopen" && task.state !== "done") || !["complete", "reopen"].includes(action)) return {kind:"reject", message:"不可用"};
    return {kind:"commit", state:action === "complete" ? "done" : "open", fields:task.fields};
  } }; export default plugin;`;
      let submitted = 0;
      const driver: Driver = {
        async generate(request) {
          if (request.tools?.some((tool) => tool.name === "submit_candidate")) {
            if (!JSON.stringify(request.history).includes("read_contract"))
              return toolReply("read_contract", {});
            if (
              !JSON.stringify(request.history).includes("read_current_source")
            )
              return {
                ...toolReply("read_current_source", {}),
                history: request.history,
              };
            return {
              ...toolReply("submit_candidate", {
                source: workflow,
                members: [
                  { pluginId: "panel", source: submitted++ === 0 ? bad : good },
                ],
              }),
              history: request.history,
            };
          }
          const reply = await planning.generate(request);
          if (reply.calls[0]?.name === "propose_plan") {
            const r = (reply.calls[0].args.requirements as Requirement[])[0];
            r.type = "interface";
            r.checks = [{ checker: "browser/1", caseId: "panel-display" }];
          }
          return reply;
        },
      };
      const e = new Evolution(w.db, driver, new EvolutionDomain(w), {
        calls: 12,
        candidates: candidateLimit,
        milliseconds: 600000,
      });
      t.after(() => e.close());
      await e.command({
        type: "request",
        text: "打备注标记后在详情显示字段，刷新重启和编辑保留",
        operationId: "request",
      });
      const ready = await settle(e);
      assert.equal(ready.status, "ready", JSON.stringify(ready));
      if (ready.status !== "ready") throw new Error("expected ready");
      const seal = ready.plan.requirementGate!.seal;
      await e.command({
        type: "start",
        runId: ready.id,
        planId: ready.plan.id,
        operationId: "start",
      });
      const finished = await settle(e);
      assert.equal(
        finished.status,
        candidateLimit === 3 ? "awaiting-apply" : "failed",
        JSON.stringify(finished),
      );
      const candidates = (await e.observe()).candidates!;
      assert.equal(candidates.length, candidateLimit === 3 ? 2 : 1);
      assert.equal(candidates[0].passed, false);
      assert.match(candidates[0].diagnostic!, /browser\/1/);
      const failedBackend = w.release.get(candidates[0].versionId!)
        .evidence as {
        workspaceCases: { status: string }[];
      };
      assert.ok(failedBackend.workspaceCases.length);
      assert.ok(
        failedBackend.workspaceCases.every((c) => c.status === "passed"),
      );
      assert.ok(
        candidates[0].browser?.results.some(
          (r) => r.status === "failed" && r.requirementIds.length,
        ),
      );
      if (candidateLimit === 1) {
        assert.equal(finished.budget?.candidatesRemaining, 0);
        assert.equal(candidates[0].requirementSeal, seal);
        assert.deepEqual(
          { tasks: w.query(), composition: w.composition() },
          before,
        );
        await assert.rejects(
          e.command({
            type: "apply",
            runId: finished.id,
            candidateId: candidates[0].id,
            evidenceHash: "failed",
            compositionRevision: before.composition.revision,
            operationId: "exhausted-apply",
          }),
          /候选|状态|应用/,
        );
        return;
      }
      assert.equal(candidates[1].passed, true);
      assert.equal(candidates[1].requirementSeal, seal);
      assert.equal(finished.budget?.candidatesRemaining, 1);
      assert.ok(finished.budget!.callsUsed <= 12);
      assert.deepEqual(
        { tasks: w.query(), composition: w.composition() },
        before,
      );
      // A forged requirement summary cannot authorize application of the passed candidate.
      await assert.rejects(
        e.command({
          type: "apply",
          runId: finished.id,
          candidateId: candidates[0].id,
          evidenceHash: "failed-browser-evidence",
          compositionRevision: before.composition.revision,
          operationId: "reject-first-candidate",
        }),
        /候选|证据/,
      );
      const row = w.db
        .prepare("SELECT body FROM evolution_runs WHERE id=?")
        .get(finished.id)!;
      const stored = JSON.parse(String(row.body)) as {
        run: { plan: { requirementGate: { seal: string } } };
      };
      stored.run.plan.requirementGate.seal = "forged";
      w.db
        .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
        .run(JSON.stringify(stored), finished.id);
      await assert.rejects(
        e.command({
          type: "apply",
          runId: finished.id,
          candidateId: candidates[1].id,
          evidenceHash: candidates[1].evidenceHash!,
          compositionRevision: before.composition.revision,
          operationId: "forged-apply",
        }),
        /冻结|需求/,
      );
    },
  );

test("缺少浏览器或构建时只阻塞自迭代；浏览器契约禁止任意脚本和 URL", async (t) => {
  const w = await workspace(t);
  const env = browserEnvironment(
    "/definitely-missing-frontend",
    "/definitely-missing-chromium",
  );
  assert.equal(env.missing.length, 2);
  class UnavailableDomain extends EvolutionDomain {
    override context() {
      const context = super.context();
      context.environment.browser = env;
      return context;
    }
  }
  const e = new Evolution(w.db, new PlanningDriver(), new UnavailableDomain(w));
  t.after(() => e.close());
  await e.command({
    type: "request",
    text: "改进应用",
    operationId: "request",
  });
  const run = await settle(e);
  assert.equal(run.status, "blocked");
  assert.match("message" in run ? run.message : "", /browser\/1|环境/);
  const result = await w.command({
    type: "create",
    operationId: "ordinary-todo",
    compositionRevision: w.composition().revision,
    title: "普通 Todo 仍可用",
  });
  assert.ok(result.task);
  for (const step of [
    { kind: "script", code: "fetch('https://example.com')" },
    { kind: "open", url: "https://example.com" },
    {
      kind: "field",
      member: "panel",
      contribution: "note-panel",
      field: "noteMark",
      value: "ok",
      selector: "body",
    },
  ])
    assert.throws(
      () => parseBrowserCases([{ id: "unsafe", task: "new", steps: [step] }]),
      /browser\/1/,
    );
});

test("浏览器数据案例通过真实动作表单验证错误、提交、刷新和重启后的可见字段", async (t) => {
  const w = await workspace(t);
  const base = w.activeVersion();
  const before = { tasks: w.query(), composition: w.composition() };
  const source = (await panelPluginCode())
    .replace(
      'actions: [{ commandId: "markNote", label: "打备注标记" }]',
      "actions: []",
    )
    .replace(
      "const { task, action } = data;",
      "const { task, action, input } = data;",
    )
    .replace(
      'if (task.state !== "open")',
      `if (!Object.hasOwn(input ?? {}, 'noteMark')) return { kind: 'input-required', fields: [{key:'noteMark',label:'备注标记',type:'text',required:true}] };
      if (input.noteMark === 'bad') return {kind:'reject',message:'拒绝 bad 标记'};
      if (task.state !== "open")`,
    )
    .replace('noteMark: "ok"', "noteMark: input.noteMark.trim()");
  const member = w.release.record({
    pluginId: "panel",
    name: "表单备注",
    service: "plugin:panel",
    contractVersion: "extensions/1",
    source,
    code: source,
    definition: {},
    evidence: { passed: true, origin: "browser-form-fixture" },
  });
  const candidate = w.release.record({
    pluginId: base.pluginId,
    name: base.name,
    source: base.source,
    code: base.code,
    definition: base.definition,
    service: base.service,
    contractVersion: base.contractVersion,
    parentId: base.id,
    evidence: { passed: false },
    members: [
      { pluginId: base.pluginId, role: "workflow", enabled: true },
      {
        pluginId: "panel",
        versionId: member.id,
        role: "auxiliary",
        enabled: true,
      },
    ],
  });
  const cases: BrowserCase[] = [
    {
      id: "real-form",
      task: "new",
      steps: [
        {
          kind: "action",
          member: "panel",
          action: "markNote",
          input: { noteMark: "bad" },
        },
        { kind: "error", text: "拒绝 bad 标记" },
        { kind: "open" },
        {
          kind: "action",
          member: "panel",
          action: "markNote",
          input: { noteMark: "bad" },
        },
        // No product copy requirement: the same checker asserts a visible error.
        { kind: "error", text: "" },
        { kind: "open" },
        {
          kind: "action",
          member: "panel",
          action: "markNote",
          input: { noteMark: "  saved  " },
        },
        {
          kind: "field",
          member: "panel",
          contribution: "note-panel",
          field: "noteMark",
          value: "saved",
        },
        { kind: "refresh" },
        { kind: "restart" },
        {
          kind: "field",
          member: "panel",
          contribution: "note-panel",
          field: "noteMark",
          value: "saved",
        },
      ],
    },
  ];
  const evidence = await verifyBrowser(
    w,
    candidate,
    base,
    cases,
    [],
    "form-fixture",
    new AbortController().signal,
  );
  assert.equal(evidence.results.length, 6);
  assert.ok(evidence.results.every((result) => result.status === "passed"));
  assert.deepEqual({ tasks: w.query(), composition: w.composition() }, before);
});

test("取消真实浏览器检查会释放浏览器、隔离服务和工作区并保留证据", async (t) => {
  const w = await workspace(t);
  const base = w.activeVersion();
  const root = resolve(".runtime/browser-acceptance");
  const before = new Set(await readdir(root));
  const controller = new AbortController();
  const checking = verifyBrowser(
    w,
    base,
    base,
    [
      {
        id: "cancel-field",
        task: "new",
        steps: [
          {
            kind: "field",
            member: "missing",
            contribution: "missing",
            field: "missing",
            value: "expected",
          },
        ],
      },
    ],
    [],
    "cancel-test",
    controller.signal,
  ).catch((error: unknown) => error);
  let directory: string | undefined;
  let checkingStarted = false;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const created = (await readdir(root)).find(
      (name) => name.startsWith(base.id) && !before.has(name),
    );
    if (created) {
      directory = join(root, created);
      try {
        const evidence = JSON.parse(
          await readFile(join(directory, "evidence.json"), "utf8"),
        ) as { results: unknown[] };
        if (evidence.results.length >= 2) {
          checkingStarted = true;
          break;
        }
      } catch {
        /* The first receipt is written after opening the page. */
      }
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  controller.abort(new Error("browser-cancel-test"));
  const error = await checking;
  assert.ok(checkingStarted && directory);
  assert.ok(error instanceof Error);
  assert.match(error.message, /browser-cancel-test/);
  const cleanup = JSON.parse(
    await readFile(join(directory, "cleanup.json"), "utf8"),
  );
  assert.deepEqual(cleanup, {
    browserClosed: true,
    serviceClosed: true,
    workspaceClosed: true,
    aborted: true,
  });
  assert.equal(
    JSON.parse(await readFile(join(directory, "failure.json"), "utf8"))
      .cancelled,
    true,
  );
  assert.equal(w.query().total, 0);
});

test("检查器故障单独阻塞，不让模型修业务源码或重置候选预算（故障桩）", async (t) => {
  const w = await workspace(t);
  const before = { tasks: w.query(), composition: w.composition() };
  class FaultDomain extends EvolutionDomain {
    override async candidate() {
      throw new BrowserEnvironmentError("browser/1 检查器故障桩");
    }
  }
  const e = new Evolution(
    w.db,
    new ExecutionDriver(new PlanningDriver(), "aux-workflow", "双贡献组合"),
    new FaultDomain(w),
  );
  t.after(() => e.close());
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "start",
  });
  const finished = await settle(e);
  assert.equal(finished.status, "blocked");
  assert.equal(finished.budget?.candidatesRemaining, 2);
  const candidates = (await e.observe()).candidates!;
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].passed, false);
  assert.match(candidates[0].diagnostic!, /检查器故障桩/);
  assert.deepEqual({ tasks: w.query(), composition: w.composition() }, before);
});

test("公开取消浏览器验收后候选仍可定位部分检查和清理证据（模型桩）", async (t) => {
  const w = await workspace(t);
  const before = { tasks: w.query(), composition: w.composition() };
  const planning = new PlanningDriver({
    browserCases: [
      {
        id: "wait-for-cancel",
        task: "new",
        steps: [
          {
            kind: "field",
            member: "workflow",
            contribution: "workflow",
            field: "reflection",
            value: "waiting",
          },
        ],
      },
    ],
  });
  const e = new Evolution(
    w.db,
    new ExecutionDriver(planning, "aux-workflow", "双贡献组合"),
    new EvolutionDomain(w),
  );
  t.after(() => e.close());
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "start",
  });
  const deadline = Date.now() + 10000;
  let browserStarted = false;
  while (Date.now() < deadline) {
    const snapshot = await e.observe();
    if (
      snapshot.run?.steps?.some(
        (step) => step.label === "浏览器验收" && step.status === "running",
      )
    ) {
      browserStarted = true;
      break;
    }
    await new Promise((done) => setTimeout(done, 20));
  }
  assert.ok(browserStarted);
  await e.command({ type: "cancel", runId: ready.id, operationId: "cancel" });
  await e.close();
  const snapshot = await e.observe();
  assert.equal(snapshot.run?.status, "cancelled");
  assert.equal(snapshot.candidates?.length, 1);
  const attempt = snapshot.candidates![0];
  assert.equal(attempt.passed, false);
  assert.match(attempt.diagnostic!, /取消/);
  assert.ok(attempt.versionId && attempt.browser?.directory);
  const failure = JSON.parse(
    await readFile(join(attempt.browser.directory, "failure.json"), "utf8"),
  );
  assert.equal(failure.cancelled, true);
  const cleanup = JSON.parse(
    await readFile(join(attempt.browser.directory, "cleanup.json"), "utf8"),
  );
  assert.deepEqual(cleanup, {
    browserClosed: true,
    serviceClosed: true,
    workspaceClosed: true,
    aborted: true,
  });
  assert.deepEqual({ tasks: w.query(), composition: w.composition() }, before);
});
