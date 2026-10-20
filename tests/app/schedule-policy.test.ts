import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../../src/server/workspace.js";
import {
  capture,
  compilePlanDraft,
  readInvestigation,
} from "../../src/server/planning.js";
import { coverage } from "../../src/server/requirement-coverage.js";
import {
  compileSpec,
  specificationFailure,
} from "../../src/evolution/specification.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { dueAutoExpireSource } from "../../src/server/capability-guides.js";
import { candidateProgramHash } from "../../src/server/browser-acceptance.js";
import { activateWorkflowOnly } from "./dual-composition-fixture.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import type { Driver } from "../../src/evolution/driver.js";
import type { SchedulePolicyEvidence } from "../../src/shared/schedule-policy.js";
import { importCompositionVersions } from "../../src/server/workspace-acceptance.js";

const quote =
  "增加截止调度：过期后完成保留过期标记；截止前完成不标记，截止后重新打开自动补标；其他行为不变";
const at = "2030-01-01T00:01:00.000Z";
const plan = {
  changes: [
    {
      target: "due",
      name: "截止插件",
      features: ["commands", "fields", "schedules", "detail"],
      cases: [
        {
          name: "set",
          state: "open",
          fields: {},
          action: "setDue",
          input: { dueAt: at },
          expected: { kind: "commit", state: "open", fields: { dueAt: at } },
        },
        {
          name: "invalid-date",
          state: "open",
          fields: {},
          action: "setDue",
          input: { dueAt: "invalid" },
          expected: { kind: "reject" },
        },
        {
          name: "fire",
          state: "open",
          fields: { dueAt: at },
          action: "expire",
          input: { scheduledAt: at },
          expected: {
            kind: "commit",
            state: "open",
            fields: { dueAt: at, expired: "true" },
          },
        },
        {
          name: "completed",
          state: "done",
          fields: { dueAt: at },
          action: "expire",
          input: { scheduledAt: at },
          expected: { kind: "reject" },
        },
      ],
    },
  ],
  requirements: [
    {
      quote,
      type: "behavior",
      expectations: [
        { kind: "behavior" },
        {
          kind: "schedule-policy",
          action: "expire",
          policies: ["complete-retains-effect", "reopen-after-due"],
        },
      ],
    },
  ],
};

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "schedule-policy-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  await activateWorkflowOnly(workspace);
  return workspace;
}

test("时序义务由宿主绑定案例、检查器与来源；没有真实效果或篡改绑定不能进入完整计划", async (t) => {
  const workspace = await fixture(t);
  const context = capture(workspace);
  const initial = readInvestigation("inspect_application", {}, context, []);
  if (!("ref" in initial)) throw new Error(initial.message);
  const seen = [initial, ...(initial.documents ?? [])].map(({ ref, hash }) => ({
    ref,
    hash,
  }));
  const sources = [{ id: "policy-run:1", text: quote }];
  const parsed = compilePlanDraft(plan, context, seen, sources);
  assert.deepEqual(parsed.blockers, []);
  const policy = parsed.plan.requirements
    ?.flatMap((r) => r.obligations ?? [])
    .find((o) => o.kind === "schedule-policy");
  assert.ok(policy?.kind === "schedule-policy");
  assert.deepEqual(policy.action, {
    kind: "action",
    member: "due",
    action: "expire",
  });
  assert.equal(policy.fireCase.caseId, "member:due:fire");
  const reordered = structuredClone(plan);
  reordered.requirements[0].expectations[1].policies!.reverse();
  const same = compilePlanDraft(reordered, context, seen, sources)
    .plan.requirements?.flatMap((r) => r.obligations ?? [])
    .find((o) => o.kind === "schedule-policy");
  assert.deepEqual(same, policy);
  assert.ok(parsed.plan.binding?.checkers.some((c) => c.id === "schedule/1"));
  assert.equal(
    coverage(parsed.plan, sources, Object.keys(context.checkerVersions)).every(
      (r) => r.reasons.length === 0,
    ),
    true,
  );
  const bad = structuredClone(parsed.plan);
  const altered = bad
    .requirements!.flatMap((r) => r.obligations ?? [])
    .find((o) => o.kind === "schedule-policy")!;
  altered.fireCase.definitionHash = "forged";
  assert.equal(
    coverage(bad, sources, Object.keys(context.checkerVersions)).some((r) =>
      r.reasons.some((reason) => reason.includes("时序策略")),
    ),
    true,
  );
  parsed.plan.changeSpec = compileSpec(
    parsed.plan,
    "policy-run",
    "source-hash",
  );
  policy.checks.pop();
  assert.match(specificationFailure(parsed.plan) ?? "", /规格.*不一致|冻结/);
  const noEffect = structuredClone(plan);
  noEffect.changes[0].cases[2].expected.fields = { dueAt: at };
  assert.throws(
    () => compilePlanDraft(noEffect, context, seen, sources),
    /字段变化/,
  );
});

