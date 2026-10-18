import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { compileReferences } from "../../src/evolution/references.js";
import { recordReview } from "../../src/evolution/review.js";
import { compileSpec } from "../../src/evolution/specification.js";
import {
  adjudicateTechnicalReview,
  technicalFacts,
  technicalReviewTargets,
  businessChoices,
} from "../../src/evolution/technical-facts.js";
import {
  boundReviewSchema,
  coverage,
  parseReview,
  parseRequirements,
  parseBrowserCases,
} from "../../src/server/requirement-coverage.js";
import { Workspace } from "../../src/server/workspace.js";
import { AdmissionEvolution as Evolution } from "./evolution-adapter.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver } from "./planning-fixture.js";
import {
  fieldReviewTargets,
  parseFieldDecisions,
} from "../../src/evolution/field-review.js";
import { panelMemberCases } from "./member-case-fixtures.js";
import type {
  InvestigatedPlan,
  RequirementReview,
} from "../../src/shared/assistant.js";
import type { ReviewLedger } from "../../src/shared/change-spec.js";
import { hash } from "../../src/release/storage.js";

const sources = [
  { id: "run:1", text: "保存后显示标记，历史标记保持，其他行为不变" },
];
const workflow = {
  id: "default",
  actions: [{ id: "complete" }, { id: "reopen" }],
};
const field = () => ({
  kind: "field",
  field: "noteMark",
  initial: { kind: "baseline" },
  scenarios: [
    { steps: [{ kind: "action", action: "markNote", input: {} }], value: "ok" },
  ],
});
const requirement = (id: string, obligations: unknown[] = [field()]) => ({
  id,
  source: 1,
  sourceQuote: sources[0].text,
  description: sources[0].text,
  type: "interface",
  checks: [],
  obligations,
});
function compile(requirements: ReturnType<typeof requirement>[]) {
  return compileReferences(
    {
      workflowRules: [],
      memberCases: panelMemberCases,
      browserCases: [],
      requirements,
    },
    sources,
    [],
    workflow,
    { memberCases: panelMemberCases, baseVersion: "a".repeat(64) },
  );
}
function plan() {
  const c = compile([requirement("display")]);
  return {
    id: "p",
    requestRevision: 1,
    baseVersion: "a".repeat(64),
    compositionRevision: 1,
    workflowRules: [],
    cases: [],
    evidence: [],
    writableScope: [],
    capabilityChanges: [],
    requirements: parseRequirements(c.requirements),
    browserCases: parseBrowserCases(c.browserCases),
  } as unknown as InvestigatedPlan;
}

test("宿主初始展示是独立保护事实；相同字段矩阵由宿主复用，不能产生额外业务初始限制", () => {
  const c = compile([requirement("display"), requirement("persist")]);
  assert.equal(c.browserCases.length, 4);
  assert.deepEqual(c.requirements[0].checks, c.requirements[1].checks);
  const o = c.requirements[0].obligations[0];
  assert.equal(o.kind, "field");
  if (o.kind !== "field") return;
  assert.equal(o.initialOrigin, "host");
  assert.deepEqual(o.initial, { kind: "visible", value: "（空）" });
  assert.equal(
    c.browserCases.filter((c) => c.classification === "system-protection")
      .length,
    2,
  );
  assert.equal(
    c.browserCases.filter((c) => c.classification === "frozen-business").length,
    2,
  );
  const p = { ...plan(), ...c } as InvestigatedPlan;
  assert.ok(
    coverage(p, sources, ["browser/1"]).every((c) => !c.reasons.length),
  );
  assert.equal(
    businessChoices(p).filter((c) => c.id.includes("initial-display")).length,
    0,
  );
});

test("同一字段同一初始状态的相反期望不能生成可执行计划", () => {
  const a = field();
  const b = field();
  Object.assign(a, { initial: { kind: "visible", value: "" } });
  Object.assign(b, { initial: { kind: "visible", value: "（空）" } });
  assert.throws(
    () => compile([requirement("a", [a]), requirement("b", [b])]),
    /同一字段验收义务发生冲突/,
  );
});

test("独立历史义务只产生已有任务检查，不能把旧ok当成全新任务的初始值", () => {
  const c = compile([
    requirement("display"),
    requirement("legacy", [
      {
        kind: "history",
        field: "noteMark",
      },
    ]),
  ]);
  const history = c.requirements[1].obligations[0];
  assert.equal(history.kind, "history");
  if (history.kind !== "history") return;
  assert.equal(history.history.baseVersion, "a".repeat(64));
  const historical = c.browserCases.filter(
    (c) => c.obligationId === history.id,
  );
  assert.equal(historical.length, 1);
  assert.equal(historical[0].task, "existing");
  assert.deepEqual(historical[0].steps[0], {
    kind: "field",
    member: "panel",
    field: "noteMark",
    value: "ok",
  });
});

