import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { ExtensionRegistry } from "../../src/server/extensions/registry.js";
import {
  HOST_UI_SLOTS,
  resolveUiContributions,
} from "../../src/server/extensions/ui-slots.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const definition: WorkflowDefinition = {
  id: "ui-detail",
  name: "UI 贡献证明",
  version: "1.0.0",
  initialState: "open",
  states: {
    open: { label: "未完成", category: "open" },
    done: { label: "已完成", category: "done" },
  },
  actions: [
    { id: "complete", label: "完成", from: ["open"] },
    { id: "reopen", label: "重新打开", from: ["done"] },
  ],
  fields: [],
};

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-ui-"));
  const filename = join(directory, "tasks.db");
  const workspace = await Workspace.open(filename);
  t.after(async () => {
    await workspace.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  return workspace;
}

async function activateUiDetail(w: Workspace) {
  const code = await readFile(join(fixtureDir, "ui-detail-plugin.mjs"), "utf8");
  const version = w.release.record({
    pluginId: "ui-detail",
    name: "UI 贡献证明",
    service: "workflow",
    contractVersion: "workflow/1",
    source: code,
    code,
    definition,
    evidence: { passed: true, origin: "test" },
  });
  const before = w.composition();
  await w.activate(
    {
      versionId: version.id,
      compositionRevision: before.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  return version;
}

test("host whitelist includes only task.detail", () => {
  assert.deepEqual([...HOST_UI_SLOTS], ["task.detail"]);
});

test("resolveUiContributions keeps valid task.detail and skips illegal entries", () => {
  const known = new Set(["markProof", "complete"]);
  const { valid, invalid } = resolveUiContributions(
    {
      uiSlots: [
        {
          id: "proof-panel",
          slot: "task.detail",
          title: "扩展证明",
          actions: [{ commandId: "markProof", label: "打证明标记" }],
          fields: [{ key: "proofMark", label: "证明标记" }],
        },
        {
          id: "row",
          slot: "task-row",
          title: "未知槽",
          actions: [{ commandId: "markProof", label: "x" }],
        },
        {
          id: "bad-cmd",
          slot: "task.detail",
          title: "坏命令",
          actions: [{ commandId: "missing", label: "无" }],
        },
        {
          id: "no-title",
          slot: "task.detail",
          actions: [{ commandId: "markProof", label: "打证明标记" }],
        },
      ],
    },
    known,
    "ui-detail",
  );
  assert.equal(valid.length, 1);
  assert.equal(valid[0]?.id, "proof-panel");
  assert.equal(valid[0]?.providerId, "ui-detail");
  assert.ok(invalid.some((item) => item.id === "row"));
  assert.ok(invalid.some((item) => item.id === "bad-cmd"));
  assert.ok(invalid.some((item) => item.id === "no-title"));
});

test("registry marks ui.slot active when host can render task.detail contributions", () => {
  const registry = new ExtensionRegistry();
  registry.install(
    "ui-detail",
    {
      commands: [{ id: "markProof", label: "打证明标记", from: ["open"] }],
      uiSlots: [
        {
          id: "proof-panel",
          slot: "task.detail",
          title: "扩展证明",
          actions: [{ commandId: "markProof", label: "打证明标记" }],
        },
      ],
    },
    [],
    "workflow",
    definition.actions,
  );
  const ui = registry
    .summarize()
    .capabilities.find((c) => c.interfaceId === "ui.slot");
  assert.equal(ui?.status, "active");
  assert.equal(ui?.count, 1);
  assert.equal(registry.uiContributions().length, 1);
});

test("registry keeps stub for non-host slots and declared without contributions", () => {
  const empty = new ExtensionRegistry();
  empty.install("p", {}, [], "workflow", definition.actions);
  assert.equal(
    empty.summarize().capabilities.find((c) => c.interfaceId === "ui.slot")
      ?.status,
    "declared",
  );

  const stub = new ExtensionRegistry();
  stub.install(
    "p",
    { uiSlots: [{ id: "badge", slot: "task-row" }] },
    [],
    "workflow",
    definition.actions,
  );
  assert.equal(
    stub.summarize().capabilities.find((c) => c.interfaceId === "ui.slot")
      ?.status,
    "stub",
  );
  assert.equal(stub.uiContributions().length, 0);
});

test("activated fixture exposes task.detail contributions and persists via proof command", async (t) => {
  const w = await setup(t);
  await activateUiDetail(w);
  const composition = w.composition();
  assert.equal(
    composition.extensions.capabilities.find((c) => c.interfaceId === "ui.slot")
      ?.status,
    "active",
  );
  assert.equal(composition.uiContributions.length, 1);
  assert.equal(composition.uiContributions[0]?.slot, "task.detail");
  assert.equal(composition.uiContributions[0]?.title, "扩展证明");
  assert.ok(
    composition.workflow.actions.some((a) => a.id === "markProof"),
  );

  const created = await w.command({
    type: "create",
    title: "详情证明任务",
    operationId: randomUUID(),
    compositionRevision: composition.revision,
  });
  const marked = await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "markProof",
    expectedRevision: created.task!.revision,
    operationId: randomUUID(),
    compositionRevision: composition.revision,
  });
  assert.equal(marked.task?.fields.proofMark, "ok");
  assert.equal(w.read(created.task!.id).fields.proofMark, "ok");
});

test("switching away clears ui contributions and proof command", async (t) => {
  const w = await setup(t);
  await activateUiDetail(w);
  assert.equal(w.composition().uiContributions.length, 1);
  const afterUi = w.composition();
  await w.activate(
    {
      versionId: afterUi.previousVersionId!,
      compositionRevision: afterUi.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const restored = w.composition();
  assert.equal(restored.workflow.id, "default");
  assert.equal(restored.uiContributions.length, 0);
  assert.equal(
    restored.extensions.capabilities.find((c) => c.interfaceId === "ui.slot")
      ?.status,
    "declared",
  );
  assert.equal(
    restored.workflow.actions.some((a) => a.id === "markProof"),
    false,
  );
});

test("isolated experience surfaces ui contributions and simulates a write", async (t) => {
  const w = await setup(t);
  const version = await activateUiDetail(w);
  const domain = new EvolutionDomain(w);
  const report = await domain.experience(
    version.id,
    "candidate-ui-detail",
    AbortSignal.timeout(15000),
  );
  assert.equal(report.isolated, true);
  assert.ok(report.uiContributions?.some((c) => c.id === "proof-panel"));
  assert.ok(report.checks.some((c) => c.includes("ui.slot:active")));
  assert.ok(report.checks.some((c) => c.includes("ui.action:markProof")));
  assert.ok(report.checks.some((c) => /ui\.write:commit|ui\.write:ok/.test(c)));
  assert.equal(w.query().tasks.length, 0);
});
