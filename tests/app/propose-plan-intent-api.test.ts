import test from "node:test";
import assert from "node:assert/strict";
import { compilePlanInput } from "../../src/evolution/plan-input.js";
import { compileReferences } from "../../src/evolution/references.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";

/**
 * Intent API: model proposes business intent; host owns inventory.
 * Enable/disable and field-rule changes must not require model-authored browserCases.
 */

const workflowCases = [
  {
    given: "未完成任务",
    when: "完成",
    then: "进入已完成",
    checker: "workflow/1",
  },
];

function workflowContext(rules: unknown[] = []) {
  return {
    pluginId: "default",
    members: [
      {
        pluginId: "default",
        role: "workflow" as const,
        versionId: "wf",
        enabled: true,
      },
      {
        pluginId: "panel",
        role: "auxiliary" as const,
        versionId: "panel-v",
        enabled: true,
      },
    ],
    capabilities: [],
    files: {
      "active-contract": {
        hash: "c",
        content: JSON.stringify({
          id: "default",
          name: "默认",
          version: "1",
          initialState: "open",
          fields: [{ key: "review", label: "复盘" }],
          states: {
            open: { label: "未完成", category: "open" },
            done: { label: "已完成", category: "done" },
          },
          actions: [
            { id: "complete", label: "完成", from: ["open"] },
            { id: "reopen", label: "重新打开", from: ["done"] },
          ],
        }),
      },
      "active-acceptance": {
        hash: "a",
        content: JSON.stringify({
          rules,
          requirements: [],
          memberCases: [],
          browserCases: [],
        }),
      },
    },
  };
}

test("启停意图：仅 target+enabled；uses/defaults 拒绝；无 browserCases 产出", () => {
  const quote = "请停用面板插件，保留数据";
  const sources = [{ id: "request:1", text: quote }];
  const ctx = workflowContext();
  const draft = compilePlanInput(
    {
      summary: quote,
      changes: [{ target: "panel", enabled: false }],
      acceptanceReason: "停用面板，数据与版本由宿主保留",
      requirements: [
        {
          quote,
          type: "behavior",
          expectations: [{ kind: "behavior" }],
        },
      ],
    },
    ctx,
    sources,
  );
  assert.deepEqual(draft.memberEnabled, { pluginId: "panel", enabled: false });
  assert.equal("browserCases" in draft, false);
  assert.throws(
    () =>
      compilePlanInput(
        {
          summary: quote,
          changes: [{ target: "panel", enabled: false }],
          uses: [{ member: "panel", feature: "commands" }],
          requirements: [
            {
              quote,
              type: "behavior",
              expectations: [{ kind: "behavior" }],
            },
          ],
        },
        ctx,
        sources,
      ),
    /uses 或 defaults/,
  );
});

test("辅助 upgrade 可省略 cases：宿主继承历史 memberCases，不产出 browserCases", () => {
  const quote = "再升级面板，行为保持";
  const sources = [{ id: "request:1", text: quote }];
  const inheritedCase = {
    name: "面板标记",
    member: "panel",
    state: "open",
    fields: {},
    action: "markNote",
    input: {},
    expected: { kind: "commit" as const, state: "open", fields: { note: "x" } },
  };
  const rejectCase = {
    name: "面板拒绝",
    member: "panel",
    state: "open",
    fields: {},
    action: "markNote",
    input: { note: "" },
    expected: { kind: "reject" as const },
  };
  const ctx = {
    ...workflowContext(),
    files: {
      ...workflowContext().files,
      "active-acceptance": {
        hash: "a",
        content: JSON.stringify({
          rules: [],
          requirements: [],
          memberCases: [inheritedCase, rejectCase],
          browserCases: [],
        }),
      },
    },
    capabilities: [
      {
        id: "ui.slot:panel",
        interfaceId: "ui.slot",
        providerId: "panel",
        status: "active" as const,
        count: 1,
        ready: true,
        artifactVersion: "panel-v",
        providerVersion: "panel-v",
        contractVersion: "extensions/1",
        installed: true,
        enabled: true,
        healthy: true,
        inUse: true,
        authorized: true,
        dependencies: [],
        checkerCoverage: [],
        purpose: "",
        limitations: "",
      },
    ],
  };
  const draft = compilePlanInput(
    {
      summary: quote,
      changes: [{ target: "panel", features: ["detail"] }],
      requirements: [
        {
          quote,
          type: "compatibility",
          expectations: [{ kind: "behavior" }],
        },
      ],
    },
    ctx,
    sources,
  );
  assert.deepEqual(draft.memberUpgrades, [{ pluginId: "panel" }]);
  assert.equal(draft.memberCases, undefined);
  assert.equal("browserCases" in draft, false);
});

test("字段意图：无 changes.cases 时宿主仍编译出 browserCases 清单", () => {
  const quote =
    "完成前必须填写复盘，去掉首尾空格后至少一个字，最多五千字；重新打开保留复盘。";
  const sources = [{ id: "request:1", text: quote }];
  const ctx = workflowContext();
  const draft = compilePlanInput(
    {
      summary: "新增必填复盘",
      intent: "improve",
      acceptanceReason: "用户新增必填复盘字段",
      changes: [
        {
          target: "workflow",
          fields: [
            {
              key: "review",
              label: "复盘",
              required: true,
              minLength: 1,
              maxLength: 5000,
            },
          ],
          actionFields: [{ key: "review", label: "复盘", type: "text" }],
        },
      ],
      requirements: [
        {
          quote,
          type: "behavior",
          expectations: [
            { kind: "behavior" },
            {
              kind: "field",
              field: "review",
              examples: ["  本周复盘  ", "复"],
            },
          ],
        },
      ],
    },
    ctx,
    sources,
  );
  assert.equal(draft.extensions?.cases?.length ?? 0, 0);
  assert.equal("browserCases" in draft, false);
  const compiled = compileReferences(
    { ...draft, memberCases: draft.memberCases ?? [], browserCases: undefined },
    sources,
    workflowCases,
    {
      id: "default",
      actions: [{ id: "complete" }, { id: "reopen" }],
      fields: [{ key: "review" }],
    },
    {
      memberCases: [],
      requirements: [],
      browserCases: [],
      baseVersion: "base",
    },
  );
  assert.ok(compiled.browserCases.length > 0);
  assert.ok(compiled.browserCases.length <= 30);
  assert.doesNotThrow(() => parseBrowserCases(compiled.browserCases));
  assert.ok(
    compiled.browserCases.some((c) =>
      JSON.stringify(c.steps).includes('"review"'),
    ),
  );
});
