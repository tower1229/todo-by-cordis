import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compilePlanInput,
  type PlanInput,
} from "../../src/evolution/plan-input.js";
import {
  parseExtensions,
  verifyExtensions,
  extensionCases,
} from "../../src/server/business-verification.js";
import { Workspace } from "../../src/server/workspace.js";
import {
  capture,
  compilePlanDraft,
  readInvestigation,
} from "../../src/server/planning.js";
import { activateWorkflowOnly } from "./dual-composition-fixture.js";
import {
  parseAdmission,
  adjudicateAdmission,
  admissionResolved,
} from "../../src/evolution/request-admission.js";
import { compileSemantics } from "../../src/evolution/requirement-semantics.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import type { RuntimeLike } from "../../src/release/types.js";
import { verifyViaIsolatedWorkspace } from "../../src/server/workspace-acceptance.js";
import {
  verifyBrowser,
  BrowserAssertionError,
} from "../../src/server/browser-acceptance.js";
import { DeepSeek } from "../../src/evolution/deepseek.js";
import { modelPolicy } from "../../src/evolution/model-policy.js";
import { hash } from "../../src/release/storage.js";
import { deriveFieldObligations, operationPreparation } from "../../src/evolution/obligation-derivation.js";
import type { BrowserStep } from "../../src/shared/browser-cases.js";
import type { Requirement } from "../../src/shared/assistant.js";

type ArchivedChange = NonNullable<PlanInput["changes"]>[number] & {
  cases: NonNullable<NonNullable<PlanInput["changes"]>[number]["cases"]>;
};
type ArchivedPlan = Omit<PlanInput, "changes"> & { changes: ArchivedChange[] };

const rawArchive: unknown = JSON.parse(
  readFileSync(
    new URL("../fixtures/planning-compiler-replay.json", import.meta.url),
    "utf8",
  ),
);
const archive = rawArchive as {
  requests: { id: string; request: string }[];
  proposals: Record<"workflow" | "addition" | "clarification", ArchivedPlan>;
};
const workflow = {
  id: "primary",
  name: "流程",
  version: "1",
  initialState: "open",
  states: {
    open: { label: "未完成", category: "open" as const },
    done: { label: "已完成", category: "done" as const },
  },
  actions: [
    { id: "complete", label: "完成", from: ["open"] },
    { id: "reopen", label: "重新打开", from: ["done"] },
  ],
  fields: [],
};
const context = {
  pluginId: "primary",
  capabilities: [],
  members: [
    {
      pluginId: "primary",
      role: "workflow" as const,
      enabled: true,
      versionId: "base",
    },
  ],
  files: {
    "active-contract": { content: JSON.stringify(workflow), hash: "contract" },
    "active-acceptance": {
      content: JSON.stringify({ rules: [] }),
      hash: "acceptance",
    },
  },
};
const sources = [
  {
    id: "request:1",
    text: archive.requests.find((r: { id: string }) => r.id === "workflow")
      .request,
  },
];

test("规划说明由宿主绑定来源，模型自由描述不能另立初值、错误提示或动作限制", () => {
  const input = structuredClone(archive.proposals.workflow);
  const first = compilePlanInput(input, context, sources);
  input.summary = "额外规定初始显示0并隐藏所有动作";
  for (const r of input.requirements) r.description = "额外规定超过长度必须显示指定错误提示";
  const second = compilePlanInput(input, context, sources);
  assert.deepEqual(second, first);
  for (const r of first.requirements) assert.equal(r.description, r.sourceQuote);
});

test("字段显示名不能替代冻结案例中的键，修正引用后不改动案例或推测别名", () => {
  const input = structuredClone(archive.proposals.addition);
  const source = archive.requests.find(r => r.id === "addition")!.request;
  const refs = [{ id: "request:1", text: source }];
  const valid = compilePlanInput(input, context, refs);
  const casesHash = hash(input.changes);
  for (const r of input.requirements)
    for (const e of r.expectations)
      if (e.kind === "field") e.field = "评审备注";
  assert.throws(() => compilePlanInput(input, context, refs), /字段 评审备注 没有可推导的冻结成功操作/);
  assert.equal(hash(input.changes), casesHash);
  for (const r of input.requirements)
    for (const e of r.expectations)
      if (e.kind === "field") e.field = "reviewNote";
  assert.deepEqual(compilePlanInput(input, context, refs), valid);
});

