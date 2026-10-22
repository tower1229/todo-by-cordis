import test from "node:test";
import assert from "node:assert/strict";
import { parseAdmission } from "../../src/evolution/request-admission.js";
import { sourceItems } from "../../src/evolution/source-items.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import { parseClarificationDecision } from "../../src/evolution/clarification-review.js";
import { recordReview } from "../../src/evolution/review.js";
import type { ReviewLedger } from "../../src/shared/change-spec.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";
import {
  designTargets,
  parseDesignDecisions,
  compileAuthority,
  authorityFailure,
} from "../../src/evolution/contract-authority.js";
import { parseReview } from "../../src/server/requirement-coverage.js";
import {
  compileSpec,
  specificationFailure,
} from "../../src/evolution/specification.js";
import { captureAvailability } from "../../src/evolution/action-availability.js";
import { hash } from "../../src/release/storage.js";
import { reviewEvidence } from "../../src/evolution/review.js";
import { parseFieldDecisions } from "../../src/evolution/field-review.js";
import { tagsTrimOnlyMemberCases } from "./member-case-fixtures.js";

const sources = [
  { id: "run:1", text: "增加任务标签，保存时拒绝空白标签；其他行为不变。" },
];

test("标签必填命题不能省略动作输入与任务存在性的作用域", () => {
  const facts = technicalFacts({ workflowRules: [] });
  const item =
    sourceItems(sources).findIndex((s) => s.text === "保存时拒绝空白标签") + 1;
  assert.throws(
    () =>
      parseAdmission(
        JSON.stringify({
          initials: [],
          effects: [],
          questions: [{ sourceItem: item, choice: { kind: "field-required" } }],
        }),
        "base",
        sources,
        facts,
      ),
    /作用域|scope|契约/,
  );
});

test("生成验收矩阵的技术事实不能推出标签动作在完成状态可用", () => {
  const facts = technicalFacts({ workflowRules: [] });
  const index = facts.findIndex(
    (f) => f.id === "host-fact:obligation-derivation",
  );
  assert.throws(
    () =>
      parseClarificationDecision(
        JSON.stringify({
          kind: "technical",
          source: 1,
          sourceQuote: sources[0].text,
          detail: "生成矩阵因此必须显示标签动作",
          fact: index + 1,
          property: "newField",
          expected: "post-action-matrix-without-baseline-history",
        }),
        sources,
        facts,
      ),
    /推导|技术|作用域/,
  );
});

test("原规格和来源未变时，一段消解理由不能关闭复核问题", () => {
  const ledger: ReviewLedger = { version: 2, findings: [], attempts: [] };
  recordReview(
    ledger,
    {
      reviewedIds: [],
      issues: [
        {
          kind: "unverifiable",
          sourceRevision: "run:1",
          sourceQuote: sources[0].text,
          detail: "完成后可见性未决",
          target: { subject: "tag", aspect: "availability" },
          stance: "undetermined",
        },
      ],
    },
    1,
    "same",
  );
  const result = recordReview(
    ledger,
    {
      reviewedIds: [],
      issues: [],
      resolutions: [
        {
          issueId: ledger.findings[0].id,
          sourceRevision: "run:1",
          sourceQuote: sources[0].text,
          reason: "引用生成矩阵的事实，认为原问题已解决",
        },
      ],
    },
    1,
    "same",
  );
  assert.equal(ledger.findings[0].status, "open");
  assert.ok(result.blockers.length);
  assert.equal(result.halt, true);
});

test("同一原文的输入必填、任务存在性及不同动作形成不同宿主身份", () => {
  const facts = technicalFacts({ workflowRules: [] });
  const choices = [
    {
      kind: "field-required",
      scope: "action-input",
      action: "setTag",
      field: { kind: "new", name: "标签" },
    },
    {
      kind: "field-required",
      scope: "task-presence",
      field: { kind: "new", name: "标签" },
    },
    {
      kind: "field-required",
      scope: "action-input",
      action: "complete",
      field: { kind: "new", name: "标签" },
    },
  ];
  const questions = choices.map(
    (choice) =>
      parseAdmission(
        JSON.stringify({
          initials: [],
          effects: [],
          questions: [{ sourceItem: 1, choice }],
        }),
        "base",
        sources,
        facts,
      ).questions[0],
  );
  assert.equal(new Set(questions.map((q) => q.choice!.id)).size, 3);
  assert.equal(new Set(questions.map((q) => q.question)).size, 3);
});

