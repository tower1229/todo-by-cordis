import test from "node:test";
import assert from "node:assert/strict";
import {
  compilePlanInput,
  type PlanInput,
} from "../../src/evolution/plan-input.js";
import {
  compileReferences,
  inheritBrowserCases,
} from "../../src/evolution/references.js";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import type { Requirement } from "../../src/shared/assistant.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";

const original = "设置标签，去除首尾空格并保留大小写";
const upgrade = "保存标签时改为小写，保留其他行为";
const sources = [
  { id: "accepted:1", text: original },
  { id: "upgrade:1", text: upgrade },
];
const workflow = {
  id: "default",
  actions: [{ id: "complete" }, { id: "reopen" }],
  initialState: "open",
  states: {
    open: { label: "未完成", category: "open" },
    done: { label: "完成", category: "done" },
  },
  fields: [],
};
const oldCases: MemberAcceptanceCase[] = [
  {
    member: "tags",
    name: "first-save",
    state: "open",
    fields: {},
    action: "setTag",
    input: { tag: " Alpha " },
    expected: { kind: "commit", state: "open", fields: { tag: "Alpha" } },
  },
  {
    member: "tags",
    name: "overwrite",
    state: "open",
    fields: { tag: "Alpha" },
    action: "setTag",
    input: { tag: " miXeD " },
    expected: { kind: "commit", state: "open", fields: { tag: "miXeD" } },
  },
];
const oldField: Extract<AcceptanceObligation, { kind: "field" }> = {
  version: 1,
  id: "old-tag-field",
  kind: "field",
  member: "tags",
  field: "tag",
  initialOrigin: "host",
  initial: { kind: "visible", value: "（空）" },
  scenarios: [
    {
      id: "overwrite",
      steps: oldCases.map((c) => ({
        kind: "action",
        member: c.member,
        action: c.action,
        input: c.input,
      })),
      value: "miXeD",
    },
  ],
};
const oldRequirement: Requirement = {
  id: "tags-request",
  description: original,
  sourceRevision: sources[0].id,
  sourceQuote: original,
  type: "behavior",
  checks: [],
  obligations: [oldField],
};
function fixture() {
  const inherited = {
    baseVersion: "a".repeat(64),
    memberCases: structuredClone(oldCases),
    requirements: [structuredClone(oldRequirement)],
    browserCases: obligationCases(oldField),
    fieldIdentities: [{ member: "tags", field: "tag", label: "标签" }],
    uiContributions: [
      {
        id: "tag-detail",
        providerId: "tags",
        fields: [{ key: "tag" }],
        actions: [{ commandId: "setTag" }],
      },
    ],
  };
  const context: Parameters<typeof compilePlanInput>[1] = {
    pluginId: "default",
    members: [
      {
        pluginId: "default",
        versionId: "base",
        enabled: true,
        role: "workflow",
      },
      {
        pluginId: "tags",
        versionId: "tags-base",
        enabled: true,
        role: "auxiliary",
      },
    ],
    capabilities: [
      {
        id: "fields:tags",
        interfaceId: "fields.register",
        providerId: "tags",
        status: "active",
        count: 1,
        ready: true,
        artifactVersion: "tags-base",
        providerVersion: "tags-base",
        contractVersion: "extensions/1",
        installed: true,
        enabled: true,
        healthy: true,
        inUse: true,
        authorized: true,
        dependencies: [],
        checkerCoverage: ["workspace/1"],
        registeredFields: ["tag"],
        purpose: "标签字段",
        limitations: "",
      },
    ],
    files: {
      "active-contract": {
        content: JSON.stringify(workflow),
        hash: "contract",
      },
      "active-acceptance": {
        content: JSON.stringify({ rules: [], ...inherited }),
        hash: "acceptance",
      },
    },
  };
  const proposal: PlanInput = {
    intent: "improve",
    acceptanceReason: "用户明确将保存改为小写；修订对应保存后断言并保留历史值",
    changes: [
      {
        target: "tags",
        cases: oldCases.map(({ member: _m, ...c }, i) => ({
          ...c,
          fields: i ? { tag: "alpha" } : { ...oldCases[0].fields },
          expected: {
            kind: "commit",
            state: "open",
            fields: { tag: i ? "mixed" : "alpha" },
          },
        })),
      },
    ],
    requirements: [
      {
        quote: upgrade,
        revises: original,
        type: "behavior",
        expectations: [
          { kind: "behavior" },
          { kind: "field", field: "tag", examples: [" Alpha "] },
        ],
      },
    ],
  };
  return { inherited, context, proposal };
}
const fieldScenarios = (draft: ReturnType<typeof compilePlanInput>) =>
  draft.requirements[0].obligations.find((o) => o.kind === "field")!
    .scenarios as { steps: unknown[]; value: string }[];

test("既有字段完整投影可达的覆盖案例，examples 不能筛掉第二次保存", () => {
  const { context, proposal } = fixture();
  const before = structuredClone({ context, proposal });
  const draft = compilePlanInput(proposal, context, sources);
  assert.deepEqual(
    fieldScenarios(draft).map((s) => [s.steps.length, s.value]),
    [
      [1, "alpha"],
      [2, "mixed"],
    ],
  );
  assert.deepEqual({ context, proposal }, before);
});

