// External Gemini calls require explicit authorization. Only a fresh synthetic DB is used.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Workspace } from "../src/server/workspace.js";
import { Evolution } from "../src/evolution/evolution.js";
import { EvolutionDomain } from "../src/server/evolution-domain.js";
import { Gemini } from "../src/evolution/gemini.js";
import type {
  AssistantCommand,
  AssistantSnapshot,
} from "../src/shared/assistant.js";
process.loadEnvFile(".env");
if (!process.env.GEMINI_API_KEY)
  throw new Error("GEMINI_API_KEY is not configured");
const directory = mkdtempSync(join(tmpdir(), "cordis-issue8-model-"));
console.log(directory);
let workspace = await Workspace.open(join(directory, "workspace.db"));
let evolution = new Evolution(
  workspace.db,
  new Gemini(process.env.GEMINI_API_KEY),
  new EvolutionDomain(workspace),
);
const sourceFiles = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(root, entry.name))
      : [join(root, entry.name)],
  );
const evidence: unknown[] = [
  {
    startedAt: new Date().toISOString(),
    sourceManifest: Object.fromEntries(
      sourceFiles("src")
        .sort()
        .map((path) => [
          path,
          createHash("sha256").update(readFileSync(path)).digest("hex"),
        ]),
    ),
    kind: "real-model-synthetic-workspace",
  },
];
const command = async (input: AssistantCommand) => {
  const receipt = await evolution.command(input);
  evidence.push({ command: input, receipt });
  return receipt;
};
async function settled(): Promise<AssistantSnapshot> {
  let last = "";
  for (let i = 0; i < 660; i++) {
    const snapshot = await evolution.observe();
    const status = snapshot.run?.status ?? "missing";
    if (status !== last) {
      console.log(status);
      last = status;
    }
    if (!["planning", "executing", "applying"].includes(status)) {
      evidence.push(snapshot);
      return snapshot;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("acceptance timeout");
}
async function publish(requireRevision = false) {
  let snapshot = await settled();
  if (requireRevision)
    assert.equal(
      snapshot.run?.status,
      "awaiting-acceptance",
      "changed rules require independent confirmation",
    );
  if (snapshot.run?.status === "awaiting-acceptance") {
    const run = snapshot.run;
    if (requireRevision) {
      assert.ok(
        run.acceptanceRevision.changes.some(
          (change) =>
            change.before.includes('"minLength":1') &&
            change.after.includes('"minLength":3') &&
            change.reason.trim(),
        ),
      );
    }
    console.log(
      "confirming compared business rules",
      JSON.stringify(run.acceptanceRevision.changes),
    );
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
  if (ready?.status !== "ready") throw new Error("not ready");
  if (requireRevision)
    assert.ok(
      ready.acceptanceRevisions?.some(
        (revision) => revision.planId === ready.plan.id && revision.confirmedAt,
      ),
    );
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
  const candidate = snapshot.candidates!.find((c) => c.passed)!;
  const formalBeforeExperience = workspace.query();
  const experienced = await command({
    type: "experience",
    operationId: randomUUID(),
    runId: ready.id,
    candidateId: candidate.id,
  });
  assert.equal(experienced.run?.status, "awaiting-apply");
  if (experienced.run?.status !== "awaiting-apply")
    throw new Error("missing experience");
  const report = experienced.run.experience;
  assert.equal(report?.candidateId, candidate.id);
  assert.equal(report?.isolated, true);
  assert.equal(report?.marked, "not-applied");
  for (const example of ready.plan.extensions?.cases ?? [])
    assert.ok(
      report?.checks.includes(`extension:${example.name}`),
      `missing candidate experience: ${example.name}`,
    );
  assert.deepEqual(workspace.query(), formalBeforeExperience);
  await command({
    type: "apply",
    operationId: randomUUID(),
    runId: ready.id,
    candidateId: candidate.id,
    evidenceHash: candidate.evidenceHash!,
    compositionRevision: workspace.composition().revision,
  });
  const applied = (await settled()).run!;
  assert.equal(applied.status, "succeeded", JSON.stringify(applied));
  const version = workspace.activeVersion();
  assert.ok(
    version.bundle,
    "new candidates must use the complete artifact protocol",
  );
  evidence.push({ published: version, composition: workspace.composition() });
  writeFileSync(
    join(directory, `${applied.id}-artifact.json`),
    JSON.stringify(version, null, 2),
  );
  return applied;
}
try {
  const task = (
    await workspace.command({
      type: "create",
      operationId: randomUUID(),
      compositionRevision: workspace.composition().revision,
      title: "合成验收任务",
    })
  ).task!;
  await command({
    type: "request",
    operationId: randomUUID(),
    text: "改进应用：完成任务时必须填写 reflection 复盘，去除首尾空白后按 Unicode 码点计 1 到 5000 字。保留原有 complete/reopen、任务和未知字段。保持工作流稳定身份和名称，无外部服务或依赖。",
  });
  const textRun = await publish();
  const action = async (actionId: string, input: Record<string, string> = {}) =>
    workspace.command({
      type: "action",
      operationId: randomUUID(),
      compositionRevision: workspace.composition().revision,
      taskId: task.id,
      expectedRevision: workspace.read(task.id).revision,
      actionId,
      input,
    });
  await action("complete", { reflection: "合成复盘" });
  await action("reopen");
  await command({
    type: "continue",
    operationId: randomUUID(),
    runId: textRun.id,
    baseVersion: textRun.versionId!,
    text: "增加独立计数能力：新增 increment 动作，仅 open 状态可用，将任务 count 字段的非负整数字符串加 1，缺省为 0，done 状态拒绝。新动作在界面可操作。保留 reflection 必填复盘、complete/reopen 和所有已有字段、工作流身份及名称。无外部服务或依赖。用 business-actions/1 的正反例与已有 count 7 加到 8 验证新动作，workflow/1 回归现有工作流。extensions.cases 仅包含 increment 案例。",
  });
  const first = await publish();
  await action("increment");
  assert.equal(workspace.read(task.id).fields.count, "1");
  await action("complete", { reflection: "合成复盘" });
  await action("reopen");
  const before = workspace.read(task.id);
  await command({
    type: "continue",
    operationId: randomUUID(),
    runId: first.id,
    baseVersion: first.versionId!,
    text: "继续修改刚发布的同一能力：把 reflection 复盘改为去空白后至少 3 个 Unicode 码点，仍最多 5000，必填。其余包括 increment 计数的每次加 1、已有正反例、任务、字段、名称、身份及重开行为全部保留。原因是用户明确要求提高复盘内容下限，请展示旧规则与替代规则，等待独立确认。",
  });
  const second = await publish(true);
  assert.equal(second.parentRunId, first.id);
  assert.equal(workspace.activeVersion().parentId, first.versionId);
  assert.deepEqual(workspace.read(task.id), before);
  await action("increment");
  await assert.rejects(action("complete", { reflection: "短" }));
  await action("complete", { reflection: "三个字" });
  assert.equal(workspace.read(task.id).fields.count, "2");
  assert.equal(workspace.read(task.id).fields.reflection, "三个字");
  const retained = workspace.read(task.id);
  await evolution.close();
  await workspace.close();
  workspace = await Workspace.open(join(directory, "workspace.db"));
  evolution = new Evolution(
    workspace.db,
    new Gemini(process.env.GEMINI_API_KEY!),
    new EvolutionDomain(workspace),
  );
  assert.equal((await evolution.observe(second.id)).run?.status, "succeeded");
  assert.deepEqual(workspace.read(task.id), retained);
  await workspace.activate({
    versionId: first.versionId!,
    compositionRevision: workspace.composition().revision,
    operationId: randomUUID(),
  });
  assert.deepEqual(workspace.read(task.id), retained);
  await action("reopen");
  await action("complete", { reflection: "短" });
  assert.equal(workspace.read(task.id).fields.count, "2");
  evidence.push({
    passed: true,
    composition: workspace.composition(),
    task: workspace.read(task.id),
  });
  console.log(
    "PASS: text and non-text generation, coexistence, continuation, revision, restart and rollback",
  );
} finally {
  await evolution.close();
  writeFileSync(
    join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  await workspace.close();
}