test("新字段的非空前置案例由宿主从冻结候选动作推导，不能把第二次增加误编译为第一次", () => {
  const source="新增计数，详情展示计数，其他行为不变";
  const cases=[
    {name:"first",state:"open",fields:{},action:"increment",input:{},expected:{kind:"commit",state:"open",fields:{count:"1"}}},
    {name:"second",state:"open",fields:{count:"1",retained:"历史字段"},action:"increment",input:{},expected:{kind:"commit",state:"open",fields:{count:"2",retained:"历史字段"}}},
  ];
  const input={requirements:[{quote:source,type:"interface",expectations:[{kind:"field",field:"count"}]}],changes:[{target:"counter",features:["commands","fields","detail"],cases}]};
  const draft=compilePlanInput(input,context,[{id:"request:1",text:source}]);
  const field=draft.requirements[0].obligations.find(o=>o.kind==="field")!;
  assert.deepEqual((field.scenarios as {steps:unknown[];value:string}[]).map(s=>[s.value,s.steps.length]),[["1",1],["2",2]]);
  const advisory = structuredClone(input);
  Object.assign(advisory.requirements[0].expectations[0], {examples:["9"]});
  assert.deepEqual(compilePlanInput(advisory,context,[{id:"request:1",text:source}]),draft,"辅助字段样例不能筛除已冻结的成功案例或另立期望来源");
  assert.throws(()=>compilePlanInput({...input,changes:[{...input.changes[0],cases:[cases[1]]}]},context,[{id:"request:1",text:source}]),/前置|可达|冻结.*路径/);
  assert.throws(()=>compilePlanInput({...input,changes:[{...input.changes[0],cases:[cases[0],{...cases[0],expected:{kind:"commit",state:"open",fields:{count:"9"}}}]}]},context,[{id:"request:1",text:source}]),/不唯一|冲突/);
});

test("字段前置缺口反馈定位目标与可达状态，补齐中间操作后保留连续断言", () => {
  const source = "新增计数，详情展示计数，其他行为不变";
  const first = { name: "first", state: "open", fields: {}, action: "increment", input: {}, expected: { kind: "commit", state: "open", fields: { count: "1" } } };
  const third = { name: "third", state: "open", fields: { count: "2", retained: "历史字段" }, action: "increment", input: {}, expected: { kind: "commit", state: "open", fields: { count: "3", retained: "历史字段" } } };
  for (const initial of [undefined, { kind: "baseline" }]) {
    const input = {
      requirements: [{ quote: source, type: "interface", expectations: [{ kind: "field", field: "count", ...(initial ? { initial } : {}) }] }],
      changes: [{ target: "counter", features: ["commands", "fields", "detail"], cases: [first, third] }],
    };
    assert.throws(() => compilePlanInput(input, context, [{ id: "request:1", text: source }]), (error: unknown) => {
      assert.ok(error instanceof Error);
      for (const detail of ["counter", "third", '"count":"2"', '"count":"1"', "commit", "initial"])
        assert.ok(error.message.includes(detail), `反馈缺少 ${detail}：${error.message}`);
      return true;
    });
    const second = { name: "second", state: "open", fields: { count: "1" }, action: "increment", input: {}, expected: { kind: "commit", state: "open", fields: { count: "2" } } };
    input.changes[0].cases.splice(1, 0, second);
    const draft = compilePlanInput(input, context, [{ id: "request:1", text: source }]);
    const field = draft.requirements[0].obligations.find(o => o.kind === "field");
    assert.ok(field?.kind === "field");
    assert.deepEqual((field.scenarios as { value: string; steps: unknown[] }[]).map(s => [s.value, s.steps.length]), [["1", 1], ["2", 2], ["3", 3]]);
    assert.deepEqual(draft.memberCases?.find(c => c.member === "counter" && c.name === "third")?.fields, third.fields);
  }
});

