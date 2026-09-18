import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { ExperienceSessionHost } from "../../src/server/experience-session.js";
import { createApp } from "../../src/server/app.js";
import type { Driver } from "../../src/evolution/driver.js";
import type {
  AssistantCommand,
  AssistantSnapshot,
  InvestigatedPlan,
} from "../../src/shared/assistant.js";
import type {
  CommandResult,
  Composition,
  Task,
} from "../../src/shared/contracts.js";
import type { ExperienceSessionSnapshot } from "../../src/server/experience-session.js";

export const v1Requests = [
  "请增加标签插件：给任务设置一个文本标签，保存时去掉首尾空格，拒绝空白标签，保留大小写；其他行为不变。",
  "请增加独立的计数插件：未完成任务可以将计数加一，初始为零，已完成任务不能增加。保留已有标签及其他行为。",
  "请升级标签插件：保存标签时统一为小写，仍去掉首尾空格、拒绝空白。保留计数和其他行为。",
  "请改进完成流程：完成前必须填写复盘，去掉首尾空格后至少一个字，最多五千字；重新打开保留复盘。标签、计数和已有任务不变。",
  "请停用标签插件，保留已有标签数据和计数、复盘功能，之后可以重新启用。",
  "请重新启用标签插件，保留原来的版本、小写规则、已有数据、计数和复盘功能。",
] as const;

export type V1Event = Record<string, unknown>;
export type V1Options = {
  directory: string;
  driver: Driver;
  mode:
    | "real-model-full-six-step"
    | "deterministic-subset"
    | "deterministic-full-six-step";
  record: (event: V1Event) => void;
  browser?: (
    app: ReturnType<typeof createApp>,
    phase: number,
    session: ExperienceSessionSnapshot,
    bindings: { tags?: Binding; counter?: Binding; reflection: string },
  ) => Promise<unknown>;
};
type Binding = { member: string; action: string; field: string };

