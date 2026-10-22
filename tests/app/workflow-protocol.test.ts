import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { verifyWorkflow } from "../../src/server/workflow-acceptance.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";
import {
  candidateProgramHash,
  browserEnvironment,
  browserViewports,
} from "../../src/server/browser-acceptance.js";
import { Evolution } from "./evolution-adapter.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import { ProtectedCandidateError } from "../../src/release/business-bundle.js";
import type { Driver } from "../../src/evolution/driver.js";
import {
  verifyExtensions,
  type BusinessExtensions,
} from "../../src/server/business-verification.js";
import type { WorkflowRule } from "../../src/shared/assistant.js";
import type { Task, WorkflowDecision } from "../../src/shared/contracts.js";
import type { BrowserEvidence } from "../../src/shared/browser-cases.js";
import { beforeCommitArtifactHash } from "../../src/server/workspace-acceptance.js";

const rule = {
  key: "reflection",
  label: "复盘",
  required: true,
  minLength: 1,
  maxLength: 4,
};
const definition: WorkflowDefinition = {
  id: "primary",
  name: "复盘",
  version: "generated",
  initialState: "open",
  states: {
    open: { label: "未完成", category: "open" },
    done: { label: "已完成", category: "done" },
  },
  actions: [
    { id: "complete", label: "完成", from: ["open"] },
    { id: "reopen", label: "重新打开", from: ["done"] },
  ],
  fields: [{ key: "reflection", label: "复盘", type: "text", required: true }],
};

test("公开执行仅变更宿主规格并继承业务源码时，界面投影仍由宿主派生且记录真实差异", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "host-workflow-projection-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"), {
    workflowProtocolOwner: "host",
  });
  const initial = { ...definition, name: "基础工作流", fields: [] };
  const files = {
    "business/entry.ts": "export default {};",
    "business/view.ts": 'export default {"title":"基础工作流","fields":[]};',
    "business/config.json": "{}",
    "business/compatibility.json": '{"preserveUnknownFields":true}',
  };
  const bundle = await workspace.release.buildBundle(
    files,
    "",
    new AbortController().signal,
  );
  const base = workspace.release.record({
    pluginId: initial.id,
    name: initial.name,
    service: "workflow",
    contractVersion: "workflow/1",
    source: JSON.stringify({
      files: Object.entries(files).map(([path, content]) => ({
        path,
        content,
      })),
    }),
    code: bundle.outputs["business/entry.js"],
    bundle,
    definition: initial,
    workflowProtocol: {
      version: "host-workflow/1",
      definition: initial,
      rules: [],
    },
    evidence: { passed: true, origin: "pretrusted-synthetic-base", rules: [] },
  });
  await workspace.activate(
    {
      versionId: base.id,
      compositionRevision: workspace.composition().revision,
      operationId: "seed",
    },
    () => undefined,
  );
  class ProjectionProbe extends EvolutionDomain {
    received?: string;
    override async candidate(source: string): Promise<never> {
      this.received = source;
      throw new ProtectedCandidateError(
        "control-plane projection probe; no candidate/browser acceptance",
      );
    }
  }
  const domain = new ProjectionProbe(workspace),
    planner = new PlanningDriver();
  planner.finish = {
    workflowRules: [{ ...rule, maxLength: 5000 }],
    writableScope: [
      "business/entry.ts",
      "business/view.ts",
      "business/config.json",
      "business/compatibility.json",
    ],
  };
  const driver: Driver = {
    generate: (request, signal) =>
      request.tools?.some((tool) => tool.name === "submit_candidate")
        ? Promise.resolve(
            toolReply("submit_candidate", { files: [], members: [] }),
          )
        : planner.generate(request, signal),
  };
  const evolution = new Evolution(workspace.db, driver, domain);
  t.after(async () => {
    await evolution.close();
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const settle = async () => {
    const until = Date.now() + 10_000;
    while (Date.now() < until) {
      const run = (await evolution.observe()).run;
      if (run && !["planning", "executing"].includes(run.status)) return run;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("projection probe did not settle");
  };
  await evolution.command({
    type: "request",
    operationId: "request",
    text: "完成前必填复盘，去掉首尾空格后至少1个最多5000个Unicode码点，重新打开保留，其他行为不变",
  });
  const ready = await settle();
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  if (ready.status !== "ready") return;
  await evolution.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "start",
  });
  const stopped = await settle();
  assert.equal(stopped.status, "blocked");
  assert.ok(domain.received);
  const actual = JSON.parse(domain.received).files as {
    path: string;
    content: string;
  }[];
  assert.equal(
    actual.find((f) => f.path === "business/entry.ts")!.content,
    files["business/entry.ts"],
  );
  const view = actual.find((f) => f.path === "business/view.ts")!.content;
  assert.deepEqual(
    JSON.parse(view.replace(/^export default /, "").replace(/;$/, "")).fields,
    ["reflection"],
  );
  const snapshot = await evolution.observe();
  assert.equal(snapshot.candidates?.[0].passed, false);
  assert(
    snapshot.candidates?.[0].delta?.files.some(
      (f) => f.key === "business/view.ts" && f.before !== f.after,
    ),
  );
  assert.equal(stopped.budget!.callsUsed + stopped.budget!.callsRemaining, 12);
  assert.equal(workspace.activeVersion().id, base.id);
});

