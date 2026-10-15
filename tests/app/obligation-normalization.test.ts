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
    2,
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
        history: { actions: [{ action: "markNote", input: {} }] },
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

test("技术复核wire不允许手工目标/立场，宿主绑定事实后裁决；模型schema强制区分业务和技术", () => {
  const p = plan();
  p.changeSpec = compileSpec(p, "run", hash("base"));
  const issue = {
    kind: "conflict",
    sourceRevision: sources[0].id,
    sourceQuote: sources[0].text,
    detail: "计数事实",
    technical: {
      factId: "host-fact:workflow-text",
      property: "lengthMetric",
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
        initial: { kind: "visible", value: "" },
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

test("规划器虚构的初始ok经来源复核退回规格修正，不能误报维护者缺口或删除原审查（模型桩）",async t=>{
  const dir=await mkdtemp(join(tmpdir(),"source-adjudication-"));const w=await Workspace.open(join(dir,"workspace.db"));
  const fixture=new PlanningDriver({workflowRules:[],writableScope:[],memberAdditions:[{pluginId:"panel",name:"标记"}],memberCases:panelMemberCases,capabilityChanges:[{capability:"command.register",provider:"member:panel",consumers:["src/web/TaskEditor.tsx"],change:"添加标记"}],requirements:[requirement("display")]});
  let plans=0;
  const e=new Evolution(w.db,{async generate(request,signal){
    const reply=await fixture.generate(request,signal);
    if(reply.calls[0]?.name==="propose_plan" && ++plans===1){const rs=reply.calls[0].args.requirements as {obligations:Record<string,unknown>[]}[];rs[0].obligations[0].initial={kind:"visible",value:"ok"};}
    if(request.schema && JSON.parse(request.message!).kind!=="clarification-review/1"){const r=JSON.parse(reply.text);r.fieldDecisions[0].initial={kind:"unspecified"};reply.text=JSON.stringify(r);}
    return reply;
  }},new EvolutionDomain(w));
  t.after(async()=>{await e.close();await w.close();await rm(dir,{recursive:true,force:true});});
  await e.command({type:"request",text:sources[0].text,operationId:"request"});
  let s=await e.observe();while(s.run?.status==="planning"){await new Promise(r=>setTimeout(r,10));s=await e.observe();}
  assert.equal(s.run?.status,"ready",JSON.stringify(s.run));assert.equal(s.run.budget?.callsUsed,5);assert.equal(s.run.revisions!.length,1);
  assert.equal(s.run.reviewLedger!.attempts.length,2);assert.ok(s.run.reviewLedger!.attempts[0].review.issues.some(i=>i.kind==="extra-constraint"));
  assert.equal(s.candidates?.length??0,0);
});
