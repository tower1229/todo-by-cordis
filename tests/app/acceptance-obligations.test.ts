import test from "node:test";
import assert from "node:assert/strict";
import { compileReferences } from "../../src/evolution/references.js";
import { historicalPreparation } from "../../src/evolution/historical-preparation.js";
import {
  adjudicateTechnicalReview,
  businessChoices,
  reviewQuestion,
  technicalFacts,
} from "../../src/evolution/technical-facts.js";
import {
  coverage,
  freezeRequirements,
  gateFailure,
  parseBrowserCases,
  parseRequirements,
} from "../../src/server/requirement-coverage.js";
import { compileSpec } from "../../src/evolution/specification.js";
import { hash } from "../../src/release/storage.js";
import type {
  InvestigatedPlan,
  RequirementReview,
} from "../../src/shared/assistant.js";
import { panelMemberCases } from "./member-case-fixtures.js";

const sources = [
  {
    id: "run:1",
    text: "详情显示备注，尚未填写时显示空白，写入后刷新及重启保留；旧标记不自动替换",
  },
];
const workflow = {
  id: "default",
  actions: [{ id: "complete" }, { id: "reopen" }],
};
function draft() {
  return {
    workflowRules: [],
    memberCases: panelMemberCases,
    browserCases: [
      {
        id: "only-after",
        task: "new",
        steps: [
          { kind: "action", action: "markNote", input: {} },
          { kind: "field", field: "noteMark", value: "ok" },
        ],
      },
    ],
    requirements: [
      {
        id: "display",
        description: sources[0].text,
        source: 1,
        sourceQuote: sources[0].text,
        type: "interface",
        checks: [{ kind: "browser", index: 1 }],
        obligations: [
          {
            kind: "field",
            field: "noteMark",
            initial: { kind: "visible", value: "" },
            scenarios: [
              {
                steps: [{ kind: "action", action: "markNote", input: {} }],
                value: "ok",
              },
            ],
          },
        ],
      },
    ],
  };
}
function plan() {
  const compiled = compileReferences(draft(), sources, [], workflow);
  return {
    id: "plan",
    requestRevision: 1,
    baseVersion: "base",
    compositionRevision: 1,
    workflowRules: [],
    cases: [],
    writableScope: [],
    capabilityChanges: [],
    evidence: [],
    requirements: parseRequirements(compiled.requirements),
    browserCases: parseBrowserCases(compiled.browserCases),
    binding: {
      guideCatalog: {},
      materials: [],
      capabilities: [],
      checkers: [{ id: "browser/1", version: "browser-checker" }],
    },
  } as unknown as InvestigatedPlan;
}

test("遗漏初始义务、用一般断言冒充字段、伪造派生案例均在规划编译时拒绝", () => {
  const missing: Record<string, unknown> = draft();
  const requirements = missing.requirements as Record<string, unknown>[];
  delete requirements[0].obligations;
  assert.throws(
    () => compileReferences(missing, sources, [], workflow),
    /义务.*缺失/,
  );
  const initial = draft();
  delete (initial.requirements[0].obligations[0] as Record<string, unknown>)
    .initial;
  assert.throws(
    () => compileReferences(initial, sources, [], workflow),
    /必需字段/,
  );
  const bypass = draft();
  Object.assign(bypass.requirements[0], {
    obligations: [
      {
        kind: "assertion",
        steps: [],
        expected: { kind: "field", field: "noteMark", value: "ok" },
      },
    ],
  });
  assert.throws(
    () => compileReferences(bypass, sources, [], workflow),
    /不能代替字段/,
  );
  Object.assign(bypass.requirements[0], {
    obligations: [{ kind: "assertion", steps: [], expected: { kind: "task" } }],
  });
  const compiled = compileReferences(bypass, sources, [], workflow);
  assert.ok(
    coverage({ ...plan(), ...compiled } as InvestigatedPlan, sources, [
      "browser/1",
    ])[0].reasons.some((r) => r.includes("可见字段")),
  );
  Object.assign(initial.requirements[0], {
    obligations: [
      { kind: "field", id: "forged", initial: { kind: "visible", value: "" } },
    ],
  });
  assert.throws(
    () => compileReferences(initial, sources, [], workflow),
    /派生字段/,
  );
});

