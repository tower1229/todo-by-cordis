import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { ExecutionDriver } from "./execution-fixture.js";
import { PlanningDriver } from "./planning-fixture.js";
import { activateDual } from "./dual-composition-fixture.js";
import { evolutionWithExperience } from "./evolution-session-fixture.js";
import { experienceSessionBanner } from "../../src/shared/assistant.js";
import { AppError } from "../../src/shared/contracts.js";
import type { Evolution } from "../../src/evolution/evolution.js";

async function settle(e: Evolution) {
  for (let i = 0; i < 200; i++) {
    const run = (await e.observe()).run;
    if (!run) throw new Error("missing run");
    if (!["planning", "executing", "applying"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

async function awaitingApplyDual(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-exp-session-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  await activateDual(w);
  const before = w.composition();
  const formalTask = await w.command({
    type: "create",
    title: "formal-only",
    compositionRevision: before.revision,
    operationId: randomUUID(),
  });
  const { evolution: e, app, sessions } = evolutionWithExperience(
    w,
    new ExecutionDriver(new PlanningDriver(), "aux-workflow", "双贡献组合"),
  );
  t.after(async () => {
    await e.close();
    await sessions.close();
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "plan-exp",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") throw new Error("expected ready");
  await e.command({
    type: "start",
    operationId: "start-exp",
    runId: ready.id,
    planId: ready.plan.id,
  });
  const done = await settle(e);
  assert.equal(done.status, "awaiting-apply");
  if (done.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  const candidate = (await e.observe()).candidates?.find((c) => c.passed);
  assert.ok(candidate?.versionId && candidate.evidenceHash);
  return {
    w,
    before,
    e,
    app,
    ready,
    done,
    candidate: candidate!,
    formalTaskId: formalTask.task!.id,
  };
}

test("待应用且已通过验证的候选可打开体验；非 awaiting-apply 不能创建", async (t) => {
  const { w, before, e, app, done, candidate, formalTaskId } =
    await awaitingApplyDual(t);
  await assert.rejects(
    () =>
      e.command({
        type: "experience",
        operationId: "exp-bad-candidate",
        runId: done.id,
        candidateId: "missing-candidate",
      }),
    (error: unknown) =>
      error instanceof AppError && error.code === "CANDIDATE_MISMATCH",
  );
  const opened = await e.command({
    type: "experience",
    operationId: "exp-open",
    runId: done.id,
    candidateId: candidate.id,
  });
  assert.equal(opened.run?.status, "awaiting-apply");
  if (opened.run?.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  assert.equal(opened.run.experienceSession?.banner, experienceSessionBanner);
  assert.equal(opened.run.experienceSession?.status, "active");
  const replay = await e.command({
    type: "experience",
    operationId: "exp-open-2",
    runId: done.id,
    candidateId: candidate.id,
  });
  assert.equal(
    replay.run?.status === "awaiting-apply"
      ? replay.run.experienceSession?.id
      : undefined,
    opened.run.experienceSession?.id,
  );
  const sessionId = opened.run.experienceSession!.id;
  const res = await app.request(`/api/experience?sessionId=${sessionId}`);
  assert.equal(res.status, 200);
  const snapshot = await res.json();
  assert.equal(snapshot.task.title, "候选体验任务");
  assert.ok(
    snapshot.composition.members.some(
      (m: { pluginId: string }) => m.pluginId === "tags",
    ),
  );
  assert.ok(
    snapshot.composition.members.some(
      (m: { pluginId: string }) => m.pluginId === "due",
    ),
  );
  assert.equal(w.composition().versionId, before.versionId);
  assert.equal(w.query().total, 1);
  assert.equal(w.query().tasks[0]?.id, formalTaskId);
});

test("同一体验中可操作 tags 与 due 辅助成员并持久化到隔离库", async (t) => {
  const { w, before, e, app, done, candidate, formalTaskId } =
    await awaitingApplyDual(t);
  const opened = await e.command({
    type: "experience",
    operationId: "exp-actions",
    runId: done.id,
    candidateId: candidate.id,
  });
  assert.equal(opened.run?.status, "awaiting-apply");
  if (opened.run?.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  const sessionId = opened.run.experienceSession!.id;
  const initial = await (
    await app.request(`/api/experience?sessionId=${sessionId}`)
  ).json();
  const setTags = await app.request("/api/experience/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      operationId: randomUUID(),
      type: "action",
      taskId: initial.task.id,
      actionId: "setTags",
      expectedRevision: initial.task.revision,
      input: { tags: "  Alpha  " },
    }),
  });
  assert.equal(setTags.status, 200);
  const tagsBody = await setTags.json();
  assert.equal(tagsBody.task.fields.tags, "  Alpha  ");
  const setDue = await app.request("/api/experience/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      operationId: randomUUID(),
      type: "action",
      taskId: tagsBody.task.id,
      actionId: "setDue",
      expectedRevision: tagsBody.task.revision,
      input: { dueAt: "2026-12-01" },
    }),
  });
  assert.equal(setDue.status, 200);
  const dueBody = await setDue.json();
  assert.equal(dueBody.task.fields.dueAt, "2026-12-01");
  assert.equal(w.query().tasks[0]?.id, formalTaskId);
  assert.equal(w.query().tasks[0]?.fields.tags, undefined);
  assert.equal(w.composition().versionId, before.versionId);
});

test("浏览器不能指定数据库路径；结束体验不自动应用候选", async (t) => {
  const { w, before, e, app, done, candidate } = await awaitingApplyDual(t);
  const opened = await e.command({
    type: "experience",
    operationId: "exp-end",
    runId: done.id,
    candidateId: candidate.id,
  });
  assert.equal(opened.run?.status, "awaiting-apply");
  if (opened.run?.status !== "awaiting-apply")
    throw new Error("expected awaiting-apply");
  const sessionId = opened.run.experienceSession!.id;
  const forbidden = await app.request("/api/experience/commands", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      databasePath: "/tmp/evil.db",
      operationId: randomUUID(),
      type: "action",
      taskId: "x",
      actionId: "setTags",
      expectedRevision: 1,
      input: { tags: "x" },
    }),
  });
  assert.equal(forbidden.status, 403);
  await app.request("/api/experience/end", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId }),
  });
  assert.deepEqual(
    await (await app.request(`/api/experience?sessionId=${sessionId}`)).json(),
    { status: "none" },
  );
  const still = await e.observe();
  assert.equal(still.run?.status, "awaiting-apply");
  assert.equal(w.composition().versionId, before.versionId);
});