test("前置诊断有界且只说明本成员可达状态，不借其他成员的案例准备字段", () => {
  const first = { member: "progress", name: "begin", state: "open", fields: {}, action: "advance", input: {}, expected: { kind: "commit" as const, state: "open", fields: { level: "started" } } };
  const target = { ...first, name: "finish", fields: { level: "ready", unrelated: "不应在字段投影出现" }, expected: { kind: "commit" as const, state: "open", fields: { level: "finished" } } };
  const bridge = { ...first, name: "prepare", fields: { level: "started" }, expected: { kind: "commit" as const, state: "open", fields: { level: "ready" } } };
  const cases = [first, target, { ...bridge, member: "other" }];
  const original = structuredClone(cases);
  assert.throws(() => operationPreparation(cases, target, "open", "level"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /progress.*finish.*level/);
    assert.ok(!error.message.includes("unrelated"));
    return true;
  });
  assert.deepEqual(cases, original);
  assert.equal(operationPreparation([...cases, bridge], target, "open", "level").length, 2);
  const longTarget = { ...target, fields: { level: "x".repeat(5000) } };
  assert.throws(() => operationPreparation([first, longTarget], longTarget, "open", "level"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.length < 3000);
    assert.ok(!error.message.includes("x".repeat(161)));
    return true;
  });
});

test("计划已声明界面能力时，宿主从冻结计数案例生成连续浏览器义务", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "compiler-counter-ui-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  await activateWorkflowOnly(w);
  const context = capture(w);
  const source = "增加计数功能，在任务详情显示计数，其他行为不变";
  const proposal = {
    requirements: [{quote: source, type: "interface", expectations: [{kind: "behavior"}]}],
    changes: [{target: "counter", features: ["commands", "fields", "detail"], cases: [
      {name: "first", state: "open", fields: {}, action: "increment", input: {}, expected: {kind: "commit", state: "open", fields: {count: "1"}}},
      {name: "second", state: "open", fields: {count: "1"}, action: "increment", input: {}, expected: {kind: "commit", state: "open", fields: {count: "2"}}},
      {name: "done", state: "done", fields: {}, action: "increment", input: {}, expected: {kind: "reject"}},
    ]}],
  };
  const parsed = compilePlanDraft(proposal, context,
    Object.entries(context.files).map(([ref, f]) => ({ref, hash: f.hash})),
    [{id: "request:1", text: source}]);
  const fields = parsed.plan.requirements?.flatMap(r => r.obligations ?? []).filter(o => o.kind === "field" && o.member === "counter" && o.field === "count");
  assert.ok(fields?.length);
  assert.deepEqual(fields[0].scenarios.map(s => [s.value, s.steps.length]), [["1", 1], ["2", 2]]);
  assert.ok(parsed.plan.browserCases?.some(c => c.steps.some(s => s.kind === "field" && s.member === "counter" && s.field === "count" && s.value === "2")));
  assert.ok(!parsed.blockers.some(b => /界面|browser|可执行.*义务/.test(b)), parsed.blockers.join("；"));
  const backendOnly = compilePlanDraft({...proposal, requirements: [{quote: source, type: "behavior", expectations: [{kind: "behavior"}]}], changes: [{...proposal.changes[0], features: ["commands", "fields"]}]}, context,
    Object.entries(context.files).map(([ref, f]) => ({ref, hash: f.hash})), [{id: "request:1", text: source}]);
  assert.ok(!backendOnly.plan.requirements?.some(r => r.obligations?.some(o => o.kind === "field" && o.member === "counter")));
  const behaviorSource = "增加计数功能，其他行为不变";
  const incidentalUi = compilePlanDraft({...proposal, requirements: [{quote: behaviorSource, type: "behavior", expectations: [{kind: "behavior"}]}]}, context,
    Object.entries(context.files).map(([ref, f]) => ({ref, hash: f.hash})), [{id: "request:1", text: behaviorSource}]);
  assert.ok(!incidentalUi.plan.requirements?.some(r => r.obligations?.some(o => o.kind === "field" && o.member === "counter")), "实现选择的界面能力不能给行为要求新增跨新旧任务的字段断言");
});

test("归档原流程案例进入原动作验收，不要求模型虚构扩展动作；原拒绝义务绑定必填表单", () => {
  const draft = compilePlanInput(archive.proposals.workflow, context, sources);
  const parsed = parseExtensions(
    draft.extensions,
    workflow,
    undefined,
    draft.workflowRules,
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.actions, []);
  assert.equal(parsed.cases.length, 3);
  assert.deepEqual(
    parsed.cases.find(
      (c) => c.action === "complete" && c.expected.kind === "reject",
    ),
    {
      ...archive.proposals.workflow.changes[0].cases[1],
      inputRequired: ["review"],
    },
  );
});

