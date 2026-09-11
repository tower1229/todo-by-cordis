import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BusinessAssertionError } from "./business-verification.js";
import { Workspace } from "./workspace.js";
import { AppError } from "../shared/contracts.js";
import { hash } from "../release/storage.js";
import {
  compositionMembers,
  resolveVersionMembers,
  workflowPluginId,
} from "../release/composition.js";
import type { Version } from "../release/types.js";
import type { Task } from "./business/contracts.js";

/** Given/When/Then cases asserted via Workspace command → query final facts. */
export type WorkspaceAcceptanceCase = {
  name: string;
  state: string;
  fields: Record<string, string>;
  action: string;
  input: Record<string, string>;
  expected:
    | { kind: "reject" }
    | { kind: "commit"; state: string; fields: Record<string, string> };
};

function importCompositionVersions(
  formal: Workspace,
  probe: Workspace,
  root: Version,
) {
  const ids = new Set<string>([root.id]);
  for (const member of resolveVersionMembers(root))
    ids.add(member.versionId ?? root.id);
  for (const id of ids) probe.release.adopt(formal.release.get(id));
}

function assertTaskUnchanged(
  probe: Workspace,
  taskId: string,
  before: { state: string; fields: Record<string, string> },
  caseName: string,
) {
  const stayed = probe.read(taskId);
  if (stayed.state !== before.state || hash(stayed.fields) !== hash(before.fields))
    throw new BusinessAssertionError(
      `业务验收失败：${caseName}；预期拒绝写入，任务已被改动`,
    );
}

function prepareCaseTask(
  probe: Workspace,
  created: Task,
  c: WorkspaceAcceptanceCase,
): Task {
  const initial = probe.composition().workflow.initialState;
  const needsSeed =
    c.state !== initial || Object.keys(c.fields).length > 0;
  if (!needsSeed) return created;
  return probe.seedAcceptanceTask(
    created.id,
    c.state,
    { ...c.fields },
    created.revision + 1,
  );
}

/** Smoke inherited auxiliary commands via formal command/query after activate. */
async function assertAuxiliaryMemberCommands(
  probe: Workspace,
  signal: AbortSignal,
): Promise<string[]> {
  const checks: string[] = [];
  const workflowId = workflowPluginId(probe.release.get(probe.composition().versionId));
  const initial = probe.composition().workflow.initialState;
  const revision = probe.composition().revision;
  const registry = probe.extensionRegistry();
  const commands = registry
    .commands()
    .filter(
      (command) =>
        command.providerId !== workflowId &&
        (!command.from?.length || command.from.includes(initial)),
    );
  for (const command of commands) {
    signal.throwIfAborted();
    const fields = registry
      .fields()
      .filter((field) => field.providerId === command.providerId);
    const input = Object.fromEntries(
      fields.map((field) => [field.key, `probe-${field.key}`]),
    );
    const created = await probe.command({
      type: "create",
      title: `member:${command.providerId}:${command.id}`,
      compositionRevision: revision,
      operationId: randomUUID(),
    });
    if (!created.task)
      throw new BusinessAssertionError(
        `业务验收失败：workspace:member:${command.providerId}:${command.id}；创建任务失败`,
      );
    const result = await probe.command({
      type: "action",
      taskId: created.task.id,
      actionId: command.id,
      expectedRevision: created.task.revision,
      input,
      operationId: randomUUID(),
      compositionRevision: revision,
    });
    const listed =
      probe.query("", "all").tasks.find((row) => row.id === created.task!.id) ??
      probe.read(created.task.id);
    for (const [key, value] of Object.entries(input)) {
      if (listed.fields[key] !== value)
        throw new BusinessAssertionError(
          `业务验收失败：workspace:member:${command.providerId}:${command.id}；查询字段 ${key} 预期 ${value}；实际 ${listed.fields[key] ?? ""}`,
        );
    }
    if (result.decision?.kind === "reject")
      throw new BusinessAssertionError(
        `业务验收失败：workspace:member:${command.providerId}:${command.id}；命令被拒绝`,
      );
    checks.push(`workspace:member:${command.providerId}:${command.id}`);
  }
  return checks;
}

/**
 * Trusted business acceptance: open an isolated Workspace, activate the full
 * candidate composition, and assert command/query final facts (including
 * beforeCommit effects). Does not touch the formal workspace data or pointer.
 */
export async function verifyViaIsolatedWorkspace(
  formal: Workspace,
  candidate: Version,
  cases: WorkspaceAcceptanceCase[],
  signal: AbortSignal,
): Promise<string[]> {
  if (!cases.length)
    throw new BusinessAssertionError("缺少隔离 Workspace 业务验收用例");
  const directory = await mkdtemp(join(tmpdir(), "cordis-accept-probe-"));
  const probe = await Workspace.open(join(directory, "workspace.db"), {
    acceptanceProbe: true,
  });
  const checks: string[] = [];
  try {
    signal.throwIfAborted();
    importCompositionVersions(formal, probe, candidate);
    await probe.activateForAcceptance(candidate.id, signal);
    const members = compositionMembers(probe.release.get(candidate.id));
    checks.push(
      `workspace:composition:${members
        .map((m) => `${m.pluginId}@${m.versionId}:${m.enabled ? "on" : "off"}`)
        .join(",")}`,
    );
    checks.push(...(await assertAuxiliaryMemberCommands(probe, signal)));
    for (const c of cases) {
      signal.throwIfAborted();
      const compositionRevision = probe.composition().revision;
      const created = await probe.command({
        type: "create",
        title: `case:${c.name}`,
        compositionRevision,
        operationId: randomUUID(),
      });
      if (!created.task)
        throw new BusinessAssertionError(`业务验收失败：${c.name}；创建任务失败`);
      const task = prepareCaseTask(probe, created.task, c);
      try {
        const result = await probe.command({
          type: "action",
          taskId: task.id,
          actionId: c.action,
          expectedRevision: task.revision,
          input: c.input,
          operationId: randomUUID(),
          compositionRevision,
        });
        if (c.expected.kind === "reject") {
          if (result.decision?.kind === "input-required") {
            assertTaskUnchanged(probe, task.id, task, c.name);
            checks.push(c.name);
            continue;
          }
          throw new BusinessAssertionError(
            `业务验收失败：${c.name}；预期拒绝，实际 ${JSON.stringify(result.decision ?? result.task)}`,
          );
        }
        const listed =
          probe.query("", "all").tasks.find((row) => row.id === task.id) ??
          probe.read(task.id);
        if (
          listed.state !== c.expected.state ||
          hash(listed.fields) !== hash(c.expected.fields)
        )
          throw new BusinessAssertionError(
            `业务验收失败：${c.name}；预期 ${JSON.stringify(c.expected)}；查询 ${JSON.stringify({ state: listed.state, fields: listed.fields })}`,
          );
        checks.push(c.name);
      } catch (error) {
        if (
          c.expected.kind === "reject" &&
          error instanceof AppError &&
          (error.code === "ACTION_REJECTED" || error.code === "INVALID_ACTION")
        ) {
          assertTaskUnchanged(probe, task.id, task, c.name);
          checks.push(c.name);
          continue;
        }
        throw error;
      }
    }
    return checks;
  } finally {
    await probe.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