test("历史义务排在展示义务之前，不能误把同字段的新任务初始检查当成历史检查", () => {
  const c = compile([
    requirement("legacy", [{ kind: "history", field: "noteMark" }]),
    requirement("display"),
  ]);
  const p = { ...plan(), ...c } as InvestigatedPlan;
  assert.deepEqual(
    coverage(p, sources, ["browser/1"]).flatMap((c) => c.reasons),
    [],
  );
});

test("只声明历史字段时，宿主从基础冻结案例推导准备动作和旧值，候选新值不能影响历史", () => {
  const d = {
    workflowRules: [],
    browserCases: [],
    memberCases: panelMemberCases.map((c) =>
      c.expected.kind === "commit"
        ? {
            ...c,
            expected: { ...c.expected, fields: { noteMark: "reviewed" } },
          }
        : c,
    ),
    requirements: [
      requirement("legacy", [{ kind: "history", field: "noteMark" }]),
    ],
  };
  const c = compileReferences(d, sources, [], workflow, {
    memberCases: panelMemberCases,
    baseVersion: "a".repeat(64),
  });
  const historical = c.browserCases[0];
  assert.equal(historical.task, "existing");
  assert.deepEqual(historical.prepare?.actions, [
    { kind: "action", member: "panel", action: "markNote", input: {} },
  ]);
  assert.deepEqual(historical.prepare?.expected, {
    state: "open",
    fields: { noteMark: "ok" },
  });
  assert.equal(historical.prepare?.sourceHash, hash([panelMemberCases[0]]));
});

test("新字段无动作后业务规格时阻塞，不能捏造基础历史（模型桩）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "history-blocked-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const before = { tasks: w.query(), composition: w.composition() };
  const e = new Evolution(
    w.db,
    new PlanningDriver({
      workflowRules: [],
      writableScope: [],
      memberAdditions: [{ pluginId: "panel", name: "标记" }],
      memberCases: panelMemberCases,
      capabilityChanges: [
        {
          capability: "command.register",
          provider: "member:panel",
          consumers: ["src/web/TaskEditor.tsx"],
          change: "添加标记",
        },
      ],
      requirements: [
        requirement("legacy", [{ kind: "history", field: "noteMark" }]),
      ],
    }),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: sources[0].text,
    operationId: "request",
  });
  let s = await e.observe();
  while (s.run?.status === "planning") {
    await new Promise((r) => setTimeout(r, 10));
    s = await e.observe();
  }
  assert.equal(s.run?.status, "blocked");
  assert.match(
    s.run && "message" in s.run ? s.run.message : "",
    /没有基础历史.*缺少可推导动作后义务/,
  );
  assert.equal(s.run?.budget?.callsUsed, 3);
  assert.equal(s.candidates?.length ?? 0, 0);
  assert.deepEqual({ tasks: w.query(), composition: w.composition() }, before);
});

test("后端引用绑定完整workflow检查器，选择单个序号不遗漏其他真实断言，伪造序号仍拒绝", () => {
  const cases = [1, 2, 3].map((i) => ({
    checker: "workflow/1",
    given: `g${i}`,
    when: `w${i}`,
    then: `t${i}`,
  }));
  const r = {
    ...requirement("backend", [{ kind: "backend" }]),
    type: "behavior",
    checks: [{ kind: "workflow", index: 1 }],
  };
  const c = compileReferences(
    { browserCases: [], requirements: [r] },
    sources,
    cases,
    workflow,
  );
  assert.deepEqual(
    c.requirements[0].checks.map((c) => c.caseId),
    ["workflow/1:1", "workflow/1:2", "workflow/1:3"],
  );
  assert.equal(c.requirements[0].obligations[0].kind, "backend");
  r.checks[0].index = 99;
  assert.throws(
    () =>
      compileReferences(
        { browserCases: [], requirements: [r] },
        sources,
        cases,
        workflow,
      ),
    /不存在/,
  );
});

