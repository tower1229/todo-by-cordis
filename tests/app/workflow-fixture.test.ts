import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { verifyWorkflow } from "../../src/server/evolution-domain.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";
import {
  activateDual,
  activateWorkflowOnly,
} from "./dual-composition-fixture.js";

for (const activate of [activateWorkflowOnly, activateDual]) {
  test(`真实运行时夹具契约与既有工作流检查器一致：${activate.name}`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "workflow-fixture-"));
    const w = await Workspace.open(join(dir, "workspace.db"));
    t.after(async () => {
      await w.close();
      await rm(dir, { recursive: true, force: true });
    });
    await activate(w);
    const base = w.activeVersion();
    const runtime = await w.release.start(base);
    t.after(() => runtime.close());
    const definition = await runtime.invoke<WorkflowDefinition>("describe");
    assert.equal(base.name, definition.name);
    assert.deepEqual(base.definition, definition);
    const checks = await verifyWorkflow(runtime, definition, base, {
      pluginId: base.pluginId,
      name: base.name,
      fields: [],
    });
    assert.deepEqual(checks, [
      "complete-preserve-fields",
      "reopen-preserve-fields",
      "invalid:done:complete",
      "invalid:open:reopen",
      "invalid:open:unknown",
    ]);
  });
}