test("模型桩经完整候选门禁执行真实时序与浏览器验收，删去时序证据不能通过应用门禁", async (t) => {
  const workspace = await fixture(t);
  const planner = new PlanningDriver();
  const code = dueAutoExpireSource.replace(
    "decide({ task, action, input })",
    "decide({ task, action, input }: {task:{state:string;fields:Record<string,string>};action:string;input:Record<string,string>})",
  );
  assert.notEqual(code, dueAutoExpireSource);
  const driver: Driver = {
    async generate(request, signal) {
      if (request.tools?.some((t) => t.name === "submit_candidate"))
        return toolReply("submit_candidate", {
          files: [],
          members: [{ pluginId: "due", source: code }],
        });
      const reply = await planner.generate(request);
      const proposal = reply.calls.find((c) => c.name === "propose_plan");
      if (proposal) proposal.args = structuredClone(plan);
      signal.throwIfAborted();
      return reply;
    },
  };
  const domain = new EvolutionDomain(workspace);
  const evolution = new Evolution(workspace.db, driver, domain);
  t.after(() => evolution.close());
  const settle = async () => {
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      const run = (await evolution.observe()).run;
      if (run && !["planning", "executing", "applying"].includes(run.status))
        return run;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("时序候选验收超时");
  };
  const before = JSON.stringify({
    composition: workspace.composition(),
    tasks: workspace.query(),
  });
  await evolution.command({
    type: "request",
    text: quote,
    operationId: "policy-request",
  });
  const ready = await settle();
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  if (ready.status !== "ready") return;
  await evolution.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "policy-start",
  });
  const done = await settle();
  assert.equal(done.status, "awaiting-apply", JSON.stringify(done));
  const candidate = (await evolution.observe()).candidates?.find(
    (c) => c.passed && c.versionId,
  );
  assert.ok(candidate?.versionId);
  const version = workspace.release.get(candidate.versionId);
  const evidence = version.evidence as {
    scheduleCases: SchedulePolicyEvidence[];
    [key: string]: unknown;
  };
  assert.equal(evidence.scheduleCases.length, 2);
  assert.equal(
    evidence.scheduleCases.every(
      (c) =>
        c.status === "passed" &&
        c.steps.length >= 2 &&
        c.candidateProgramHash === candidateProgramHash(workspace, version),
    ),
    true,
  );
  domain.verifyAcceptance(version.id, ready.plan);
  const {
    id: _id,
    createdAt: _createdAt,
    entry: _entry,
    ...artifact
  } = version;
  const missing = workspace.release.record({
    ...artifact,
    evidence: { ...evidence, scheduleCases: [] },
  });
  assert.throws(
    () => domain.verifyAcceptance(missing.id, ready.plan),
    /冻结时序策略/,
  );
  assert.equal(
    JSON.stringify({
      composition: workspace.composition(),
      tasks: workspace.query(),
    }),
    before,
  );
  const budget = (await evolution.observe()).run?.budget;
  assert.ok(budget);
  assert.ok(budget.callsUsed <= 12);
  assert.equal(budget.callsUsed + budget.callsRemaining, 12);
  const nextDirectory = await mkdtemp(
    join(tmpdir(), "schedule-policy-inheritance-"),
  );
  const nextWorkspace = await Workspace.open(
    join(nextDirectory, "workspace.db"),
  );
  t.after(async () => {
    await nextWorkspace.close();
    await rm(nextDirectory, { recursive: true, force: true });
  });
  importCompositionVersions(workspace, nextWorkspace, version);
  await nextWorkspace.activate(
    {
      versionId: version.id,
      compositionRevision: nextWorkspace.composition().revision,
      operationId: "isolated-apply",
    },
    () => undefined,
  );
  const context = capture(nextWorkspace);
  const initial = readInvestigation("inspect_application", {}, context, []);
  if (!("ref" in initial)) throw new Error(initial.message);
  const nextQuote =
    "对 needsReview=yes 的任务完成时标记 reviewed=yes，其他行为不变";
  const next = compilePlanDraft(
    {
      changes: [
        {
          target: "guard",
          features: ["beforeCommit"],
          cases: [
            {
              state: "open",
              fields: { needsReview: "yes" },
              action: "complete",
              input: {},
              expected: {
                kind: "commit",
                state: "done",
                fields: { needsReview: "yes", reviewed: "yes" },
              },
            },
            {
              state: "done",
              fields: { needsReview: "yes" },
              action: "complete",
              input: {},
              expected: { kind: "reject" },
            },
          ],
        },
      ],
      requirements: [
        {
          quote: nextQuote,
          type: "behavior",
          expectations: [{ kind: "behavior" }],
        },
      ],
    },
    context,
    [initial, ...(initial.documents ?? [])].map(({ ref, hash }) => ({
      ref,
      hash,
    })),
    [...ready.plan.requirementGate!.sources, { id: "next:1", text: nextQuote }],
  );
  assert.deepEqual(next.blockers, []);
  assert.ok(
    next.plan.requirements?.some((r) =>
      r.obligations?.some((o) => o.kind === "schedule-policy"),
    ),
  );
  assert.ok(next.plan.binding?.checkers.some((c) => c.id === "schedule/1"));
});
