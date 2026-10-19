import test from "node:test";
import assert from "node:assert/strict";
import { compilePlanInput } from "../../src/evolution/plan-input.js";

const source = "已有 ok 不自动替换，已完成任务仍不可执行。";
const context = {
  pluginId: "primary",
  members: [
    {
      pluginId: "primary",
      role: "workflow" as const,
      versionId: "base",
      enabled: true,
    },
    {
      pluginId: "panel",
      role: "auxiliary" as const,
      versionId: "panel-base",
      enabled: true,
    },
  ],
  capabilities: [],
  files: {
    "active-contract": {
      content: JSON.stringify({
        id: "primary",
        initialState: "open",
        actions: [{ id: "complete" }],
      }),
      hash: "contract",
    },
    "active-acceptance": {
      content: JSON.stringify({ rules: [] }),
      hash: "acceptance",
    },
  },
};
const businessPlan = () => ({
  summary: source,
  changes: [
    {
      target: "panel",
      cases: [
        {
          state: "done",
          fields: {},
          action: "markNote",
          input: {},
          expected: { kind: "reject" },
        },
      ],
    },
  ],
  requirements: [
    {
      description: source,
      quote: source,
      type: "behavior",
      expectations: [
        { kind: "behavior" },
        { kind: "error", action: "markNote" },
        {
          kind: "action-visible",
          action: "markNote",
          state: "done",
          visible: false,
        },
      ],
    },
  ],
});

test("归档升级反例：隐藏动作的页面报错进入来源裁决，后端拒绝独立保留", () => {
  const draft = compilePlanInput(businessPlan(), context, [
    { id: "request:1", text: source },
  ]);
  const obligations = draft.requirements[0].obligations;
  assert.ok(obligations.some((o) => o.kind === "backend-rejection"));
  const feedback = obligations.find((o) => o.kind === "feedback");
  assert.ok(feedback);
  assert.equal(feedback.resolution, "pending");
  assert.deepEqual(feedback.scenarios, []);
  assert.deepEqual(feedback.unavailable, [
    { code: "action-hidden", state: "done" },
  ]);
});

import { readFile } from "node:fs/promises";
import { compileReferences } from "../../src/evolution/references.js";
import {
  coverage,
  parseReview,
  freezeRequirements,
  gateFailure,
} from "../../src/server/requirement-coverage.js";
import {
  resolveErrorFeedback,
  feedbackConflicts,
  parseErrorDecisions,
} from "../../src/evolution/error-review.js";
import { compileSpec } from "../../src/evolution/specification.js";
import { compileSemantics } from "../../src/evolution/requirement-semantics.js";
import type {
  InvestigatedPlan,
  RequirementReview,
} from "../../src/shared/assistant.js";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";

const supported = ["workspace/1", "browser/1"];
function boundPlan(input: unknown = businessPlan(), text = source) {
  const sources = [{ id: "request:1", text }];
  const draft = compilePlanInput(input, context, sources);
  const references = compileReferences(draft, sources, [], {
    id: "primary",
    actions: [{ id: "complete" }],
  });
  return {
    sources,
    plan: {
      ...draft,
      ...references,
      cases: [],
      workflowRules: [],
      binding: {
        guideCatalog: {},
        materials: [],
        capabilities: [],
        checkers: supported.map((id) => ({ id, version: "test" })),
      },
    } as unknown as InvestigatedPlan,
  };
}
function sourceReview(
  plan: InvestigatedPlan,
  sources: { id: string; text: string }[],
  feedback: "required" | "not-requested" | "undetermined",
  text = "",
) {
  return parseReview(
    JSON.stringify({
      reviewedIds: plan.requirements!.map((r) => r.id),
      issues: [],
      fieldDecisions: [],
      errorDecisions: [
        {
          target: 1,
          source: 1,
          sourceQuote: sources[0].text,
          feedback,
          effectQuote: feedback === "required" ? sources[0].text : "",
          text,
        },
      ],
    }),
    plan,
    sources,
  );
}

