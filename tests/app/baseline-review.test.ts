import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import {
  capture,
  compilePlanDraft,
  readInvestigation,
} from "../../src/server/planning.js";
import { semanticChoiceTargets } from "../../src/evolution/technical-facts.js";
import { memberUiReleaseInput } from "../fixtures/member-ui.js";
import { panelMemberCases } from "./member-case-fixtures.js";
import { DeepSeek } from "../../src/evolution/deepseek.js";

test("继承已有动作的状态可见性由宿主基线证明，不再生成业务澄清目标", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "baseline-review-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = await memberUiReleaseInput("baseline-review");
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
  const context = capture(w);
  const source = "原动作及贡献ID不变，已完成任务仍不可执行，其他行为保留。";
  const parsed = compilePlanDraft(
    {
      summary: source,
      changes: [{ target: "panel", cases: null }],
      requirements: [
        {
          description: source,
          quote: source,
          type: "constraint",
          expectations: [
            { kind: "behavior" },
            {
              kind: "action-visible",
              action: "markNote",
              state: "open",
              visible: true,
            },
            {
              kind: "action-visible",
              action: "markNote",
              state: "done",
              visible: false,
            },
          ],
        },
      ],
    },
    context,
    [
      ...Object.entries(context.files).map(([ref, f]) => ({
        ref,
        hash: f.hash,
      })),
      ...Object.entries(context.guideHashes).map(([ref, hash]) => ({
        ref,
        hash,
      })),
      ...["inspect_application", "check_environment"].map((name) => {
        const result = readInvestigation(name, {}, context);
        if (!("ref" in result)) throw new Error(result.message);
        return { ref: result.ref, hash: result.hash };
      }),
    ],
    [{ id: "run:1", text: source }],
  );
  assert.deepEqual(parsed.blockers, []);
  assert.deepEqual(
    semanticChoiceTargets(parsed.plan).filter(
      (t) => t.aspect === "action-availability",
    ),
    [],
  );
});

test("独立 JSON 复核按明确阶段关闭思考，不能由有无工具隐式选择无限思考", async () => {
  let body: Record<string, unknown> = {};
  const driver = new DeepSeek("test-key", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        model: "deepseek-flash",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: JSON.stringify({ result: { ok: true } }),
            },
          },
        ],
        usage: { completion_tokens: 5 },
      }),
      { status: 200 },
    );
  });
  const request = {
    phase: "review" as const,
    instruction: "独立复核",
    history: [],
    message: "合成要求",
    schema: {
      type: "object",
      required: ["ok"],
      additionalProperties: false,
      properties: { ok: { type: "boolean" } },
    },
  };
  const reply = await driver.generate(request, new AbortController().signal);
  assert.equal(reply.text, JSON.stringify({ ok: true }));
  assert.deepEqual(body.thinking, { type: "enabled" });
});

import {
  captureAvailability,
  bindAvailability,
  availabilityFailure,
} from "../../src/evolution/action-availability.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import { compileSemantics } from "../../src/evolution/requirement-semantics.js";
import {
  boundReviewSchema,
  parseReview,
  coverage,
  freezeRequirements,
  gateFailure,
} from "../../src/server/requirement-coverage.js";
import { compileSpec } from "../../src/evolution/specification.js";
import { planBindingFailure } from "../../src/server/planning.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver } from "./planning-fixture.js";
import { modelPolicy } from "../../src/evolution/model-policy.js";

