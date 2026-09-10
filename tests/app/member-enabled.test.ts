import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { createApp } from "../../src/server/app.js";
import { activateDual, dualWorkflowDefinition } from "./dual-composition-fixture.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const workflowDefinition = dualWorkflowDefinition;

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-member-"));
  const filename = join(directory, "tasks.db");
  const workspace = await Workspace.open(filename);
  t.after(async () => {
    await workspace.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  return { workspace, filename, directory };
}

test("public disable then enable keeps fields, drops contributions, other plugin stays", async (t) => {
  const { workspace: w } = await setup(t);
  await activateDual(w);
  const active = w.composition();
  const created = await w.command({
    type: "create",
    title: "停用保留",
    operationId: randomUUID(),
    compositionRevision: active.revision,
  });
  const tagged = await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setTags",
    expectedRevision: created.task!.revision,
    input: { tags: "keep-me" },
    operationId: randomUUID(),
    compositionRevision: active.revision,
  });
  const dated = await w.command({
    type: "action",
    taskId: tagged.task!.id,
    actionId: "setDue",
    expectedRevision: tagged.task!.revision,
    input: { dueAt: "2026-09-20T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: active.revision,
  });
  assert.equal(dated.task?.fields.tags, "keep-me");

  const beforeDisable = w.composition();
  const disabled = await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: beforeDisable.revision,
    versionId: beforeDisable.versionId,
    pluginId: "tags",
    enabled: false,
  });
  assert.equal(disabled.revision, beforeDisable.revision + 1);
  const afterDisable = w.composition();
  assert.equal(afterDisable.revision, disabled.revision);
  assert.equal(afterDisable.versionId !== beforeDisable.versionId, true);
  assert.ok(
    afterDisable.history.some(
      (item) =>
        item.versionId === afterDisable.versionId &&
        /停用.*tags/.test(item.name),
    ),
  );
  const tagsMember = afterDisable.members.find((m) => m.pluginId === "tags");
  assert.ok(tagsMember);
  assert.equal(tagsMember.enabled, false);
  assert.equal(tagsMember.role, "auxiliary");
  assert.equal(
    afterDisable.members.find((m) => m.pluginId === "due")?.enabled,
    true,
  );
  assert.equal(
    afterDisable.members.find((m) => m.pluginId === "aux-workflow")?.role,
    "workflow",
  );
  assert.equal(
    afterDisable.workflow.fields.some((f) => f.key === "tags"),
    false,
  );
  assert.equal(
    afterDisable.workflow.actions.some((a) => a.id === "setTags"),
    false,
  );
  assert.ok(afterDisable.workflow.fields.some((f) => f.key === "dueAt"));
  assert.ok(afterDisable.workflow.actions.some((a) => a.id === "setDue"));
  assert.ok(afterDisable.retainedFields.some((f) => f.key === "tags"));
  assert.ok(
    afterDisable.extensions.capabilities.some(
      (c) =>
        c.interfaceId === "member.register" &&
        c.status === "declared" &&
        c.providerId === "tags",
    ),
  );
  assert.equal(
    afterDisable.extensions.capabilities.some(
      (c) =>
        c.interfaceId === "fields.register" &&
        c.providerId === "tags" &&
        c.status === "active",
    ),
    false,
  );
  assert.ok(
    afterDisable.extensions.capabilities.some(
      (c) =>
        c.interfaceId === "fields.register" &&
        c.providerId === "due" &&
        c.status === "active",
    ),
  );

  const stored = w.read(created.task!.id);
  assert.equal(stored.fields.tags, "keep-me");
  assert.equal(stored.fields.dueAt, "2026-09-20T00:00:00Z");
  const listed = w.query();
  assert.equal(listed.total, 1);
  assert.equal(listed.tasks[0]?.id, stored.id);
  assert.equal(listed.tasks[0]?.fields.tags, "keep-me");
  assert.equal(listed.revision, afterDisable.revision);

  await assert.rejects(
    w.command({
      type: "action",
      taskId: stored.id,
      actionId: "setDue",
      expectedRevision: stored.revision,
      input: { dueAt: "2026-09-22T00:00:00Z" },
      operationId: randomUUID(),
      compositionRevision: beforeDisable.revision,
    }),
    /流程已变化|刷新/,
  );
  assert.equal(w.read(stored.id).fields.dueAt, "2026-09-20T00:00:00Z");

  await assert.rejects(
    w.command({
      type: "action",
      taskId: stored.id,
      actionId: "setTags",
      expectedRevision: stored.revision,
      input: { tags: "nope" },
      operationId: randomUUID(),
      compositionRevision: afterDisable.revision,
    }),
    /不可用|无效/,
  );
  assert.equal(w.read(stored.id).fields.tags, "keep-me");

  const dueAgain = await w.command({
    type: "action",
    taskId: stored.id,
    actionId: "setDue",
    expectedRevision: stored.revision,
    input: { dueAt: "2026-09-21T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: afterDisable.revision,
  });
  assert.equal(dueAgain.task?.fields.dueAt, "2026-09-21T00:00:00Z");
  assert.equal(dueAgain.task?.fields.tags, "keep-me");

  const reenabled = await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: afterDisable.revision,
    versionId: afterDisable.versionId,
    pluginId: "tags",
    enabled: true,
  });
  assert.equal(reenabled.revision, afterDisable.revision + 1);
  const afterEnable = w.composition();
  assert.equal(
    afterEnable.members.find((m) => m.pluginId === "tags")?.enabled,
    true,
  );
  assert.ok(
    afterEnable.history.some(
      (item) =>
        item.versionId === afterEnable.versionId &&
        /启用.*tags/.test(item.name),
    ),
  );
  assert.ok(afterEnable.workflow.fields.some((f) => f.key === "tags"));
  assert.ok(afterEnable.workflow.actions.some((a) => a.id === "setTags"));

  const task = w.read(created.task!.id);
  assert.equal(task.fields.tags, "keep-me");
  const retagged = await w.command({
    type: "action",
    taskId: task.id,
    actionId: "setTags",
    expectedRevision: task.revision,
    input: { tags: "again" },
    operationId: randomUUID(),
    compositionRevision: afterEnable.revision,
  });
  assert.equal(retagged.task?.fields.tags, "again");
});

