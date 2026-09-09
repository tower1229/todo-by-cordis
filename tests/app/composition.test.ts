import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

const workflowDefinition: WorkflowDefinition = {
  id: "aux-workflow",
  name: "组合主流程",
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
  const directory = await mkdtemp(join(tmpdir(), "cordis-comp-"));
  const filename = join(directory, "tasks.db");
  const workspace = await Workspace.open(filename);
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  return workspace;
}

async function recordComposition(w: Workspace) {
  const workflowCode = await readFile(join(fixtureDir, "aux-workflow.mjs"), "utf8");
  const tagsCode = await readFile(join(fixtureDir, "tags-plugin.mjs"), "utf8");
  const dueCode = await readFile(join(fixtureDir, "due-plugin.mjs"), "utf8");

  const tags = w.release.record({
    pluginId: "tags",
    name: "标签插件",
    service: "plugin:tags",
    contractVersion: "extensions/1",
    source: tagsCode,
    code: tagsCode,
    definition: { id: "tags" },
    evidence: { passed: true, origin: "test" },
  });
  const due = w.release.record({
    pluginId: "due",
    name: "截止日期插件",
    service: "plugin:due",
    contractVersion: "extensions/1",
    source: dueCode,
    code: dueCode,
    definition: { id: "due" },
    evidence: { passed: true, origin: "test" },
  });
  const composition = w.release.record({
    pluginId: "aux-workflow",
    name: "双贡献组合",
    service: "workflow",
    contractVersion: "workflow/1",
    source: workflowCode,
    code: workflowCode,
    definition: workflowDefinition,
    evidence: { passed: true, origin: "test" },
    members: [
      {
        pluginId: "aux-workflow",
        enabled: true,
        role: "workflow",
      },
      {
        pluginId: "tags",
        versionId: tags.id,
        enabled: true,
        role: "auxiliary",
      },
      {
        pluginId: "due",
        versionId: due.id,
        enabled: true,
        role: "auxiliary",
      },
    ],
  });
  return { composition, tags, due };
}

test("legacy single-plugin version lists as one-member composition", async (t) => {
  const w = await setup(t);
  const composition = w.composition();
  assert.equal(composition.members.length, 1);
  assert.equal(composition.members[0]?.pluginId, "default");
  assert.equal(composition.members[0]?.versionId, composition.versionId);
  assert.equal(composition.members[0]?.enabled, true);
  const created = await w.command({
    type: "create",
    title: "兼容任务",
    operationId: randomUUID(),
    compositionRevision: composition.revision,
  });
  assert.equal(created.task?.title, "兼容任务");
});

test("dual plugins in one runtime expose both fields and commands with providers", async (t) => {
  const w = await setup(t);
  const before = w.composition();
  const { composition } = await recordComposition(w);
  await w.activate(
    {
      versionId: composition.id,
      compositionRevision: before.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const active = w.composition();
  assert.equal(active.members.length, 3);
  assert.deepEqual(
    active.members.map((m) => m.pluginId).sort(),
    ["aux-workflow", "due", "tags"],
  );
  assert.ok(active.members.every((m) => m.enabled && m.versionId));

  const tagsField = active.workflow.fields.find((f) => f.key === "tags");
  const dueField = active.workflow.fields.find((f) => f.key === "dueAt");
  assert.equal(tagsField?.providerId, "tags");
  assert.equal(dueField?.providerId, "due");

  const setTags = active.workflow.actions.find((a) => a.id === "setTags");
  const setDue = active.workflow.actions.find((a) => a.id === "setDue");
  assert.equal(setTags?.providerId, "tags");
  assert.equal(setDue?.providerId, "due");

  const created = await w.command({
    type: "create",
    title: "双插件任务",
    operationId: randomUUID(),
    compositionRevision: active.revision,
  });
  const tagged = await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setTags",
    expectedRevision: created.task!.revision,
    input: { tags: "work" },
    operationId: randomUUID(),
    compositionRevision: active.revision,
  });
  assert.equal(tagged.task?.fields.tags, "work");
  const dated = await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setDue",
    expectedRevision: tagged.task!.revision,
    input: { dueAt: "2026-09-10T12:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: active.revision,
  });
  assert.equal(dated.task?.fields.dueAt, "2026-09-10T12:00:00Z");
  assert.equal(dated.task?.fields.tags, "work");
});

