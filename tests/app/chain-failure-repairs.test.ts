import test from "node:test";
import assert from "node:assert/strict";
import { recordReview } from "../../src/evolution/review.js";
import { protocolCorrectionExhausted } from "../../src/evolution/model-protocol.js";
import { transportTimeoutRetryable } from "../../src/evolution/transport-failure.js";
import { planningStructureTerminal } from "../../src/evolution/historical-preparation.js";
import type { RequirementReview } from "../../src/shared/assistant.js";
import type { ReviewLedger } from "../../src/shared/change-spec.js";

const quote = "请停用标签插件，保留已有标签数据和计数、复盘功能，之后可以重新启用。";
const target = { subject: "requirement-tags", aspect: "visibility" };
const issue = (
  kind: "conflict" | "omission" | "extra-constraint",
  stance: "required" | "forbidden",
  detail: string,
): RequirementReview["issues"][number] => ({
  kind,
  sourceRevision: "run:1",
  sourceQuote: quote,
  detail,
  target,
  stance,
});

test("停用标签时，禁止当前可见与要求改正遗漏是同一方向，不构成相反立场", () => {
  const ledger: ReviewLedger = { version: 2, findings: [], attempts: [] };
  const review: RequirementReview = {
    reviewedIds: ["requirement-tags"],
    issues: [
      issue("conflict", "forbidden", "停用期间仍把 setTags 当作可用动作，标签字段不应继续显示"),
      issue("omission", "required", "来源要求停用后标签不可见，计划仍把初始值显示为空"),
    ],
  };
  const result = recordReview(ledger, review, 1, "spec-disable");
  assert.equal(result.halt, false);
  assert.equal(result.blockers.some((b) => b.includes("相反立场")), false);
  assert.equal(ledger.findings.length, 2);
  assert.ok(ledger.findings.every((f) => f.status === "open"));
});

test("同一种问题的要求与禁止仍然停止", () => {
  const ledger: ReviewLedger = { version: 2, findings: [], attempts: [] };
  const result = recordReview(
    ledger,
    {
      reviewedIds: [],
      issues: [
        issue("conflict", "forbidden", "不应接受 setTags"),
        issue("conflict", "required", "必须接受 setTags"),
      ],
    },
    1,
    "spec-opposite",
  );
  assert.equal(result.halt, true);
  assert.ok(result.blockers.some((b) => b.includes("相反立场")));
});

test("相同协议缺陷停止，不同缺陷在调用上限内还可以纠正两次", () => {
  const first = ["tool:propose_plan：$o.defaults[4].description: 未授权字段"];
  const second = ["tool:propose_plan：Expected ',' or ']' after array element"];
  assert.equal(
    protocolCorrectionExhausted({ attempt: 0, calls: 2, callLimit: 12, problems: first }),
    false,
  );
  assert.equal(
    protocolCorrectionExhausted({
      attempt: 0,
      calls: 3,
      callLimit: 12,
      previousProblems: first,
      problems: first,
    }),
    true,
  );
  assert.equal(
    protocolCorrectionExhausted({
      attempt: 1,
      calls: 3,
      callLimit: 12,
      previousProblems: first,
      problems: second,
    }),
    false,
  );
  assert.equal(
    protocolCorrectionExhausted({
      attempt: 2,
      calls: 4,
      callLimit: 12,
      previousProblems: second,
      problems: first,
    }),
    true,
  );
  assert.equal(
    protocolCorrectionExhausted({ attempt: 0, calls: 12, callLimit: 12, problems: second }),
    true,
  );
});

test("传输超时只在原调用上限内重试一次", () => {
  assert.equal(transportTimeoutRetryable({ kind: "timeout", attempt: 0, calls: 8, callLimit: 12 }), true);
  assert.equal(transportTimeoutRetryable({ kind: "timeout", attempt: 1, calls: 9, callLimit: 12 }), false);
  assert.equal(transportTimeoutRetryable({ kind: "connection", attempt: 0, calls: 8, callLimit: 12 }), false);
  assert.equal(transportTimeoutRetryable({ kind: "timeout", attempt: 0, calls: 12, callLimit: 12 }), false);
});

test("历史准备不唯一仍是计划缺陷，但相同调用上限内的第一次可以改正", () => {
  assert.equal(
    planningStructureTerminal({ historical: true, rejectionSeen: false, calls: 4, callLimit: 12 }),
    false,
  );
  assert.equal(
    planningStructureTerminal({ historical: true, rejectionSeen: true, calls: 5, callLimit: 12 }),
    true,
  );
  assert.equal(
    planningStructureTerminal({ historical: false, rejectionSeen: false, calls: 12, callLimit: 12 }),
    true,
  );
});

test("浏览器案例超限或悬空引用第一次就是结构失败，不能靠再规划一轮躲开", () => {
  assert.equal(
    planningStructureTerminal({
      historical: false,
      structural: true,
      rejectionSeen: false,
      calls: 2,
      callLimit: 12,
    }),
    true,
  );
  assert.equal(
    planningStructureTerminal({
      historical: false,
      structural: false,
      rejectionSeen: false,
      calls: 2,
      callLimit: 12,
    }),
    false,
  );
});
