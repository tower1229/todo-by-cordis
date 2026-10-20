import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adjudicateTechnicalReview,
  technicalFacts,
  technicalReviewTargets,
} from "../../src/evolution/technical-facts.js";
import { modelPolicy } from "../../src/evolution/model-policy.js";
import { Workspace } from "../../src/server/workspace.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { Evolution } from "./evolution-adapter.js";
import { PlanningDriver } from "./planning-fixture.js";
import {
  compileSpec,
  specificationFailure,
} from "../../src/evolution/specification.js";
import { requirementReviewInput } from "../../src/evolution/review-input.js";
import {
  boundReviewSchema,
  caseCatalog,
  parseReview,
} from "../../src/server/requirement-coverage.js";
import type {
  InvestigatedPlan,
  RequirementReview,
} from "../../src/shared/assistant.js";
import type { ReviewLedger } from "../../src/shared/change-spec.js";
import { recordReview, reviewEvidence } from "../../src/evolution/review.js";
import { hash } from "../../src/release/storage.js";
import { schemaProblems } from "../../src/evolution/model-protocol.js";

const sources = [
  {
    id: "run:1",
    text: "复盘必填，去掉首尾空白后至少1个、最多100个Unicode码点，其他行为不变",
  },
];
function plan(): InvestigatedPlan {
  const p: InvestigatedPlan = {
    id: "plan",
    requestRevision: 1,
    baseVersion: "base",
    compositionRevision: 1,
    route: { kind: "application" },
    summary: "完成前填复盘",
    changes: ["增加复盘"],
    outcome: "完成后保存复盘",
    dataImpact: "保留历史字段",
    workflowRules: [
      {
        key: "reflection",
        label: "复盘",
        required: true,
        minLength: 1,
        maxLength: 100,
      },
    ],
    cases: [
      {
        checker: "workflow/1",
        given: "已有任务",
        when: "带首尾空白完成",
        then: "保存去空白的值并保留其他字段",
      },
    ],
    requirements: [
      {
        id: "requirement",
        description: sources[0].text,
        type: "behavior",
        sourceRevision: sources[0].id,
        sourceQuote: sources[0].text,
        checks: [{ checker: "workflow/1", caseId: "workflow/1:1" }],
      },
    ],
    binding: {
      guideCatalog: {},
      materials: [],
      capabilities: [],
      checkers: [{ id: "workflow/1", version: "checker-version" }],
    },
    ruleChanges: [],
    excluded: [],
    evidence: [],
    capabilityChanges: [],
    steps: [],
    writableScope: [],
    compatibility: "保留",
    rollback: "恢复",
    preview: "隔离体验",
    application: "独立确认",
    restartImpact: "重启",
    dependencies: [],
    unresolved: [],
  };
  p.changeSpec = compileSpec(p, "run", "source-hash");
  return p;
}

function review(p: InvestigatedPlan, issues: unknown[]) {
  return JSON.stringify({
    reviewedIds: p.requirements!.map((r) => r.id),
    issues,
    fieldDecisions: [],
  });
}

test("只读宿主事实随统一规格冻结；收窄复核选项不能丢失真实交互与执行事实", () => {
  const p = plan();
  const input = requirementReviewInput(p, sources);
  assert.ok(Array.isArray(input.hostFacts), "复核仍须收到只读宿主事实");
  assert.deepEqual(input.hostFacts, p.changeSpec!.hostFacts);
  assert.ok(input.hostFacts.some(f => f.id === "host-fact:field-interaction" && f.properties.detail === "read-only-display"));
  assert.ok(!input.technicalTargets.some(t => t.factId === "host-fact:field-interaction"));
  const fact = p.changeSpec!.hostFacts.find(f => f.id === "host-fact:field-interaction")!;
  fact.properties.detail = "任意改写事实";
  assert.match(specificationFailure(p) ?? "", /冻结|规格.*不一致/);
});