test("duplicate identity and exclusive conflicts fail activation without changing formal composition", async (t) => {
  const w = await setup(t);
  const before = w.composition();
  const task = (
    await w.command({
      type: "create",
      title: "保留任务",
      operationId: randomUUID(),
      compositionRevision: before.revision,
    })
  ).task!;

  const workflowCode = await readFile(join(fixtureDir, "aux-workflow.mjs"), "utf8");
  const tagsCode = await readFile(join(fixtureDir, "tags-plugin.mjs"), "utf8");
  const dueCode = await readFile(join(fixtureDir, "due-plugin.mjs"), "utf8");

  const tags = w.release.record({
    pluginId: "tags",
    name: "标签插件",
    service: "plugin:tags",
    contractVersion: "extensions/1",
    source: tagsCode,
    code: tagsCode,
    definition: { id: "tags" },
    evidence: { passed: true, origin: "test" },
  });
  const due = w.release.record({
    pluginId: "due",
    name: "截止日期插件",
    service: "plugin:due",
    contractVersion: "extensions/1",
    source: dueCode,
    code: dueCode,
    definition: { id: "due" },
    evidence: { passed: true, origin: "test" },
  });

  const dupIdentity = w.release.record({
    pluginId: "aux-workflow",
    name: "重复身份",
    service: "workflow",
    contractVersion: "workflow/1",
    source: workflowCode,
    code: workflowCode,
    definition: workflowDefinition,
    evidence: { passed: true, origin: "test" },
    members: [
      {
        pluginId: "tags",
        versionId: tags.id,
        enabled: true,
        role: "workflow",
      },
      {
        pluginId: "tags",
        versionId: due.id,
        enabled: true,
        role: "auxiliary",
      },
    ],
  });
  await assert.rejects(
    w.activate(
      {
        versionId: dupIdentity.id,
        compositionRevision: before.revision,
        operationId: randomUUID(),
      },
      () => undefined,
    ),
    /重复|身份|冲突/,
  );
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.read(task.id).title, "保留任务");

  const dualWorkflow = w.release.record({
    pluginId: "aux-workflow",
    name: "双主工作流",
    service: "workflow",
    contractVersion: "workflow/1",
    source: workflowCode,
    code: workflowCode,
    definition: workflowDefinition,
    evidence: { passed: true, origin: "test" },
    members: [
      {
        pluginId: "aux-workflow",
        enabled: true,
        role: "workflow",
      },
      {
        pluginId: "tags",
        versionId: tags.id,
        enabled: true,
        role: "workflow",
      },
    ],
  });
  await assert.rejects(
    w.activate(
      {
        versionId: dualWorkflow.id,
        compositionRevision: before.revision,
        operationId: randomUUID(),
      },
      () => undefined,
    ),
    /主工作流|工作流/,
  );
  assert.equal(w.composition().versionId, before.versionId);

  const dualSortCode = `export default {
  contribute() {
    return {
      fields: [{ key: "altDue", label: "另一截止", type: "text" }],
      querySorts: [{ id: "alt", label: "另一", primary: true }],
    };
  },
  decide() { return { kind: "reject", message: "无" }; },
};`;
  const dualSortPlugin = w.release.record({
    pluginId: "due-alt",
    name: "另一排序",
    service: "plugin:due-alt",
    contractVersion: "extensions/1",
    source: dualSortCode,
    code: dualSortCode,
    definition: { id: "due-alt" },
    evidence: { passed: true, origin: "test" },
  });
  const dualSort = w.release.record({
    pluginId: "aux-workflow",
    name: "双主排序",
    service: "workflow",
    contractVersion: "workflow/1",
    source: workflowCode,
    code: workflowCode,
    definition: workflowDefinition,
    evidence: { passed: true, origin: "test" },
    members: [
      {
        pluginId: "aux-workflow",
        enabled: true,
        role: "workflow",
      },
      {
        pluginId: "due",
        versionId: due.id,
        enabled: true,
        role: "auxiliary",
      },
      {
        pluginId: "due-alt",
        versionId: dualSortPlugin.id,
        enabled: true,
        role: "auxiliary",
      },
    ],
  });
  await assert.rejects(
    w.activate(
      {
        versionId: dualSort.id,
        compositionRevision: before.revision,
        operationId: randomUUID(),
      },
      () => undefined,
    ),
    /主排序/,
  );
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.read(task.id).title, "保留任务");
});

