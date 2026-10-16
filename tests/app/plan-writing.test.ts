import test from "node:test";
import assert from "node:assert/strict";
import { planningTools } from "../../src/server/planning.js";
import { compileReferences } from "../../src/evolution/references.js";
import { compilePlanInput as compileNativePlanInput } from "../../src/evolution/plan-input.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import { obligationFailure } from "../../src/evolution/acceptance-obligations.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import { DeepSeek } from "../../src/evolution/deepseek.js";

import { targetFixture } from "./planning-fixture.js";
const compilePlanInput = (value: Record<string, unknown>, context: Parameters<typeof compileNativePlanInput>[1], sources: Parameters<typeof compileNativePlanInput>[2]) => compileNativePlanInput(targetFixture(value), context, sources);
const workflow = {
  id: "baseline",
  fields: [],
  actions: [{ id: "complete" }, { id: "reopen" }],
};

test("没有辅助 UI 贡献仍冻结主工作流身份并生成真实浏览器保护，不能退化为空义务", () => {
  const compiled = compileReferences(
    {
      workflowRules: [],
      requirements: [
        {
          id: "preserve",
          description: "保留原工作流界面",
          source: 1,
          sourceQuote: "保留原工作流界面",
          type: "constraint",
          checks: [{ kind: "workflow" }],
          obligations: [{ kind: "preserve-ui" }],
        },
      ],
    },
    [{ id: "request:1", text: "保留原工作流界面" }],
    [
      {
        checker: "workflow/1",
        given: "未完成",
        when: "complete",
        then: "完成",
      },
    ],
    workflow,
    { uiContributions: [] },
  );
  const identity = compiled.requirements[0].obligations.find(
    (o) => o.kind === "ui-identity",
  );
  assert.ok(identity && "workflow" in identity);
  assert.deepEqual(identity.workflow, workflow);
  const tampered = structuredClone(compiled.browserCases);
  for (const c of tampered)
    for (const s of c.steps)
      if (s.kind === "ui-identity" && s.workflow) s.workflow.actions = [];
  assert.ok(obligationFailure(compiled.requirements[0], tampered).length);
  assert.throws(
    () =>
      parseBrowserCases([
        {
          id: "empty",
          task: "new",
          steps: [{ kind: "ui-identity", contributions: [] }],
        },
      ]),
    /快照为空/,
  );

  assert.ok(compiled.browserCases.length >= 2);
  assert.ok(
    compiled.browserCases.every((c) =>
      c.steps.some((s) => s.kind === "ui-identity"),
    ),
  );
});

test("公开计划写入不再接受手工索引、资料引用、能力绑定或浏览器步骤", () => {
  const schema = planningTools.find(
    (t) => t.name === "propose_plan",
  )!.parameters;
  const serialized = JSON.stringify(schema);
  for (const name of [
    "checks",
    "index",
    "source",
    "sourceRevision",
    "requiredCapabilities",
    "capabilityChanges",
    "writableScope",
    "steps",
    "scenarios",
  ])
    assert.ok(!serialized.includes('"' + name + '":'), `模型仍须维护 ${name}`);
});

test("模型传输直接发送业务契约，正确输出无需供应商 strict 或可选字段标记", async () => {
  let requests = 0;
  const tools = [
    {
      name: "read_guides",
      description: "读取",
      parameters: {
        type: "object",
        properties: {
          refs: { type: "array", items: { type: "string" } },
          knownHashes: {
            type: "object",
            additionalProperties: { type: "string" },
          },
        },
        required: ["refs"],
        additionalProperties: false,
      },
    },
  ];
  const reply = await new DeepSeek("synthetic-key", async (url, init) => {
    requests++;
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.notEqual(body.tools[0].function.strict, true);
    assert.deepEqual(body.tools[0].function.parameters, tools[0].parameters);
    return new Response(
      JSON.stringify({
        model: "deepseek-flash",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call:1",
                  type: "function",
                  function: {
                    name: "read_guides",
                    arguments: JSON.stringify({
                      refs: ["guide:1"],
                      knownHashes: { "guide:1": "digest" },
                    }),
                  },
                },
              ],
            },
          },
        ],
        usage: { total_tokens: 7 },
      }),
    );
  }).generate(
    { history: [], instruction: "读取", tools },
    new AbortController().signal,
  );
  assert.equal(requests, 1);
  assert.equal(reply.protocolErrors, undefined);
  assert.deepEqual(reply.calls[0].args, {
    refs: ["guide:1"],
    knownHashes: { "guide:1": "digest" },
  });
  assert.deepEqual(reply.usage, { total_tokens: 7 });
});