test("定时检查器真实覆盖范围以宿主事实绑定，不能被误认为已通过或仅手动动作", () => {
  const p = plan();
  p.binding!.checkers.push({id: "schedule/1", version: "schedule-checker-hash"});
  p.changeSpec = compileSpec(p, "run", "source-hash");
  const input = requirementReviewInput(p, sources);
  const fact = input.hostFacts.find(f => f.id === "host-fact:checker:schedule/1")!;
  assert.ok(fact);
  assert.equal(fact.properties.checkerHash, "schedule-checker-hash");
  assert.equal(fact.properties.stage, "candidate-verification-required");
  assert.match(fact.properties.execution, /controlled-clock/);
  assert.match(fact.properties["assert:on-time"], /提前|到点/);
  assert.match(fact.properties.limits, /重新打开|页面/);
  const target = technicalReviewTargets(p).find(t => t.factId === fact.id && t.property === "execution")!;
  const parsed = parseReview(review(p, [{kind:"unverifiable",sourceRevision:sources[0].id,sourceQuote:sources[0].text,detail:"误认为没有真实定时检查器",technical:{target:target.target,expected:"manual-action-only"}}]),p,sources);
  const result = adjudicateTechnicalReview(parsed,technicalFacts(p));
  assert.equal(result.issues.length,1);
  assert.equal(result.technicalDecisions[0].outcome,"conflict");
  const supported = parseReview(review(p, [{kind:"unverifiable",sourceRevision:sources[0].id,sourceQuote:sources[0].text,detail:"要求真实受控时钟执行",technical:{target:target.target,expected:fact.properties.execution}}]),p,sources);
  assert.equal(adjudicateTechnicalReview(supported,technicalFacts(p)).issues.length,0);
});

test("修改无关要求不能重置复核问题的无进展保护，实际修正目标才提供新证据", () => {
  const p=plan();
  p.requirements!.push({...structuredClone(p.requirements![0]),id:"unrelated"});
  const issue:RequirementReview["issues"][number]={kind:"extra-constraint",sourceRevision:sources[0].id,sourceQuote:sources[0].text,detail:"保存语义",target:{subject:"requirement",aspect:"persistence"},stance:"forbidden"};
  const result={reviewedIds:["requirement","unrelated"],issues:[issue]};
  const ledger:ReviewLedger={version:2,findings:[],attempts:[]};
  recordReview(ledger,result,1,hash(p),i=>reviewEvidence(p,sources,i));
  p.requirements![1].description="只改变无关要求";
  assert.equal(recordReview(ledger,result,1,hash(p),i=>reviewEvidence(p,sources,i)).halt,true);
  const before=reviewEvidence(p,sources,issue);
  p.requirements![0].sourceQuote="去掉首尾空白";
  assert.notEqual(reviewEvidence(p,sources,issue),before);
});

test("复核技术目标只包含可比较语义，身份摘要和只读诊断不再成为模型裁决选项", () => {
  const p=plan();
  const targets=technicalReviewTargets(p);
  assert.ok(targets.length>0);
  assert.ok(targets.every(t=>t.expectedValues.length>1));
  assert.ok(!targets.some(t=>["baselineHash","origin","failureCodes","definition"].includes(t.property)));
});

test("同一检查器的校验、保存规则有独立宿主来源、作用域与精确检查器绑定", () => {
  const p = plan();
  const input = requirementReviewInput(p, sources);
  const rules = p.changeSpec!.hostRules;
  assert.equal(rules.length, 3);
  for (const rule of rules) {
    assert.equal(rule.origin, "host");
    assert.equal(rule.checkerHash, "checker-version");
    assert.deepEqual(rule.scope, {
      action: "complete",
      fields: ["reflection"],
    });
    assert.deepEqual(rule.checks, [
      { checker: "workflow/1", caseId: "workflow/1:1" },
    ]);
    const projected = input.hostRules.find((r) => r.id === rule.id)!;
    const target = input.technicalTargets.find(
      (t) => t.target === projected.technicalTarget,
    )!;
    assert.equal(target.actual, rule.value);
    assert.equal(target.property, rule.property);
  }
  assert.equal(input.requirementOrigins[0].origin, "request");
  assert.equal(
    input.hostRules.find((r) => r.aspect === "persistence")!.origin,
    "host",
  );
});

test("技术裁决不依赖模型问题分类；匹配事实留证，显式要求相反保存语义仍阻塞", () => {
  const p = plan();
  const target = technicalReviewTargets(p).find(
    (t) => t.property === "persistenceNormalization",
  )!;
  for (const expected of ["trim", "preserve"] as const) {
    const wire = review(p, [
      {
        kind: "extra-constraint",
        sourceRevision: sources[0].id,
        sourceQuote: sources[0].text,
        detail: "保存归一化规则",
        technical: { target: target.target, expected },
      },
    ]);
    assert.deepEqual(
      schemaProblems(JSON.parse(wire), boundReviewSchema(p, sources)),
      [],
    );
    const result = adjudicateTechnicalReview(
      parseReview(wire, p, sources),
      technicalFacts(p),
    );
    assert.equal(
      result.technicalDecisions![0].property,
      "persistenceNormalization",
    );
    assert.equal(
      result.technicalDecisions![0].outcome,
      expected === "trim" ? "satisfied" : "conflict",
    );
    assert.equal(result.issues.length, expected === "trim" ? 0 : 1);
  }
  const ordinary = parseReview(
    review(p, [
      {
        kind: "extra-constraint",
        sourceRevision: sources[0].id,
        sourceQuote: sources[0].text,
        detail: "规划器将保存规则错误归因于用户",
        target: { subject: "requirement", aspect: "persistence" },
        stance: "forbidden",
      },
    ]),
    p,
    sources,
  );
  assert.equal(
    adjudicateTechnicalReview(ordinary, technicalFacts(p)).issues.length,
    1,
    "宽泛业务异议不能被宿主规则自动抹掉",
  );
});