test("原动作相同声明与省略声明收敛；改变状态范围仍拒绝，新增动作仍须正反例", () => {
  const original = compilePlanInput(
    archive.proposals.workflow,
    context,
    sources,
  );
  const repeated = structuredClone(archive.proposals.workflow);
  repeated.changes[0].actions = structuredClone(workflow.actions);
  repeated.changes[0].actionFields = [
    { key: "review", label: "复盘", type: "text" },
  ];
  assert.deepEqual(
    compilePlanInput(repeated, context, sources).extensions,
    original.extensions,
  );
  repeated.changes[0].actions[0].from = ["done"];
  assert.throws(() => compilePlanInput(repeated, context, sources), /既有动作/);
  assert.throws(
    () =>
      parseExtensions(
        {
          actions: [{ id: "newAction", label: "新增", from: ["open"] }],
          fields: [],
          cases: [],
        },
        workflow,
      ),
    /正例和反例/,
  );
});

test("归档澄清提案把98码点误报超长：宿主拒绝与冻结长度规则冲突的断言", () => {
  const request = archive.requests.find((r) => r.id === "clarification")! as {
    id: string;
    request: string;
    answer: string;
  };
  const sources = [
    { id: "request:1", text: request.request },
    { id: "request:2", text: request.answer },
  ];
  assert.throws(
    () => compilePlanInput(archive.proposals.clarification, context, sources),
    /98.*Unicode.*1.*100/,
  );
  const corrected = structuredClone(archive.proposals.clarification);
  const oversized = corrected.changes[0].cases.find(
    (c) => c.name === "complete-review-too-long",
  )!;
  oversized.input.review = "🙂".repeat(101);
  const draft = compilePlanInput(corrected, context, sources);
  assert.deepEqual(draft.extensions?.actions, []);
  assert.equal(
    draft.extensions?.cases.length,
    corrected.changes[0].cases.length,
  );
  const forged = structuredClone(draft.extensions)!;
  forged.cases.find(
    (c) => c.name === "complete-review-too-long",
  )!.input.review = "🙂".repeat(98);
  assert.throws(
    () => parseExtensions(forged, workflow, undefined, draft.workflowRules),
    /98.*Unicode.*1.*100/,
  );
  const narrowed = structuredClone(archive.proposals.clarification);
  narrowed.changes[0].cases.find(
    (c) => c.name === "complete-review-too-long",
  )!.input.review = "  🙂  ";
  assert.throws(
    () => compilePlanInput(narrowed, context, sources),
    /1.*Unicode.*1.*100/,
  );
});

test("原动作补充案例不能替换冻结的去空白、状态和历史字段保留语义", () => {
  for (const mutate of [
    (c: ArchivedChange["cases"][number]) => {
      if (c.expected.kind === "commit") c.expected.fields.retained = "被替换";
    },
    (c: ArchivedChange["cases"][number]) => {
      if (c.expected.kind === "commit") c.expected.state = "open";
    },
    (c: ArchivedChange["cases"][number]) => {
      c.input.review = "  本次复盘  ";
      if (c.expected.kind === "commit")
        c.expected.fields.review = "  本次复盘  ";
    },
  ]) {
    const value = structuredClone(archive.proposals.workflow);
    mutate(value.changes[0].cases[0]);
    assert.throws(
      () => compilePlanInput(value, context, sources),
      /冻结.*语义/,
    );
  }
});

test("已有字段的非空前置状态不能被自动投影成新任务；新字段探针仍独立保留", () => {
  const c = {
    ...archive.proposals.addition.changes[0].cases[0],
    member: "review-note",
  };
  const r: Requirement = {
    id: "r",
    description: "字段",
    sourceRevision: "s",
    sourceQuote: "字段",
    type: "behavior",
    checks: [
      { checker: "workspace/1", caseId: `member:${c.member}:${c.name}` },
    ],
  };
  const bind = (steps: unknown[]) =>
    steps.map(
      (s) =>
        ({
          ...(s as object),
          member: "review-note",
          contribution: "detail",
        }) as BrowserStep,
    );
  assert.deepEqual(
    deriveFieldObligations(
      r,
      [c],
      [],
      bind,
      [],
      () => true,
      () => true,
    ),
    [],
  );
  assert.ok(
    deriveFieldObligations(
      r,
      [c],
      [],
      bind,
      [],
      () => true,
      () => false,
    ).some((o) => o.kind === "field" && o.field === "reviewNote"),
  );
});