test("宿主工作流协议通过真实受限运行时提供冻结定义、表单和标准动作，沿用原检查器", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "host-workflow-protocol-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const files = {
    "business/entry.ts": "export default {};",
    "business/view.ts": "export default {title:'复盘',fields:['reflection']};",
    "business/config.json": "{}",
    "business/compatibility.json": '{"preserveUnknownFields":true}',
  };
  const bundle = await workspace.release.buildBundle(
    files,
    "",
    new AbortController().signal,
  );
  const input = {
    pluginId: "primary",
    name: "复盘",
    service: "workflow",
    contractVersion: "workflow/1",
    source: JSON.stringify({ files }),
    code: bundle.outputs["business/entry.js"],
    bundle,
    definition,
    workflowProtocol: {
      version: "host-workflow/1" as const,
      definition,
      rules: [rule],
    },
    evidence: { passed: true, origin: "test" },
  };
  const candidate = workspace.release.record(input);
  const runtime = await workspace.release.start(candidate);
  t.after(() => runtime.close());
  const actual = await runtime.invoke<WorkflowDefinition>("describe");
  assert.deepEqual(actual, definition);
  const checks = await verifyWorkflow(runtime, actual, candidate, {
    pluginId: "primary",
    name: "复盘",
    fields: [rule],
  });
  assert.ok(checks.includes("reflection:missing-input-form"));
  assert.ok(checks.includes("reflection:unicode-boundary"));
  assert.ok(checks.includes("complete-preserve-fields"));
  assert.ok(checks.includes("reopen-preserve-fields"));
});

async function businessFixture(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "host-workflow-business-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const record = async (
    body: string,
    view: WorkflowDefinition = definition,
    rules: WorkflowRule[] = [rule],
  ) => {
    const source = `type Input={task:{state:string;fields:Record<string,string>};action:string;input:Record<string,string>};export default {decide({task,action,input}:Input){${body}}};`;
    const files = {
      "business/entry.ts": source,
      "business/view.ts": `export default ${JSON.stringify({ title: view.name, fields: view.fields.map((f) => f.key) })};`,
      "business/config.json": "{}",
      "business/compatibility.json": '{"preserveUnknownFields":true}',
    };
    const bundle = await workspace.release.buildBundle(
      files,
      "",
      new AbortController().signal,
    );
    return workspace.release.record({
      pluginId: view.id,
      name: view.name,
      service: "workflow",
      contractVersion: "workflow/1",
      source: JSON.stringify({ files }),
      code: bundle.outputs["business/entry.js"],
      bundle,
      definition: view,
      workflowProtocol: { version: "host-workflow/1", definition: view, rules },
      evidence: { passed: true, origin: "test" },
    });
  };
  return { workspace, record };
}

const task: Task = {
  id: "test",
  title: "保留",
  description: "保留备注",
  state: "open",
  revision: 7,
  createdAt: "2030-01-01",
  updatedAt: "2030-01-01",
  deletedAt: null,
  fields: { retained: "keep" },
};