test("rejects sole workflow disable, unknown plugin, stale revision; formal data unchanged", async (t) => {
  const { workspace: w } = await setup(t);
  await activateDual(w);
  const before = w.composition();
  const task = (
    await w.command({
      type: "create",
      title: "非法停用保留",
      operationId: randomUUID(),
      compositionRevision: before.revision,
    })
  ).task!;

  await assert.rejects(
    w.setMemberEnabled({
      operationId: randomUUID(),
      compositionRevision: before.revision,
      versionId: before.versionId,
      pluginId: "aux-workflow",
      enabled: false,
    }),
    /主工作流|工作流/,
  );
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.composition().revision, before.revision);
  assert.equal(w.read(task.id).title, "非法停用保留");

  await assert.rejects(
    w.setMemberEnabled({
      operationId: randomUUID(),
      compositionRevision: before.revision,
      versionId: before.versionId,
      pluginId: "missing-plugin",
      enabled: false,
    }),
    /未知|不存在|找不到/,
  );
  assert.equal(w.composition().versionId, before.versionId);

  await assert.rejects(
    w.setMemberEnabled({
      operationId: randomUUID(),
      compositionRevision: before.revision + 99,
      versionId: before.versionId,
      pluginId: "tags",
      enabled: false,
    }),
    /流程已变化|刷新/,
  );
  assert.equal(w.composition().revision, before.revision);
});

test("setMemberEnabled is idempotent on operationId and rejects mismatched input", async (t) => {
  const { workspace: w } = await setup(t);
  await activateDual(w);
  const before = w.composition();
  const operationId = randomUUID();
  const request = {
    operationId,
    compositionRevision: before.revision,
    versionId: before.versionId,
    pluginId: "tags",
    enabled: false,
  };
  const first = await w.setMemberEnabled(request);
  const second = await w.setMemberEnabled(request);
  assert.deepEqual(second, first);
  assert.equal(w.composition().revision, first.revision);

  await assert.rejects(
    w.setMemberEnabled({ ...request, enabled: true }),
    /重新提交/,
  );
});