test("auxiliary plugin need not provide workflow; exactly one workflow provider", async (t) => {
  const w = await setup(t);
  const before = w.composition();
  const { composition } = await recordComposition(w);
  await w.activate(
    {
      versionId: composition.id,
      compositionRevision: before.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const active = w.composition();
  assert.equal(active.workflow.id, "aux-workflow");
  const workflowCaps = active.extensions.capabilities.filter(
    (c) => c.interfaceId === "workflow.provide" && c.status === "active",
  );
  assert.equal(workflowCaps.length, 1);
  assert.equal(workflowCaps[0]?.providerId, "aux-workflow");
  assert.ok(
    active.extensions.capabilities.some(
      (c) =>
        c.interfaceId === "fields.register" &&
        c.providerId === "tags" &&
        c.count >= 1,
    ),
  );
  assert.ok(
    active.extensions.capabilities.some(
      (c) =>
        c.interfaceId === "fields.register" &&
        c.providerId === "due" &&
        c.count >= 1,
    ),
  );
});

test("disabled member remains listed but does not contribute", async (t) => {
  const w = await setup(t);
  const before = w.composition();
  const workflowCode = await readFile(join(fixtureDir, "aux-workflow.mjs"), "utf8");
  const tagsCode = await readFile(join(fixtureDir, "tags-plugin.mjs"), "utf8");
  const dueCode = await readFile(join(fixtureDir, "due-plugin.mjs"), "utf8");
  const tags = w.release.record({
    pluginId: "tags",
    name: "标签插件",
    service: "plugin:tags",
    contractVersion: "extensions/1",
    source: tagsCode,
    code: tagsCode,
    definition: { id: "tags" },
    evidence: { passed: true, origin: "test" },
  });
  const due = w.release.record({
    pluginId: "due",
    name: "截止日期插件",
    service: "plugin:due",
    contractVersion: "extensions/1",
    source: dueCode,
    code: dueCode,
    definition: { id: "due" },
    evidence: { passed: true, origin: "test" },
  });
  const composition = w.release.record({
    pluginId: "aux-workflow",
    name: "停用标签",
    service: "workflow",
    contractVersion: "workflow/1",
    source: workflowCode,
    code: workflowCode,
    definition: workflowDefinition,
    evidence: { passed: true, origin: "test" },
    members: [
      { pluginId: "aux-workflow", enabled: true, role: "workflow" },
      {
        pluginId: "tags",
        versionId: tags.id,
        enabled: false,
        role: "auxiliary",
      },
      {
        pluginId: "due",
        versionId: due.id,
        enabled: true,
        role: "auxiliary",
      },
    ],
  });
  await w.activate(
    {
      versionId: composition.id,
      compositionRevision: before.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const active = w.composition();
  assert.equal(active.members.length, 3);
  assert.equal(
    active.members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );
  assert.equal(
    active.members.find((m) => m.pluginId === "due")?.enabled,
    true,
  );
  assert.equal(
    active.workflow.fields.some((f) => f.key === "tags"),
    false,
  );
  assert.ok(active.workflow.fields.some((f) => f.key === "dueAt"));
  assert.equal(
    active.workflow.actions.some((a) => a.id === "setTags"),
    false,
  );
  assert.ok(active.workflow.actions.some((a) => a.id === "setDue"));
});

test("single-element composition activate, query, restore still works", async (t) => {
  const w = await setup(t);
  const baseline = w.composition();
  assert.equal(baseline.members.length, 1);

  await w.activate({
    workflowId: "review",
    compositionRevision: baseline.revision,
    operationId: randomUUID(),
  });
  const review = w.composition();
  assert.equal(review.members.length, 1);
  assert.equal(review.members[0]?.pluginId, "review");
  assert.equal(review.workflow.id, "review");

  const created = await w.command({
    type: "create",
    title: "撤回保留",
    operationId: randomUUID(),
    compositionRevision: review.revision,
  });
  await w.activate({
    versionId: baseline.versionId,
    compositionRevision: review.revision,
    operationId: randomUUID(),
  });
  const restored = w.composition();
  assert.equal(restored.versionId, baseline.versionId);
  assert.equal(restored.members[0]?.pluginId, "default");
  assert.equal(w.read(created.task!.id).title, "撤回保留");
});