test("业务原文、成员案例、字段操作和能力引用由宿主绑定；无需手工命名仍继承旧触发案例身份", () => {
  const original = {
    name: "已接受案例",
    member: "panel",
    state: "open",
    fields: {},
    action: "markNote",
    input: {},
    expected: { kind: "commit", state: "open", fields: { noteMark: "ok" } },
  };
  const context = {
    pluginId: "baseline",
    members: [{ pluginId: "panel", role: "auxiliary" as const, versionId: "panel", enabled: true }],
    files: {
      "active-contract": {
        content: JSON.stringify({
          id: "baseline",
          initialState: "open",
          actions: [{ id: "complete" }, { id: "reopen" }],
        }),
        hash: "contract",
      },
      "active-acceptance": {
        content: JSON.stringify({ rules: [], memberCases: [original] }),
        hash: "accepted",
      },
    },
    capabilities: [],
  };
  const quote = "旧标记保留，新操作写入 reviewed 并在详情显示";
  const input = {
    summary: quote,
    workflow: null,
    members: [
      {
        operation: "upgrade",
        pluginId: "panel",
        cases: [
          {
            ...original,
            member: undefined,
            name: "模型换名",
            expected: {
              kind: "commit",
              state: "open",
              fields: { noteMark: "reviewed" },
            },
          },
        ],
      },
    ],
    requirements: [
      {
        description: quote,
        quote,
        type: "interface",
        expectations: [
          { kind: "field", field: "noteMark" },
          { kind: "history", field: "noteMark" },
        ],
      },
    ],
  };
  delete input.members[0].cases[0].member;

  const draft = compilePlanInput(input, context, [
    { id: "trusted:1", text: quote },
  ]);
  assert.equal(draft.memberCases![0].name, "已接受案例");
  assert.equal(draft.requirements[0].source, 1);
  assert.ok(draft.requirements[0].checks.some((c) => c.kind === "member"));
  const field = draft.requirements[0].obligations.find(
    (o) => o.kind === "field",
  )!;
  assert.deepEqual(field.scenarios, [
    {
      steps: [{ kind: "action", action: "markNote", input: {} }],
      value: "reviewed",
    },
  ]);
  assert.deepEqual(draft.writableScope, []);
  assert.ok(
    draft.capabilityChanges.some(
      (c) =>
        c.capability === "command.register" && c.provider === "member:panel",
    ),
  );
  const compiled = compileReferences(
    draft,
    [{ id: "trusted:1", text: quote }],
    [],
    workflow,
    {
      baseVersion: "a".repeat(64),
      memberCases: [original as MemberAcceptanceCase],
      uiContributions: [
        {
          providerId: "panel",
          id: "note-panel",
          fields: [{ key: "noteMark" }],
          actions: [{ commandId: "markNote" }],
        },
      ],
    },
  );
  const history = compiled.requirements[0].obligations.find(
    (o) => o.kind === "history",
  );
  assert.ok(history?.kind === "history");
  assert.equal(history.history.expected.fields.noteMark, "ok");
});