test("already-at-target enable state returns unchanged without new revision", async (t) => {
  const { workspace: w } = await setup(t);
  await activateDual(w);
  const before = w.composition();
  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: before.revision,
    versionId: before.versionId,
    pluginId: "tags",
    enabled: false,
  });
  const disabled = w.composition();
  const operationId = randomUUID();
  const noopRequest = {
    operationId,
    compositionRevision: disabled.revision,
    versionId: disabled.versionId,
    pluginId: "tags",
    enabled: false,
  };
  const first = await w.setMemberEnabled(noopRequest);
  assert.equal(first.revision, disabled.revision);
  assert.equal(
    (first as { unchanged?: boolean }).unchanged,
    true,
  );
  assert.equal(w.composition().revision, disabled.revision);
  assert.equal(w.composition().versionId, disabled.versionId);

  const replayed = await w.setMemberEnabled(noopRequest);
  assert.deepEqual(replayed, first);

  await assert.rejects(
    w.setMemberEnabled({ ...noopRequest, enabled: true }),
    /重新提交/,
  );
});

test("recordMemberEnabledVersion rejects already-at-target without changing formal composition", async (t) => {
  const { workspace: w } = await setup(t);
  await activateDual(w);
  const before = w.composition();
  assert.throws(
    () => w.recordMemberEnabledVersion("tags", true),
    /目标启用状态|已是/,
  );
  assert.equal(w.composition().revision, before.revision);
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(
    w.composition().members.find((m) => m.pluginId === "tags")?.enabled,
    true,
  );
});

test("disable, upgrade member version, re-enable uses current contract and keeps fields", async (t) => {
  const { workspace: w } = await setup(t);
  const { tags: tagsV1, due } = await activateDual(w);
  const active = w.composition();
  const created = await w.command({
    type: "create",
    title: "升级保留",
    operationId: randomUUID(),
    compositionRevision: active.revision,
  });
  await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setTags",
    expectedRevision: created.task!.revision,
    input: { tags: "legacy-value" },
    operationId: randomUUID(),
    compositionRevision: active.revision,
  });

  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
    versionId: w.composition().versionId,
    pluginId: "tags",
    enabled: false,
  });
  const disabled = w.composition();
  assert.equal(w.read(created.task!.id).fields.tags, "legacy-value");
  assert.ok(disabled.retainedFields.some((f) => f.key === "tags"));
  assert.equal(
    disabled.workflow.actions.some((a) => a.id === "setTags"),
    false,
  );

  const tagsV2Code = `export default {
  contribute() {
    return {
      fields: [{ key: "tags", label: "标签V2", type: "text" }],
      commands: [
        { id: "setTags", label: "设标签", from: ["open", "done"] },
        { id: "appendTag", label: "追加标签", from: ["open", "done"] },
      ],
    };
  },
  decide(data) {
    const { task, action, input } = data;
    if (action === "setTags")
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, tags: input?.tags ?? "" },
      };
    if (action === "appendTag")
      return {
        kind: "commit",
        state: task.state,
        fields: {
          ...task.fields,
          tags: [task.fields.tags, input?.tag].filter(Boolean).join(","),
        },
      };
    return { kind: "reject", message: "未知动作" };
  },
};`;
  const tagsV2 = w.release.record({
    pluginId: "tags",
    name: "标签插件 V2",
    service: "plugin:tags",
    contractVersion: "extensions/1",
    source: tagsV2Code,
    code: tagsV2Code,
    definition: { id: "tags" },
    evidence: { passed: true, origin: "test" },
  });
  assert.notEqual(tagsV2.id, tagsV1.id);
  const workflowCode = await readFile(join(fixtureDir, "aux-workflow.mjs"), "utf8");
  const upgradedWhileDisabled = w.release.record({
    pluginId: "aux-workflow",
    name: "双贡献组合（升级停用 tags）",
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
        versionId: tagsV2.id,
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
      versionId: upgradedWhileDisabled.id,
      compositionRevision: disabled.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const afterUpgrade = w.composition();
  assert.equal(
    afterUpgrade.members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );
  assert.equal(
    afterUpgrade.members.find((m) => m.pluginId === "tags")?.versionId,
    tagsV2.id,
  );
  assert.equal(w.read(created.task!.id).fields.tags, "legacy-value");
  assert.ok(afterUpgrade.retainedFields.some((f) => f.key === "tags"));
  assert.equal(
    afterUpgrade.workflow.actions.some((a) => a.id === "appendTag"),
    false,
  );

  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: afterUpgrade.revision,
    versionId: afterUpgrade.versionId,
    pluginId: "tags",
    enabled: true,
  });
  const reenabled = w.composition();
  assert.equal(
    reenabled.members.find((m) => m.pluginId === "tags")?.enabled,
    true,
  );
  assert.equal(
    reenabled.members.find((m) => m.pluginId === "tags")?.versionId,
    tagsV2.id,
  );
  assert.ok(reenabled.workflow.actions.some((a) => a.id === "appendTag"));
  assert.ok(
    reenabled.workflow.fields.some(
      (f) => f.key === "tags" && f.label === "标签V2",
    ),
  );
  const stored = w.read(created.task!.id);
  assert.equal(stored.fields.tags, "legacy-value");
  const appended = await w.command({
    type: "action",
    taskId: stored.id,
    actionId: "appendTag",
    expectedRevision: stored.revision,
    input: { tag: "v2" },
    operationId: randomUUID(),
    compositionRevision: reenabled.revision,
  });
  assert.equal(appended.task?.fields.tags, "legacy-value,v2");
});