test("新字段误报历史由宿主按真实生命周期绑定动作后矩阵，不能虚构旧值或遗漏已有任务", () => {
  const c = compileReferences(
    {
      workflowRules: [{ key: "review", required: true, minLength: 1 }],
      browserCases: [],
      requirements: [
        {
          ...requirement("write", [{ kind: "backend" }]),
          checks: [{ kind: "workflow" }],
        },
        {
          ...requirement("retain", [{ kind: "history", field: "review" }]),
          checks: [],
        },
      ],
    },
    sources,
    [{ checker: "workflow/1", given: "open", when: "complete", then: "done" }],
    { ...workflow, fields: [] },
    { baseVersion: "a".repeat(64) },
  );
  const retained = c.requirements[1];
  assert.ok(retained.obligations.every((o) => o.kind === "field"));
  assert.ok(!c.browserCases.some((b) => b.prepare));
  assert.deepEqual(
    new Set(c.browserCases.map((b) => b.task)),
    new Set(["existing", "new"]),
  );
  assert.ok(
    c.browserCases
      .filter((b) => b.id.includes("after-"))
      .every((b) => b.steps.some((s) => s.kind === "restart")),
  );
  assert.deepEqual(retained.checks, c.requirements[0].checks);
});

test("界面要求只有后端映射时从字段和成功案例生成义务；未知目标仍不能借无关 UI 放行", () => {
  const baseline = {
    baseVersion: "a".repeat(64),
    memberCases: panelMemberCases,
    uiContributions: [
      {
        id: "note-panel",
        providerId: "panel",
        fields: [{ key: "noteMark" }],
        actions: [{ commandId: "markNote" }],
      },
    ],
  };
  const r = {
    ...requirement("display", [{ kind: "backend" }]),
    checks: [{ kind: "member", index: 1 }],
  };
  const c = compileReferences(
    {
      memberCases: panelMemberCases.map((c) =>
        c.expected.kind === "commit"
          ? {
              ...c,
              expected: { ...c.expected, fields: { noteMark: "reviewed" } },
            }
          : c,
      ),
      browserCases: [],
      requirements: [r],
    },
    sources,
    [],
    workflow,
    baseline,
  );
  assert.ok(c.requirements[0].obligations.some((o) => o.kind === "field"));
  assert.ok(
    c.browserCases.some((b) => b.prepare?.expected.fields.noteMark === "ok"),
  );
  assert.deepEqual(
    coverage({ ...plan(), ...c, memberCases: panelMemberCases }, sources, [
      "workspace/1",
      "browser/1",
    ]).flatMap((c) => c.reasons),
    [],
  );
  const unknown = compileReferences(
    {
      memberCases: panelMemberCases,
      browserCases: [],
      requirements: [{ ...r, checks: [{ kind: "workflow" }] }],
    },
    sources,
    [{ checker: "workflow/1", given: "open", when: "complete", then: "done" }],
    workflow,
    baseline,
  );
  assert.ok(
    coverage(
      {
        ...plan(),
        ...unknown,
        cases: [
          {
            checker: "workflow/1",
            given: "open",
            when: "complete",
            then: "done",
          },
        ],
      },
      sources,
      ["workflow/1", "browser/1"],
    ).some((c) => c.reasons.some((r) => r.includes("界面要求"))),
  );
});

test("界面身份义务快照由宿主生成，不添加动作可见性限制；缺失、伪造和删除断言均拒绝", () => {
  const r = requirement("identity", [{ kind: "preserve-ui" }]);
  const baseline = {
    uiContributions: [
      {
        id: "note-panel",
        providerId: "panel",
        fields: [{ key: "noteMark" }],
        actions: [{ commandId: "markNote" }],
      },
    ],
  };
  const c = compileReferences(
    { requirements: [r] },
    sources,
    [],
    workflow,
    baseline,
  );
  assert.ok(
    c.browserCases.every((b) =>
      b.steps.every((s) => s.kind !== "action-visible"),
    ),
  );
  assert.deepEqual(parseBrowserCases(c.browserCases), c.browserCases);
  const p = { ...plan(), ...c };
  assert.deepEqual(
    coverage(p, sources, ["browser/1"]).flatMap((c) => c.reasons),
    [],
  );
  const changed = structuredClone(p);
  changed.browserCases[0].steps = [];
  assert.ok(
    coverage(changed, sources, ["browser/1"]).some((c) => c.reasons.length),
  );
  assert.throws(
    () => compileReferences({ requirements: [r] }, sources, [], {id:"",actions:[]}),
    /没有可信基础贡献/,
  );
  assert.throws(
    () =>
      compileReferences(
        {
          requirements: [r],
          browserCases: [
            {
              id: "fake",
              task: "new",
              steps: [{ kind: "ui-identity", contributions: [] }],
            },
          ],
        },
        sources,
        [],
        workflow,
        baseline,
      ),
    /宿主生成/,
  );
});

