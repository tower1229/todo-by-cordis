import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { capture, bindPlan, planBindingFailure } from "../../src/server/planning.js";
import { compileDefaults } from "../../src/evolution/interaction.js";
import { compileSpec, specificationFailure } from "../../src/evolution/specification.js";
import { requirementReviewInput } from "../../src/evolution/review-input.js";
import { memberUiReleaseInput } from "../fixtures/member-ui.js";
import { PlanningDriver, clarificationPayloadFixture } from "./planning-fixture.js";
import { settleEvolution } from "./evolution-adapter.js";
import { hash } from "../../src/release/storage.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";

const defaults = compileDefaults([{
  scope: "标记字段的任务存在性",
  behavior: "未设置标记不阻止任务保存；设置标记时拒绝空白输入。",
  basis: "已审查的可选元数据默认",
  impact: "既有任务无需补充标记",
}]);
const review = { id: defaults[0].id, verdict: "safe-default", detail: "不引入全局必填约束", targets: [] };

async function setup(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), "baseline-defaults-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  t.after(async () => { await w.close(); await rm(dir, { recursive: true, force: true }); });
  const fixture = await memberUiReleaseInput("baseline-defaults");
  w.release.record(fixture.panel);
  const v = w.release.record({ ...fixture.composition, evidence: {
    passed: true,
    changeSpec: { definition: { defaults } },
    requirementGate: { sources: [{ id: "published:1", text: "新增标记，设置时拒绝空白输入" }], review: { defaultReviews: [review] } },
  } });
  await w.activate({ versionId: v.id, compositionRevision: w.composition().revision, operationId: "activate" }, () => undefined);
  return w;
}

test("连续变更的预检、澄清和独立复核收到同一已审基线默认，原始来源不变", async t => {
  const w = await setup(t);
  const fixture = new PlanningDriver();
  const captured: Record<string, unknown>[] = [];
  const e = new Evolution(w.db, { async generate(request) {
    const input = JSON.parse(request.message ?? "{}");
    captured.push(input);
    if (input.kind === "request-admission/2") return {
      text: JSON.stringify({ initials: [], effects: [], questions: [{ source: 1, sourceQuote: "设置时拒绝空白输入", question: "所有任务是否必须填写标记？" }] }),
      history: [], calls: [], usage: null, raw: { fixture: "old-source-question" },
    };
    if (input.kind === "clarification-review/2") return {
      text: JSON.stringify(clarificationPayloadFixture({ kind: "unnecessary", source: 1, sourceQuote: "设置时拒绝空白输入", detail: "继承已审查的可选默认；动作输入限制不能扩为所有任务必填" })),
      history: [], calls: [], usage: null, raw: { fixture: "baseline-default-review" },
    };
    return fixture.generate(request);
  } }, new EvolutionDomain(w));
  t.after(() => e.close());
  const text = "完成前填写复盘，保留已有标记及其他行为";
  await e.command({ type: "request", text, operationId: "request" });
  const ready = await settleEvolution(e, "ready");
  const intake = captured.find(x => x.kind === "request-admission/2")!;
  const clarification = captured.find(x => x.kind === "clarification-review/2")!;
  const independent = captured.find(x => x.kind === "requirement-review/2")!;
  assert.ok(intake.baselineDefaults, "预检丢失已发布的独立默认复核依据，会重新解释旧必填性");
  assert.deepEqual(clarification.baselineDefaults, intake.baselineDefaults);
  assert.deepEqual(independent.baselineDefaults, intake.baselineDefaults);
  assert.deepEqual((intake.baselineDefaults as { defaults: unknown }).defaults, defaults);
  assert.deepEqual(intake.sources, [{ id: "published:1", text: "新增标记，设置时拒绝空白输入" }, { id: ready.id + ":1", text }]);
  assert.equal(ready.status, "ready");
  assert.equal(ready.budget?.callsUsed, 4);
  assert.equal(ready.budget?.grants?.length, 0);
  assert.equal(ready.clarificationReviews?.[0].decision.kind, "unnecessary");
  assert.equal(w.query().total, 0, "只形成计划，不能修改业务数据");
  if (ready.status !== "ready") throw new Error("fixture");
  const altered = structuredClone(ready.plan);
  altered.binding!.baselineDefaults!.defaults[0].behavior = "改成所有任务必填";
  assert.ok(specificationFailure(altered));
  assert.throws(() => requirementReviewInput(altered, ready.plan.requirementGate!.sources), /冻结/);
});