function tagPlan(visible = true): InvestigatedPlan {
  return {
    id: "tag-plan",
    requestRevision: 1,
    baseVersion: "base",
    compositionRevision: 1,
    route: { kind: "application" },
    summary: "增加标签",
    changes: ["增加标签"],
    outcome: "可设置标签",
    dataImpact: "保留数据",
    workflowRules: [],
    cases: [],
    ruleChanges: [],
    excluded: [],
    evidence: [],
    capabilityChanges: [],
    steps: [],
    writableScope: [],
    compatibility: "保留旧行为",
    rollback: "恢复",
    preview: "隔离体验",
    application: "独立确认",
    restartImpact: "重启",
    dependencies: [],
    unresolved: [],
    binding: {
      guideCatalog: {},
      materials: [],
      capabilities: [],
      checkers: [],
    },
    requirements: [
      {
        id: "tag",
        description: "标签动作",
        type: "interface",
        sourceRevision: "run:1",
        sourceQuote: sources[0].text,
        checks: [],
        obligations: [
          {
            version: 1,
            id: "tag-done",
            kind: "assertion",
            steps: [{ kind: "action", member: "workflow", action: "complete" }],
            expected: {
              kind: "action-visible",
              member: "tags",
              action: "setTags",
              visible,
            },
          },
        ],
      },
    ],
  };
}
const authorizedSources = [
  {
    id: "run:1",
    text: "增加任务标签；完成后显示或隐藏标签编辑动作都可以，由实现自行选择。",
  },
];
const permission = (target = 1) => ({
  target,
  source: 1,
  quote: "完成后显示或隐藏标签编辑动作都可以，由实现自行选择",
  permission: "delegated",
});

test("同一明确设计授权允许显示和隐藏两种候选选择，实际选择随规格冻结", () => {
  for (const visible of [false, true]) {
    const p = tagPlan(visible);
    p.designDecisions = parseDesignDecisions(
      [permission()],
      p,
      authorizedSources,
    );
    p.changeSpec = compileSpec(p, "run", "source");
    assert.deepEqual(p.changeSpec.authority.designDecisions[0].allowed, [
      false,
      true,
    ]);
    assert.equal(
      p.changeSpec.authority.propositions[0].authority,
      "authorized-design",
    );
    assert.equal(specificationFailure(p), undefined);
    assert.equal(
      authorityFailure(p, authorizedSources, {
        reviewedIds: ["tag"],
        issues: [],
        designDecisions: p.designDecisions,
      }),
      undefined,
    );
    const o = p.requirements![0].obligations![0];
    if (o.kind !== "assertion" || o.expected.kind !== "action-visible")
      throw new Error("fixture");
    o.expected.visible = !visible;
    assert.throws(() => compileSpec(p, "run", "source"), /作用域/);
  }
});

test("不存在授权时保留业务未决；授权不能跨动作、准备路径、来源或取值范围复用", () => {
  const p = tagPlan();
  assert.equal(
    compileAuthority(p).propositions[0].authority,
    "business-specification",
  );
  const target = designTargets(p)[0];
  const unresolved = {
    targetId: target.id,
    sourceRevision: "run:1",
    sourceQuote: sources[0].text,
  };
  const raw = {
    reviewedIds: ["tag"],
    issues: [],
    fieldDecisions: [],
    unresolvedChoices: [unresolved],
  };
  assert.equal(parseReview(JSON.stringify(raw), p, sources).issues.length, 1);
  for (const value of [
    [permission(2)],
    [permission(), permission()],
    [{ ...permission(), quote: "不存在的授权" }],
    [{ ...permission(), allowed: [true] }],
  ])
    assert.throws(() => parseDesignDecisions(value, p, authorizedSources));
  p.designDecisions = parseDesignDecisions(
    [permission()],
    p,
    authorizedSources,
  );
  p.changeSpec = compileSpec(p, "run", "source");
  const reviewed = {
    reviewedIds: ["tag"],
    issues: [],
    designDecisions: structuredClone(p.designDecisions),
  };
  assert.match(authorityFailure(p, sources, reviewed)!, /来源|失效/);
  p.designDecisions[0].allowed = [true];
  assert.match(authorityFailure(p, authorizedSources, reviewed)!, /授权/);
  p.designDecisions = structuredClone(reviewed.designDecisions);
  const o = p.requirements![0].obligations![0];
  if (o.kind !== "assertion") throw new Error("fixture");
  o.steps = [];
  assert.throws(() => compileAuthority(p), /作用域/);
});