test("confirmed enable state survives workspace reopen", async (t) => {
  const { workspace: first, filename } = await setup(t);
  await activateDual(first);
  const before = first.composition();
  await first.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: before.revision,
    versionId: before.versionId,
    pluginId: "tags",
    enabled: false,
  });
  const disabledRevision = first.composition().revision;
  const disabledVersionId = first.composition().versionId;
  await first.close();

  const second = await Workspace.open(filename);
  t.after(async () => {
    await second.close().catch(() => undefined);
  });
  const active = second.composition();
  assert.equal(active.revision, disabledRevision);
  assert.equal(active.versionId, disabledVersionId);
  assert.equal(
    active.members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );
  assert.equal(
    active.members.find((m) => m.pluginId === "tags")?.role,
    "auxiliary",
  );
  assert.ok(
    active.extensions.capabilities.some(
      (c) =>
        c.interfaceId === "member.register" &&
        c.providerId === "tags" &&
        c.status === "declared",
    ),
  );
  assert.equal(
    active.workflow.fields.some((f) => f.key === "tags"),
    false,
  );
  assert.ok(active.workflow.fields.some((f) => f.key === "dueAt"));
  assert.ok(active.retainedFields.some((f) => f.key === "tags"));
});

test("disable is forward revision, not restore; restore keeps interim tasks and fields", async (t) => {
  const { workspace: w } = await setup(t);
  await activateDual(w);
  const dual = w.composition();
  const dualVersionId = dual.versionId;

  const created = await w.command({
    type: "create",
    title: "停用前",
    operationId: randomUUID(),
    compositionRevision: dual.revision,
  });
  await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setTags",
    expectedRevision: created.task!.revision,
    input: { tags: "before" },
    operationId: randomUUID(),
    compositionRevision: dual.revision,
  });

  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
    versionId: w.composition().versionId,
    pluginId: "tags",
    enabled: false,
  });
  const disabled = w.composition();
  assert.notEqual(disabled.versionId, dualVersionId);
  assert.equal(disabled.previousVersionId, dualVersionId);

  const interim = await w.command({
    type: "create",
    title: "停用期间新增",
    operationId: randomUUID(),
    compositionRevision: disabled.revision,
  });
  await w.command({
    type: "action",
    taskId: interim.task!.id,
    actionId: "setDue",
    expectedRevision: interim.task!.revision,
    input: { dueAt: "2026-10-01T00:00:00Z" },
    operationId: randomUUID(),
    compositionRevision: disabled.revision,
  });

  await w.activate({
    versionId: dualVersionId,
    compositionRevision: disabled.revision,
    operationId: randomUUID(),
  });
  const restored = w.composition();
  assert.equal(restored.versionId, dualVersionId);
  assert.equal(
    restored.members.find((m) => m.pluginId === "tags")?.enabled,
    true,
  );
  assert.equal(w.read(interim.task!.id).title, "停用期间新增");
  assert.equal(w.read(interim.task!.id).fields.dueAt, "2026-10-01T00:00:00Z");
  assert.equal(w.read(created.task!.id).fields.tags, "before");
});