test("宿主协议保留自定义动作与错误文案，错误业务结果仍被同一检查器拒绝", async (t) => {
  const { workspace, record } = await businessFixture(t);
  const increment = { id: "increment", label: "计数", from: ["open"] };
  const count = { key: "count", label: "次数", type: "text" as const };
  const view = {
    ...definition,
    actions: [...definition.actions, increment],
    fields: [...definition.fields, count],
  };
  const extensions: BusinessExtensions = {
    actions: [increment],
    fields: [count],
    cases: [
      {
        name: "累加",
        state: "open",
        fields: { count: "7" },
        action: "increment",
        input: {},
        expected: { kind: "commit", state: "open", fields: { count: "8" } },
      },
      {
        name: "完成后拒绝",
        state: "done",
        fields: { count: "7" },
        action: "increment",
        input: {},
        expected: { kind: "reject" },
      },
    ],
  };
  for (const delta of [1, 2]) {
    const version = await record(
      `if(action==='increment')return {kind:'commit',state:task.state,fields:{...task.fields,count:String(Number(task.fields.count??'0')+${delta})}};if(action==='complete'&&[...input.reflection].length>4)return {kind:'reject',message:'最多四个字'};`,
      view,
    );
    const runtime = await workspace.release.start(version);
    try {
      await verifyWorkflow(runtime, view, version, {
        pluginId: view.id,
        name: view.name,
        fields: [rule],
        extensions,
      });
      if (delta === 1) await verifyExtensions(runtime, extensions);
      else await assert.rejects(verifyExtensions(runtime, extensions), /累加/);
      const result = await runtime.invoke<WorkflowDecision>("decide", {
        task,
        action: "complete",
        input: { reflection: "字字字字字" },
      });
      assert.deepEqual(result, { kind: "reject", message: "最多四个字" });
    } finally {
      await runtime.close();
    }
  }
  const corrupt = await record(
    "if(action==='complete')return {kind:'commit',state:'done',fields:{reflection:input.reflection}};",
  );
  const runtime = await workspace.release.start(corrupt);
  try {
    await assert.rejects(
      verifyWorkflow(runtime, definition, corrupt, {
        pluginId: definition.id,
        name: definition.name,
        fields: [rule],
      }),
      /complete-preserve-fields/,
    );
  } finally {
    await runtime.close();
  }
});

test("可选空值与缺失值的业务选择仍可表达，不由宿主新增默认保存契约", async (t) => {
  const { workspace, record } = await businessFixture(t);
  const optional = {
    key: "memo",
    label: "备注",
    required: false,
    minLength: 1,
    maxLength: 4,
  };
  const view = {
    ...definition,
    fields: [
      ...definition.fields,
      { key: "memo", label: "备注", type: "text" as const, required: false },
    ],
  };
  for (const policy of [
    "preserve-empty",
    "save-empty",
    "preserve-omitted",
  ] as const) {
    const when =
      policy === "preserve-omitted"
        ? "!Object.hasOwn(input,'memo')"
        : "input.memo===''";
    const fields =
      policy === "save-empty"
        ? "{...task.fields,reflection:input.reflection,memo:''}"
        : "{...task.fields,reflection:input.reflection}";
    const version = await record(
      `if(action==='complete'&&${when})return {kind:'commit',state:'done',fields:${fields}};`,
      view,
      [rule, optional],
    );
    const runtime = await workspace.release.start(version);
    try {
      await verifyWorkflow(runtime, view, version, {
        pluginId: view.id,
        name: view.name,
        fields: [rule, optional],
      });
      const input =
        policy === "preserve-omitted"
          ? { reflection: " 字 " }
          : { reflection: " 字 ", memo: "" };
      const result = await runtime.invoke<WorkflowDecision>("decide", {
        task: { ...task, fields: { ...task.fields, memo: "old" } },
        action: "complete",
        input,
      });
      assert.deepEqual(result, {
        kind: "commit",
        state: "done",
        fields: {
          retained: "keep",
          reflection: "字",
          memo: policy === "save-empty" ? "" : "old",
        },
      });
    } finally {
      await runtime.close();
    }
  }
});

test("已应用宿主协议版本独立于新规划的职责配置，重启与回退后仍可执行", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "host-workflow-restart-"));
  let workspace = await Workspace.open(join(directory, "workspace.db"), {
    workflowProtocolOwner: "host",
  });
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = workspace.activeVersion();
  const version = workspace.release.record({
    pluginId: definition.id,
    name: definition.name,
    service: "workflow",
    contractVersion: "workflow/1",
    source: "export default {};",
    code: "export default {};",
    definition,
    workflowProtocol: { version: "host-workflow/1", definition, rules: [rule] },
    evidence: { passed: true, origin: "test" },
  });
  const activate = (versionId: string) =>
    workspace.activate(
      {
        versionId,
        compositionRevision: workspace.composition().revision,
        operationId: crypto.randomUUID(),
      },
      () => undefined,
    );
  await activate(version.id);
  await workspace.close();
  workspace = await Workspace.open(join(directory, "workspace.db"), {
    workflowProtocolOwner: "model",
  });
  assert.equal(workspace.activeVersion().id, version.id);
  const created = (
    await workspace.command({
      type: "create",
      title: "历史任务",
      compositionRevision: workspace.composition().revision,
      operationId: crypto.randomUUID(),
    })
  ).task!;
  const result = await workspace.command({
    type: "action",
    taskId: created.id,
    actionId: "complete",
    input: { reflection: " 🙂🙂 " },
    expectedRevision: created.revision,
    compositionRevision: workspace.composition().revision,
    operationId: crypto.randomUUID(),
  });
  assert.equal(result.task?.state, "done");
  assert.equal(result.task?.fields.reflection, "🙂🙂");
  await activate(base.id);
  await activate(version.id);
  const reopened = await workspace.command({
    type: "action",
    taskId: created.id,
    actionId: "reopen",
    expectedRevision: workspace.read(created.id).revision,
    compositionRevision: workspace.composition().revision,
    operationId: crypto.randomUUID(),
  });
  assert.equal(reopened.task?.fields.reflection, "🙂🙂");
});