test("同一复核不能同时声称该作用域已授权且仍未决定，授权也不能抹去其他业务异议", () => {
  const p = tagPlan(),
    target = designTargets(p)[0];
  const raw = {
    reviewedIds: ["tag"],
    issues: [],
    fieldDecisions: [],
    designDecisions: [permission()],
    unresolvedChoices: [
      {
        targetId: target.id,
        sourceRevision: "run:1",
        sourceQuote: authorizedSources[0].text,
      },
    ],
  };
  assert.throws(
    () => parseReview(JSON.stringify(raw), p, authorizedSources),
    /同时|冲突/,
  );
  const issue = {
    kind: "extra-constraint",
    sourceRevision: "run:1",
    sourceQuote: authorizedSources[0].text,
    detail: "其他动作被禁用",
    target: { subject: "tag", aspect: "compatibility" },
    stance: "forbidden",
  };
  assert.deepEqual(
    parseReview(
      JSON.stringify({ ...raw, unresolvedChoices: [], issues: [issue] }),
      p,
      authorizedSources,
    ).issues,
    [issue],
  );
});

test("设计授权消解生成宿主证据；无关修改不能消解同一动作可见性争议", () => {
  const p = tagPlan(),
    target = designTargets(p)[0];
  const issue = {
    kind: "unverifiable" as const,
    sourceRevision: "run:1",
    sourceQuote: authorizedSources[0].text,
    detail: "可见性未决",
    target: { subject: "tag", aspect: "availability" as const },
    stance: "undetermined" as const,
    clarificationChoice: target.id,
  };
  const ledger: ReviewLedger = { version: 2, findings: [], attempts: [] };
  recordReview(
    ledger,
    { reviewedIds: ["tag"], issues: [issue] },
    1,
    hash(p),
    (i) => reviewEvidence(p, authorizedSources, i),
  );
  p.summary = "改写摘要";
  const raw = {
    reviewedIds: ["tag"],
    issues: [],
    fieldDecisions: [],
    resolutions: [
      {
        issueId: ledger.findings[0].id,
        sourceRevision: "run:1",
        sourceQuote: authorizedSources[0].text,
        reason: "新的独立来源解释确认两种选择均被授权",
      },
    ],
  };
  const unchanged = parseReview(JSON.stringify(raw), p, authorizedSources);
  assert.ok(
    recordReview(ledger, unchanged, 1, hash(p), (i) =>
      reviewEvidence(p, authorizedSources, i),
    ).blockers.length,
  );
  const reviewed = parseReview(
    JSON.stringify({ ...raw, designDecisions: [permission()] }),
    p,
    authorizedSources,
  );
  assert.deepEqual(
    recordReview(ledger, reviewed, 1, hash(p), (i) =>
      reviewEvidence(p, authorizedSources, i),
    ).blockers,
    [],
  );
  assert.equal(reviewed.resolutionEvidence?.[0].kind, "design-authorization");
  assert.equal(ledger.findings[0].status, "resolved");
  assert.throws(
    () =>
      parseReview(
        JSON.stringify({
          ...raw,
          resolutionEvidence: reviewed.resolutionEvidence,
        }),
        p,
        authorizedSources,
      ),
    /宿主生成/,
  );
});

test("已有动作的可见性只能由精确基础版本和可达准备推导，不能借此证明新标签动作", () => {
  const p = tagPlan();
  p.binding!.actionAvailability = captureAvailability({
    baseVersion: "base",
    revision: 1,
    rendererHash: "renderer",
    initialState: "open",
    states: ["open", "done"],
    workflowProvider: "default",
    members: [
      { pluginId: "default", versionId: "base", enabled: true },
      { pluginId: "tags", versionId: "old-tags", enabled: true },
    ],
    actions: [
      { id: "complete", from: ["open"] },
      { id: "setTags", providerId: "tags", from: ["open", "done"] },
    ],
    contributions: [
      { id: "tag-ui", providerId: "tags", actions: [{ commandId: "setTags" }] },
    ],
  });
  const authority = compileAuthority(p);
  assert.equal(authority.factDerivations.length, 1);
  assert.deepEqual(authority.factDerivations[0].scope, {
    member: "tags",
    action: "setTags",
    state: "done",
  });
  assert.equal(authority.factDerivations[0].conclusion.visible, true);
  const o = p.requirements![0].obligations![0];
  if (o.kind !== "assertion" || o.expected.kind !== "action-visible")
    throw new Error("fixture");
  o.expected.action = "newSetTag";
  assert.deepEqual(compileAuthority(p).factDerivations, []);
});