const sources = [
  { id: "run:1", text: "保留原动作状态限制；已完成任务仍不可执行。" },
];
function fixturePlan(visible = false): InvestigatedPlan {
  const snapshot = captureAvailability({
    baseVersion: "base",
    revision: 1,
    rendererHash: "renderer",
    initialState: "open",
    states: ["open", "done"],
    workflowProvider: "primary",
    members: [
      { pluginId: "primary", versionId: "primary-version", enabled: true },
      { pluginId: "panel", versionId: "panel-version", enabled: true },
    ],
    actions: [
      { id: "complete", from: ["open"], providerId: "primary" },
      { id: "reopen", from: ["done"], providerId: "primary" },
      { id: "markNote", from: ["open"], providerId: "panel" },
    ],
    contributions: [
      {
        id: "note-panel",
        providerId: "panel",
        actions: [{ commandId: "markNote" }],
      },
    ],
  });
  const obligation: AcceptanceObligation = {
    version: 1,
    id: "visibility",
    kind: "assertion",
    steps: [{ kind: "action", member: "workflow", action: "complete" }],
    expected: {
      kind: "action-visible",
      member: "panel",
      contribution: "note-panel",
      action: "markNote",
      visible,
    },
  };
  const plan = {
    id: "plan",
    baseVersion: "base",
    compositionRevision: 1,
    requestRevision: 1,
    requirements: [
      {
        id: "r",
        description: sources[0].text,
        sourceRevision: "run:1",
        sourceQuote: sources[0].text,
        type: "interface",
        checks: [],
        obligations: [obligation],
      },
    ],
    binding: {
      actionAvailability: snapshot,
      guideCatalog: {},
      materials: [],
      capabilities: [],
      checkers: [{ id: "browser/1", version: "checker" }],
    },
    workflowRules: [],
    cases: [],
    writableScope: [],
    evidence: [],
    capabilityChanges: [],
  } as unknown as InvestigatedPlan;
  bindAvailability(plan.requirements!, snapshot);
  plan.browserCases = obligationCases(obligation);
  plan.requirements![0].checks = plan.browserCases.map((c) => ({
    checker: "browser/1",
    caseId: c.id,
  }));
  return plan;
}
test("宿主已证明的可见性保护不能伪装成额外业务限制，明确改变可见性的异议仍保留", () => {
  const wire={reviewedIds:["r"],fieldDecisions:[],issues:[{kind:"extra-constraint",sourceRevision:"run:1",sourceQuote:sources[0].text,detail:"来源未要求固定可见性",target:{subject:"r",aspect:"availability"},stance:"forbidden"}]};
  assert.throws(()=>parseReview(JSON.stringify(wire),fixturePlan(),sources),/宿主.*保护|业务限制/);
  assert.equal(parseReview(JSON.stringify(wire),fixturePlan(true),sources).issues.length,1);
});
test("基线来源进入语义、技术事实及系统保护证据，伪造业务澄清不能绕过目录", () => {
  const p = fixturePlan();
  assert.deepEqual(semanticChoiceTargets(p), []);
  assert.ok(
    technicalFacts(p).some(
      (f) =>
        f.id === "host-fact:action-availability:visibility" &&
        f.properties.visible === "false",
    ),
  );
  assert.equal(compileSemantics(p, sources).entries[0].origin, "host");
  assert.ok(
    p.browserCases!.every((c) => c.classification === "system-protection"),
  );
  assert.deepEqual(coverage(p, sources, ["browser/1"])[0].reasons, []);
  const schema = boundReviewSchema(p, sources);
  assert.equal(schema.properties.unresolvedChoices.maxItems, 0);
  assert.throws(
    () =>
      parseReview(
        JSON.stringify({
          reviewedIds: ["r"],
          issues: [],
          fieldDecisions: [],
          unresolvedChoices: [
            {
              targetId: "business-choice:action-availability:visibility",
              sourceRevision: "run:1",
              sourceQuote: sources[0].text,
            },
          ],
        }),
        p,
        sources,
      ),
    /未决语义/,
  );
});
test("明确改变可见性保留业务复核；不可由不可执行或后端拒绝推导新可见性", () => {
  const p = fixturePlan(true);
  assert.equal(
    semanticChoiceTargets(p).filter((t) => t.aspect === "action-availability")
      .length,
    1,
  );
  assert.equal(compileSemantics(p, sources).entries[0].origin, "requirement");
  assert.equal(p.requirements![0].obligations![0].kind, "assertion");
  const o = p.requirements![0].obligations![0];
  if (o.kind !== "assertion") throw new Error("fixture");
  assert.equal(o.availability, undefined);
  o.availability = { origin: "host", state: "done" };
  assert.match(availabilityFailure(p)!, /可信基线/);
  assert.equal(
    semanticChoiceTargets(p).filter((t) => t.aspect === "action-availability")
      .length,
    1,
  );
});
test("基线来源、版本及摘要在开始和应用共用门禁校验，删除浏览器断言仍失败", () => {
  const p = fixturePlan();
  p.changeSpec = compileSpec(p, "run", "source");
  const g = freezeRequirements(
    p,
    sources,
    "request",
    { reviewedIds: ["r"], issues: [], fieldDecisions: [] },
    ["browser/1"],
  );
  p.requirementGate = g;
  assert.equal(gateFailure(p, g), undefined);
  for (const mutate of [
    (p: InvestigatedPlan) => {
      p.binding!.actionAvailability!.actions[2].from = ["invalid-state"];
    },
    (p: InvestigatedPlan) => {
      p.binding!.actionAvailability!.baseVersion = "other";
    },
    (p: InvestigatedPlan) => {
      delete p.binding!.actionAvailability;
    },
    (p: InvestigatedPlan) => {
      const o = p.requirements![0].obligations![0];
      if (o.kind === "assertion") delete o.availability;
    },
    (p: InvestigatedPlan) => {
      p.browserCases!.pop();
    },
  ]) {
    const copy = structuredClone(p);
    mutate(copy);
    assert.ok(gateFailure(copy, g));
  }
});
test("当前基线、成员启用态及渲染器变化使旧绑定失效，未知 UI 身份不获得宿主来源", () => {
  const p = fixturePlan();
  const current = {
    actionAvailability: {
      ...p.binding!.actionAvailability!,
      rendererHash: "changed",
    },
  };
  assert.match(
    planBindingFailure(
      p.binding,
      current as Parameters<typeof planBindingFailure>[1],
    )!,
    /动作可见性基线/,
  );
  const o = p.requirements![0].obligations![0];
  if (o.kind !== "assertion" || o.expected.kind !== "action-visible")
    throw new Error("fixture");
  o.expected.member = "unknown";
  bindAvailability(p.requirements!, p.binding!.actionAvailability);
  assert.equal(o.availability, undefined);
  assert.equal(semanticChoiceTargets(p).length, 1);
});
for (const phase of ["admission", "planning", "review", "generation"] as const)
  test(`输出策略与工具目录解耦，按阶段选择额度：${phase}`, async () => {
    assert.equal(modelPolicy(phase).thinking, "enabled");
    assert.equal(modelPolicy(phase).reasoningEffort, "max");
    assert.equal(modelPolicy(phase).maxTokens, phase === "admission" ? 65536 : 131072);
    let payload: Record<string, unknown> = {};
    const driver = new DeepSeek("test-key", async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          model: "deepseek-flash",
          choices: [{ finish_reason: "stop", message: { content: "ok" } }],
        }),
      );
    });
    const r = await driver.generate(
      { phase, instruction: "fixture", history: [] },
      new AbortController().signal,
    );
    assert.deepEqual(payload.thinking, { type: "enabled" });
    assert.equal(payload.reasoning_effort, "max");
    assert.equal(r.transport!.outputPolicy!.phase, phase);
  });
