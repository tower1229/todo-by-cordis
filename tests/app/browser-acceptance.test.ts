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
import {
  parseBrowserCases,
  parseRequirements,
  coverage,
} from "../../src/server/requirement-coverage.js";
import { compileReferences } from "../../src/evolution/references.js";
import { ExecutionDriver } from "./execution-fixture.js";
import { hash } from "../../src/release/storage.js";

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

test("宿主编译的表单矩阵通过真实 Chromium：原生必填、空白、Unicode长度及重新打开（模型桩）",async(t)=>{
 const w=await workspace(t);const before={tasks:w.query(),composition:w.composition()};
 const planning=new PlanningDriver({workflowRules:[{key:"reflection",label:"复盘",required:true,minLength:2,maxLength:5000}]});
 const e=new Evolution(w.db,new ExecutionDriver(planning,"aux-workflow","双贡献组合",2),new EvolutionDomain(w));t.after(()=>e.close());
 await e.command({type:"request",text:"完成前复盘必填，去空白后2至5000个Unicode码点，重新打开保留",operationId:"request"});
 const ready=await settle(e);assert.equal(ready.status,"ready");if(ready.status!=="ready")throw new Error("未就绪");
 assert.ok(ready.plan.browserCases?.some(c=>c.steps.some(s=>s.kind==="form-invalid")));
 await e.command({type:"start",runId:ready.id,planId:ready.plan.id,operationId:"start"});const done=await settle(e);assert.equal(done.status,"awaiting-apply");
 const candidate=(await e.observe()).candidates!.find(c=>c.passed)!;assert.ok(candidate.browser?.results.every(r=>r.status==="passed"));assert.ok(candidate.browser?.results.some(r=>r.caseId.includes("workflow-input")));
 assert.deepEqual({tasks:w.query(),composition:w.composition()},before);
});

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
  const sources = [
    { id: "archive:1", text: "重要标记，新旧任务默认普通，标记后显示重要" },
  ];
  const compiled = compileReferences(
    {
      workflowRules: [],
      memberCases: archived.cases,
      browserCases: [],
      requirements: [
        {
          id: "default-ordinary",
          source: 1,
          sourceQuote: sources[0].text,
          description: sources[0].text,
          type: "interface",
          checks: [],
          obligations: [
            {
              kind: "field",
              field: "isImportant",
              initial: { kind: "visible", value: "普通" },
              scenarios: [
                {
                  steps: [
                    { kind: "action", action: "markImportant", input: {} },
                  ],
                  value: "重要",
                },
              ],
            },
          ],
        },
      ],
    },
    sources,
    [],
    { id: base.pluginId, actions: [{ id: "complete" }, { id: "reopen" }] },
  );
  const cases = parseBrowserCases(compiled.browserCases);
  const requirements = parseRequirements(compiled.requirements);
  assert.ok(
    coverage(
      {
        requirements,
        browserCases: cases,
        cases: [],
      } as unknown as import("../../src/shared/assistant.js").InvestigatedPlan,
      sources,
      ["browser/1"],
    )[0].reasons.length === 0,
  );
  let screenshots: string[] = [];
  await assert.rejects(
    verifyBrowser(
      w,
      candidate,
      base,
      cases,
      requirements,
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
      assert.ok(
        failed.every(
          (r) =>
            r.caseId.includes("initial-") &&
            r.obligationId &&
            r.requirementIds.includes("default-ordinary"),
        ),
      );
      assert.ok(
        error.evidence.results
          .filter((r) => r.caseId.includes("after-"))
          .every((r) => r.status === "passed"),
      );
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
            { kind: "task" },
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
            r.obligations = [
              ...(r.obligations??[]),
              {
                kind: "field",
                field: "noteMark",
                initial: { kind: "visible", value: "（空）" },
                scenarios: [
                  {
                    steps: [{ kind: "action", action: "markNote", input: {} }],
                    value: "ok",
                  },
                ],
              },
            ] as unknown as Requirement["obligations"];
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
  assert.match(
    "message" in run ? run.message : "",
    /browser\/1|环境|预检缺少依赖或检查器/,
  );
  assert.equal(run.budget?.callsUsed, 0);
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

for (const faultyBase of [false, true])
  test(
    faultyBase
      ? "基础版本历史准备失败独立归类为环境/夹具故障并保留证据"
      : "历史数据由基础页面真实动作准备，候选只改变后续动作，旧值跨刷新重启保留",
    async (t) => {
      const w = await workspace(t);
      const workflow = w.activeVersion();
      const oldSource = await panelPluginCode();
      const recordPanel = (source: string) =>
        w.release.record({
          pluginId: "panel",
          name: "历史面板",
          service: "plugin:panel",
          contractVersion: "extensions/1",
          source,
          code: source,
          definition: {},
          evidence: { passed: true, origin: "historical-fixture" },
        });
      const old = recordPanel(
        faultyBase
          ? oldSource.replace('noteMark: "ok"', 'noteMark: "unexpected"')
          : oldSource,
      );
      const compose = (memberId: string, parentId?: string) =>
        w.release.record({
          pluginId: workflow.pluginId,
          name: workflow.name,
          service: workflow.service,
          contractVersion: workflow.contractVersion,
          source: workflow.source,
          code: workflow.code,
          definition: workflow.definition,
          evidence: { passed: !parentId, origin: "historical-fixture" },
          ...(parentId ? { parentId } : {}),
          members: [
            { pluginId: workflow.pluginId, role: "workflow", enabled: true },
            {
              pluginId: "panel",
              role: "auxiliary",
              enabled: true,
              versionId: memberId,
            },
          ],
        });
      const base = compose(old.id);
      await w.activate(
        {
          versionId: base.id,
          compositionRevision: w.composition().revision,
          operationId: "historical-fixture-base",
        },
        () => undefined,
      );
      const before = { tasks: w.query(), composition: w.composition() };
      const updated = recordPanel(
        oldSource.replace('noteMark: "ok"', 'noteMark: "reviewed"'),
      );
      const candidate = compose(updated.id, base.id);
      const updatedCases = panelMemberCases.map((c) => ({
        ...c,
        expected:
          c.expected.kind === "commit"
            ? { ...c.expected, fields: { noteMark: "reviewed" } }
            : c.expected,
      }));
      const sources = [
        {
          id: "history:1",
          text: "原标记不自动替换，新动作写 reviewed，详情刷新重启保留",
        },
      ];
      const compiled = compileReferences(
        {
          workflowRules: [],
          memberCases: updatedCases,
          browserCases: [],
          requirements: [
            {
              id: "identity",
              source: 1,
              sourceQuote: sources[0].text,
              description: "界面身份沿用基线",
              type: "interface",
              checks: [],
              obligations: [{ kind: "preserve-ui" }],
            },
            {
              id: "history",
              source: 1,
              sourceQuote: sources[0].text,
              description: sources[0].text,
              type: "interface",
              checks: [],
              obligations: [
                {
                  kind: "field",
                  field: "noteMark",
                  initial: { kind: "visible", value: "（空）" },
                  scenarios: [
                    {
                      steps: [
                        { kind: "action", action: "markNote", input: {} },
                      ],
                      value: "reviewed",
                    },
                  ],
                },
                { kind: "history", field: "noteMark" },
              ],
            },
          ],
        },
        sources,
        [],
        {
          id: workflow.pluginId,
          actions: [{ id: "complete" }, { id: "reopen" }],
        },
        {
          memberCases: panelMemberCases,
          baseVersion: base.id,
          uiContributions: [
            {
              id: "note-panel",
              providerId: "panel",
              fields: [{ key: "noteMark" }],
              actions: [{ commandId: "markNote" }],
            },
          ],
        },
      );
      const cases = parseBrowserCases(compiled.browserCases);
      const checking = verifyBrowser(
        w,
        candidate,
        base,
        cases,
        parseRequirements(compiled.requirements),
        "history-definition",
        new AbortController().signal,
      );
      if (faultyBase) {
        await assert.rejects(checking, (error: unknown) => {
          assert.ok(error instanceof BrowserEnvironmentError);
          assert.match(error.message, /历史准备失败/);
          assert.equal(error.evidence!.preparations![0].status, "failed");
          assert.equal(
            error.evidence!.preparations![0].actual.fields.noteMark,
            "unexpected",
          );
          assert.ok(error.evidence!.preparations![0].screenshot);
          return true;
        });
      } else {
        const evidence = await checking;
        assert.equal(evidence.preparations!.length, 6);
        assert.ok(
          evidence.preparations!.every(
            (p) => p.status === "passed" && p.actual.fields.noteMark === "ok",
          ),
        );
        assert.ok(evidence.results.every((r) => r.status === "passed"));
        const renamed = recordPanel(
          oldSource
            .replace('id: "note-panel"', 'id: "renamed-panel"')
            .replace('noteMark: "ok"', 'noteMark: "reviewed"'),
        );
        const wrong = compose(renamed.id, base.id);
        await verifyViaIsolatedWorkspace(
          w,
          wrong,
          updatedCases,
          new AbortController().signal,
        );
        await assert.rejects(
          verifyBrowser(
            w,
            wrong,
            base,
            cases.filter((c) => c.steps.some((s) => s.kind === "ui-identity")),
            parseRequirements(compiled.requirements),
            "identity-counterexample",
            new AbortController().signal,
          ),
          (error: unknown) => {
            assert.ok(error instanceof BrowserAssertionError);
            assert.ok(
              error.evidence.results.some(
                (r) =>
                  r.status === "failed" &&
                  r.requirementIds.includes("identity") &&
                  r.screenshot,
              ),
            );
            return true;
          },
        );
        assert.equal(
          evidence.results.filter((r) => r.caseId.includes("-historical-"))
            .length,
          4,
        );
        const fixtures = JSON.parse(
          await readFile(join(evidence.directory, "fixtures.json"), "utf8"),
        );
        assert.ok(
          fixtures.tasks
            .filter((r: { caseId: string }) =>
              r.caseId.includes("-historical-"),
            )
            .every(
              (r: { task: { fields: Record<string, string> } }) =>
                r.task.fields.noteMark === "ok",
            ),
        );
        const broken = structuredClone(evidence);
        broken.preparations = [];
        assert.notEqual(hash(broken), hash(evidence));
        const advancedBase = compose(updated.id, base.id);
        const next = compose(updated.id, advancedBase.id);
        const inherited = await verifyBrowser(
          w,
          next,
          advancedBase,
          cases,
          parseRequirements(compiled.requirements),
          "inherited-history-definition",
          new AbortController().signal,
        );
        assert.ok(inherited.results.every((r) => r.status === "passed"));
        assert.ok(
          inherited.preparations!.every(
            (p) =>
              p.baseVersion === base.id && p.actual.fields.noteMark === "ok",
          ),
        );
      }
      assert.deepEqual(
        { tasks: w.query(), composition: w.composition() },
        before,
      );
    },
  );

test("公开取消浏览器验收后候选仍可定位部分检查和清理证据（模型桩）", async (t) => {
  const w = await workspace(t);
  const before = { tasks: w.query(), composition: w.composition() };
  const planning = new PlanningDriver({
    requirements:[{id:"cancel-field",source:1,sourceQuote:"完成前填写复盘",description:"完成前填写复盘",type:"interface",checks:[{kind:"workflow"}],obligations:[{kind:"field",field:"reflection",initial:{kind:"baseline"},scenarios:[{steps:[{kind:"action",action:"complete",input:{reflection:"waiting"}}],value:"waiting"}]}]}],
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