test("宿主强制生成初始及动作后 × 新旧任务 × 刷新重启矩阵；删除或替换任意断言均未覆盖", () => {
  const p = plan();
  const generated = p.browserCases!.filter((c) => c.obligationId);
  assert.equal(generated.length, 4);
  for (const c of generated) {
    assert.equal(c.steps.filter((s) => s.kind === "field").length, 3);
    assert.ok(c.steps.some((s) => s.kind === "refresh"));
    assert.ok(c.steps.some((s) => s.kind === "restart"));
  }
  assert.ok(coverage(p, sources, ["browser/1"])[0].reasons.length === 0);
  for (const mutate of [
    (p: InvestigatedPlan) => {
      p.browserCases = p.browserCases!.filter(
        (c) => !c.id.includes("initial-") && c.id.endsWith("-new"),
      );
    },
    (p: InvestigatedPlan) => {
      p.browserCases!.find(
        (c) => c.id.includes("initial-") && c.id.endsWith("-existing"),
      )!.steps = [{ kind: "task" }];
    },
    (p: InvestigatedPlan) => {
      p.browserCases!.find(
        (c) => c.id.includes("after-") && c.id.endsWith("-new"),
      )!.steps = p
        .browserCases!.find(
          (c) => c.id.includes("after-") && c.id.endsWith("-new"),
        )!
        .steps.filter((s) => s.kind !== "restart");
    },
  ]) {
    const copy = structuredClone(p);
    mutate(copy);
    assert.ok(
      coverage(copy, sources, ["browser/1"])[0].reasons.some((r) =>
        r.includes("验收义务"),
      ),
    );
  }
});

test("义务与案例双写篡改及需求修订不能绕过冻结证据", () => {
  const p = plan();
  p.changeSpec = compileSpec(p, "run", hash("base"));
  p.requirementGate = freezeRequirements(
    p,
    sources,
    "original-request",
    { reviewedIds: p.requirements!.map((r) => r.id), issues: [] },
    ["browser/1"],
  );
  const trusted = structuredClone(p.requirementGate);
  assert.equal(gateFailure(p, trusted, "original-request"), undefined);
  assert.match(gateFailure(p, trusted, "revised-request")!, /已变化/);
  const o = p.requirements![0].obligations![0];
  if (o.kind !== "field") throw new Error("field expected");
  o.initial = { kind: "visible", value: "（空）" };
  p.changeSpec = compileSpec(p, "run", hash("base"));
  p.requirementGate = freezeRequirements(
    p,
    sources,
    "original-request",
    { reviewedIds: p.requirements!.map((r) => r.id), issues: [] },
    ["browser/1"],
  );
  assert.ok(gateFailure(p, trusted, "original-request"));
});

test("已接受要求修订沿用宿主义务及案例身份，期望改变仍留给原验收修订门禁", () => {
  const p = plan();
  const revised = draft();
  revised.requirements[0].obligations[0].initial.value = "（空）";
  const compiled = compileReferences(
    revised,
    [{ id: "run:2", text: sources[0].text }],
    [],
    workflow,
    { requirements: p.requirements, browserCases: p.browserCases },
  );
  assert.equal(
    compiled.requirements[0].obligations[0].id,
    p.requirements![0].obligations![0].id,
  );
  assert.equal(compiled.requirements[0].sourceRevision, "run:2");
  const old = p.browserCases!.find(
    (c) => c.id.includes("initial-") && c.id.endsWith("-new"),
  )!;
  const replacement = compiled.browserCases.find((c) => c.id === old.id)!;
  assert.ok(replacement);
  assert.notEqual(hash(replacement), hash(old));
});

test("历史准备从基线冻结案例推导，不能使用候选新值、任意字段注入或不存在的历史", () => {
  const h = historicalPreparation(
    { member: "panel", field: "noteMark" },
    panelMemberCases,
    "a".repeat(64),
  );
  assert.deepEqual(h.expected, { state: "open", fields: { noteMark: "ok" } });
  assert.deepEqual(h.actions, [
    { kind: "action", member: "panel", action: "markNote", input: {} },
  ]);
  assert.equal(h.sourceHash, hash([panelMemberCases[0]]));
  assert.throws(
    () =>
      historicalPreparation(
        { member: "panel", field: "nonexistent" },
        panelMemberCases,
        "a".repeat(64),
      ),
    /基础版本/,
  );
  assert.throws(
    () =>
      historicalPreparation(
        { member: "panel", field: "noteMark" },
        [],
        "a".repeat(64),
      ),
    /基础版本/,
  );
  const d = draft();
  d.requirements[0].obligations.push({kind:"history",field:"noteMark"} as typeof d.requirements[0].obligations[number]);
  const compiled = compileReferences(d, sources, [], workflow, {
    memberCases: panelMemberCases,
    baseVersion: "a".repeat(64),
  });
  const legacy = compiled.browserCases.find((c) =>
    c.id.includes("-historical-"),
  )!;
  assert.equal(legacy.task, "existing");
  assert.equal(legacy.prepare?.expected.fields.noteMark, "ok");
  assert.equal((legacy.steps[0] as { value: string }).value, "ok");
  const assumed = plan();
  const extra = assumed.browserCases![0];
  extra.steps = [
    { kind: "field", member: "panel", field: "noteMark", value: "ok" },
  ];
  extra.task = "existing";
  assert.ok(
    coverage(assumed, sources, ["browser/1"])[0].reasons.some((r) =>
      r.includes("初始状态未准备"),
    ),
  );
});