test("宿主生成的字段来源解释更正可以消解原问题，错误目标和伪造解释不能代替证据", () => {
  const p = tagPlan();
  p.requirements![0].obligations = [
    {
      version: 1,
      id: "tag-field",
      kind: "field",
      member: "tags",
      field: "tag",
      initialOrigin: "host",
      initial: { kind: "visible", value: "（空）" },
      scenarios: [],
    },
  ];
  const initial = (kind: "undetermined" | "unspecified") =>
    parseFieldDecisions(
      [
        {
          target: 1,
          source: 1,
          sourceQuote: sources[0].text,
          initial:
            kind === "undetermined"
              ? { kind, questionQuote: sources[0].text }
              : { kind },
        },
      ],
      p,
      sources,
    );
  const old = initial("undetermined");
  const ledger: ReviewLedger = { version: 2, findings: [], attempts: [] };
  recordReview(
    ledger,
    { reviewedIds: ["tag"], issues: old.issues, fieldDecisions: old.decisions },
    1,
    "same",
  );
  const corrected = initial("unspecified");
  const resolution = {
    issueId: ledger.findings[0].id,
    sourceRevision: "run:1",
    sourceQuote: sources[0].text,
    reason: "独立字段来源解释更正为未要求初始显示",
  };
  for (const alteration of [
    "wrong-target",
    "same-interpretation",
    "missing-prior-proof",
    "definite-opposite",
  ]) {
    const copy = structuredClone(ledger),
      decision = structuredClone(corrected.decisions[0]);
    if (alteration === "wrong-target") decision.obligationId = "other-field";
    if (alteration === "same-interpretation")
      Object.assign(decision, old.decisions[0]);
    if (alteration === "missing-prior-proof")
      copy.findings[0].issue.sourceDecision!.interpretationHash = "forged";
    if (alteration === "definite-opposite") {
      copy.attempts[0].review.fieldDecisions![0].initial = {
        kind: "visible",
        value: "必须显示",
      };
      copy.findings[0].issue.sourceDecision!.interpretationHash = hash(
        copy.attempts[0].review.fieldDecisions![0],
      );
    }
    const result = recordReview(
      copy,
      {
        reviewedIds: ["tag"],
        issues: [],
        fieldDecisions: [decision],
        resolutions: [resolution],
      },
      1,
      "same",
    );
    assert.equal(copy.findings[0].status, "open");
    assert.equal(result.halt, true);
  }
  const reviewed = {
    reviewedIds: ["tag"],
    issues: corrected.issues,
    fieldDecisions: corrected.decisions,
    resolutions: [resolution],
  };
  assert.deepEqual(recordReview(ledger, reviewed, 1, "same").blockers, []);
  assert.equal(ledger.findings[0].status, "resolved");
  assert.equal(
    (reviewed as import("../../src/shared/assistant.js").RequirementReview)
      .resolutionEvidence?.[0].kind,
    "source-adjudication",
  );
  assert.throws(
    () =>
      parseReview(
        JSON.stringify({
          reviewedIds: ["tag"],
          issues: old.issues,
          fieldDecisions: [],
        }),
        p,
        sources,
      ),
    /宿主生成/,
  );
});

test("辅助成员的标签输入义务绑定动作、状态和冻结案例，不升级为任务全局必填", () => {
  const p = tagPlan();
  p.memberCases = structuredClone(tagsTrimOnlyMemberCases);
  p.requirements![0].checks = p.memberCases.map((c) => ({
    checker: "workspace/1",
    caseId: `member:${c.member}:${c.name}`,
  }));
  p.changeSpec = compileSpec(p, "run", "source");
  const scopes = p.changeSpec.authority.inputObligations;
  assert.equal(scopes.length, 3);
  assert.ok(
    scopes.every(
      (o) =>
        o.scope.kind === "action-input" &&
        o.scope.member === "tags" &&
        o.scope.action === "setTags" &&
        o.scope.state === "open",
    ),
  );
  assert.ok(
    scopes.every(
      (o) =>
        o.meaning === "frozen-input-case-not-global-field-presence" &&
        o.requirements.includes("tag"),
    ),
  );
  p.memberCases[0].input.tags = "changed";
  assert.match(specificationFailure(p)!, /冻结/);
});