test("原动作拒绝不能被普通报错冒充必填表单；伪造表单绑定、未知动作均拒绝", async () => {
  const draft = compilePlanInput(archive.proposals.workflow, context, sources);
  const ext = parseExtensions(
    draft.extensions,
    workflow,
    undefined,
    draft.workflowRules,
  )!;
  const missing = ext.cases.find((c) => c.inputRequired?.length)!;
  assert.deepEqual(
    JSON.parse(extensionCases({ ...ext, cases: [missing] })[0].then),
    { kind: "input-required", fields: ["review"] },
  );
  const runtime = (decision: unknown) =>
    ({
      async invoke() {
        return decision;
      },
    }) as unknown as RuntimeLike;
  await assert.rejects(
    verifyExtensions(runtime({ kind: "reject", message: "未填写" }), {
      ...ext,
      cases: [missing],
    }),
    /业务验收失败/,
  );
  await verifyExtensions(
    runtime({
      kind: "input-required",
      fields: [{ key: "review", label: "复盘", type: "text", required: true }],
    }),
    { ...ext, cases: [missing] },
  );
  const tampered = structuredClone(ext);
  tampered.cases.find((c) => c.inputRequired)!.inputRequired = ["retained"];
  assert.throws(
    () => parseExtensions(tampered, workflow, undefined, draft.workflowRules),
    /宿主规则绑定/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        {
          ...archive.proposals.workflow,
          changes: [
            {
              target: "workflow",
              cases: [
                {
                  ...archive.proposals.workflow.changes[0].cases[0],
                  action: "unknown",
                },
              ],
            },
          ],
        },
        context,
        sources,
      ),
    /没有宿主身份/,
  );
});

test("归档辅助字段案例的历史保留断言不变，宿主另生成新旧任务的空起点字段探针", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "compiler-probe-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  await activateWorkflowOnly(w);
  const context = capture(w);
  const proposal = structuredClone(archive.proposals.addition);
  // The supported host presentation is the only change to this synthetic positive fixture.
  for (const r of proposal.requirements)
    for (const e of r.expectations) if (e.kind === "field") delete e.initial;
  const sources = [
    {
      id: "request:1",
      text: archive.requests.find((r: { id: string }) => r.id === "addition")
        .request,
    },
  ];
  const parsed = compilePlanDraft(
    proposal,
    context,
    Object.entries(context.files).map(([ref, f]) => ({ ref, hash: f.hash })),
    sources,
  );
  assert.deepEqual(
    parsed.plan.memberCases?.map(({ member: _member, ...c }) => c),
    proposal.changes[0].cases,
  );
  const fields = parsed.plan.requirements
    ?.flatMap((r) => r.obligations ?? [])
    .filter((o) => o.kind === "field" && o.field === "reviewNote");
  assert.ok(fields?.length);
  assert.ok(
    fields.some(
      (o) =>
        o.kind === "field" &&
        o.scenarios.some((s) =>
          s.steps.some(
            (step) => step.kind === "action" && step.action === "setReviewNote",
          ),
        ),
    ),
  );
  assert.ok(
    parsed.plan.browserCases?.some(
      (c) =>
        c.task === "new" &&
        c.steps.some((s) => s.kind === "field" && s.field === "reviewNote"),
    ),
  );
  // The exact original requirement must reach the unsupported-presentation gate, not fail preparing examples.
  const unsupported = compilePlanDraft(
    archive.proposals.addition,
    context,
    Object.entries(context.files).map(([ref, f]) => ({ ref, hash: f.hash })),
    sources,
  );
  assert.ok(
    unsupported.blockers.some((b) => b.includes("无法表达该初始呈现要求")),
  );
});

