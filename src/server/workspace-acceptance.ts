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
import type { Task } from "./business/contracts.js";

import type { AcceptanceExpected } from "../shared/acceptance-cases.js";
import type { AffectedAcceptance } from "./affected-acceptance.js";

/** Given/When/Then cases asserted via Workspace command → query final facts. */
export type WorkspaceAcceptanceCase = {
  name: string;
  member?: string;
  state: string;
  fields: Record<string, string>;
  action: string;
  input: Record<string, string>;
  expected: AcceptanceExpected;
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

/** Ensures each plan-authorized member action has commit+reject frozen cases to run. */
export function assertWorkspaceCaseCoverage(
  affected: AffectedAcceptance | undefined,
  cases: WorkspaceAcceptanceCase[],
): void {
  if (!affected?.complete) return;
  for (const target of affected.targets) {
    for (const action of target.actions) {
      const matched = cases.filter(
        (c) => c.member === target.pluginId && c.action === action,
      );
      if (
        !matched.some((c) => c.expected.kind === "commit") ||
        !matched.some((c) => c.expected.kind === "reject")
      )
        throw new BusinessAssertionError(
          `验收缺失：成员 ${target.pluginId} 的动作 ${action} 缺少成对隔离 Workspace 冻结案例`,
        );
    }
  }
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
    let registry = probe.extensionRegistry();
    for (const c of cases) {
      signal.throwIfAborted();
      if (c.member) {
        const listed = probe.composition().members.find(
          (m) => m.pluginId === c.member,
        );
        if (!listed)
          throw new BusinessAssertionError(
            `业务验收失败：${c.name}；组合中不存在成员 ${c.member}`,
          );
        if (!listed.enabled) {
          const composition = probe.composition();
          await probe.setMemberEnabled({
            operationId: randomUUID(),
            compositionRevision: composition.revision,
            versionId: composition.versionId,
            pluginId: c.member,
            enabled: true,
          });
          registry = probe.extensionRegistry();
        }
        const command = registry
          .commands()
          .find((item) => item.id === c.action);
        if (command?.providerId !== c.member)
          throw new BusinessAssertionError(
            `业务验收失败：${c.name}；动作 ${c.action} 不是成员 ${c.member} 的贡献`,
          );
      }
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
