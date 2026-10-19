import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../../src/server/workspace.js";
import { AdmissionEvolution as Evolution } from "./evolution-adapter.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver, toolReply, clarificationPayloadFixture } from "./planning-fixture.js";
import { compileReferences } from "../../src/evolution/references.js";
import {
  businessChoices,
  reviewQuestion,
} from "../../src/evolution/technical-facts.js";
import { parseClarificationDecision } from "../../src/evolution/clarification-review.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import type {
  InvestigatedPlan,
  RequirementReview,
} from "../../src/shared/assistant.js";

async function setup(t: test.TestContext, driver: Driver) {
  const dir = await mkdtemp(join(tmpdir(), "clarification-routing-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  return e;
}
async function settle(e: Evolution) {
  for (let n = 0; n < 1000; n++) {
    const r = (await e.observe()).run!;
    if (r.status !== "planning") return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("规划未结束");
}
const auditInput = (request: ModelRequest) =>
  request.schema &&
  request.message &&
  JSON.parse(request.message).kind === "clarification-review/2"
    ? JSON.parse(request.message)
    : undefined;
const auditReply = (
  input: { sources: { text: string }[] },
  kind: string,
  extra: Record<string, unknown> = {},
) => ({
  text: JSON.stringify(clarificationPayloadFixture({
    kind,
    source: 1,
    sourceQuote: input.sources[0].text,
    detail: "模型桩独立来源审查",
    ...extra,
  })),
  history: [],
  calls: [],
  usage: { fixture: true },
  raw: { fixture: "clarification-audit" },
});

test("已知计数事实不问用户：审查和规划共享12次预算，原运行纠正后ready", async (t) => {
  const fixture = new PlanningDriver();
  let asked = false;
  const e = await setup(t, {
    async generate(request, signal) {
      const input = auditInput(request);
      if (input) {
        assert.deepEqual(request.history, []);
        assert.equal(request.tools, undefined);
        return auditReply(input, "technical", {
          fact:
            input.facts.findIndex(
              (f: { id: string }) => f.id === "host-fact:workflow-text",
            ) + 1,
          property: "lengthMetric",
          expected: "unicode-code-point",
        });
      }
      const reply = await fixture.generate(request, signal);
      if (!asked && reply.calls[0]?.name === "propose_plan") {
        asked = true;
        return {
          ...toolReply("request_clarification", {
            question: "Unicode 应怎样计数？",
          }),
          history: request.history,
        };
      }
      return reply;
    },
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘，按 Unicode 码点计数",
    operationId: "request",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  assert.equal(ready.budget?.callsUsed, 5);
  assert.equal(ready.budget!.callsUsed + ready.budget!.callsRemaining, 12);
  assert.equal(ready.revisions!.length, 1);
  assert.equal(ready.clarificationReviews!.length, 1);
  assert.equal(
    ready.clarificationReviews![0].decision.fact!.actual,
    "unicode-code-point",
  );
});

for (const kind of ["scope-reduction", "technical"])
  test(`能力缺口不能改成确认降低要求：${kind}`, async (t) => {
    const fixture = new PlanningDriver();
    let asked = false;
    const e = await setup(t, {
      async generate(request, signal) {
        const input = auditInput(request);
        if (input)
          return auditReply(
            input,
            kind,
            kind === "technical"
              ? {
                  fact:
                    input.facts.findIndex(
                      (f: { id: string }) =>
                        f.id === "host-fact:initial-field-presentation",
                    ) + 1,
                  property: "auxiliaryMissingField",
                  expected: "",
                }
              : {},
          );
        const reply = await fixture.generate(request, signal);
        if (!asked && reply.calls[0]?.name === "propose_plan") {
          asked = true;
          return {
            ...toolReply("request_clarification", {
              question: "是否接受未填写显示（空）？",
            }),
            history: request.history,
          };
        }
        return reply;
      },
    });
    await e.command({
      type: "request",
      text: "尚未填写时显示空白",
      operationId: "request",
    });
    const run = await settle(e);
    assert.equal(run.status, "blocked");
    assert.equal(run.budget?.callsUsed, 3);
    assert.equal(run.budget!.callsRemaining, 9);
    assert.equal((await e.observe()).candidates?.length ?? 0, 0);
    assert.equal(run.clarificationReviews![0].decision.kind, kind);
  });

test("真正业务歧义仍进入原澄清流程，内部审查记录与计数均保留", async (t) => {
  const fixture = new PlanningDriver();
  let asked = false;
  const e = await setup(t, {
    async generate(request, signal) {
      const input = auditInput(request);
      if (input) return auditReply(input, "business-ambiguity");
      const reply = await fixture.generate(request, signal);
      if (!asked && reply.calls[0]?.name === "propose_plan") {
        asked = true;
        return {
          ...toolReply("request_clarification", {
            question: "复盘必填还是选填？",
          }),
          history: request.history,
        };
      }
      return reply;
    },
  });
  await e.command({
    type: "request",
    text: "复盘是否必填尚未决定，请先问我",
    operationId: "request",
  });
  const waiting = await settle(e);
  assert.equal(waiting.status, "awaiting-input");
  assert.equal(waiting.budget?.callsUsed, 3);
  await e.command({
    type: "answer",
    runId: waiting.id,
    text: "复盘必填",
    operationId: "answer",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  assert.equal(ready.id, waiting.id);
  assert.equal(ready.budget?.callsUsed, 6);
  assert.equal(ready.clarificationReviews!.length, 1);
});

test("初始呈现提问服从来源解释，未要求或已经明确的值不能再提问", () => {
  const sources = [{ id: "r:1", text: "完成前填写复盘" }];
  for (const origin of ["baseline", "absent"]) {
    const c = compileReferences(
      {
        workflowRules: [{ key: "reflection" }],
        browserCases: [],
        requirements: [
          {
            id: "r",
            source: 1,
            sourceQuote: sources[0].text,
            description: sources[0].text,
            type: "interface",
            checks: [],
            obligations: [
              {
                kind: "field",
                field: "reflection",
                initial: { kind: origin },
                scenarios: [
                  {
                    steps: [
                      {
                        kind: "action",
                        action: "complete",
                        input: { reflection: "x" },
                      },
                    ],
                    value: "x",
                  },
                ],
              },
            ],
          },
        ],
      },
      sources,
      [],
      { id: "w", actions: [{ id: "complete" }] },
    );
    const p = {
      ...c,
      workflowRules: [],
      cases: [],
    } as unknown as InvestigatedPlan;
    const choice = businessChoices(p,{fieldDecisions:[{obligationId:c.requirements[0].obligations[0].id,sourceRevision:"r:1",sourceQuote:sources[0].text,initial:{kind:"undetermined"}}]}).find((c) =>
      c.id.includes("initial-display"),
    )!;
    for (const initial of [
      { kind: "unspecified" as const },
      { kind: "undetermined" as const },
      { kind: "absent" as const },
      { kind: "visible" as const, value: "" },
    ])
      for (const selected of [true, false]) {
        const review: RequirementReview = {
          reviewedIds: ["r"],
          issues: selected
            ? [
                {
                  kind: "unverifiable",
                  sourceRevision: "r:1",
                  sourceQuote: sources[0].text,
                  detail: "初始呈现",
                  target: { subject: "r", aspect: "visibility" },
                  stance: "undetermined",
                  clarificationChoice: choice.id,
                },
              ]
            : [],
          fieldDecisions: [
            {
              obligationId: c.requirements[0].obligations[0].id,
              sourceRevision: "r:1",
              sourceQuote: sources[0].text,
              initial,
            },
          ],
        };
        assert.equal(
          reviewQuestion(review, p),
          initial.kind === "undetermined" ? choice.question : undefined,
        );
      }
  }
});

test("来源未要求的初始限制退回同一规划循环，不增加用户回答或调用预算（模型桩）", async (t) => {
  const source = "完成前填写复盘，保存后显示复盘";
  const fixture = new PlanningDriver({
    requirements: [
      {
        id: "r",
        source: 1,
        sourceQuote: source,
        description: source,
        type: "interface",
        checks: [{ kind: "workflow" }],
        obligations: [
          { kind: "backend" },
          {
            kind: "field",
            field: "reflection",
            initial: { kind: "absent" },
            scenarios: [
              {
                steps: [
                  {
                    kind: "action",
                    action: "complete",
                    input: { reflection: "复盘" },
                  },
                ],
                value: "复盘",
              },
            ],
          },
        ],
      },
    ],
  });
  let plans = 0;
  let reviews = 0;
  const e = await setup(t, {
    async generate(request, signal) {
      const reply = await fixture.generate(request, signal);
      if (reply.calls[0]?.name === "propose_plan" && ++plans > 1) {
        const r = reply.calls[0].args.requirements as {
          expectations: Record<string, unknown>[];
        }[];
        r[0].expectations[1].initial = { kind: "baseline" };
      }
      if (request.schema && !auditInput(request)) {
        const input = JSON.parse(request.message!);
        const r = JSON.parse(reply.text);
        r.fieldDecisions[0].initial = { kind: "unspecified" };
        if (++reviews === 1)
          r.issues = [
            {
              kind: "extra-constraint",
              sourceRevision: input.sources[0].id,
              sourceQuote: input.sources[0].text,
              detail: "初始显隐未要求",
              target: {
                subject: input.requirements[0].id,
                aspect: "visibility",
              },
              stance: "undetermined",
            },
          ];
        reply.text = JSON.stringify(r);
      }
      return reply;
    },
  });
  await e.command({ type: "request", text: source, operationId: "request" });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  assert.equal(ready.revisions!.length, 1);
  assert.equal(ready.budget?.callsUsed, 5);
  assert.equal(ready.budget!.callsUsed + ready.budget!.callsRemaining, 12);
});

test("澄清审查不能伪造来源或事实目录", () => {
  assert.throws(
    () =>
      parseClarificationDecision(
        JSON.stringify({
          kind: "business-ambiguity",
          source: 1,
          sourceQuote: "伪造",
          detail: "不允许",
        }),
        [{ id: "r", text: "原文" }],
        [],
      ),
    /可靠来源/,
  );
  assert.throws(
    () =>
      parseClarificationDecision(
        JSON.stringify({
          kind: "technical",
          source: 1,
          sourceQuote: "原文",
          detail: "不允许",
          fact: 1,
          property: "x",
          expected: "",
        }),
        [{ id: "r", text: "原文" }],
        [],
      ),
    /引用不支持/,
  );
});

test("复核生成的未要求初始呈现问题也必须审查，原意见保留且同预算修正至ready（模型桩）",async t=>{
  const source="完成前填写复盘，保存后显示复盘";
  const fixture=new PlanningDriver({requirements:[{id:"r",source:1,sourceQuote:source,description:source,type:"interface",checks:[{kind:"workflow"}],obligations:[{kind:"backend"},{kind:"field",field:"reflection",initial:{kind:"baseline"},scenarios:[{steps:[{kind:"action",action:"complete",input:{reflection:"复盘"}}],value:"复盘"}]}]}]});
  let reviews=0,audits=0;
  const e=await setup(t,{async generate(request,signal){
    const audit=auditInput(request);
    if(audit){audits++;return auditReply(audit,"unnecessary");}
    const reply=await fixture.generate(request,signal);
    if(request.schema){const v=JSON.parse(reply.text);if(++reviews===1)v.fieldDecisions[0].initial={kind:"undetermined",questionQuote:source};reply.text=JSON.stringify(v);}
    return reply;
  }});
  await e.command({type:"request",text:source,operationId:"request"});
  const ready=await settle(e);assert.equal(ready.status,"ready");assert.equal(ready.budget?.callsUsed,6);assert.equal(ready.revisions!.length,1);assert.equal(audits,1);
  assert.equal(ready.clarificationReviews![0].decision.kind,"unnecessary");
  assert.equal(ready.reviewLedger!.attempts.length,2);
  assert.ok(ready.reviewLedger!.attempts[0].review.issues.length);
  if(ready.status==="ready") assert.deepEqual(ready.plan.questionAdjudications,ready.clarificationReviews);
});

test("统一澄清审查取消后迟到回复不能恢复planning或提出问题",async t=>{
  const fixture=new PlanningDriver();let release!:()=>void,enter!:()=>void;
  const entered=new Promise<void>(r=>{enter=r;});
  const e=await setup(t,{async generate(request,signal){
    const audit=auditInput(request);
    if(audit){enter();return new Promise<ReturnType<typeof auditReply>>(r=>{release=()=>r(auditReply(audit,"business-ambiguity"));});}
    const reply=await fixture.generate(request,signal);
    if(reply.calls[0]?.name==="propose_plan")return {...toolReply("request_clarification",{question:"复盘是否必填？"}),history:request.history};
    return reply;
  }});
  await e.command({type:"request",text:"复盘是否必填尚未决定",operationId:"request"});
  await entered;const run=(await e.observe()).run!;
  await e.command({type:"cancel",runId:run.id,operationId:"cancel"});release();
  await new Promise(r=>setTimeout(r,30));
  assert.equal((await e.observe()).run?.status,"cancelled");
});