test("公开规划冻结宿主协议职责和执行内核，生成接口仅要求业务决策", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "host-workflow-planning-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"), {
    workflowProtocolOwner: "host",
  });
  const domain = new EvolutionDomain(workspace);
  const evolution = new Evolution(workspace.db, new PlanningDriver(), domain);
  t.after(async () => {
    await evolution.close();
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  await evolution.command({
    type: "request",
    text: "完成前填写复盘，其他行为不变",
    operationId: "request",
  });
  const deadline = Date.now() + 10_000;
  let run = (await evolution.observe()).run;
  while (run?.status === "planning" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    run = (await evolution.observe()).run;
  }
  assert.equal(run?.status, "ready");
  if (run?.status !== "ready") return;
  assert.equal(run.plan.binding?.workflowProtocol?.owner, "host");
  assert.ok(run.plan.binding.workflowProtocol.implementationHash);
  const generation = domain.generation(domain.target(run.plan));
  assert.ok(generation.scaffold.workflowTemplate.includes("WorkflowBusiness"));
  assert.equal(
    generation.scaffold.workflowTemplate.includes("describe()"),
    false,
  );
  assert.equal(run.budget!.callsUsed + run.budget!.callsRemaining, 12);
  // Deliberately forged negative fixture, never counted as browser or model acceptance.
  // Even a self-consistent rehash must not certify a profile that differs from the plan.
  const frozen = run.plan.changeSpec!.workflowDefinition!;
  const input = {
    pluginId: frozen.id,
    name: frozen.name,
    service: "workflow",
    contractVersion: "workflow/1",
    source: "export default {};",
    code: "export default {};",
    definition: frozen,
    workflowProtocol: {
      version: "host-workflow/1" as const,
      definition: frozen,
      rules: run.plan.workflowRules.map((r) => ({
        ...r,
        maxLength: r.maxLength + 1,
      })),
    },
    evidence: { passed: false, origin: "forged-negative-fixture" },
  };
  const draft = workspace.release.record(input);
  const env = browserEnvironment();
  const browser: BrowserEvidence = {
    checker: "browser/1",
    checkerHash: env.checkerHash,
    candidateVersion: draft.id,
    baseVersion: run.plan.baseVersion!,
    candidateProgramHash: candidateProgramHash(workspace, draft),
    definitionHash: run.plan.requirementGate!.definitionHash,
    frontendHash: env.frontendHash,
    fixtureHash: "forged-negative-fixture",
    directory: "forged-negative-fixture",
    results: [
      "host:basic-existing",
      "host:basic-new",
      ...(run.plan.browserCases ?? []).map((c) => c.id),
    ].flatMap((caseId) =>
      browserViewports.map((viewport) => ({
        caseId,
        viewport,
        requirementIds: [],
        status: "passed" as const,
      })),
    ),
    preparations: (run.plan.browserCases ?? []).flatMap((c) =>
      c.prepare
        ? browserViewports.map((viewport) => ({
            caseId: c.id,
            viewport,
            sourceHash: c.prepare!.sourceHash,
            baseVersion: c.prepare!.baseVersion,
            expected: c.prepare!.expected,
            actual: c.prepare!.expected,
            status: "passed" as const,
          }))
        : [],
    ),
  };
  const forged = workspace.release.record({
    ...input,
    evidence: {
      passed: true,
      origin: "forged-negative-fixture",
      requirementGate: run.plan.requirementGate,
      browser,
    },
  });
  assert.throws(
    () => domain.verifyAcceptance(forged.id, run.plan),
    /协议.*冻结|冻结.*协议/,
  );
});