test("HTTP composition member endpoint disables via public path", async (t) => {
  const { workspace: w } = await setup(t);
  await activateDual(w);
  const before = w.composition();
  const app = createApp(w);
  const response = await app.request("/api/composition/members", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      operationId: randomUUID(),
      compositionRevision: before.revision,
      versionId: before.versionId,
      pluginId: "tags",
      enabled: false,
    }),
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { revision: number };
  assert.equal(body.revision, before.revision + 1);
  assert.equal(
    w.composition().members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );
});

test("precise versionId binding rejects wrong composition identity", async (t) => {
  const { workspace: w } = await setup(t);
  await activateDual(w);
  const before = w.composition();
  await assert.rejects(
    w.setMemberEnabled({
      operationId: randomUUID(),
      compositionRevision: before.revision,
      versionId: "not-the-active-version",
      pluginId: "tags",
      enabled: false,
    }),
    /绑定|身份|版本/,
  );
  assert.equal(w.composition().versionId, before.versionId);
});

test("public disable drops UI contributions and field schedules", async (t) => {
  const { workspace: w } = await setup(t);
  const workflowCode = await readFile(join(fixtureDir, "aux-workflow.mjs"), "utf8");
  const panelCode = `export default {
  contribute() {
    return {
      fields: [{ key: "note", label: "备注", type: "text" }],
      commands: [{ id: "setNote", label: "设备注", from: ["open"] }],
      uiSlots: [{
        id: "note-panel",
        slot: "task.detail",
        title: "备注面板",
        actions: [{ commandId: "setNote", label: "设备注" }],
        fields: [{ key: "note", label: "备注" }],
      }],
      schedules: [{
        id: "note-field",
        at: "note",
        atKind: "field",
        dedupeKey: "note-field",
        onFire: { type: "action", commandId: "setNote" },
        missPolicy: "skip",
      }],
    };
  },
  decide(data) {
    const { task, action, input } = data;
    if (action === "setNote")
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, note: input?.note ?? "" },
      };
    return { kind: "reject", message: "未知动作" };
  },
};`;
  const dueCode = await readFile(join(fixtureDir, "due-plugin.mjs"), "utf8");
  const panel = w.release.record({
    pluginId: "panel",
    name: "面板插件",
    service: "plugin:panel",
    contractVersion: "extensions/1",
    source: panelCode,
    code: panelCode,
    definition: { id: "panel" },
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
    name: "UI 调度组合",
    service: "workflow",
    contractVersion: "workflow/1",
    source: workflowCode,
    code: workflowCode,
    definition: workflowDefinition,
    evidence: { passed: true, origin: "test" },
    members: [
      { pluginId: "aux-workflow", enabled: true, role: "workflow" },
      {
        pluginId: "panel",
        versionId: panel.id,
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
  const before = w.composition();
  await w.activate(
    {
      versionId: composition.id,
      compositionRevision: before.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const active = w.composition();
  assert.ok(active.uiContributions.some((c) => c.id === "note-panel"));
  const created = await w.command({
    type: "create",
    title: "调度任务",
    operationId: randomUUID(),
    compositionRevision: active.revision,
  });
  await w.command({
    type: "action",
    taskId: created.task!.id,
    actionId: "setNote",
    expectedRevision: created.task!.revision,
    input: { note: new Date(Date.now() + 60_000).toISOString() },
    operationId: randomUUID(),
    compositionRevision: active.revision,
  });
  assert.equal(w.schedulerState().armed, 1);

  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
    versionId: w.composition().versionId,
    pluginId: "panel",
    enabled: false,
  });
  const after = w.composition();
  assert.equal(
    after.uiContributions.some((c) => c.id === "note-panel"),
    false,
  );
  assert.equal(w.schedulerState().armed, 0);
  assert.ok(after.workflow.fields.some((f) => f.key === "dueAt"));
  assert.ok(after.retainedFields.some((f) => f.key === "note"));
});