test("基线默认进入冻结绑定，缺失旧证据保持未知，篡改与基线变化不能复用", async t => {
  const w = await setup(t);
  const context = capture(w);
  const p = { capabilityChanges: [], cases: [] };
  const binding = bindPlan(p, context, []);
  const baseline = binding.baselineDefaults;
  assert.ok(baseline, "计划绑定没有保留已审基线默认");
  assert.equal(planBindingFailure(binding, context), undefined);
  const changed = structuredClone(binding);
  delete changed.baselineDefaults;
  assert.match(planBindingFailure(changed, context) ?? "", /默认|基线/);
  const unknown = structuredClone(context);
  unknown.files["active-acceptance"] = { content: "{}", hash: hash("{}") };
  assert.equal(bindPlan(p, unknown, []).baselineDefaults, undefined);
  for (const evidence of [
    { passed: true, changeSpec: { definition: { defaults } } },
    { passed: true, changeSpec: { definition: { defaults } }, requirementGate: {} },
    { passed: false, changeSpec: { definition: { defaults } }, requirementGate: { review: { defaultReviews: [review] } } },
    { passed: true, changeSpec: { definition: { defaults } }, requirementGate: { review: { defaultReviews: [{ ...review, verdict: "conflict" }] } } },
  ]) {
    const content = JSON.stringify(evidence);
    unknown.files["active-acceptance"] = { content, hash: hash(content) };
    assert.equal(bindPlan(p, unknown, []).baselineDefaults, undefined, "缺少有效已审依据不能猜成已通过");
  }
});

test("基线默认是可被新明确要求替代的 Agent 上下文，不是新增用户来源或自动授权", async t => {
  const w = await setup(t);
  const context = capture(w);
  const binding = bindPlan({ capabilityChanges: [], cases: [] }, context, []);
  const baseline = binding.baselineDefaults!;
  assert.equal(baseline.origin, "reviewed-agent-default");
  assert.equal(baseline.evidenceHash, context.files["active-acceptance"].hash);
  assert.equal(baseline.reviewHash, hash([review]));
  assert.match(baseline.policy, /用户本轮明确修改要求优先/);
  assert.match(baseline.policy, /不是用户原话或宿主保护规则/);
  const source = { id: "new:1", text: "现在明确把标记改为必填" };
  const plan: InvestigatedPlan = {
    id: "plan", requestRevision: 1, baseVersion: context.versionId, compositionRevision: context.revision,
    route: { kind: "application" }, summary: source.text, changes: [source.text], outcome: source.text,
    dataImpact: "待复核", workflowRules: [], cases: [], requirements: [], binding,
    defaults: [], ruleChanges: [], excluded: [], evidence: [], capabilityChanges: [], steps: [], writableScope: [],
    compatibility: "待复核", rollback: "恢复", preview: "体验", application: "显式确认", restartImpact: "无", dependencies: [], unresolved: [],
  };
  plan.changeSpec = compileSpec(plan, "new", "source-hash");
  const input = requirementReviewInput(plan, [source]);
  assert.deepEqual(input.sources, [source]);
  assert.deepEqual(input.defaults, []);
  assert.deepEqual(input.baselineDefaults, baseline);
  assert.deepEqual(input.contractAuthority.defaultReviews, [], "不能把旧默认复核冒充本轮授权");
  input.baselineDefaults!.defaults[0].behavior = "篡改输入";
  assert.equal(plan.binding!.baselineDefaults!.defaults[0].behavior, defaults[0].behavior);
});

test("下一次发布不丢失已冻结携带的较早默认，保留顺序而不按文字猜测业务归并", async t => {
  const w = await setup(t);
  const context = capture(w);
  const prior = bindPlan({ capabilityChanges: [], cases: [] }, context, []).baselineDefaults!;
  const nextDefaults = compileDefaults([{ scope: "新增成员展示", behavior: "沿用详情入口", basis: "现有惯例", impact: "不改旧成员" }]);
  const content = JSON.stringify({ passed: true, changeSpec: { definition: { defaults: nextDefaults, binding: { baselineDefaults: prior } } }, requirementGate: { review: { defaultReviews: [{ ...review, id: nextDefaults[0].id }] } } });
  context.files["active-acceptance"] = { content, hash: hash(content) };
  context.versionId = "next-published-version";
  const next = bindPlan({ capabilityChanges: [], cases: [] }, context, []).baselineDefaults!;
  assert.deepEqual(next.defaults, [...defaults, ...nextDefaults]);
  assert.equal(next.baseVersion, context.versionId);
  assert.notEqual(next.reviewHash, prior.reviewHash);
});
