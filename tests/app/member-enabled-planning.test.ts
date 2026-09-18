import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver } from "./planning-fixture.js";
import { activateDual } from "./dual-composition-fixture.js";

for (const [name, override, expected] of [
  ["纯辅助成员启停可以计划", {}, "ready"],
  [
    "主工作流不可停用",
    { memberEnabled: { pluginId: "aux-workflow", enabled: false } },
    "blocked",
  ],
  ["不能混入源码修改", { writableScope: ["active-source"] }, "blocked"],
  [
    "不能混入验收修订",
    {
      workflowRules: [
        {
          key: "reflection",
          label: "复盘",
          required: true,
          minLength: 1,
          maxLength: 5000,
        },
      ],
    },
    "blocked",
  ],
] as const) {
  test(name, async () => {
    const directory = await mkdtemp(join(tmpdir(), "cordis-toggle-plan-"));
    const w = await Workspace.open(join(directory, "workspace.db"));
    await activateDual(w);
    const before = w.composition();
    const e = new Evolution(
      w.db,
      new PlanningDriver({
        workflowRules: [],
        writableScope: [],
        memberEnabled: { pluginId: "tags", enabled: false },
        ...override,
      }),
      new EvolutionDomain(w),
    );
    try {
      await e.command({ type: "request", text: "停用标签", operationId: name });
      let snapshot = await e.observe();
      for (let i = 0; i < 200 && snapshot.run?.status === "planning"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        snapshot = await e.observe();
      }
      assert.equal(
        snapshot.run?.status,
        expected,
        JSON.stringify(snapshot.run),
      );
      assert.deepEqual(w.composition(), before);
    } finally {
      await e.close();
      await w.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
