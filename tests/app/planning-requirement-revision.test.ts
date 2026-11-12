import test from "node:test";
import assert from "node:assert/strict";
import { compilePlanInput } from "../../src/evolution/plan-input.js";
import { v1Requests } from "../../scripts/lib/v1-scenario.js";

const original = "增加标签，保存去首尾空格、拒绝空白并保留大小写；其他行为不变";
const upgrade = "升级标签，保存统一小写，仍去首尾空格并拒绝空白；其他行为不变";
const sources = [{ id: "accepted:1", text: original }, { id: "upgrade:1", text: upgrade }];
/** tip 916faff phase2 sourceCatalog shape: install + counter + upgrade. */
const v1Phase2Sources = [
  { id: "phase0:1", text: v1Requests[0] },
  { id: "phase1:1", text: v1Requests[1] },
  { id: "phase2:1", text: v1Requests[2] },
];
const oldRequirement = {
  id: "accepted-tags", description: original, sourceQuote: original,
  sourceRevision: sources[0].id, type: "behavior",
};
const oldCase = {
  member: "tags", name: "去空白并保留大小写", state: "open", fields: {},
  action: "setTags", input: { tags: "  Alpha Project  " },
  expected: { kind: "commit", state: "open", fields: { tags: "Alpha Project" } },
};
function context(requirements = [oldRequirement]) {
  return {
    pluginId: "default", capabilities: [],
    members: [
      { pluginId: "default", role: "workflow" as const, enabled: true, versionId: "base" },
      { pluginId: "tags", role: "auxiliary" as const, enabled: true, versionId: "tags-base" },
    ],
    files: {
      "active-contract": { hash: "contract", content: JSON.stringify({
        id: "default", name: "默认", version: "1", initialState: "open", fields: [],
        states: { open: { label: "未完成", category: "open" }, done: { label: "已完成", category: "done" } },
        actions: [{ id: "complete", label: "完成", from: ["open"] }, { id: "reopen", label: "重新打开", from: ["done"] }],
      }) },
      "active-acceptance": { hash: "acceptance", content: JSON.stringify({
        rules: [], requirements, memberCases: [oldCase],
      }) },
    },
  };
}
function proposal(revises?: string) {
  const { member: _member, ...previous } = oldCase;
  return {
    intent: "improve", acceptanceReason: "用户明确升级保存规则，原大小写数据保持历史",
    changes: [{ target: "tags", features: ["commands", "fields", "detail"], cases: [{
      ...previous, expected: { kind: "commit", state: "open", fields: { tags: "alpha project" } },
    }] }],
    requirements: [{ quote: upgrade, type: "behavior", ...(revises === undefined ? {} : { revises }),
      expectations: [{ kind: "behavior" }, { kind: "field", field: "tags" }] }],
  };
}

test("标签升级以业务原文显式修订旧要求，宿主沿用身份并绑定新的权威来源", () => {
  const c = context();
  const before = structuredClone(c);
  const input = proposal(original);
  Object.assign(input.requirements[0], { description: "未经要求的错误文案与数据迁移" });
  const draft = compilePlanInput(input, c, sources);
  const requirement = draft.requirements[0];
  assert.equal(requirement.id, oldRequirement.id);
  assert.equal(requirement.source, 2);
  assert.equal(requirement.sourceQuote, upgrade);
  assert.equal(requirement.description, upgrade, "可选说明不能替代业务原文权威");
  const field = requirement.obligations.find(o => o.kind === "field");
  assert.ok(field);
  assert.deepEqual((field.scenarios as { value: string }[]).map(s => s.value), ["alpha project"]);
  assert.equal(draft.memberCases?.[0].name, oldCase.name, "既有案例兼容身份不能因显示名称改变");
  assert.deepEqual(c, before, "原基线、旧来源及历史预期不被改写");
});

test("没有显式业务修订时，新要求不能静默接管旧身份", () => {
  const c = context();
  const draft = compilePlanInput(proposal(), c, sources);
  assert.notEqual(draft.requirements[0].id, oldRequirement.id);
  assert.equal(JSON.parse(c.files["active-acceptance"].content).requirements[0].description, original);
});

test("业务修订拒绝未知、歧义与非后续来源，不能用相同旧原文授权改写", () => {
  // #54：撤回 6bacd68；缺失修订目标恢复致命，不得降级为新增。
  assert.throws(
    () => compilePlanInput(proposal("不存在的旧业务要求"), context(), sources),
    /修订.*不存在|既有.*不存在/,
  );
  assert.throws(() => compilePlanInput(proposal(original), context([
    oldRequirement, { ...oldRequirement, id: "another-accepted-tags" },
  ]), sources), /修订.*不唯一|修订.*歧义/);
  const same = proposal(original);
  same.requirements[0].quote = original;
  assert.throws(() => compilePlanInput(same, context(), sources), /修订.*较新|修订.*后续/);
});