test("Unicode 等技术事实由宿主确定性裁决，保留原意见；冲突与不支持均阻塞且不问用户", () => {
  const p = plan();
  const facts = technicalFacts(p);
  const issue: RequirementReview["issues"][number] = {
    kind: "conflict",
    sourceRevision: sources[0].id,
    sourceQuote: sources[0].text,
    target: { subject: "host-fact:workflow-text", aspect: "meaning" },
    stance: "required",
    detail: "计数语义需要澄清",
    clarification: "Unicode 应怎样计数？",
    technical: {
      factId: "host-fact:workflow-text",
      property: "lengthMetric",
      expected: "unicode-code-point",
    },
  };
  const review: RequirementReview = {
    reviewedIds: ["display"],
    issues: [issue],
  };
  const adjudicated = adjudicateTechnicalReview(review, facts);
  assert.equal(adjudicated.issues.length, 0);
  assert.equal(
    adjudicated.technicalDecisions![0].issue.clarification,
    issue.clarification,
  );
  assert.equal(adjudicated.technicalDecisions![0].outcome, "satisfied");
  assert.ok(adjudicated.technicalDecisions![0].factHash);
  assert.equal(review.issues.length, 1);
  for (const claim of [
    { property: "lengthMetric", expected: "utf16-code-unit" },
    { property: "unknown", expected: "anything" },
  ]) {
    const result = adjudicateTechnicalReview(
      {
        ...review,
        issues: [{ ...issue, technical: { ...issue.technical!, ...claim } }],
      },
      facts,
    );
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].clarification, undefined);
    assert.notEqual(result.technicalDecisions![0].outcome, "satisfied");
  }
  assert.throws(
    () =>
      adjudicateTechnicalReview(
        { ...review, issues: [{ ...issue, technical: undefined }] },
        facts,
      ),
    /不能转交用户/,
  );
  const business = {
    ...issue,
    target: { subject: "display", aspect: "input" as const },
    technical: undefined,
  };
  assert.equal(
    adjudicateTechnicalReview({ ...review, issues: [business] }, facts)
      .issues[0].clarification,
    issue.clarification,
  );
});

test("自由文本复核问题不能绕过技术裁决；业务问题只能由宿主目录生成", () => {
  const p = plan();
  const issue: RequirementReview["issues"][number] = {
    kind: "unverifiable",
    sourceRevision: sources[0].id,
    sourceQuote: sources[0].text,
    target: { subject: p.requirements![0].id, aspect: "meaning" },
    stance: "undetermined",
    detail: "复核疑问",
    clarification: "字和 Unicode 码点怎样对应？",
  };
  const review: RequirementReview = {
    reviewedIds: [p.requirements![0].id],
    issues: [issue],
  };
  assert.throws(
    () => reviewQuestion(review, p),
    /自由文本及技术问题不能直接提问/,
  );
  const choice = businessChoices(p)[0];
  assert.ok(choice.id.startsWith("business-choice:initial-display:"));
  const bound = {
    ...review, fieldDecisions: [{obligationId: p.requirements![0].obligations![0].id, sourceRevision: sources[0].id, sourceQuote: sources[0].text, initial: {kind: "undetermined" as const}}],
    issues: [{ ...issue, clarificationChoice: choice.id }],
  };
  assert.equal(reviewQuestion(bound, p), choice.question);
  assert.notEqual(reviewQuestion(bound, p), issue.clarification);
  assert.throws(
    () =>
      reviewQuestion(
        { ...review, issues: [{ ...issue, clarificationChoice: "forged" }] },
        p,
      ),
    /目录绑定/,
  );
  assert.throws(
    () =>
      reviewQuestion(
        {
          ...review,
          issues: [
            {
              ...issue,
              target: { subject: "host-fact:workflow-text", aspect: "meaning" },
              clarificationChoice: choice.id,
            },
          ],
        },
        p,
      ),
    /技术事实不能/,
  );
});
