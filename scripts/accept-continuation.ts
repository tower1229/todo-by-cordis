// External Gemini calls require explicit authorization. Only a fresh synthetic DB is used.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
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
const directory = mkdtempSync(join(tmpdir(), "cordis-issue6-model-"));
console.log(directory);
const workspace = await Workspace.open(join(directory, "workspace.db"));
const evolution = new Evolution(
  workspace.db,
  new Gemini(process.env.GEMINI_API_KEY),
  new EvolutionDomain(workspace),
);
const evidence: unknown[] = [];
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
async function publish() {
  let snapshot = await settled();
  if (snapshot.run?.status === "awaiting-acceptance") {
    const run = snapshot.run;
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
  await command({
    type: "experience",
    operationId: randomUUID(),
    runId: ready.id,
    candidateId: candidate.id,
  });
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
    text: "改进应用：完成任务时必须填写 reflection 复盘，去除首尾空白后按 Unicode 码点计 1 到 5000 字；增加 increment 计数动作，只在 open 状态可用，把任务字段 count 的非负整数字符串加 1，缺省为 0，done 状态拒绝。两种能力同时可用，保留原有 complete/reopen、任务和未知字段。无外部服务或依赖。基于现有 workflow/1 和 business-actions/1 检查器验证，提供计数正反例、已有 count 7 加到 8 的案例；complete/reopen 回归仅由 workflow/1 提供，extensions.cases 仅放 increment 案例。保持工作流稳定身份和名称。",
  });
  const first = await publish();
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
  const second = await publish();
  assert.equal(second.parentRunId, first.id);
  assert.equal(workspace.activeVersion().parentId, first.versionId);
  assert.deepEqual(workspace.read(task.id), before);
  await action("increment");
  await assert.rejects(action("complete", { reflection: "短" }));
  await action("complete", { reflection: "三个字" });
  assert.equal(workspace.read(task.id).fields.count, "2");
  assert.equal(workspace.read(task.id).fields.reflection, "三个字");
  evidence.push({
    passed: true,
    composition: workspace.composition(),
    task: workspace.read(task.id),
  });
  console.log(
    "PASS: real-model continuation, rule confirmation, retained task and both capabilities",
  );
} finally {
  await evolution.close();
  writeFileSync(
    join(directory, "evidence.json"),
    JSON.stringify(evidence, null, 2),
  );
  await workspace.close();
}