test("预检不再接收模型的字段归属，未安装字段经来源复核后必须绑定计划实际字段", () => {
  const source = "任务详情显示备注，尚未填写时显示空白";
  const sources = [{ id: "request:1", text: source }];
  const value = {
    effects: [], initials: [
      {
        source: 1,
        sourceQuote: source,
        target: {kind:"new",name:"评审备注"},
        meaning: {
          kind:"blank",
          conditionQuote: "尚未填写时",
          effectQuote: "显示空白",
        },
      },
    ],
    questions: [],
  };
  const facts = technicalFacts({ workflowRules: [], binding: undefined });
  assert.throws(
    () =>
      parseAdmission(
        JSON.stringify({
          ...value,
          effects: [], initials: [{ ...value.initials[0], surface: "workflow" }],
        }),
        "base",
        sources,
        facts,
      ),
    /未授权字段/,
  );
  const admission = parseAdmission(
    JSON.stringify(value),
    "base",
    sources,
    facts,
  );
  assert.equal(admission.initialMeanings[0].surface, "unbound");
  const reviewed = adjudicateAdmission(
    JSON.stringify({
      decisions: [
        {
          claim: 1,
          source: 1,
          sourceQuote: source,
          layer: "initial-display", verdict: "entailed",
          detail: "明确要求空白",
        },
      ],
    }),
    admission,
    sources,
  );
  assert.equal(reviewed.blockers.length, 1, "两类受保护渲染器均无法呈现空白时，无须猜测新字段归属即可阻塞");
  const plan = {
    workflowRules: [],
    requestAdmission: reviewed,
    requirements: [
      {
        id: "r",
        sourceRevision: "request:1",
        sourceQuote: source,
        description: source,
        type: "interface" as const,
        checks: [],
        obligations: [
          {
            version: 1 as const,
            id: "f",
            kind: "field" as const,
            member: "review-note",
            field: "reviewNote",
            initial: { kind: "visible" as const, value: "" },
            initialOrigin: "requirement" as const,
            scenarios: [],
          },
        ],
      },
    ],
  };
  const state = compileSemantics(plan, sources);
  assert.equal(
    state.entries.filter((e) => e.target.aspect === "initial-display").length,
    1,
  );
  assert.equal(state.entries[0].target.subject, "review-note::reviewNote");
  assert.ok(
    compileSemantics({ ...plan, requirements: [] }, sources).entries.some(
      (e) => e.status === "conflicting",
    ),
  );
  const ambiguous = structuredClone(plan);
  ambiguous.requirements[0].obligations.push({
    ...ambiguous.requirements[0].obligations[0],
    id: "other",
    field: "otherNote",
  });
  assert.ok(
    compileSemantics(ambiguous, sources).entries.some(
      (e) => e.status === "conflicting",
    ),
  );
  const tampered = structuredClone(reviewed);
  tampered.initialMeanings[0].surface = "workflow";
  tampered.presentations[0].surface = "workflow";
  assert.equal(admissionResolved(tampered), false);
});

test("归档完整工作流提案通过宿主编译，补充案例与既有 workflow/1 验收同时保留", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "compiler-native-draft-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  await activateWorkflowOnly(w);
  const context = capture(w);
  const seen = [
    ...Object.entries(context.files).map(([ref, f]) => ({ ref, hash: f.hash })),
    ...["inspect_application", "check_environment"].map((name) => {
      const result = readInvestigation(name, {}, context);
      assert.ok("ref" in result);
      return { ref: result.ref, hash: result.hash };
    }),
  ];
  const parsed = compilePlanDraft(
    archive.proposals.workflow,
    context,
    seen,
    sources,
  );
  assert.deepEqual(parsed.blockers, []);
  assert.deepEqual(parsed.plan.extensions?.actions, []);
  assert.equal(
    parsed.plan.extensions?.cases.length,
    archive.proposals.workflow.changes[0].cases.length,
  );
  assert.ok(parsed.plan.cases.some((c) => c.checker === "workflow/1"));
  for (const c of parsed.plan.extensions!.cases)
    assert.ok(
      parsed.plan.cases.some(
        (x) => x.checker === "business-actions/1" && x.when.includes(c.action),
      ),
    );
});