test("宿主派生样本可按规则重编译并保留身份，但不能手工伪造来源或删除既有字段义务", () => {
  const cases = [
    { checker: "workflow/1", given: "open", when: "complete", then: "done" },
  ];
  const raw = {
    workflowRules: [{ key: "review", minLength: 1 }],
    requirements: [
      {
        ...requirement("write", [{ kind: "backend" }]),
        checks: [{ kind: "workflow" }],
      },
    ],
  };
  const first = compileReferences(raw, sources, cases, workflow);
  const next = compileReferences(
    {
      ...raw,
      workflowRules: [{ key: "review", minLength: 3 }],
      requirements: [{ ...raw.requirements[0], id: "new" }],
    },
    sources,
    cases,
    workflow,
    { requirements: first.requirements, browserCases: first.browserCases },
  );
  const old = first.browserCases.find((c) => c.id.includes("after-"))!;
  const revised = next.browserCases.find((c) => c.id === old.id)!;
  assert.ok(revised);
  assert.notDeepEqual(old.steps, revised.steps);
  assert.equal(
    next.requirements.find((r) => r.id === "write")?.sourceRevision,
    first.requirements[0].sourceRevision,
  );
  assert.throws(
    () =>
      compileReferences(
        { ...raw, workflowRules: [], requirements: [] },
        sources,
        cases,
        workflow,
        { requirements: first.requirements },
      ),
    /不能删除旧断言/,
  );
  const forged = { ...field(), derivation: { checker: "workflow/1" } };
  assert.throws(() => compile([requirement("fake", [forged])]), /派生字段/);
});

test("技术复核wire不允许手工目标/立场，宿主绑定事实后裁决；模型schema强制区分业务和技术", () => {
  const p = plan();
  p.changeSpec = compileSpec(p, "run", hash("base"));
  const issue = {
    kind: "conflict",
    sourceRevision: sources[0].id,
    sourceQuote: sources[0].text,
    detail: "计数事实",
    technical: {
      target: technicalReviewTargets(p).find((t) => t.factId === "host-fact:workflow-text" && t.property === "lengthMetric")!.target,
      expected: "unicode-code-point",
    },
  };
  const raw = {
    reviewedIds: p.requirements!.map((r) => r.id),
    issues: [issue],
    fieldDecisions: [
      {
        target: 1,
        source: 1,
        sourceQuote: sources[0].text,
        initial: { kind: "unspecified" },
      },
    ],
  };
  const parsed = parseReview(JSON.stringify(raw), p, sources);
  assert.deepEqual(parsed.issues[0].target, {
    subject: "host-fact:workflow-text",
    aspect: "meaning",
  });
  assert.equal(parsed.issues[0].stance, "required");
  assert.equal(
    adjudicateTechnicalReview(parsed, technicalFacts(p)).issues.length,
    0,
  );
  assert.throws(
    () =>
      parseReview(
        JSON.stringify({
          ...raw,
          issues: [
            { ...issue, target: { subject: "invented", aspect: "meaning" } },
          ],
        }),
        p,
        sources,
      ),
    /宿主绑定/,
  );
  const schema = boundReviewSchema(p, sources) as {
    properties: {
      issues: {
        items: {
          anyOf: { properties: Record<string, unknown>; required: string[] }[];
        };
      };
    };
  };
  const [business, technical] = schema.properties.issues.items.anyOf;
  assert.equal(business.properties.technical, undefined);
  assert.equal(technical.properties.target, undefined);
  assert.ok(technical.required.includes("technical"));
});

test("issues空不能冒充初始覆盖；独立解释指出未填写空白时，宿主阻止沿用基线绕过", () => {
  const p = plan();
  const quote = "未填写时显示空白";
  p.requirements![0].sourceQuote = quote;
  const targets = fieldReviewTargets(p);
  assert.equal(targets.length, 1);
  assert.throws(() => parseFieldDecisions(undefined, p), /不能自报完整/);
  const result = parseFieldDecisions(
    [
      {
        target: 1,
        source: 1,
        sourceQuote: quote,
        initial: { kind: "blank",conditionQuote:quote,effectQuote:quote },
      },
    ],
    p,
  );
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "omission");
  assert.equal(result.decisions[0].sourceQuote, quote);
  assert.throws(
    () =>
      parseFieldDecisions(
        [
          {
            target: 99,
            source: 1,
            sourceQuote: quote,
            initial: { kind: "unspecified" },
          },
        ],
        p,
      ),
    /来源不存在/,
  );
});

