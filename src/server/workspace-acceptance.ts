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
} from "../release/composition.js";
import type { Version } from "../release/types.js";

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

function importCompositionVersions(formal: Workspace, probe: Workspace, root: Version) {
  const ids = new Set<string>([root.id]);
  for (const member of resolveVersionMembers(root))
    ids.add(member.versionId ?? root.id);
  for (const id of ids) probe.release.adopt(formal.release.get(id));
}

function seedTask(
  workspace: Workspace,
  state: string,
  fields: Record<string, string>,
  taskId: string,
  revision: number,
) {
  const now = new Date().toISOString();
  workspace.db
    .prepare(
      "UPDATE tasks SET state=?, fields=?, revision=?, updatedAt=? WHERE id=?",
    )
    .run(state, JSON.stringify(fields), revision, now, taskId);
  return workspace.read(taskId);
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
      const task = seedTask(
        probe,
        c.state,
        { ...c.fields },
        created.task.id,
        created.task.revision + 1,
      );
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