test("合成反例：依赖历史保留字段的候选后端通过，空起点浏览器探针仍拒绝", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "compiler-browser-probe-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  await activateWorkflowOnly(w);
  const base = w.activeVersion();
  const context = capture(w);
  const proposal = structuredClone(archive.proposals.addition);
  for (const r of proposal.requirements)
    for (const e of r.expectations) if (e.kind === "field") delete e.initial;
  const parsed = compilePlanDraft(
    proposal,
    context,
    Object.entries(context.files).map(([ref, f]) => ({ ref, hash: f.hash })),
    [
      {
        id: "request:1",
        text: archive.requests.find((r) => r.id === "addition")!.request,
      },
    ],
  );
  const code = `export default {
    contribute(){return {fields:[{key:"reviewNote",label:"评审备注",type:"text"}],commands:[{id:"setReviewNote",label:"填写评审备注",from:["open","done"]}],uiSlots:[{id:"review-note-detail",slot:"task.detail",title:"评审备注",fields:[{key:"reviewNote",label:"评审备注"}],actions:[{commandId:"setReviewNote",label:"填写评审备注"}]}]};},
    decide({task,action,input}){
      if(action!=="setReviewNote")return {kind:"reject",message:"未知动作"};
      if(!Object.hasOwn(input,"reviewNote"))return {kind:"input-required",fields:[{key:"reviewNote",label:"评审备注",type:"text",required:true}]};
      const value=String(input.reviewNote).trim();
      if(!value||!task.fields.retained)return {kind:"reject",message:"缺少历史字段"};
      return {kind:"commit",state:task.state,fields:{...task.fields,reviewNote:value}};
    }
  };`;
  const member = w.release.record({
    pluginId: "review-note",
    name: "评审备注",
    service: "plugin:review-note",
    contractVersion: "extensions/1",
    source: code,
    code,
    definition: { id: "review-note" },
    evidence: { passed: true, origin: "synthetic-counterexample" },
  });
  const candidate = w.release.record({
    pluginId: base.pluginId,
    name: base.name,
    parentId: base.id,
    service: "workflow",
    contractVersion: base.contractVersion,
    source: base.source,
    code: base.code,
    definition: base.definition,
    evidence: { passed: true, origin: "synthetic-counterexample" },
    members: [
      {
        pluginId: base.pluginId,
        role: "workflow",
        enabled: true,
        versionId: base.id,
      },
      {
        pluginId: member.pluginId,
        role: "auxiliary",
        enabled: true,
        versionId: member.id,
      },
    ],
  });
  const before = JSON.stringify({
    composition: w.composition(),
    tasks: w.query(),
  });
  await verifyViaIsolatedWorkspace(
    w,
    candidate,
    parsed.plan.memberCases!,
    new AbortController().signal,
  );
  const probe = parsed.plan.browserCases!.find(
    (c) =>
      c.task === "new" &&
      c.steps.some(
        (s) => s.kind === "action" && s.action === "setReviewNote",
      ) &&
      c.steps.some((s) => s.kind === "field" && s.field === "reviewNote"),
  )!;
  assert.ok(probe);
  await assert.rejects(
    verifyBrowser(
      w,
      candidate,
      base,
      [probe],
      [],
      "synthetic-empty-start-probe",
      new AbortController().signal,
    ),
    BrowserAssertionError,
  );
  assert.equal(
    JSON.stringify({ composition: w.composition(), tasks: w.query() }),
    before,
  );
});

test("语义评估可注入宿主思考模式，输出额度仍由宿主按阶段选择", async () => {
  let body: Record<string, unknown> = {};
  const http: typeof fetch = async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        model: "deepseek-flash",
        choices: [
          {
            finish_reason: "stop",
            message: { content: '{"result":{"ok":true}}' },
          },
        ],
        usage: { total_tokens: 1 },
      }),
    );
  };
  const policy = (phase: Parameters<typeof modelPolicy>[0]) => {
    const { hash: _old, ...base } = modelPolicy(phase);
    const next = { ...base, thinking: "disabled" as const, reasoningEffort: "none" as const };
    return { ...next, hash: hash(next) };
  };
  // The fourth argument is a host dependency; model requests cannot select it.
  const driver = new DeepSeek(
    "fixture",
    http,
    "https://example.invalid",
    policy,
  );
  const reply = await driver.generate(
    {
      phase: "review",
      history: [],
      instruction: "fixture",
      schema: { type: "object" },
    },
    new AbortController().signal,
  );
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.max_tokens, 131072);
  assert.equal(reply.transport?.outputPolicy?.thinking, "disabled");
  assert.equal(modelPolicy("review").thinking, "enabled");
});