test("复核 length 是资源失败：只消费一次调用，保留原始响应及 usage，不重发相同参数", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "review-resource-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  const fixture = new PlanningDriver();
  let reviews = 0;
  const raw = {
    choices: [{ finish_reason: "length", message: { content: "" } }],
    usage: { completion_tokens: 32768 },
  };
  const e = new Evolution(
    w.db,
    {
      async generate(request, signal) {
        if (
          request.phase === "review" &&
          JSON.parse(request.message ?? "{}").requirements
        ) {
          reviews++;
          return {
            text: "",
            calls: [],
            history: [],
            usage: raw.usage,
            raw,
            transport: { finishReason: "length" },
            protocolErrors: ["供应商返回未完成的响应：length"],
          };
        }
        return fixture.generate(request, signal);
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
    text: "完成前必须填写复盘",
    operationId: "request",
  });
  let run = (await e.observe()).run!;
  for (let i = 0; run.status === "planning" && i < 1000; i++) {
    await new Promise((r) => setTimeout(r, 10));
    run = (await e.observe()).run!;
  }
  assert.equal(run.status, "blocked");
  assert.equal(reviews, 1);
  assert.equal(
    run.resourceFailures?.length,
    1,
    JSON.stringify({
      status: run.status,
      message: "message" in run ? run.message : undefined,
      failures: run.protocolFailures,
    }),
  );
  assert.equal(run.resourceFailures![0].kind, "output-budget");
  assert.equal(run.budget!.callsUsed, 3);
  assert.equal(run.budget!.callsRemaining, 9);
  const calls = w.db
    .prepare("SELECT body FROM evolution_calls ORDER BY id")
    .all()
    .map((r) => JSON.parse(String(r.body)));
  assert.deepEqual(calls.at(-1).usage, raw.usage);
  assert.deepEqual(calls.at(-1).response, raw);
  assert.ok(calls.every((c) => c.request.phase === c.phase));
});