test("伪造索引或引用、歧义来源、无操作字段及超大字段规则均拒绝，不能补造覆盖或分配巨大样本", () => {
  const quote = "复盘";
  const context = {
    pluginId: "baseline",
    members: [{ pluginId: "panel", role: "auxiliary" as const, versionId: "panel", enabled: true }],
    files: {
      "active-contract": {
        content: JSON.stringify({
          id: "baseline",
          initialState: "open",
          actions: [{ id: "complete" }],
        }),
        hash: "c",
      },
      "active-acceptance": { content: "{}", hash: "a" },
    },
    capabilities: [],
  };
  const input = {
    summary: quote,
    workflow: null,
    members: [],
    requirements: [
      {
        description: quote,
        quote,
        type: "behavior",
        expectations: [{ kind: "behavior" }],
      },
    ],
  };
  const sources = [{ id: "1", text: quote }];
  assert.throws(
    () =>
      compilePlanInput(
        { ...input, requiredCapabilities: [] },
        context,
        sources,
      ),
    /业务计划契约/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        {
          ...input,
          requirements: [
            {
              ...input.requirements[0],
              checks: [{ kind: "member", index: 1 }],
            },
          ],
        },
        context,
        sources,
      ),
    /业务计划契约/,
  );
  assert.throws(
    () =>
      compilePlanInput(input, context, [
        { id: "1", text: "填写复盘" },
        { id: "2", text: "不再需要复盘" },
      ]),
    /多个修订/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        {
          ...input,
          requirements: [{ ...input.requirements[0], quote: "伪造" }],
        },
        context,
        sources,
      ),
    /原文引用不存在/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        {
          ...input,
          requirements: [
            {
              ...input.requirements[0],
              expectations: [{ kind: "field", field: "unknown" }],
            },
          ],
        },
        context,
        sources,
      ),
    /没有可推导/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        {
          ...input,
          workflow: {
            modules: ["workflow"],
            fields: [
              {
                key: "review",
                label: "复盘",
                required: true,
                minLength: 1e9,
                maxLength: 1e9,
              },
            ],
          },
        },
        context,
        sources,
      ),
    /业务计划契约/,
  );
});

test("主工作流扩展字段的成功操作也由宿主从 business-actions 案例推导，不丢失原有能力", () => {
  const quote = "计数后显示次数";
  const context = {
    pluginId: "baseline",
    members: [{ pluginId: "panel", role: "auxiliary" as const, versionId: "panel", enabled: true }],
    files: {
      "active-contract": {
        content: JSON.stringify({
          id: "baseline",
          initialState: "open",
          actions: [{ id: "complete" }, { id: "reopen" }],
        }),
        hash: "c",
      },
      "active-acceptance": { content: "{}", hash: "a" },
    },
    capabilities: [],
  };
  const draft = compilePlanInput(
    {
      summary: quote,
      workflow: {
        modules: ["entry"],
        fields: [],
        actions: [{ id: "increment", label: "计数", from: ["open"] }],
        actionFields: [{ key: "count", label: "次数", type: "text" }],
        cases: [
          {
            name: "计数",
            state: "open",
            fields: {},
            action: "increment",
            input: {},
            expected: { kind: "commit", state: "open", fields: { count: "1" } },
          },
        ],
      },
      members: [],
      requirements: [
        {
          description: quote,
          quote,
          type: "interface",
          expectations: [{ kind: "field", field: "count" }],
        },
      ],
    },
    context,
    [{ id: "source:1", text: quote }],
  );
  assert.deepEqual(draft.requirements[0].obligations[0].scenarios, [
    { steps: [{ kind: "action", action: "increment", input: {} }], value: "1" },
  ]);
  assert.ok(draft.requirements[0].checks.some((c) => c.kind === "action"));
});

test("JSON 业务资产只声明名称，由宿主生成授权路径；越界、受保护及重复资产不能冻结", () => {
  const quote = "保存业务元数据";
  const context = {
    pluginId: "baseline",
    members: [{ pluginId: "panel", role: "auxiliary" as const, versionId: "panel", enabled: true }],
    files: {
      "active-contract": {
        content: JSON.stringify({
          id: "baseline",
          initialState: "open",
          actions: [{ id: "complete" }],
        }),
        hash: "c",
      },
      "active-acceptance": { content: "{}", hash: "a" },
    },
    capabilities: [],
  };
  const input = {
    summary: quote,
    workflow: { modules: ["entry"], data: ["metadata"], fields: [] },
    members: [],
    requirements: [
      {
        description: quote,
        quote,
        type: "behavior",
        expectations: [{ kind: "behavior" }],
      },
    ],
  };
  const sources = [{ id: "source:1", text: quote }];
  const compiled = compilePlanInput(input, context, sources);
  assert.ok(compiled.writableScope.includes("business/metadata.json"));
  assert.ok(
    !compiled.capabilityChanges.some((c) => c.provider.endsWith(".json")),
  );
  for (const data of [
    ["../formal"],
    ["config"],
    ["compatibility"],
    ["metadata", "metadata"],
  ])
    assert.throws(
      () =>
        compilePlanInput(
          { ...input, workflow: { ...input.workflow, data } },
          context,
          sources,
        ),
      /业务资产|重复/,
    );
});