test("伪造技术目标、手填属性及无效来源无法进入宿主裁决", () => {
  const p = plan();
  const target = technicalReviewTargets(p).find(
    (t) => t.property === "persistenceNormalization",
  )!;
  for (const technical of [
    { target: "invented", expected: "trim" },
    {
      target: target.target,
      property: "validationNormalization",
      expected: "trim",
    },
    { factId: target.factId, property: target.property, expected: "trim" },
  ]) {
    const wire = review(p, [
      {
        kind: "conflict",
        sourceRevision: sources[0].id,
        sourceQuote: sources[0].text,
        detail: "fixture",
        technical,
      },
    ]);
    assert.throws(
      () => parseReview(wire, p, sources),
      /宿主.*绑定|宿主属性目标/,
    );
  }
  assert.throws(
    () =>
      parseReview(
        review(p, [
          {
            kind: "conflict",
            sourceRevision: "unknown",
            sourceQuote: sources[0].text,
            detail: "fixture",
            technical: { target: target.target, expected: "trim" },
          },
        ]),
        p,
        sources,
      ),
    /来源引用/,
  );
});

test("删除、改写或重新计算摘要不能伪造冻结的宿主规则；旧计划须重新规划", () => {
  for (const alteration of [
    "delete",
    "rewrite",
    "scope",
    "checker",
    "missing",
  ] as const) {
    const p = plan();
    const spec = p.changeSpec!;
    if (alteration === "delete") spec.hostRules = [];
    else if (alteration === "missing")
      delete (spec as Partial<typeof spec>).hostRules;
    else {
      const r = spec.hostRules[1];
      if (alteration === "rewrite") Object.assign(r, { value: "preserve" });
      if (alteration === "scope") r.scope.fields = [];
      if (alteration === "checker") r.checkerHash = "other-checker";
      const { hash: _hash, ...body } = r;
      r.hash = hash(body);
    }
    assert.match(specificationFailure(p)!, /冻结需求/);
    assert.throws(() => requirementReviewInput(p, sources), /冻结需求/);
  }
});

test("复核历史按内容引用去重，未决、已消解及相反意见均完整保留", () => {
  const p = plan();
  const issue: RequirementReview["issues"][number] = {
    kind: "extra-constraint",
    sourceRevision: sources[0].id,
    sourceQuote: sources[0].text,
    detail: "额外保存限制",
    target: { subject: "requirement", aspect: "persistence" },
    stance: "forbidden",
  };
  const ledger: ReviewLedger = { version: 2, findings: [], attempts: [] };
  recordReview(
    ledger,
    { reviewedIds: ["requirement"], issues: [issue] },
    1,
    "old",
  );
  recordReview(
    ledger,
    {
      reviewedIds: ["requirement"],
      issues: [],
      resolutions: [
        {
          issueId: ledger.findings[0].id,
          sourceRevision: sources[0].id,
          sourceQuote: sources[0].text,
          reason: "修正来源归属",
        },
      ],
    },
    1,
    "corrected",
  );
  const before = hash({ p, ledger });
  const input = requirementReviewInput(p, sources, ledger);
  const compact = input.reviewLedger!;
  assert.equal(Object.keys(compact.issues).length, 1);
  assert.deepEqual(
    compact.findings.map(({ issueRef, ...f }) => ({
      ...f,
      issue: compact.issues[issueRef],
    })),
    ledger.findings,
  );
  assert.deepEqual(
    compact.attempts.map(({ review: { issueRefs, ...r }, ...a }) => ({
      ...a,
      review: { ...r, issues: issueRefs.map((ref) => compact.issues[ref]) },
    })),
    ledger.attempts,
  );
  assert.deepEqual(input.acceptance, caseCatalog(p));
  assert.equal(
    input.specification.definitionHash,
    hash(p.changeSpec!.definition),
  );
  assert.equal(hash({ p, ledger }), before, "投影不得修改冻结规格或账本");
  input.requirements![0].description = "篡改投影";
  input.sources[0].text = "篡改来源";
  assert.equal(hash({ p, ledger }), before, "投影不得持有可变的冻结对象引用");
});