test("同一既有业务要求不能在一次计划中被多次接管", () => {
  const input = proposal(original);
  input.requirements.push({ ...input.requirements[0], expectations: [{ kind: "behavior" }] });
  assert.throws(() => compilePlanInput(input, context(), sources), /相同业务要求重复/);
});

test("同一新原文分别修订两条已接受要求时，不能去重丢失其中一个身份", () => {
  const partial = "拒绝空白并保留大小写";
  const second = { ...oldRequirement, id: "accepted-tag-detail", sourceQuote: partial, description: partial };
  const input = proposal(original);
  input.requirements.push({ ...input.requirements[0], revises: partial });
  const draft = compilePlanInput(input, context([oldRequirement, second]), sources);
  assert.deepEqual(draft.requirements.map(r => r.id), [oldRequirement.id, second.id]);
});

test("业务修订只绑定来源和身份，不能根据原文静默改写模型的执行预期", () => {
  const input = proposal(original);
  input.changes[0].cases[0].expected.fields.tags = "Alpha Project";
  const draft = compilePlanInput(input, context(), sources);
  const field = draft.requirements[0].obligations.find(o => o.kind === "field")!;
  assert.deepEqual((field.scenarios as { value: string }[]).map(s => s.value), ["Alpha Project"],
    "矛盾预期必须交给原独立复核阻塞，不能被编译器改成通过值");
});

test("error-feedback 冲突场景：业务修订引用缺失的既有要求仍致命", () => {
  // #54：与「未知修订目标」同裁决；不得借冲突场景绕过致命门禁。
  const blankTagRequirement = "拒绝空白标签";
  const revisedText = "升级标签验证，继续拒绝空白";
  const conflictingSources = [
    { id: "initial:1", text: blankTagRequirement },
    { id: "revision:1", text: revisedText },
  ];
  const c = context();
  const { member: _member, ...caseWithoutMember } = oldCase;
  const input = {
    intent: "improve",
    acceptanceReason: "修订 error-feedback 约束时旧要求可能因冲突转换而缺失",
    changes: [{ target: "tags", cases: [caseWithoutMember] }],
    requirements: [
      { quote: revisedText, revises: blankTagRequirement, type: "constraint",
        expectations: [{ kind: "error", action: "setTags" }] },
    ],
  };
  assert.throws(
    () => compilePlanInput(input, c, conflictingSources),
    /修订.*不存在|既有.*不存在/,
  );
});

function v1Phase2Proposal(quote: string) {
  const { member: _member, ...previous } = oldCase;
  return {
    intent: "improve" as const,
    acceptanceReason: "用户明确把标签保存改为统一小写，并保留拒绝空白",
    changes: [
      {
        target: "tags",
        features: ["commands", "fields", "detail"],
        cases: [
          {
            ...previous,
            expected: {
              kind: "commit" as const,
              state: "open",
              fields: { tags: "alpha project" },
            },
          },
        ],
      },
    ],
    requirements: [
      {
        quote,
        type: "behavior",
        expectations: [
          { kind: "behavior" as const },
          { kind: "field" as const, field: "tags" },
        ],
      },
    ],
  };
}

test("v1 phase2：短 quote「拒绝空白」跨初装/升级修订歧义（916faff 停点）", () => {
  assert.throws(
    () => compilePlanInput(v1Phase2Proposal("拒绝空白"), context(), v1Phase2Sources),
    /需求原文「拒绝空白」对应多个修订/,
  );
});

test("v1 phase2：短 quote「去掉首尾空格」同样跨修订歧义", () => {
  assert.throws(
    () =>
      compilePlanInput(v1Phase2Proposal("去掉首尾空格"), context(), v1Phase2Sources),
    /需求原文「去掉首尾空格」对应多个修订/,
  );
});

test("v1 phase2：加长 quote 唯一绑定升级修订", () => {
  const quote = "仍去掉首尾空格、拒绝空白";
  assert.equal(v1Requests[2].includes(quote), true);
  assert.equal(v1Requests[0].includes(quote), false);
  const draft = compilePlanInput(
    v1Phase2Proposal(quote),
    context(),
    v1Phase2Sources,
  );
  assert.equal(draft.requirements[0].sourceQuote, quote);
  assert.equal(draft.requirements[0].source, 3);
  assert.equal(draft.requirements[0].description, quote);
});
