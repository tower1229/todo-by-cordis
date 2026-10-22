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
