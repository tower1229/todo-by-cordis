import test from "node:test";
import assert from "node:assert/strict";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";
import { hash } from "../../src/release/storage.js";
import { schedulePolicyChecks, type SchedulePolicy } from "../../src/shared/schedule-policy.js";
import {
  checkIndependentPlan,
  checkIndependentBrowser,
  checkIndependentBlock,
  checkDuePolicy,
  duePolicyCheckIds,
  oracleCheck,
} from "../../scripts/lib/stability-eval/oracle.js";
import { parseAdmission, adjudicateAdmission } from "../../src/evolution/request-admission.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import type { BrowserEvidence } from "../../src/shared/browser-cases.js";

test("模型自报通过不能替代原文要求：遗漏必填或替换长度上限被独立判定拒绝", () => {
  const scenario = currentManifest("a".repeat(40)).scenarios.find(
    (s) => s.id === "rule-revision-reflection",
  )!;
  for (const workflowRules of [
    [],
    [
      {
        key: "reflection",
        label: "复盘",
        required: false,
        minLength: 1,
        maxLength: 5000,
      },
    ],
    [
      {
        key: "reflection",
        label: "复盘",
        required: true,
        minLength: 1,
        maxLength: 100,
      },
    ],
  ]) {
    const checks = checkIndependentPlan(scenario, {
      workflowRules,
      requirements: [],
    });
    assert(checks.some((c) => c.status === "failed"));
  }
});

test("基础页面成功或重复同一视口的通过结果不能冒充独立业务覆盖", () => {
  const evidence: BrowserEvidence = {
    checker: "browser/1",
    checkerHash: "fixture",
    candidateVersion: "candidate",
    baseVersion: "base",
    candidateProgramHash: "program",
    definitionHash: "definition",
    frontendHash: "frontend",
    fixtureHash: "fixture",
    directory: "fixture",
    results: [],
  };
  const cases = [{ id: "business", task: "new" as const, steps: [] }];
  for (const results of [
    [
      {
        caseId: "host:basic",
        requirementIds: [],
        viewport: { width: 390, height: 844 },
        status: "passed" as const,
      },
    ],
    [1, 2].map(() => ({
      caseId: "business",
      requirementIds: [],
      viewport: { width: 390, height: 844 },
      status: "passed" as const,
    })),
  ])
    assert.equal(
      checkIndependentBrowser(cases, { ...evidence, results }).status,
      "failed",
    );
  const results = [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
  ].map((viewport) => ({
    caseId: "business",
    requirementIds: [],
    viewport,
    status: "passed" as const,
  }));
  assert.equal(
    checkIndependentBrowser(cases, { ...evidence, results }).status,
    "passed",
  );
});

test("计时验收补全定义也必须补全执行义务，遗漏修改或清除旧标记不能通过", () => {
  const scenario = currentManifest("a".repeat(40)).scenarios.find(s => s.id === "due-auto-expire")!;
  const fired = { name:"到期",member:"due",state:"open",fields:{dueAt:"2030-01-01T00:00:00Z"},action:"expire",input:{scheduledAt:"2030-01-01T00:00:00Z"},expected:{kind:"commit" as const,state:"open",fields:{dueAt:"2030-01-01T00:00:00Z",expired:"true"}} };
  const modify = {name:"修改",member:"due",state:"open",fields:{dueAt:"2030-01-01T00:00:00Z",expired:"true"},action:"setDue",input:{dueAt:"2030-02-01T00:00:00Z"},expected:{kind:"commit" as const,state:"open",fields:{dueAt:"2030-02-01T00:00:00Z"}}};
  const clear = {...modify,name:"清除",input:{dueAt:""},expected:{kind:"commit" as const,state:"open",fields:{}}};
  for (const cases of [[fired], [fired,modify], [fired,clear], [fired,modify,{...clear,expected:{...clear.expected,fields:{expired:"true"}}}]])
    assert.equal(checkIndependentPlan(scenario,{memberCases:cases}).find(c => c.id === "plan:due-policy")?.status,"failed");
  assert.equal(checkIndependentPlan(scenario,{memberCases:[fired,modify,clear]}).find(c => c.id === "plan:due-policy")?.status,"passed");
  const policy: SchedulePolicy = {
    version: 1, id: "reset", kind: "schedule-policy",
    action: { kind: "action", member: "due", action: "expire" },
    fireCase: { caseId: "member:due:到期", definitionHash: hash(fired) },
    checks: ["reset-clears-effect"],
  };
  const requirement = {
    id: "r", description: "修改或清除截止时清除原过期标记",
    sourceRevision: "run:1", sourceQuote: scenario.request,
    type: "behavior" as const,
    checks: schedulePolicyChecks(policy), obligations: [policy],
  };
  const result = (r = requirement) => checkIndependentPlan(scenario, {
    memberCases: [fired], requirements: [r],
  }).find(c => c.id === "plan:due-policy")?.status;
  assert.equal(result(), "passed");
  assert.equal(result({ ...requirement, checks: [] }), "failed");
  for (const forged of [
    { ...policy, fireCase: { ...policy.fireCase, definitionHash: "forged" } },
    { ...policy, action: { ...policy.action, member: "other" } },
    { ...policy, checks: ["set-past-due"] as SchedulePolicy["checks"] },
  ]) assert.equal(result({ ...requirement, obligations: [forged] }), "failed");
  const checks = duePolicyCheckIds.map(id => oracleCheck(id,true,true));
  assert.equal(checkDuePolicy(checks).status,"passed");
  assert.equal(checkDuePolicy(checks.slice(1)).status,"failed");
  assert.equal(checkDuePolicy([...checks,checks[0]]).status,"failed");
});