test("预检已裁决逻辑初值时宿主纠正重复声明的界面初值，显式界面要求仍保留", () => {
  const source = "新增文本标签，默认逻辑值为零；详情显示标签，其他行为不变";
  const sources = [{ id: "request:1", text: source }];
  const facts = technicalFacts({ workflowRules: [] });
  const raw = parseAdmission(JSON.stringify({ effects: [], initials: [{ source: 1, sourceQuote: source, target: { kind: "new", name: "tags" }, meaning: { kind: "state", value: "0", conditionQuote: "默认", effectQuote: "逻辑值为零" } }], questions: [] }), "base", sources, facts);
  const admission = adjudicateAdmission(JSON.stringify({ decisions: [{ claim: 1, source: 1, sourceQuote: source, layer: "initial-state", verdict: "entailed", detail: "初始逻辑值不规定未赋值显示" }] }), raw, sources);
  const input = structuredClone(archive.proposals.addition);
  input.requirements.forEach(r => { r.quote = source; for (const e of r.expectations) if (e.kind === "field") e.initial = { kind: "visible", value: "0" }; });
  const without = compilePlanInput(input, context, sources);
  const compiled = compilePlanInput(input, context, sources, admission);
  const fields = (draft: typeof compiled) => draft.requirements.flatMap(r => r.obligations).filter(o => o.kind === "field");
  assert.ok(fields(without).some(o => o.initial && (o.initial as {kind:string}).kind === "visible"));
  assert.ok(fields(compiled).every(o => (o.initial as {kind:string}).kind === "baseline"));
  assert.throws(() => compilePlanInput(input, context, sources, { ...admission, factsHash: "forged" }), /预检.*绑定|预检.*失效/);
  const displaySource = source + "；未填写时显示（空）";
  const displaySources = [{id:"request:1",text:displaySource}];
  const proposal = parseAdmission(JSON.stringify({ effects:[], questions:[], initials:[
    {...raw.intents.initials[0], sourceQuote:displaySource},
    {source:1,sourceQuote:displaySource,target:{kind:"new",name:"tags"},meaning:{kind:"literal",value:"（空）",conditionQuote:"未填写时",effectQuote:"显示（空）"}},
  ]}),"base",displaySources,facts);
  const display = adjudicateAdmission(JSON.stringify({decisions:[
    {claim:1,source:1,sourceQuote:displaySource,layer:"initial-state",verdict:"entailed",detail:"逻辑初值"},
    {claim:2,source:1,sourceQuote:displaySource,layer:"initial-display",verdict:"entailed",detail:"另外明确要求未填写呈现"},
  ]}),proposal,displaySources);
  input.requirements.forEach(r=>{r.quote=displaySource;for(const e of r.expectations)if(e.kind==="field")e.initial={kind:"visible",value:"（空）"};});
  assert.ok(fields(compilePlanInput(input,context,displaySources,display)).every(o=>(o.initial as {kind:string;value:string}).value === "（空）"));

});

test("同一新字段跨要求复用来源绑定，中文名称与字段键不同不能只纠正一条义务", () => {
  const source = "新增文本评审备注，默认逻辑值为零；详情显示备注，其他行为不变";
  const sources = [{id:"request:1",text:source}];
  const proposed = parseAdmission(JSON.stringify({effects:[],questions:[],initials:[{
    source:1,sourceQuote:"默认逻辑值为零",target:{kind:"new",name:"评审备注"},
    meaning:{kind:"state",value:"0",conditionQuote:"默认",effectQuote:"逻辑值为零"},
  }]}),"base",sources,technicalFacts({workflowRules:[]}));
  const admission = adjudicateAdmission(JSON.stringify({decisions:[{claim:1,source:1,sourceQuote:"默认逻辑值为零",layer:"initial-state",verdict:"entailed",detail:"逻辑初值不推出页面文字"}]}),proposed,sources);
  const input = structuredClone(archive.proposals.addition);
  input.requirements = ["默认逻辑值为零","详情显示备注"].map(quote=>({description:quote,quote,type:"interface",expectations:[{kind:"field",field:"reviewNote",initial:{kind:"visible",value:"0"}}]}));
  const compiled=compilePlanInput(input,context,sources,admission);
  const fields=compiled.requirements.flatMap(r=>r.obligations).filter(o=>o.kind==="field");
  assert.equal(fields.length,2);
  assert.ok(fields.every(o=>(o.initial as {kind:string}).kind==="baseline"));
});
