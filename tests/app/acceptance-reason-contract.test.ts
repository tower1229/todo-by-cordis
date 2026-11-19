import test from "node:test";
import assert from "node:assert/strict";
import { replyProblems } from "../../src/evolution/model-protocol.js";
import { planInputSchema } from "../../src/evolution/plan-input.js";
import { hash } from "../../src/release/storage.js";
import type { Requirement } from "../../src/shared/assistant.js";
import type { ModelRequest, ModelReply } from "../../src/evolution/driver.js";
import {
  acceptanceSurface,
  requirementAcceptanceChanged,
  requirementRevisionBlockers,
} from "../../src/evolution/acceptance-surface.js";

const proposeTool = {
  name: "propose_plan",
  description: "test",
  parameters: planInputSchema,
};

function replyWithArgs(args: Record<string, unknown>): {
  request: ModelRequest;
  reply: ModelReply;
} {
  const request: ModelRequest = {
    instruction: "合成",
    history: [],
    tools: [proposeTool],
  };
  const reply: ModelReply = {
    text: "",
    history: [],
    calls: [{ id: "c1", name: "propose_plan", args }],
    usage: undefined,
    raw: {},
  };
  return { request, reply };
}

test("真实 planInputSchema：requirements[].acceptanceReason 为未授权字段", () => {
  const { request, reply } = replyWithArgs({
    requirements: [
      {
        quote: "请改进完成流程：完成前必须填写复盘",
        type: "behavior",
        expectations: [{ kind: "behavior" }],
        acceptanceReason: "误放在需求项内",
      },
    ],
  });
  const problems = replyProblems(request, reply).join("；");
  assert.match(problems, /requirements\[0\]\.acceptanceReason: 未授权字段/);
});

test("真实 planInputSchema：plan 根 acceptanceReason 合法", () => {
  const { request, reply } = replyWithArgs({
    acceptanceReason: "用户新增必填复盘，兼容保留标签与计数",
    requirements: [
      {
        quote: "请改进完成流程：完成前必须填写复盘",
        type: "behavior",
        expectations: [{ kind: "behavior" }],
      },
    ],
  });
  assert.deepEqual(replyProblems(request, reply), []);
});

test("改变已接受需求业务表面：缺 plan 根原因 → 修订 blocker；有原因 → 无 blocker", () => {
  const oldReq = {
    id: "requirement-review",
    description: "旧复盘要求",
    sourceRevision: "request:3",
    sourceQuote: "旧原文",
    type: "behavior" as const,
    checks: [],
    obligations: [
      {
        version: 1 as const,
        id: "o1",
        kind: "assertion" as const,
        steps: [],
        expected: { kind: "task" as const },
      },
    ],
  };
  const nextReq = {
    ...oldReq,
    sourceQuote: "请改进完成流程：完成前必须填写复盘",
    description: "新复盘要求",
    obligations: [
      {
        version: 1 as const,
        id: "o2",
        kind: "field" as const,
        member: "workflow",
        field: "review",
        contribution: undefined,
        initial: { kind: "absent" as const },
        initialOrigin: "requirement" as const,
        scenarios: [],
      },
    ],
  };
  assert.equal(
    requirementAcceptanceChanged(oldReq as never, nextReq as never),
    true,
  );
  assert.match(
    requirementRevisionBlockers(
      [oldReq as never],
      [nextReq as never],
      undefined,
    ).join("；"),
    /既有需求 requirement-review 改变，须说明验收修订原因/,
  );
  assert.deepEqual(
    requirementRevisionBlockers(
      [oldReq as never],
      [nextReq as never],
      "用户新增必填复盘，兼容保留标签与计数",
    ),
    [],
  );
});

test("宿主投影 churn：full hash 不等但 acceptanceSurface 相等 → 无修订 blocker", () => {
  const frozen: Requirement = {
    id: "requirement-tags",
    description: "标签要求",
    sourceRevision: "request:1",
    sourceQuote: "支持标签",
    type: "behavior",
    checks: [{ checker: "browser/1", caseId: "old-case" }],
    obligations: [
      {
        version: 1,
        id: "assert-done",
        kind: "assertion",
        steps: [{ kind: "action", member: "workflow", action: "complete" }],
        expected: {
          kind: "action-visible",
          member: "counter",
          action: "increment",
          visible: false,
        },
      },
    ],
  };
  const afterHost: Requirement = {
    ...frozen,
    checks: [
      { checker: "browser/1", caseId: "new-case" },
      { checker: "workflow/1", caseId: "workflow/1:1" },
    ],
    obligations: [
      {
        version: 1,
        id: "workflow-input-x",
        kind: "workflow-input",
        rules: [
          {
            key: "review",
            label: "review",
            required: true,
            minLength: 1,
            maxLength: 5000,
          },
        ],
      },
      {
        version: 1,
        id: "host-field",
        kind: "field",
        member: "workflow",
        field: "review",
        initial: { kind: "absent" },
        initialOrigin: "host",
        scenarios: [],
      },
      {
        version: 1,
        id: "assert-done",
        kind: "assertion",
        availability: { origin: "host", state: "done" },
        steps: [
          {
            kind: "action",
            member: "workflow",
            action: "complete",
            input: { review: "验" },
          },
        ],
        expected: {
          kind: "action-visible",
          member: "counter",
          action: "increment",
          visible: false,
        },
      },
    ],
  };
  assert.notEqual(hash(frozen), hash(afterHost), "full hash should churn");
  assert.deepEqual(acceptanceSurface(frozen), acceptanceSurface(afterHost));
  assert.equal(requirementAcceptanceChanged(frozen, afterHost), false);
  assert.deepEqual(
    requirementRevisionBlockers([frozen], [afterHost], undefined),
    [],
  );
});
