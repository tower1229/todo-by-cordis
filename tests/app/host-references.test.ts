import test from "node:test";
import assert from "node:assert/strict";
import { compileReferences } from "../../src/evolution/references.js";
import { coverage } from "../../src/server/requirement-coverage.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";

const sources = [{ id: "host-run:1", text: "显示复盘，其他行为不变" }];
const cases = [
  { checker: "workflow/1", given: "未完成", when: "complete", then: "完成" },
];
const workflow = {
  id: "default",
  actions: [{ id: "complete" }, { id: "reopen" }],
};
const draft = () => ({
  workflowRules: [{ key: "review" }],
  browserCases: [
    {
      id: "display",
      task: "new",
      steps: [
        { kind: "action", action: "complete", input: { review: "复盘" } },
        { kind: "field", field: "review", value: "复盘" },
      ],
    },
  ],
  requirements: [
    {
      id: "display",
      description: "显示复盘",
      source: 1,
      sourceQuote: "显示复盘",
      type: "interface",
      checks: [{ kind: "browser", index: 1 }],
      obligations: [
        {
          kind: "field",
          field: "review",
          initial: { kind: "absent" },
          scenarios: [
            {
              steps: [
                {
                  kind: "action",
                  action: "complete",
                  input: { review: "复盘" },
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

test("来源、检查器案例与浏览器所有者由宿主从结构化引用绑定", () => {
  const compiled = compileReferences(draft(), sources, cases, workflow);
  const requirement = compiled.requirements[0];
  assert.equal(requirement.sourceRevision, sources[0].id);
  assert.deepEqual(
    requirement.checks.map((c) => c.caseId),
    compiled.browserCases.map((c) => c.id),
  );
  assert.match(compiled.browserCases[0].id, /^browser-[a-f0-9]{24}$/);
  assert.equal(compiled.browserCases[0].steps[0].member, "workflow");
  assert.equal(compiled.browserCases[0].steps[1].member, "workflow");
  assert.equal(compiled.browserCases[0].steps[1].contribution, "workflow");
});

test("伪造引用、来源、身份歧义仍阻塞，后端引用仍不能覆盖界面要求", () => {
  const missing = draft();
  missing.requirements[0].checks[0].index = 99;
  assert.throws(
    () => compileReferences(missing, sources, cases, workflow),
    /不存在/,
  );
  const source = draft();
  source.requirements[0].source = 99;
  assert.throws(
    () => compileReferences(source, sources, cases, workflow),
    /不存在/,
  );
  const forged = {
    ...draft(),
    requirements: [{ ...draft().requirements[0], sourceRevision: "forged" }],
  };
  assert.throws(
    () => compileReferences(forged, sources, cases, workflow),
    /派生字段/,
  );
  const ambiguous = {
    ...draft(),
    memberCases: [{ member: "panel", action: "complete", name: "collision" }],
  };
  assert.throws(
    () => compileReferences(ambiguous, sources, cases, workflow),
    /不唯一/,
  );
  const backend = draft();
  backend.requirements[0].checks = [{ kind: "workflow", index: 1 }];
  Object.assign(backend.requirements[0], {
    obligations: [{ kind: "backend" }],
  });
  const compiled = compileReferences(backend, sources, cases, workflow);
  const plan = { ...compiled, cases } as unknown as InvestigatedPlan;
  assert.ok(
    coverage(plan, sources, ["workflow/1", "browser/1"])[0].reasons.some((r) =>
      r.includes("界面"),
    ),
  );
});

test("宿主可绑定完整 workflow 检查器，既有浏览器案例修订保留身份", () => {
  const d = draft();
  const all = {
    ...d,
    requirements: [
      {
        ...d.requirements[0],
        type: "behavior",
        checks: [{ kind: "workflow" }],
        obligations: [{ kind: "backend" }],
      },
    ],
  };
  assert.deepEqual(
    compileReferences(all, sources, cases, workflow).requirements[0].checks,
    [{ checker: "workflow/1", caseId: "workflow/1:1" }],
  );
  const first = compileReferences(d, sources, cases, workflow);
  const inherited = first.browserCases as unknown as NonNullable<
    InvestigatedPlan["browserCases"]
  >;
  const revision = draft();
  revision.browserCases[0].id = first.browserCases[0].id as string;
  assert.equal(
    compileReferences(revision, sources, cases, workflow, {
      browserCases: inherited,
    }).browserCases[0].id,
    first.browserCases[0].id,
  );
});

test("已有 UI 贡献身份从宿主基线冻结，不能靠候选改名后重新匹配绕过", () => {
  const input = {
    workflowRules: [],
    memberCases: [
      {
        member: "panel",
        name: "mark",
        action: "markNote",
        expected: { fields: { noteMark: "reviewed" } },
      },
    ],
    browserCases: [
      {
        id: "display",
        task: "new",
        steps: [{ kind: "field", field: "noteMark", value: "reviewed" }],
      },
    ],
    requirements: [],
  };
  const baseline = {
    uiContributions: [
      {
        id: "note-panel",
        providerId: "panel",
        fields: [{ key: "noteMark" }],
        actions: [{ commandId: "markNote" }],
      },
    ],
  };
  const compiled = compileReferences(input, sources, cases, workflow, baseline);
  assert.equal(compiled.browserCases[0].steps[0].contribution, "note-panel");
  assert.throws(
    () =>
      compileReferences(input, sources, cases, workflow, {
        uiContributions: [
          ...baseline.uiContributions,
          { ...baseline.uiContributions[0], id: "duplicate" },
        ],
      }),
    /不唯一/,
  );
});

test("宿主编译提前拒绝原生必填校验无法提交的浏览器输入，保留可触发后端错误的空白输入", () => {
  const step: Record<string, unknown> = {kind: "action", action: "complete", input: {}};
  const input = {
    ...draft(),
    workflowRules: [{ key: "review", required: true }],
    browserCases: [{id: "required", task: "new", steps: [step]}],
  };
  assert.throws(
    () => compileReferences(input, sources, cases, workflow),
    /原生必填校验阻止/,
  );
  step.input = { review: "" };
  assert.throws(
    () => compileReferences(input, sources, cases, workflow),
    /原生必填校验阻止/,
  );
  step.input = { review: "   " };
  assert.doesNotThrow(() => compileReferences(input, sources, cases, workflow));
  step.action = "reopen";
  step.input = {};
  assert.doesNotThrow(() => compileReferences(input, sources, cases, workflow));
});

test("任务属性断言绑定宿主合成基线及前面编辑，不接受模型猜测初始名称", () => {
  const input = {...draft(), browserCases: [{id: "task", task: "new", steps: [
    {kind: "task"},
    {kind: "edit", title: " 新标题 ", description: " 原样备注 "},
    {kind: "task"},
  ]}]};
  const steps = compileReferences(input, sources, cases, workflow).browserCases[0].steps;
  assert.deepEqual(steps[0], {kind: "task"});
  assert.deepEqual(steps[2], {kind: "task", title: "新标题", description: " 原样备注 "});
  assert.throws(() => compileReferences({...input, browserCases: [{id: "bad", task: "new", steps: [
    {kind: "task", title: "模型猜测的任务名", description: ""},
  ]}]}, sources, cases, workflow), /不得提交手工期望/);
});