test("能力阻塞须有当前来源和宿主绑定证明，恢复过的协议事件不推翻有效终态", () => {
  const scenario = currentManifest("a".repeat(40)).scenarios.find(s => s.id === "missing-capability-push")!;
  const context = {environment:{node:"test",dependencies:{},missing:[]},capabilities:[]};
  const sources = [{id:"s:1",text:scenario.request}];
  const parsed = parseAdmission(JSON.stringify({initials:[],questions:[],effects:[{source:1,sourceQuote:"离线时仍保证送达",effect:"offline-delivery"}]}),"base",sources,technicalFacts({workflowRules:[],binding:undefined,capabilities:[]}));
  const admission = adjudicateAdmission(JSON.stringify({decisions:[{claim:1,source:1,sourceQuote:"离线时仍保证送达",layer:"capability",verdict:"entailed",detail:"来源明确要求"}]}),parsed,sources);
  const run = {status:"blocked",blockReason:"maintainer-capability",requestAdmissions:[admission],protocolFailures:[{}]};
  assert.equal(checkIndependentBlock(scenario,run,context).status,"passed");
  assert.equal(checkIndependentBlock(scenario,{...run,requestAdmissions:[]},context).status,"failed");
  const tampered=structuredClone(admission);tampered.capabilityChecks[0].factHash="伪造";
  assert.equal(checkIndependentBlock(scenario,{...run,requestAdmissions:[tampered]},context).status,"failed");
  assert.equal(checkIndependentBlock(scenario,{...run,stop:{kind:"protocol",phase:"review",code:"invalid-model-protocol",evidence:["model-call:2"]}},context).status,"failed");
});

test("空白呈现阻塞通过同一 claim 的已复核完整来源绑定，不要求条件引用重复效果原文", () => {
  const scenario = currentManifest("a".repeat(40)).scenarios.find(
    (s) => s.id === "unsupported-blank-presentation",
  )!;
  const sources = [{ id: "s:1", text: scenario.request }];
  const parsed = parseAdmission(
    JSON.stringify({
      initials: [{
        source: 1,
        sourceQuote: "尚未填写时",
        target: { kind: "new", name: "评审备注" },
        meaning: {
          kind: "blank",
          conditionQuote: "尚未填写时",
          effectQuote: "显示空白",
        },
      }],
      effects: [],
      questions: [],
    }),
    "base",
    sources,
    technicalFacts({ workflowRules: [] }),
  );
  const admission = adjudicateAdmission(
    JSON.stringify({ decisions: [{
      claim: 1,
      source: 1,
      sourceQuote: "任务详情显示备注，尚未填写时显示空白",
      layer: "initial-display",
      verdict: "entailed",
      detail: "原文明确要求未填写时显示空白",
    }] }),
    parsed,
    sources,
  );
  const context = {
    environment: { node: "test", dependencies: {}, missing: [] },
    capabilities: [],
  };
  const run = {
    status: "blocked",
    blockReason: "maintainer-capability",
    requestAdmissions: [admission],
  };
  assert.equal(checkIndependentBlock(scenario, run, context).status, "passed");
  const tampered = structuredClone(admission);
  tampered.technicalChecks[0].factHash = "fabricated";
  assert.equal(checkIndependentBlock(scenario, {
    ...run, requestAdmissions: [tampered],
  }, context).status, "failed");
  assert.equal(checkIndependentBlock({
    ...scenario,
    oracle: { kind: "block", reason: "blank-presentation", sources: ["标签显示空白"] },
  }, run, context).status, "failed");
});