test("宿主区分文本校验归一化与持久化归一化，不能依赖业务描述猜测", () => {
  const fact = technicalFacts({ workflowRules: [] }).find(
    (f) => f.id === "host-fact:workflow-text",
  )!;
  assert.equal(fact.properties.validationNormalization, "trim");
  assert.equal(fact.properties.persistenceNormalization, "trim");
});

test("真实规划调用交付唯一的复核规格投影，保持义务、来源与验收完整", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "review-authority-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  const driver = new PlanningDriver();
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: "完成前必须填写复盘，其他行为不变",
    operationId: "request",
  });
  for (let n = 0; n < 1000; n++) {
    const run = (await e.observe()).run!;
    if (run.status !== "planning") {
      assert.equal(run.status, "ready");
      if (run.status !== "ready") return;
      const review = driver.requests.find(
        (r) =>
          r.phase === "review" && JSON.parse(r.message ?? "{}").requirements,
      )!;
      const input = JSON.parse(review.message!);
      assert.equal(
        Object.hasOwn(input, "changeSpec"),
        false,
        "不能重复交付整份 changeSpec.definition",
      );
      assert.deepEqual(input.requirements, run.plan.requirements);
      assert.deepEqual(input.workflowRules, run.plan.workflowRules);
      assert.deepEqual(input.sources, run.plan.requirementGate!.sources);
      assert.equal(run.budget!.callsUsed + run.budget!.callsRemaining, 12);
      assert.equal(run.budget!.candidatesRemaining, 3);
      assert.ok(run.budget!.millisecondsRemaining <= 600000);
      assert.equal(
        Object.hasOwn(input.requestAdmission ?? {}, "sources"),
        false,
      );
      assert.equal(
        Object.hasOwn(input.requestAdmission ?? {}, "factsSnapshot"),
        false,
      );
      const planning = driver.requests.find(r=>r.phase === "planning" && JSON.parse(r.message??"{}").sources)!;
      const preparation = JSON.parse(planning.message!);
      assert.equal(preparation.request,undefined);
      assert.equal(preparation.revisions,undefined);
      assert.equal(preparation.previousPlans,undefined);
      assert.equal(preparation.baselineFacts,undefined);
      assert.ok(preparation.materials.documents.some((d:{ref:string})=>d.ref==="guide/workflow.provide"));
      assert.ok(!preparation.materials.documents.some((d:{ref:string})=>d.ref==="guide/command.register"));
      assert.deepEqual(review.history, []);
      assert.equal(review.tools, undefined);
      assert.ok(input.acceptance.length);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("规划未结束");
});

test("max 输出资源按阶段分配，不再让复杂复核沿用 32768 上限", () => {
  assert.ok(modelPolicy("review").maxTokens > 32768);
  assert.ok(
    modelPolicy("review").maxTokens > modelPolicy("admission").maxTokens,
  );
  for (const phase of [
    "admission",
    "planning",
    "review",
    "generation",
  ] as const) {
    assert.equal(modelPolicy(phase).thinking, "enabled");
    assert.equal(modelPolicy(phase).reasoningEffort, "max");
    assert.equal(modelPolicy(phase).truncation, "block");
  }
});

test("复核来源按验收作用域冻结：动作拒绝不提升为全局必填，观察不提升为错误文案要求", () => {
  const p = plan();
  p.requirements![0].obligations = [
    {version:1,id:"input",kind:"workflow-input",rules:p.workflowRules},
    { version: 1, id: "reject", kind: "backend-rejection", action: {kind:"action", member:"tags", action:"setTags", input:{tags:"   "}}, cases:[] },
    { version: 1, id: "feedback", kind: "feedback", action:{kind:"action",member:"tags",action:"setTags"}, text:"", resolution:"not-requested", scenarios:[], unavailable:[] },
    { version: 1, id: "field", kind: "field", member:"tags",field:"tags",initial:{kind:"visible",value:"（空）"},initialOrigin:"host",scenarios:[] },
  ];
  p.changeSpec = compileSpec(p,"run","base-hash");
  const input = requirementReviewInput(p,sources);
  assert.deepEqual(input.validationOrigins.find(o=>o.obligationId==="reject")?.scope,{kind:"action",member:"tags",action:"setTags"});
  assert.equal(input.validationOrigins.find(o=>o.obligationId==="feedback")?.origin,"observation");
  assert.equal(input.validationOrigins.find(o=>o.obligationId==="field"&&o.aspect==="initial-display")?.origin,"host");
  assert.equal(input.validationOrigins.find(o=>o.obligationId==="input"&&o.aspect==="required-and-length")?.origin,"requirement");
  p.changeSpec.validationOrigins.find(o=>o.obligationId==="reject")!.origin = "host";
  assert.match(specificationFailure(p)!, /来源|规格/);
});