/** Same public Evolution and Workspace path for CI and real calls; no generated source edits. */
export async function runV1Acceptance(options: V1Options) {
  let w = await Workspace.open(join(options.directory, "workspace.db"));
  let sessions = new ExperienceSessionHost(w);
  let e = new Evolution(
    w.db,
    options.driver,
    new EvolutionDomain(w),
    sessions,
    { calls: 12, candidates: 3, milliseconds: 600_000 },
  );
  let app = createApp(w, e, sessions);
  let phase = -1;
  let tags: Binding | undefined;
  let counter: Binding | undefined;
  let reflection = "";
  const record = (event: V1Event) => options.record({ phase, ...event });
  const fingerprint = () => ({
    composition: w.composition(),
    tasks: w.query(),
  });
  const command = async (input: AssistantCommand) => {
    record({ type: "confirmation-or-request", command: input });
    const receipt = await e.command(input);
    record({ type: "receipt", receipt });
    return receipt;
  };
  async function settled() {
    const deadline = Date.now() + 660_000;
    while (Date.now() < deadline) {
      const snapshot = await e.observe();
      if (
        !snapshot.run ||
        !["planning", "executing", "applying"].includes(snapshot.run.status)
      ) {
        record({ type: "settled", snapshot });
        return snapshot;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    throw new Error("有界等待超时，不重置预算或自动重试");
  }
  function binding(plan: InvestigatedPlan): Binding {
    const member =
      plan.memberAdditions?.[0]?.pluginId ?? plan.memberUpgrades?.[0]?.pluginId;
    const example = plan.memberCases?.find(
      (c) => c.member === member && c.expected.kind === "commit",
    );
    assert.ok(
      member && example && example.expected.kind === "commit",
      "缺少可绑定的成员案例",
    );
    const changedFields = Object.keys(example.expected.fields ?? {}).filter(
      (key) =>
        example.expected.kind === "commit" &&
        example.expected.fields?.[key] !== example.fields[key],
    );
    assert.equal(changedFields.length, 1, "案例必须明确绑定一个目标业务字段");
    const field = changedFields[0];
    assert.ok(field, "案例未声明可观测字段");
    return { member, action: example.action, field };
  }
  async function exercise(
    composition: Composition,
    read: () => Task,
    send: (
      action: string,
      input?: Record<string, string>,
    ) => Promise<CommandResult>,
  ) {
    if (phase >= 4) {
      assert.equal(
        composition.members.find((m) => m.pluginId === tags!.member)?.enabled,
        phase !== 4,
        "启停必须是成员 enabled 变更，不能伪装为业务代码替换",
      );
    }
    if (phase === 4 && tags) {
      const before = read();
      await assert.rejects(send(tags.action, { [tags.field]: "disabled" }));
      assert.deepEqual(read(), before);
    }
    if (tags && phase !== 4) {
      await send(tags.action, { [tags.field]: "  HeLLo " });
      assert.equal(read().fields[tags.field], phase >= 2 ? "hello" : "HeLLo");
      const before = read();
      await assert.rejects(send(tags.action, { [tags.field]: "   " }));
      assert.deepEqual(read(), before);
    }
    const retainedTag = tags ? read().fields[tags.field] : undefined;
    if (counter) {
      const before = Number(read().fields[counter.field] ?? "0");
      await send(counter.action);
      assert.equal(read().fields[counter.field], String(before + 1));
    }
    if (phase >= 3) {
      const before = read();
      const missing = await send("complete");
      assert.equal(missing.decision?.kind, "input-required");
      assert.deepEqual(read(), before);
      await send("complete", { [reflection]: "  完成复盘  " });
      assert.equal(read().state, "done");
      assert.equal(read().fields[reflection], "完成复盘");
      if (counter) await assert.rejects(send(counter.action));
      await send("reopen");
      assert.equal(read().state, "open");
    }
    if (tags) assert.equal(read().fields[tags.field], retainedTag);
  }
  const formalAction = (
    id: string,
    actionId: string,
    input: Record<string, string> = {},
  ) =>
    w.command({
      type: "action",
      operationId: randomUUID(),
      compositionRevision: w.composition().revision,
      taskId: id,
      expectedRevision: w.read(id).revision,
      actionId,
      input,
    });
  async function close() {
    await e.close();
    await sessions.close();
    await w.close();
  }
  try {
    const seed = (
      await w.command({
        type: "create",
        operationId: randomUUID(),
        compositionRevision: w.composition().revision,
        title: "首版保留任务",
      })
    ).task!;
    let previous: AssistantSnapshot["run"] = null;
    let restoreVersion = "";
    for (
      phase = 0;
      phase < (options.mode === "deterministic-subset" ? 4 : 6);
      phase++
    ) {
      const before = fingerprint();
      const base = w.composition();
      await command(
        previous
          ? {
              type: "continue",
              operationId: randomUUID(),
              runId: previous.id,
              baseVersion: base.versionId,
              text: v1Requests[phase],
            }
          : {
              type: "request",
              operationId: randomUUID(),
              text: v1Requests[phase],
            },
      );
      let snapshot = await settled();
      assert.deepEqual(fingerprint(), before);
      if (snapshot.run?.status === "awaiting-acceptance") {
        const run = snapshot.run;
        await command({
          type: "confirm-acceptance",
          operationId: randomUUID(),
          runId: run.id,
          planId: run.plan.id,
          revisionId: run.acceptanceRevision.id,
        });
        snapshot = await settled();
      }
      const ready = snapshot.run;
      assert.equal(ready?.status, "ready", JSON.stringify(ready));
      if (ready?.status !== "ready") throw new Error("规划未就绪");
      if (phase === 0) tags = binding(ready.plan);
      if (phase === 1) counter = binding(ready.plan);
      if (phase === 3) {
        reflection = ready.plan.workflowRules[0]?.key;
        assert.ok(reflection, "复盘规则缺失");
        restoreVersion = base.versionId;
      }
      await command({
        type: "start",
        operationId: randomUUID(),
        runId: ready.id,
        planId: ready.plan.id,
      });
      snapshot = await settled();
      assert.equal(
        snapshot.run?.status,
        "awaiting-apply",
        JSON.stringify(snapshot.run),
      );
      assert.deepEqual(fingerprint(), before);
      const candidate = snapshot.candidates?.find((c) => c.passed);
      assert.ok(candidate?.versionId && candidate.evidenceHash);
      const failedAttempts =
        snapshot.candidates?.filter((attempt) => !attempt.passed) ?? [];
      if (failedAttempts.length)
        record({
          type: "generated-candidate-correction",
          runId: ready.id,
          faultOrigin:
            options.mode === "real-model-full-six-step"
              ? "natural-flow"
              : "synthetic-model-fixture",
          failedCandidates: failedAttempts,
          correctedCandidate: candidate,
          budget: snapshot.run?.budget,
        });
      for (const attempt of failedAttempts) {
        if (!attempt.versionId) continue;
        record({ type: "failed-candidate-evidence", candidate: attempt,
          evidence: w.release.get(attempt.versionId).evidence });
      }
      const version = w.release.get(candidate.versionId);
      record({
        type: "candidate-evidence",
        candidate,
        members: version.members,
        evidence: version.evidence,
      });
      await command({
        type: "experience",
        operationId: randomUUID(),
        runId: ready.id,
        candidateId: candidate.id,
      });
      const session = sessions.observe({ runId: ready.id });
      assert.equal(session.status, "active");
      if (session.status !== "active") throw new Error("体验不可用");
      const readExperience = () => sessions.readSnapshot(session.id);
      await exercise(
        readExperience().composition,
        () => readExperience().task,
        async (actionId, input = {}) => {
          const response = await app.request("/api/experience/commands", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: session.id,
              type: "action",
              operationId: randomUUID(),
              taskId: session.taskId,
              expectedRevision: readExperience().task.revision,
              actionId,
              input,
            }),
          });
          const result = await response.json();
          if (!response.ok) throw new Error(JSON.stringify(result));
          return result as CommandResult;
        },
      );
      const experienceSnapshot = readExperience();
      const browser = options.browser
        ? await options.browser(app, phase, readExperience(), { tags, counter, reflection })
        : { status: "not-run", reason: "CI public-control-plane subset" };
      record({
        type: "experience-checked",
        snapshot: experienceSnapshot,
        browser,
      });
      assert.deepEqual(fingerprint(), before);
      await sessions.end(session.id);
      assert.equal((await e.observe()).run?.status, "awaiting-apply");
      assert.deepEqual(fingerprint(), before);
      await command({
        type: "apply",
        operationId: randomUUID(),
        runId: ready.id,
        candidateId: candidate.id,
        evidenceHash: candidate.evidenceHash,
        compositionRevision: base.revision,
      });
      snapshot = await settled();
      assert.equal(
        snapshot.run?.status,
        "succeeded",
        JSON.stringify(snapshot.run),
      );
      assert.deepEqual(w.query().tasks, before.tasks.tasks);
      for (const member of base.members) {
        if ((phase <= 1 || phase === 3) && member.role === "workflow") continue;
        if (phase === 2 && member.pluginId === tags!.member) continue;
        const actual = w
          .composition()
          .members.find((m) => m.pluginId === member.pluginId);
        assert.deepEqual(
          actual,
          phase >= 4 && member.pluginId === tags!.member
            ? { ...member, enabled: phase !== 4 }
            : member,
          "无关成员必须保留精确版本锁",
        );
      }
      await exercise(
        w.composition(),
        () => w.read(seed.id),
        (action, input) => formalAction(seed.id, action, input),
      );
      record({
        type: "applied",
        composition: w.composition(),
        task: w.read(seed.id),
      });
      previous = snapshot.run;
    }
    if (options.mode === "deterministic-subset") {
      // Explicitly a Workspace lifecycle subset, never presented as model planned enable-status changes.
      const before = w.read(seed.id);
      for (const enabled of [false, true]) {
        await w.setMemberEnabled({
          operationId: randomUUID(),
          compositionRevision: w.composition().revision,
          versionId: w.composition().versionId,
          pluginId: tags!.member,
          enabled,
        });
        assert.deepEqual(w.read(seed.id), before);
        if (!enabled)
          await assert.rejects(
            formalAction(seed.id, tags!.action, { [tags!.field]: "x" }),
          );
      }
      record({
        type: "lifecycle-subset-checked",
        source: "public-workspace-api-not-agent-plan",
      });
    }
    phase = 6;
    const added = (
      await w.command({
        type: "create",
        operationId: randomUUID(),
        compositionRevision: w.composition().revision,
        title: "升级后新增保留任务",
      })
    ).task!;
    await formalAction(added.id, tags!.action, { [tags!.field]: "  KEEP " });
    const beforeRestart = fingerprint();
    record({
      type: "calls",
      calls: w.db.prepare("SELECT runId,body FROM evolution_calls").all(),
    });
    await close();
    w = await Workspace.open(join(options.directory, "workspace.db"));
    sessions = new ExperienceSessionHost(w);
    e = new Evolution(w.db, options.driver, new EvolutionDomain(w), sessions);
    app = createApp(w, e, sessions);
    assert.deepEqual(w.query().tasks, beforeRestart.tasks.tasks);
    assert.equal(
      w.composition().versionId,
      beforeRestart.composition.versionId,
    );
    assert.deepEqual(
      w.composition().members,
      beforeRestart.composition.members,
    );
    await w.activate({
      operationId: randomUUID(),
      compositionRevision: w.composition().revision,
      versionId: restoreVersion,
    });
    assert.equal(w.composition().versionId, restoreVersion);
    assert.deepEqual(w.query().tasks, beforeRestart.tasks.tasks);
    assert.equal(w.read(seed.id).fields[reflection], "完成复盘");
    assert.equal(w.read(added.id).fields[tags!.field], "keep");
    await formalAction(added.id, tags!.action, { [tags!.field]: "  AFTER " });
    assert.equal(w.read(added.id).fields[tags!.field], "after");
    await formalAction(added.id, counter!.action);
    assert.equal(w.read(added.id).fields[counter!.field], "1");
    record({
      type: "restart-restore-checked",
      restartScope:
        "workspace-and-evolution-reopened-with-fresh-runtime-process",
      composition: w.composition(),
      tasks: w.query(),
    });
    return {
      status:
        options.mode === "deterministic-subset" ? "subset-passed" : "passed",
    } as const;
  } catch (error) {
    record({
      type: "failure",
      faultOrigin:
        options.mode !== "real-model-full-six-step"
          ? "synthetic-model-fixture"
          : "natural-flow",
      message: error instanceof Error ? error.message : String(error),
      snapshot: await e.observe().catch(() => null),
      preservedDirectory: options.directory,
    });
    throw error;
  } finally {
    record({
      type: "calls",
      calls: w.db.prepare("SELECT runId,body FROM evolution_calls").all(),
    });
    await close();
  }
}
