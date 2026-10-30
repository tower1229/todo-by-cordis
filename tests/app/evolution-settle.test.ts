import test from "node:test";
import assert from "node:assert/strict";
import { settleEvolution } from "./evolution-adapter.js";
import type { AssistantRun, AssistantSnapshot } from "../../src/shared/assistant.js";

function run(status: "planning" | "cancelled" | "failed"): AssistantRun {
  const base = { id: "bounded-fixture", request: "synthetic", updatedAt: "2026-10-21T00:00:00Z",
    budget: { callsUsed: 1, callsRemaining: 11, candidatesRemaining: 3, millisecondsRemaining: 120_000 } };
  return status === "failed" ? { ...base, status, message: "synthetic host failure", steps: [] }
    : { ...base, status };
}

test("等待指定终态不能把其他终态当作成功，即使调用方没有额外断言", async () => {
  const port = { async observe(): Promise<AssistantSnapshot> { return { availability: "ready", run: run("failed") }; } };
  await assert.rejects(settleEvolution(port, "succeeded"), /unexpected host terminal/);
});

test("固定六十秒过去后，仍在宿主预算内的工作须继续等待且保留运行身份", async (t) => {
  let now = 0, calls = 0;
  t.mock.method(Date, "now", () => now);
  const port = { async observe(): Promise<AssistantSnapshot> {
    if (++calls === 2) now = 61_000;
    return { availability: "ready", run: run(calls < 3 ? "planning" : "cancelled") };
  } };
  const observed = await settleEvolution(port, "cancelled");
  assert.equal(observed.status, "cancelled");
  assert.equal(observed.id, "bounded-fixture");
  assert.equal(calls, 3);
});

test("未指定期望终态时仍返回真实失败，不能补造通过记录", async () => {
  const actual = run("failed");
  const port = { async observe(): Promise<AssistantSnapshot> { return { availability: "ready", run: actual }; } };
  assert.equal(await settleEvolution(port), actual);
});

test("意外终态保留原生预检差异，避免临时库清理后只剩笼统阻塞", async () => {
  const detail = JSON.stringify({
    reason: "admission-invalid",
    checks: { factsAndSourcesBound: false },
    changedFacts: [{ id: "host-fact:effect:online-schedule", frozenHash: "before", currentHash: "after" }],
  });
  const snapshot: AssistantSnapshot = {
    availability: "ready",
    run: { ...run("planning"), status: "blocked", message: "需求预检事实或来源已变化，请重新规划",
      userMessage: "请重新规划", blockReason: "investigation" },
    events: [{ sequence: 1, stepId: "preflight", attempt: 1,
      label: "方案预检未通过", status: "failed", tool: "host:plan-preflight", detail, at: "2026-10-30T00:00:00Z" }],
  };
  let calls = 0;
  await assert.rejects(settleEvolution({ async observe(): Promise<AssistantSnapshot> {
    return ++calls === 1 ? { availability: "ready", run: run("planning") } : snapshot;
  } }, "awaiting-apply"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /unexpected host terminal/);
      assert.ok(error.message.includes("host:plan-preflight"));
      assert.ok(error.message.includes("admission-invalid"));
      assert.ok(error.message.includes("frozenHash"));
      return true;
    });
  assert.equal(calls, 2, "已知阻塞应立即失败并保留诊断，不继续等待六十秒");
});