import { readFile } from "node:fs/promises";

test("归档可见性误判离线重放：原有效目标现在由可信基线裁决，不转交用户", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "availability-replay-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  let evolution: Evolution | undefined;
  t.after(async () => {
    await evolution?.close();
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const archive = JSON.parse(
    await readFile(
      new URL("../fixtures/upgrade-availability-review.json", import.meta.url),
      "utf8",
    ),
  );
  const fixture = await memberUiReleaseInput("availability-replay");
  w.release.record(fixture.panel);
  const v = w.release.record({
    ...fixture.composition,
    evidence: {
      ...fixture.composition.evidence,
      rules: [],
      memberCases: panelMemberCases,
    },
  });
  await w.activate(
    {
      versionId: v.id,
      compositionRevision: w.composition().revision,
      operationId: "activate",
    },
    () => undefined,
  );
  const context = capture(w);
  const evidence = [
    ...Object.entries(context.files).map(([ref, f]) => ({ ref, hash: f.hash })),
    ...Object.entries(context.guideHashes).map(([ref, hash]) => ({
      ref,
      hash,
    })),
    ...["inspect_application", "check_environment"].map((name) => {
      const r = readInvestigation(name, {}, context);
      if (!("ref" in r)) throw new Error(r.message);
      return { ref: r.ref, hash: r.hash };
    }),
  ];
  const parsed = compilePlanDraft(archive.plan, context, evidence, [
    { id: archive.sourceId, text: archive.request },
  ]);
  assert.deepEqual(parsed.blockers, []);
  const ids = parsed.plan
    .requirements!.flatMap((r) => r.obligations ?? [])
    .filter(
      (o) => o.kind === "assertion" && o.expected.kind === "action-visible",
    )
    .map((o) => o.id);
  assert.equal(ids.length, 2);
  const replay = {...archive.review, unresolvedChoices: archive.review.unresolvedChoices.map((choice: {targetId:string}, index:number)=>({...choice,targetId:"business-choice:action-availability:"+ids[index]}))};
  for (const choice of replay.unresolvedChoices)
    assert.ok(
      ids.includes(
        choice.targetId.replace("business-choice:action-availability:", ""),
      ),
      "归档必须命中原真实目标，不能依靠无效 ID 假通过",
    );
  assert.deepEqual(
    semanticChoiceTargets(parsed.plan).filter(
      (t) => t.aspect === "action-availability",
    ),
    [],
  );
  assert.throws(
    () =>
      parseReview(
        JSON.stringify({
          ...replay,
          reviewedIds: parsed.plan.requirements!.map((r) => r.id),
        }),
        parsed.plan,
        [{ id: archive.sourceId, text: archive.request }],
      ),
    /未决语义/,
  );
  let reviewCalls = 0;
  const reply = (value: unknown) => ({
    text: JSON.stringify(value),
    history: [],
    calls: [],
    usage: { fixture: true },
    raw: { fixture: true },
  });
  let planning = 0;
  const e = new Evolution(
    w.db,
    {
      async generate(request) {
        const input = JSON.parse(request.message ?? "{}");
        if (input.kind === "request-admission/2")
          return reply({ effects: [], initials: [], questions: [] });
        if (request.schema) {
          assert.equal(input.kind, "requirement-review/2", "不能增加用户澄清审查调用");
          assert.deepEqual(request.history, []);
          assert.equal(request.tools, undefined);
          assert.equal(request.phase, "review");
          reviewCalls++;
          const assertions = input.requirements
            .flatMap(
              (r: { obligations: AcceptanceObligation[] }) => r.obligations,
            )
            .filter(
              (o: AcceptanceObligation) =>
                o.kind === "assertion" && o.expected.kind === "action-visible",
            );
          return reply({
            ...archive.review,
            reviewedIds: input.requirements.map((r: { id: string }) => r.id),
            unresolvedChoices:
              reviewCalls === 1
                ? archive.review.unresolvedChoices.map(
                    (
                      c: { targetId: string; sourceQuote: string },
                      i: number,
                    ) => ({
                      ...c,
                      targetId:
                        "business-choice:action-availability:" +
                        assertions[i].id,
                      sourceRevision: input.sources[0].id,
                    }),
                  )
                : [],
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
        assert.equal(planning, 2);
        return {
          ...reply(null),
          text: "",
          calls: [{ name: "propose_plan", args: archive.plan }],
        };
      },
    },
    new EvolutionDomain(w),
  );
  evolution = e;
  const before = JSON.stringify({
    composition: w.composition(),
    tasks: w.query(),
  });
  await e.command({
    type: "request",
    operationId: "request",
    text: archive.request,
  });
  let run = (await e.observe()).run!;
  for (let i = 0; run.status === "planning" && i < 1500; i++) {
    await new Promise((r) => setTimeout(r, 10));
    run = (await e.observe()).run!;
  }
  assert.equal(
    run.status,
    "awaiting-acceptance",
    JSON.stringify({
      status: run.status,
      message: "message" in run ? run.message : undefined,
    }),
  );
  assert.equal(reviewCalls, 2);
  assert.equal(run.budget!.callsUsed, 5);
  assert.equal(run.budget!.callsRemaining, 7);
  if (run.status !== "awaiting-acceptance") throw new Error("fixture");
  assert.equal(run.protocolFailures!.length, 1);
  assert.ok(
    run.plan
      .semanticState!.entries.filter(
        (e) => e.target.aspect === "action-availability",
      )
      .every((e) => e.origin === "host" && e.status === "specified"),
  );
  await e.command({
    type: "confirm-acceptance",
    runId: run.id,
    planId: run.plan.id,
    revisionId: run.acceptanceRevision.id,
    operationId: "confirm",
  });
  assert.equal((await e.observe()).run!.status, "ready");
  assert.equal(
    JSON.stringify({ composition: w.composition(), tasks: w.query() }),
    before,
  );
});

test("规划前预检也收到同一精确基线事实，不能等到最终复核才补事实", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "availability-intake-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const context = capture(w);
  const domain = new EvolutionDomain(w);
  const facts = domain.admission(context).facts;
  assert.ok(
    facts.some(
      (f) =>
        f.id.startsWith("host-fact:baseline-action:") &&
        f.properties.action === "complete" &&
        f.properties.state === "done" &&
        f.properties.visible === "false",
    ),
  );
  const inspection = readInvestigation("inspect_application", {}, context);
  if (!("ref" in inspection)) throw new Error(inspection.message);
  const technical = (
    inspection.content as {
      technicalFacts: { id: string; properties: Record<string, string> }[];
    }
  ).technicalFacts;
  assert.deepEqual(
    technical.filter((f) => f.id.startsWith("host-fact:baseline-action:")),
    facts.filter((f) => f.id.startsWith("host-fact:baseline-action:")),
  );
});