test("来源未要求页面报错时只裁决新意图，保留后端拒绝和动作隐藏；旧证据不能代替本次复核", () => {
  const { plan, sources } = boundPlan();
  assert.ok(coverage(plan, sources, supported)[0].reasons.length);
  const review = sourceReview(plan, sources, "not-requested");
  assert.deepEqual(review.issues, []);
  resolveErrorFeedback(plan, review);
  assert.deepEqual(coverage(plan, sources, supported)[0].reasons, []);
  const obligations = plan.requirements![0].obligations!;
  assert.equal(
    obligations.find((o) => o.kind === "backend-rejection")?.kind,
    "backend-rejection",
  );
  assert.equal(
    plan.browserCases!.some((c) => c.steps.some((s) => s.kind === "error")),
    false,
  );
  assert.equal(
    plan.browserCases!.filter((c) =>
      c.steps.some((s) => s.kind === "action-visible" && !s.visible),
    ).length,
    2,
  );
  const semantics = compileSemantics(plan, sources, review);
  assert.deepEqual(
    new Set(semantics.entries.map((e) => e.target.aspect)),
    new Set(["operation-rejection", "action-availability", "error-feedback"]),
  );
  assert.equal(
    semantics.entries.find((e) => e.target.aspect === "error-feedback")?.status,
    "unspecified",
  );
  plan.changeSpec = compileSpec(plan, "run", "base");
  const gate = freezeRequirements(plan, sources, "request", review, supported);
  plan.requirementGate = gate;
  assert.equal(gateFailure(plan, gate), undefined);
  const copy = structuredClone(plan);
  copy.requirements![0].obligations!.find(
    (o) => o.kind === "feedback",
  )!.resolution = "required";
  assert.match(gateFailure(copy, gate)!, /页面反馈|义务|冻结/);
});

test("明确要求可见错误时隐藏按钮不能替代，空文案不等于取消反馈，待裁决不能伪造通过", () => {
  const { plan, sources } = boundPlan(
    undefined,
    "已有 ok 不自动替换，已完成任务仍不可执行。必须显示错误。",
  );
  const review = sourceReview(plan, sources, "required");
  assert.deepEqual(review.issues, []);
  resolveErrorFeedback(plan, review);
  const reasons = coverage(plan, sources, supported)[0].reasons;
  assert.ok(reasons.some((r) => r.includes("action-hidden:done")));
  assert.equal(
    plan.browserCases!.some((c) => c.steps.some((s) => s.kind === "error")),
    false,
  );
  assert.deepEqual(
    feedbackConflicts(plan).map((c) => c.code),
    ["action-hidden"],
  );
  const feedback = plan.requirements![0].obligations!.find(
    (o) => o.kind === "feedback",
  )!;
  assert.equal(feedback.resolution, "required");
  feedback.unavailable = [];
  assert.ok(
    coverage(plan, sources, supported)[0].reasons.some((r) =>
      r.includes("missing-scenario"),
    ),
  );
});

test("可达非初始状态由宿主先准备，独立复核后生成新旧任务反馈案例；删除断言或替换后端拒绝均失败", () => {
  const input = businessPlan();
  input.requirements[0].expectations =
    input.requirements[0].expectations.filter(
      (e) => e.kind !== "action-visible",
    );
  const { plan, sources } = boundPlan(input);
  resolveErrorFeedback(plan, sourceReview(plan, sources, "required"));
  assert.equal(plan.browserCases!.length, 2);
  for (const c of plan.browserCases!)
    assert.deepEqual(
      c.steps.map((s) => (s.kind === "action" ? s.action : s.kind)),
      ["complete", "markNote", "error"],
    );
  assert.deepEqual(coverage(plan, sources, supported)[0].reasons, []);
  const removed = structuredClone(plan);
  removed.browserCases![0].steps.pop();
  assert.ok(
    coverage(removed, sources, supported)[0].reasons.some((r) =>
      r.includes("断言已变化"),
    ),
  );
  const changed = structuredClone(plan);
  changed.memberCases![0].expected = {
    kind: "commit",
    state: "done",
    fields: {},
  };
  assert.ok(
    coverage(changed, sources, supported)[0].reasons.some((r) =>
      r.includes("后端拒绝义务"),
    ),
  );
  const frozen = structuredClone(plan);
  const conflicting = sourceReview(frozen, sources, "not-requested");
  assert.ok(conflicting.issues.some((i) => i.kind === "conflict"));
  resolveErrorFeedback(frozen, conflicting);
  assert.equal(
    frozen.requirements![0].obligations!.find((o) => o.kind === "feedback")!
      .resolution,
    "required",
  );
  assert.equal(frozen.browserCases!.length, 2);
});

