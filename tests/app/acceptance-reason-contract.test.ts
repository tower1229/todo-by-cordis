import test from "node:test";
import assert from "node:assert/strict";
import { replyProblems } from "../../src/evolution/model-protocol.js";
import { planInputSchema } from "../../src/evolution/plan-input.js";
import { hash } from "../../src/release/storage.js";
import type { Requirement } from "../../src/shared/assistant.js";
import type { ModelRequest, ModelReply } from "../../src/evolution/driver.js";

/** Same gate as evolution.ts when an accepted requirement hash changes. */
function requirementRevisionBlockers(
  inherited: Requirement[],
  next: Requirement[],
  acceptanceReason: unknown,
) {
  const blockers: string[] = [];
  for (const old of inherited) {
    const replacement = next.find((item) => item.id === old.id);
    if (!replacement || hash(replacement) === hash(old)) continue;
    if (typeof acceptanceReason !== "string" || !acceptanceReason.trim())
      blockers.push(`既有需求 ${old.id} 改变，须说明验收修订原因`);
  }
  return blockers;
}

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

test("改变已接受需求：缺 plan 根原因 → 修订 blocker；有原因 → 无 blocker", () => {
  const oldReq = {
    id: "requirement-review",
    description: "旧复盘要求",
    sourceRevision: "request:3",
    sourceQuote: "旧原文",
    type: "behavior" as const,
    checks: [],
    obligations: [{ version: 1 as const, id: "o1", kind: "behavior" as const }],
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
  assert.match(
    requirementRevisionBlockers([oldReq as never], [nextReq as never], undefined).join(
      "；",
    ),
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