test("同源码的不同宿主协议配置具有不同程序身份，不能复用候选浏览器证据", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "host-workflow-identity-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const input = {
    pluginId: "primary",
    name: "复盘",
    service: "workflow",
    contractVersion: "workflow/1",
    source: "export default {};",
    code: "export default {};",
    definition,
    evidence: { passed: true, origin: "test" },
  };
  const plain = workspace.release.record(input);
  const first = workspace.release.record({
    ...input,
    workflowProtocol: { version: "host-workflow/1", definition, rules: [rule] },
  });
  const changed = workspace.release.record({
    ...input,
    workflowProtocol: {
      version: "host-workflow/1",
      definition,
      rules: [{ ...rule, maxLength: 5 }],
    },
  });
  assert.notEqual(
    candidateProgramHash(workspace, first),
    candidateProgramHash(workspace, changed),
  );
  assert.notEqual(
    candidateProgramHash(workspace, first),
    candidateProgramHash(workspace, plain),
  );
  assert.notEqual(
    beforeCommitArtifactHash(first),
    beforeCommitArtifactHash(changed),
  );
});

test("辅助启停只产生状态候选，宿主协议配置与业务实现必须一起继承", async (t) => {
  const { workspace } = await businessFixture(t);
  const auxiliary = workspace.release.record({
    pluginId: "aux",
    name: "辅助",
    service: "plugin:aux",
    contractVersion: "extensions/1",
    source: "export default {};",
    code: "export default {};",
    definition: { id: "aux" },
    evidence: { passed: true, origin: "test" },
  });
  const profile = {
    version: "host-workflow/1" as const,
    definition,
    rules: [rule],
  };
  const version = workspace.release.record({
    pluginId: definition.id,
    name: definition.name,
    service: "workflow",
    contractVersion: "workflow/1",
    source: "export default {};",
    code: "export default {};",
    definition,
    workflowProtocol: profile,
    evidence: { passed: true, origin: "test" },
    members: [
      { pluginId: definition.id, role: "workflow", enabled: true },
      {
        pluginId: "aux",
        versionId: auxiliary.id,
        role: "auxiliary",
        enabled: true,
      },
    ],
  });
  await workspace.activate(
    {
      versionId: version.id,
      compositionRevision: workspace.composition().revision,
      operationId: "activate",
    },
    () => undefined,
  );
  const workflowBefore = workspace.composition().workflow;
  const stateCandidate = workspace.recordMemberEnabledVersion("aux", false);
  assert.deepEqual(stateCandidate.workflowProtocol, profile);
  await workspace.activate(
    {
      versionId: stateCandidate.id,
      compositionRevision: workspace.composition().revision,
      operationId: "disable",
    },
    () => undefined,
  );
  assert.deepEqual(workspace.composition().workflow, workflowBefore);
});

test("更换职责配置后旧待执行计划必须重新规划，既有预算和正式数据不变", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "host-workflow-owner-restart-"),
  );
  const filename = join(directory, "workspace.db");
  let workspace = await Workspace.open(filename, {
    workflowProtocolOwner: "host",
  });
  let evolution = new Evolution(
    workspace.db,
    new PlanningDriver(),
    new EvolutionDomain(workspace),
  );
  t.after(async () => {
    await evolution.close();
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  await evolution.command({
    type: "request",
    text: "完成前填写复盘，其他行为不变",
    operationId: "request",
  });
  let run = (await evolution.observe()).run;
  const deadline = Date.now() + 10_000;
  while (run?.status === "planning" && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
    run = (await evolution.observe()).run;
  }
  assert.equal(run?.status, "ready");
  if (run?.status !== "ready") return;
  const calls = run.budget!.callsUsed,
    before = JSON.stringify({
      composition: workspace.composition(),
      tasks: workspace.query(),
    });
  await evolution.close();
  await workspace.close();
  workspace = await Workspace.open(filename, {
    workflowProtocolOwner: "model",
  });
  evolution = new Evolution(
    workspace.db,
    new PlanningDriver(),
    new EvolutionDomain(workspace),
  );
  await assert.rejects(
    evolution.command({
      type: "start",
      runId: run.id,
      planId: run.plan.id,
      operationId: "start-old",
    }),
    /职责|执行内核/,
  );
  assert.equal((await evolution.observe()).run!.budget!.callsUsed, calls);
  assert.equal((await evolution.observe()).candidates?.length, 0);
  assert.equal(
    JSON.stringify({
      composition: workspace.composition(),
      tasks: workspace.query(),
    }),
    before,
  );
});