test("同次复核多个问题不算重复运行；下一次没有新规格重报仍停止，原意见全部留证", () => {
  const ledger: ReviewLedger = { version: 2, findings: [], attempts: [] };
  const issue: RequirementReview["issues"][number] = {
    kind: "omission",
    sourceRevision: sources[0].id,
    sourceQuote: sources[0].text,
    target: { subject: "r", aspect: "coverage" },
    stance: "required",
    detail: "缺少边界用例",
  };
  const review = {
    reviewedIds: ["r"],
    issues: [issue, { ...issue, detail: "缺少错误后保留用例" }],
  };
  assert.equal(recordReview(ledger, review, 1, "same").halt, false);
  assert.equal(ledger.attempts[0].review.issues.length, 2);
  assert.equal(recordReview(ledger, review, 1, "same").halt, true);
});

test("用户明确空白呈现且宿主无法表达时，公开规划门禁直接阻塞，不生成候选或消耗修复调用", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "unsupported-display-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const r = requirement("blank");
  r.sourceQuote = "未填写显示空白";
  r.description = r.sourceQuote;
  Object.assign(r.obligations[0] as Record<string, unknown>, {
    initial: { kind: "visible", value: "" },
  });
  const e = new Evolution(
    w.db,
    new PlanningDriver({
      workflowRules: [],
      writableScope: [],
      memberAdditions: [{ pluginId: "panel", name: "标记" }],
      memberCases: panelMemberCases,
      capabilityChanges: [
        {
          capability: "command.register",
          provider: "member:panel",
          consumers: ["src/web/TaskEditor.tsx"],
          change: "添加标记",
        },
      ],
      requirements: [r],
    }),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    operationId: "request",
    text: "未填写显示空白",
  });
  let snapshot = await e.observe();
  while (snapshot.run?.status === "planning") {
    await new Promise((r) => setTimeout(r, 10));
    snapshot = await e.observe();
  }
  assert.equal(snapshot.run?.status, "blocked");
  assert.match(
    snapshot.run && "message" in snapshot.run ? snapshot.run.message : "",
    /当前无法表达该初始呈现要求/,
  );
  assert.equal(snapshot.run!.budget!.callsUsed, 3);
  assert.equal(snapshot.candidates?.length ?? 0, 0);
});

test("规划器虚构的初始ok经来源复核退回规格修正，不能误报维护者缺口或删除原审查（模型桩）", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "source-adjudication-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const fixture = new PlanningDriver({
    workflowRules: [],
    writableScope: [],
    memberAdditions: [{ pluginId: "panel", name: "标记" }],
    memberCases: panelMemberCases,
    capabilityChanges: [
      {
        capability: "command.register",
        provider: "member:panel",
        consumers: ["src/web/TaskEditor.tsx"],
        change: "添加标记",
      },
    ],
    requirements: [requirement("display")],
  });
  let plans = 0;
  const e = new Evolution(
    w.db,
    {
      async generate(request, signal) {
        const reply = await fixture.generate(request, signal);
        if (reply.calls[0]?.name === "propose_plan" && ++plans === 1) {
          const rs = reply.calls[0].args.requirements as {
            expectations: Record<string, unknown>[];
          }[];
          rs[0].expectations[0].initial = { kind: "visible", value: "ok" };
        }
        if (
          request.schema &&
          JSON.parse(request.message!).kind !== "clarification-review/1"
        ) {
          const r = JSON.parse(reply.text);
          r.fieldDecisions[0].initial = { kind: "unspecified" };
          reply.text = JSON.stringify(r);
        }
        return reply;
      },
    },
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: sources[0].text,
    operationId: "request",
  });
  let s = await e.observe();
  while (s.run?.status === "planning") {
    await new Promise((r) => setTimeout(r, 10));
    s = await e.observe();
  }
  assert.equal(s.run?.status, "ready", JSON.stringify(s.run));
  assert.equal(s.run.budget?.callsUsed, 5);
  assert.equal(s.run.revisions!.length, 1);
  assert.equal(s.run.reviewLedger!.attempts.length, 2);
  assert.ok(
    s.run.reviewLedger!.attempts[0].review.issues.some(
      (i) => i.kind === "extra-constraint",
    ),
  );
  assert.equal(s.candidates?.length ?? 0, 0);
});
