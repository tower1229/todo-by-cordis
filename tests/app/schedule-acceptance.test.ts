import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { verifyScheduleViaIsolatedWorkspace } from "../../src/server/schedule-acceptance.js";
import { dueAutoExpireSource } from "../../src/server/capability-guides.js";
import { dualWorkflowDefinition } from "./dual-composition-fixture.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import { hash } from "../../src/release/storage.js";
import type { SchedulePolicy, SchedulePolicyEvidence } from "../../src/shared/schedule-policy.js";

const at = "2030-01-01T00:01:00.000Z";
const cases: MemberAcceptanceCase[] = [
  {
    name: "set due",
    member: "due",
    state: "open",
    fields: {},
    action: "setDue",
    input: { dueAt: at },
    expected: { kind: "commit", state: "open", fields: { dueAt: at } },
  },
  {
    name: "expire",
    member: "due",
    state: "open",
    fields: { dueAt: at },
    action: "expire",
    input: { scheduledAt: at },
    expected: {
      kind: "commit",
      state: "open",
      fields: { dueAt: at, expired: "true" },
    },
  },
];

test("schedule/1 uses real timer dispatch and rejects missing or ineffective schedules", async (t) => {
  const directory = await mkdtemp(
    join(tmpdir(), "cordis-schedule-checker-test-"),
  );
  const formal = await Workspace.open(join(directory, "formal.db"));
  t.after(async () => {
    await formal.close();
    await rm(directory, { recursive: true, force: true });
  });
  const workflowCode = await readFile(
    new URL("../fixtures/aux-workflow.mjs", import.meta.url),
    "utf8",
  );
  async function candidate(source: string, workflowSource=workflowCode) {
    const member = formal.release.record({
      pluginId: "due",
      name: "截止",
      service: "plugin:due",
      contractVersion: "extensions/1",
      source,
      code: source,
      definition: { id: "due" },
      evidence: { passed: true, origin: "test" },
    });
    return formal.release.record({
      pluginId: "aux-workflow",
      name: "工作流",
      service: "workflow",
      contractVersion: "workflow/1",
      source: workflowSource,
      code: workflowSource,
      definition: dualWorkflowDefinition,
      evidence: { passed: true, origin: "test" },
      members: [
        { pluginId: "aux-workflow", enabled: true, role: "workflow" },
        {
          pluginId: "due",
          versionId: member.id,
          enabled: true,
          role: "auxiliary",
        },
      ],
    });
  }
  const signal = new AbortController().signal;
  const good = await candidate(dueAutoExpireSource);
  assert.deepEqual(
    await verifyScheduleViaIsolatedWorkspace(formal, good, cases, signal),
    [
      "schedule/1:due-expire:on-time",
      "schedule/1:due-expire:completed-safe",
      "schedule/1:due-expire:updated-once",
      "schedule/1:due-expire:cleared",
      "schedule/1:due-expire:deleted",
      "schedule/1:due-expire:recovery-run-once",
    ],
  );
  const policy:SchedulePolicy={version:1,id:"due-lifecycle",kind:"schedule-policy",action:{kind:"action",member:"due",action:"expire"},fireCase:{caseId:"member:due:expire",definitionHash:hash(cases[1])},checks:["complete-retains-effect","reopen-after-due"]};
  const lifecycleChecks=await verifyScheduleViaIsolatedWorkspace(formal,good,cases,signal,[policy]);
  assert.ok(lifecycleChecks.includes("schedule-policy:due-lifecycle:complete-retains-effect"));
  assert.ok(lifecycleChecks.includes("schedule-policy:due-lifecycle:reopen-after-due"));
  const duplicatePolicyChecks=await verifyScheduleViaIsolatedWorkspace(formal,good,cases,signal,[policy,{...policy,id:"same-business-second-source"}]);
  assert.ok(duplicatePolicyChecks.includes("schedule-policy:same-business-second-source:complete-retains-effect"));
  for (const [workflowSource,check,message] of [
    [workflowCode.replace('state: "done", fields: task.fields','state: "done", fields: Object.fromEntries(Object.entries(task.fields).filter(([key]) => key !== "expired"))'),"complete-retains-effect","完成后未保留"],
    [workflowCode.replace('state: "open", fields: task.fields','state: "open", fields: Object.fromEntries(Object.entries(task.fields).filter(([key]) => key !== "dueAt"))'),"reopen-after-due","重开未由真实调度"],
  ] as const) {
    assert.notEqual(workflowSource,workflowCode);
    const mutant=await candidate(dueAutoExpireSource,workflowSource);
    await verifyScheduleViaIsolatedWorkspace(formal,mutant,cases,signal);
    const receipts:SchedulePolicyEvidence[]=[];
    await assert.rejects(verifyScheduleViaIsolatedWorkspace(formal,mutant,cases,signal,[{...policy,checks:[check]}],r=>receipts.push(r)),new RegExp(message));
    assert.equal(receipts.at(-1)?.status,"failed");
    assert.ok(receipts.at(-1)!.steps.length>=2);
  }
  await assert.rejects(verifyScheduleViaIsolatedWorkspace(formal,good,cases,signal,[{...policy,fireCase:{...policy.fireCase,definitionHash:"forged"}}]),/冻结的到期案例不一致/);
  await assert.rejects(verifyScheduleViaIsolatedWorkspace(formal,good,cases,signal,[{...policy,action:{...policy.action,member:"wrong-provider"}}]),/没有绑定候选实际登记/);
  const skip = await candidate(
    dueAutoExpireSource.replace('missPolicy: "run-once"', 'missPolicy: "skip"'),
  );
  assert.ok(
    (
      await verifyScheduleViaIsolatedWorkspace(formal, skip, cases, signal)
    ).includes("schedule/1:due-expire:recovery-skip"),
  );
  await assert.rejects(
    verifyScheduleViaIsolatedWorkspace(
      formal,
      good,
      cases.map((item) => ({ ...item, member: "other" })),
      signal,
    ),
    /缺少设置截止与到期动作的冻结正例/,
  );
  const missing = await candidate(
    dueAutoExpireSource.replace(
      /schedules: \[\{[\s\S]*?\}\],/,
      "schedules: [],",
    ),
  );
  await assert.rejects(
    verifyScheduleViaIsolatedWorkspace(formal, missing, cases, signal),
    /未注册调度/,
  );
  const noEffect = await candidate(
    dueAutoExpireSource.replace('expired: "true"', 'expired: "false"'),
  );
  await assert.rejects(
    verifyScheduleViaIsolatedWorkspace(formal, noEffect, cases, signal),
    /到点未通过真实调度/,
  );
  const noClear = await candidate(
    dueAutoExpireSource.replace(
      "if (dueAt) fields.dueAt = dueAt;\n      else delete fields.dueAt;",
      "fields.dueAt = dueAt || task.fields.dueAt;",
    ),
  );
  await assert.rejects(
    verifyScheduleViaIsolatedWorkspace(formal, noClear, cases, signal),
    /清除未撤销调度/,
  );
  const premature = await candidate(
    dueAutoExpireSource.replace(
      'return { kind: "commit", state: task.state, fields };',
      'return { kind: "commit", state: task.state, fields: { ...fields, expired: "true" } };',
    ),
  );
  await assert.rejects(
    verifyScheduleViaIsolatedWorkspace(formal, premature, cases, signal),
    /触发前已出现/,
  );
  const exposed = await candidate(
    dueAutoExpireSource.replace(
      '{ id: "expire", label: "标为过期", from: ["open"], internalOnly: true }',
      '{ id: "expire", label: "标为过期", from: [], internalOnly: true }',
    ),
  );
  await assert.rejects(
    verifyScheduleViaIsolatedWorkspace(formal, exposed, cases, signal),
    /授权未完成状态/,
  );
  const publicFire = await candidate(
    dueAutoExpireSource.replace("internalOnly: true", "internalOnly: false"),
  );
  await assert.rejects(
    verifyScheduleViaIsolatedWorkspace(formal, publicFire, cases, signal),
    /仅调度可触发/,
  );
  const completedWrong = await candidate(
    dueAutoExpireSource
      .replace(
        '{ id: "expire", label: "标为过期", from: ["open"], internalOnly: true }',
        '{ id: "expire", label: "标为过期", from: ["open", "done"], internalOnly: true }',
      )
      .replace('task.state !== "open" || ', ""),
  );
  await assert.rejects(
    verifyScheduleViaIsolatedWorkspace(formal, completedWrong, cases, signal),
    /误标已完成任务/,
  );
});