test("反馈来源分类漏项、伪造或混填证据不能靠 issues=[] 通过；真实未决保留阻塞", () => {
  const { plan, sources } = boundPlan();
  const valid = {
    target: 1,
    source: 1,
    sourceQuote: source,
    feedback: "not-requested",
    effectQuote: "",
    text: "",
  };
  for (const value of [
    [],
    [valid, valid],
    [{ ...valid, source: 2 }],
    [{ ...valid, effectQuote: source }],
    [{ ...valid, feedback: "required" }],
    [{ ...valid, feedback: "required", effectQuote: "伪造" }],
  ])
    assert.throws(() => parseErrorDecisions(value, plan, sources));
  const review = sourceReview(plan, sources, "undetermined");
  assert.equal(review.issues[0].kind, "unverifiable");
  resolveErrorFeedback(plan, review);
  assert.ok(
    coverage(plan, sources, supported)[0].reasons.some((r) =>
      r.includes("尚未完成"),
    ),
  );
  assert.equal(
    obligationCases(
      plan.requirements![0].obligations!.find((o) => o.kind === "feedback")!,
    ).length,
    0,
  );
});

test("真实归档提案离线重放保留拒绝及不可执行原因，不依赖原数据库或 API", async () => {
  const archive = JSON.parse(
    await readFile(
      new URL("../fixtures/upgrade-feedback-plan.json", import.meta.url),
      "utf8",
    ),
  );
  const draft = compilePlanInput(archive.plan, context, [
    { id: "request:1", text: archive.request },
  ]);
  const obligations = draft.requirements.flatMap((r) => r.obligations);
  assert.ok(obligations.some((o) => o.kind === "backend-rejection"));
  const feedback = obligations.find((o) => o.kind === "feedback")!;
  assert.equal(feedback.resolution, "pending");
  assert.deepEqual(feedback.unavailable, [
    { code: "action-hidden", state: "done" },
  ]);
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { memberUiReleaseInput } from "../fixtures/member-ui.js";
import { panelMemberCases } from "./member-case-fixtures.js";
import { fieldDecisionsFixture } from "./planning-fixture.js";
import { verifyViaIsolatedWorkspace } from "../../src/server/workspace-acceptance.js";

for (const required of [false, true])
  test(`模型桩闭环：不可执行反馈经现有独立复核${required ? "确认要求并阻塞" : "判定额外限制并收敛"}，仍共用12次预算`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "operation-feedback-"));
    const w = await Workspace.open(join(directory, "workspace.db"));
    const fixture = await memberUiReleaseInput("operation-feedback-stub");
    w.release.record(fixture.panel);
    const version = w.release.record({
      ...fixture.composition,
      evidence: {
        ...fixture.composition.evidence,
        rules: [],
        memberCases: panelMemberCases,
      },
    });
    await w.activate(
      {
        versionId: version.id,
        compositionRevision: w.composition().revision,
        operationId: "activate",
      },
      () => undefined,
    );
    const before = JSON.stringify({
      composition: w.composition(),
      tasks: w.query(),
    });
    const archive = JSON.parse(
      await readFile(
        new URL("../fixtures/upgrade-feedback-plan.json", import.meta.url),
        "utf8",
      ),
    );
    let planning = 0;
    let reviews = 0;
    const reply = (value: unknown) => ({
      text: JSON.stringify(value),
      history: [],
      calls: [],
      usage: { fixture: true },
      raw: { fixture: true },
    });
    const e = new Evolution(
      w.db,
      {
        async generate(request) {
          const input = JSON.parse(request.message ?? "{}");
          if (input.kind === "request-admission/2")
            return reply({ effects: [], initials: [], questions: [] });
          if (request.schema) {
            reviews++;
            assert.deepEqual(request.history, []);
            assert.equal(request.tools, undefined);
            assert.ok(
              input.compilerConflicts.some(
                (c: { code: string }) => c.code === "action-hidden",
              ),
            );
            return reply({
              reviewedIds: input.requirements.map((r: { id: string }) => r.id),
              issues: [],
              fieldDecisions: fieldDecisionsFixture(input),
              errorDecisions: input.errorReviewTargets.map(
                (target: { sources: { source: number }[] }, index: number) => ({
                  target: index + 1,
                  source: 1,
                  sourceQuote: input.sources[target.sources[0].source - 1].text,
                  feedback: required ? "required" : "not-requested",
                  effectQuote: required ? "必须显示错误。" : "",
                  text: "",
                }),
              ),
            });
          }
          planning++;
          if (planning === 1)
            return {
              ...reply(null),
              text: "",
              calls: [
                {
                  name: "read_guides",
                  args: {
                    refs: [
                      "guide/command.register",
                      "guide/task.events",
                      "guide/workflow.provide",
                      "guide/schedule.register",
                    ],
                  },
                },
              ],
            };
          assert.equal(planning, 2, "不应以多轮规划重试制造通过");
          return {
            ...reply(null),
            text: "",
            calls: [{ name: "propose_plan", args: archive.plan }],
          };
        },
      },
      new EvolutionDomain(w),
    );
    t.after(async () => {
      await e.close();
      await w.close();
      await rm(directory, { recursive: true, force: true });
    });
    await e.command({
      type: "request",
      text: archive.request + (required ? "必须显示错误。" : ""),
      operationId: "request",
    });
    let run = (await e.observe()).run!;
    for (let i = 0; run.status === "planning" && i < 1500; i++) {
      await new Promise((r) => setTimeout(r, 10));
      run = (await e.observe()).run!;
    }
    assert.equal(
      run.status,
      required ? "blocked" : "awaiting-acceptance",
      JSON.stringify({
        status: run.status,
        message: "message" in run ? run.message : undefined,
      }),
    );
    assert.equal(reviews, 1);
    assert.equal(run.budget!.callsUsed, 4);
    assert.equal(run.budget!.callsRemaining, 8);
    assert.equal(
      w.db.prepare("SELECT count(*) n FROM evolution_calls").get()!.n,
      4,
    );
    if (run.status === "awaiting-acceptance") {
      assert.deepEqual(run.plan.requirementGate!.review.issues, []);
      assert.ok(
        run.plan
          .requirements!.flatMap((r) => r.obligations ?? [])
          .some((o) => o.kind === "backend-rejection"),
      );
      assert.equal(
        run.plan.semanticState!.entries.find(
          (e) => e.target.aspect === "error-feedback",
        )!.status,
        "unspecified",
      );
      assert.ok(
        run.plan.requirementGate!.coverage.every((c) => !c.reasons.length),
      );
      await e.command({
        type: "confirm-acceptance",
        operationId: "confirm",
        runId: run.id,
        planId: run.plan.id,
        revisionId: run.acceptanceRevision.id,
      });
      const confirmed = (await e.observe()).run!;
      assert.equal(confirmed.status, "ready");
      assert.equal(
        confirmed.budget!.callsUsed,
        4,
        "既有验收修订确认不新增模型调用",
      );
    }
    assert.equal(
      JSON.stringify({ composition: w.composition(), tasks: w.query() }),
      before,
    );
  });

test("按钮隐藏的冻结要求仍直接执行后端拒绝案例，允许已完成命令的候选不能通过", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "backend-rejection-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = await memberUiReleaseInput(
    "backend-rejection-counterexample",
  );
  const source = fixture.panel.source
    .replace('from: ["open"]', 'from: ["open", "done"]')
    .replace('if (task.state !== "open")', "if (false)");
  assert.notEqual(source, fixture.panel.source);
  const panel = w.release.record({ ...fixture.panel, source, code: source });
  const candidate = w.release.record({
    ...fixture.composition,
    members: [
      { pluginId: "aux-workflow", role: "workflow", enabled: true },
      {
        pluginId: "panel",
        role: "auxiliary",
        enabled: true,
        versionId: panel.id,
      },
    ],
  });
  const before = JSON.stringify({
    composition: w.composition(),
    tasks: w.query(),
  });
  await assert.rejects(
    verifyViaIsolatedWorkspace(
      w,
      candidate,
      panelMemberCases,
      new AbortController().signal,
    ),
    /拒绝|reject|已完成/,
  );
  assert.equal(
    JSON.stringify({ composition: w.composition(), tasks: w.query() }),
    before,
  );
});