test("连续修订通过原生引用与继承更新两次保存断言，保留动作、历史及系统保护", () => {
  const { inherited, context, proposal } = fixture();
  const before = structuredClone(inherited);
  const draft = compilePlanInput(proposal, context, sources);
  const compiled = compileReferences(draft, sources, [], workflow, inherited);
  const result = inheritBrowserCases(
    compiled,
    inherited,
    proposal.acceptanceReason,
  );
  assert.deepEqual(result.blockers, []);
  const oldAfter = inherited.browserCases.filter(
    (c) => c.classification === "frozen-business",
  );
  assert.equal(oldAfter.length, 2);
  for (const old of oldAfter) {
    const change = result.changes.find(
      (c) => c.rule === `浏览器案例 ${old.id}`,
    );
    assert.ok(change);
    const after = JSON.parse(change.after);
    assert.deepEqual(
      after.steps.filter((s: { kind: string }) => s.kind === "action"),
      old.steps.filter((s) => s.kind === "action"),
    );
    assert.ok(
      after.steps
        .filter((s: { kind: string }) => s.kind === "field")
        .every((s: { value: string }) => s.value === "mixed"),
    );
  }
  for (const old of inherited.browserCases.filter(
    (c) => c.classification === "system-protection",
  ))
    assert.deepEqual(
      result.browserCases.find((c) => c.id === old.id),
      old,
    );
  const field = compiled.requirements[0].obligations?.find(
    (o) => o.kind === "field",
  );
  assert.ok(field?.kind === "field" && field.history);
  assert.equal(field.history.expected.fields.tag, "Alpha");
  assert.equal(field.history.baseVersion, inherited.baseVersion);
  assert.deepEqual(inherited, before);
});

test("相同覆盖修订缺少原因时仍阻塞，不能静默丢弃旧断言", () => {
  const { inherited, context, proposal } = fixture();
  const compiled = compileReferences(
    compilePlanInput(proposal, context, sources),
    sources,
    [],
    workflow,
    inherited,
  );
  const result = inheritBrowserCases(compiled, inherited, undefined);
  assert.ok(result.blockers.some((b) => b.includes("修订原因")));
  assert.ok(
    result.browserCases.some((c) =>
      c.steps.some((s) => s.kind === "field" && s.value === "miXeD"),
    ),
  );
});

test("既有字段的状态操作前置不可达时仍拒绝，不能跳过覆盖案例", () => {
  const { context, proposal } = fixture();
  const cases = proposal.changes![0].cases!;
  cases[1] = {
    ...cases[1],
    action: "appendTag",
    fields: { tag: "unreachable" },
  };
  assert.throws(
    () => compilePlanInput(proposal, context, sources),
    /前置|无法|可达/,
  );
});

test("覆盖案例中的错误预期保持原样，不能由编译器猜测小写结果", () => {
  const { context, proposal } = fixture();
  proposal.changes![0].cases![1].expected = {
    kind: "commit",
    state: "open",
    fields: { tag: "miXeD" },
  };
  const draft = compilePlanInput(proposal, context, sources);
  assert.ok(
    fieldScenarios(draft).some(
      (s) => s.steps.length === 2 && s.value === "miXeD",
    ),
  );
});

test("显式字段与其他要求携带的宿主投影比较完整更新场景，继续共用同一身份", () => {
  const { inherited, context, proposal } = fixture();
  const hostField: typeof oldField = {
    ...structuredClone(oldField),
    id: "host-tag-field",
    contribution: "tag-detail",
    derivation: { checker: "workspace/1" },
    scenarios: [
      {
        id: "first-save",
        steps: [oldField.scenarios[0].steps[0]],
        value: "Alpha",
      },
    ],
  };
  inherited.requirements.push({
    ...structuredClone(oldRequirement),
    id: "preserve-tags",
    sourceQuote: "保留大小写",
    description: "保留大小写",
    checks: oldCases.map((c) => ({
      checker: "workspace/1",
      caseId: `member:${c.member}:${c.name}`,
    })),
    obligations: [hostField],
  });
  inherited.browserCases.push(...obligationCases(hostField));
  context.files["active-acceptance"].content = JSON.stringify({
    rules: [],
    ...inherited,
  });
  const compiled = compileReferences(
    compilePlanInput(proposal, context, sources),
    sources,
    [],
    workflow,
    inherited,
  );
  const fields = compiled.requirements
    .flatMap((r) => r.obligations ?? [])
    .filter((o) => o.kind === "field" && o.member === "tags");
  assert.equal(fields.length, 2);
  assert.deepEqual([...new Set(fields.map((o) => o.id))], [hostField.id]);
  for (const field of fields) {
    assert.ok(field.kind === "field");
    assert.deepEqual(
      field.scenarios.map((s) => [s.steps.length, s.value]),
      [
        [1, "alpha"],
        [2, "mixed"],
      ],
    );
  }
  const result = inheritBrowserCases(
    compiled,
    inherited,
    proposal.acceptanceReason,
  );
  const after = result.browserCases.filter(
    (c) =>
      c.steps.filter((s) => s.kind === "action" && s.member === "tags")
        .length === 2,
  );
  assert.equal(after.length, 2, "同一两次保存场景仅各有一条新任务和旧任务断言");
});
