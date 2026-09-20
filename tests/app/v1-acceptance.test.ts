import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runV1Acceptance } from "../../scripts/lib/v1-scenario.js";
import { v1FixtureDriver } from "./v1-driver-fixture.js";

test("首版桩层经公开控制面完成四次变更、隔离体验和独立应用，再验证启停、重启撤回子集", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-v1-stub-"));
  try {
    const events: Record<string, unknown>[] = [];
    const result = await runV1Acceptance({
      directory,
      driver: v1FixtureDriver(),
      mode: "deterministic-subset",
      record: (event) => events.push(event),
    });
    assert.equal(result.status, "subset-passed");
    assert.equal(events.filter((e) => e.type === "applied").length, 4);
    assert.equal(
      events.filter((e) => e.type === "experience-checked").length,
      4,
    );
    const combined = events.find(
      (e) => e.type === "candidate-evidence" && e.phase === 1,
    );
    assert.ok(combined);
    const evidence = combined.evidence as {
      capabilities: {
        id: string;
        capability: string;
        provider: string;
        version: string;
        ready: boolean;
      }[];
    };
    const commands = evidence.capabilities.filter(
      (c) => c.capability === "command.register",
    );
    assert.deepEqual(commands.map((c) => c.provider).sort(), [
      "member:counter",
      "member:tags",
    ]);
    assert.equal(new Set(commands.map((c) => c.id)).size, 2);
    assert.ok(commands.every((c) => c.ready && c.version));
    assert.ok(events.some((e) => e.type === "restart-restore-checked"));
    assert.ok(events.some((e) => e.type === "lifecycle-subset-checked"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("合成候选故障由模型桩下一轮提交修复；失败尝试保留且不重置预算", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-v1-fault-"));
  try {
    const snapshots: import("../../src/shared/assistant.js").AssistantSnapshot[] =
      [];
    await runV1Acceptance({
      directory,
      driver: v1FixtureDriver(true),
      mode: "deterministic-subset",
      record: (event) => {
        if (event.type === "settled")
          snapshots.push(
            event.snapshot as import("../../src/shared/assistant.js").AssistantSnapshot,
          );
      },
    });
    const repaired = snapshots.find(
      (s) => s.run?.status === "awaiting-apply" && s.candidates?.length === 2,
    );
    assert.ok(repaired);
    assert.equal(repaired.candidates?.[0].passed, false);
    assert.equal(repaired.candidates?.[1].passed, true);
    assert.equal(repaired.run?.budget?.candidatesRemaining, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("六步控制面含 Agent 规划的启停候选、体验及独立应用，不直接切换成员", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-v1-full-stub-"));
  try {
    const events: Record<string, unknown>[] = [];
    const result = await runV1Acceptance({
      directory,
      driver: v1FixtureDriver(),
      mode: "deterministic-full-six-step",
      record: (e) => events.push(e),
    });
    assert.equal(result.status, "passed");
    assert.equal(events.filter((e) => e.type === "applied").length, 6);
    assert.equal(
      events.filter((e) => e.type === "experience-checked").length,
      6,
    );
    assert.equal(
      events.some((e) => e.type === "lifecycle-subset-checked"),
      false,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("启停候选篡改源码不能应用且完整验收失败", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-v1-tamper-"));
  const fixture = v1FixtureDriver();
  const events: Record<string, unknown>[] = [];
  try {
    await assert.rejects(
      runV1Acceptance({
        directory,
        mode: "deterministic-full-six-step",
        record: (event) => events.push(event),
        driver: {
          async generate(request, signal) {
            const result = await fixture.generate(request, signal);
            if (
              request.instruction.includes("only changes member enabled status")
            ) {
              for (const call of result.calls)
                if (call.name === "submit_candidate")
                  call.args.source =
                    String(call.args.source) + "\n// unauthorized change";
            }
            return result;
          },
        },
      }),
      /启停候选禁止修改源码/,
    );
    assert.equal(events.filter((e) => e.type === "applied").length, 4);
    assert.ok(events.some((e) => e.type === "failure" && e.phase === 4));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for (const loss of ["decide", "beforeCommit"] as const)
  test(`计数丢弃未知字段须在待应用前失败：${loss}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordis-retention-gate-"));
    const snapshots: import("../../src/shared/assistant.js").AssistantSnapshot[] =
      [];
    const events: Record<string, unknown>[] = [];
    try {
      await assert.rejects(
        runV1Acceptance({
          directory,
          driver: v1FixtureDriver(false, true, false, loss),
          mode: "deterministic-subset",
          record: (event) => {
            events.push(event);
            if (event.type === "settled" && event.phase === 1)
              snapshots.push(
                event.snapshot as import("../../src/shared/assistant.js").AssistantSnapshot,
              );
          },
        }),
      );
      assert.equal(snapshots.at(-1)?.run?.status, "failed");
      assert.ok(!snapshots.some((s) => s.run?.status === "awaiting-apply"));
      assert.ok(snapshots.at(-1)?.candidates?.every((c) => !c.passed));
      assert.match(
        snapshots.at(-1)?.candidates?.[0].diagnostic ?? "",
        /preserve-unknown-fields/,
      );
      assert.ok(!events.some((e) => e.phase === 1 && e.type === "applied"));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
