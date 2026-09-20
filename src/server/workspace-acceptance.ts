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
  protectionOf?: string;
};

type FormExpected = {
  kind: "input-required";
  examples: {
    name: string;
    input: Record<string, string>;
    expected: Extract<AcceptanceExpected, { kind: "commit" }>;
  }[];
};

type WorkspaceExecutionCase = Omit<WorkspaceAcceptanceCase, "expected"> & {
  expected: AcceptanceExpected | FormExpected;
};

export type WorkspaceCaseEvidence = {
  kind: "frozen-business" | "system-protection";
  protectionOf?: string;
  name: string;
  compositionVersionId: string;
  member: string;
  memberVersionId: string;
  action: string;
  initial: { state: string; fields: Record<string, string> };
  input: Record<string, string>;
  expected: AcceptanceExpected | FormExpected;
  actual: {
    state?: string;
    fields?: Record<string, string>;
    decision?: string;
    formFields?: { key: string; label: string }[];
    formSubmissions?: {
      caseName: string;
      input: Record<string, string>;
      state?: string;
      fields?: Record<string, string>;
      matched: boolean;
      error?: string;
    }[];
    error?: string;
  };
  status: "passed" | "failed";
  diagnostic: string;
};

export function importCompositionVersions(
  formal: Workspace,
  isolated: Workspace,
  root: Version,
) {
  const ids = new Set<string>([root.id]);
  for (const member of resolveVersionMembers(root))
    ids.add(member.versionId ?? root.id);
  for (const id of ids) isolated.release.adopt(formal.release.get(id));
}

function assertTaskUnchanged(
  isolated: Workspace,
  taskId: string,
  before: { state: string; fields: Record<string, string>; revision: number },
  caseName: string,
) {
  const stayed = isolated.read(taskId);
  if (
    stayed.revision !== before.revision ||
    stayed.state !== before.state ||
    hash(stayed.fields) !== hash(before.fields)
  )
    throw new BusinessAssertionError(
      `业务验收失败：${caseName}；预期拒绝写入，任务已被改动`,
    );
}

function prepareCaseTask(
  isolated: Workspace,
  created: Task,
  c: WorkspaceExecutionCase,
): Task {
  const initial = isolated.composition().workflow.initialState;
  const needsSeed = c.state !== initial || Object.keys(c.fields).length > 0;
  if (!needsSeed) return created;
  return isolated.seedAcceptanceTask(
    created.id,
    c.state,
    { ...c.fields },
    created.revision + 1,
  );
}

/** Blocks member-change acceptance when planning coverage is incomplete. */
export function requireAffectedAcceptanceForMemberChange(
  affected: AffectedAcceptance | undefined,
  memberChange: boolean,
): void {
  if (!memberChange || !affected) return;
  if (!affected.complete)
    throw new BusinessAssertionError(`验收缺失：${affected.gaps.join("；")}`);
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
  recordCase?: (evidence: WorkspaceCaseEvidence) => void,
): Promise<string[]> {
  if (!cases.length)
    throw new BusinessAssertionError("缺少隔离 Workspace 业务验收用例");
  const directory = await mkdtemp(join(tmpdir(), "cordis-accept-isolated-"));
  const isolated = await Workspace.open(join(directory, "workspace.db"), {
    acceptanceProbe: true,
  });
  const checks: string[] = [];
  let receipt: WorkspaceCaseEvidence;
  const recordCasePass = (
    c: WorkspaceExecutionCase,
    memberVersionId: string | undefined,
  ) => {
    receipt.status = "passed";
    receipt.diagnostic =
      c.expected.kind === "input-required"
        ? "输入表单可收集冻结正例所需数据并完成动作"
        : c.protectionOf
          ? "系统数据保留约束与持久化最终事实一致"
          : "冻结案例与持久化最终事实一致";
    checks.push(c.name);
    if (c.member && memberVersionId)
      checks.push(`member-version:${c.member}@${memberVersionId}`);
  };
  try {
    signal.throwIfAborted();
    importCompositionVersions(formal, isolated, candidate);
    await isolated.activateForAcceptance(candidate.id, signal);
    const members = compositionMembers(isolated.release.get(candidate.id));
    checks.push(
      `workspace:composition:${members
        .map((m) => `${m.pluginId}@${m.versionId}:${m.enabled ? "on" : "off"}`)
        .join(",")}`,
    );
    let registry = isolated.extensionRegistry();
    // Keep frozen business cases untouched. Separately exercise the mandatory
    // unknown-field retention contract with the same known-valid action input.
    const occupied = new Set([
      ...isolated.composition().retainedFields.map((field) => field.key),
      ...cases.flatMap((c) => [
        ...Object.keys(c.fields),
        ...Object.keys(c.input),
        ...(c.expected.kind === "commit" ? Object.keys(c.expected.fields) : []),
      ]),
    ]);
    let retainedKey = "host_retained";
    while (occupied.has(retainedKey)) retainedKey += "_";
    const protectionCases: WorkspaceAcceptanceCase[] = cases.flatMap((c) =>
      c.expected.kind !== "commit"
        ? []
        : [
            {
              ...c,
              name: `system:preserve-unknown-fields:${c.name}`,
              protectionOf: c.name,
              fields: { ...c.fields, [retainedKey]: "preserve" },
              expected: {
                ...c.expected,
                fields: { ...c.expected.fields, [retainedKey]: "preserve" },
              },
            },
          ],
    );
    const formCases: WorkspaceExecutionCase[] = cases.flatMap((c) => {
      if (
        !c.member ||
        c.expected.kind !== "reject" ||
        Object.keys(c.input).length
      )
        return [];
      const positives = cases.filter(
        (p) =>
          p.expected.kind === "commit" &&
          p.member === c.member &&
          p.action === c.action &&
          p.state === c.state &&
          hash(p.fields) === hash(c.fields) &&
          Object.keys(p.input).length > 0,
      );
      if (!positives.length) return [];
      return [
        {
          ...c,
          name: `system:input-form:${c.name}`,
          protectionOf: c.name,
          expected: {
            kind: "input-required",
            examples: positives.flatMap((p) =>
              p.expected.kind === "commit"
                ? [
                    {
                      name: p.name,
                      input: { ...p.input },
                      expected: structuredClone(p.expected),
                    },
                  ]
                : [],
            ),
          },
        },
      ];
    });
    for (const c of [...cases, ...protectionCases, ...formCases]) {
      signal.throwIfAborted();
      const targetMember = members.find((m) =>
        c.member ? m.pluginId === c.member : m.role === "workflow",
      );
      receipt = {
        kind: c.protectionOf ? "system-protection" : "frozen-business",
        ...(c.protectionOf ? { protectionOf: c.protectionOf } : {}),
        name: c.name,
        compositionVersionId: candidate.id,
        member: c.member ?? targetMember?.pluginId ?? candidate.pluginId,
        memberVersionId: targetMember?.versionId ?? candidate.id,
        action: c.action,
        initial: { state: c.state, fields: { ...c.fields } },
        input: { ...c.input },
        expected: structuredClone(c.expected),
        actual: {},
        status: "failed",
        diagnostic: "案例尚未完成",
      };
      let caseTaskId: string | undefined;
      try {
        let toggledMember: string | null = null;
        let priorEnabled = false;
        let memberVersionId: string | undefined;
        if (c.member) {
          const listed = isolated
            .composition()
            .members.find((m) => m.pluginId === c.member);
          if (!listed)
            throw new BusinessAssertionError(
              `业务验收失败：${c.name}；组合中不存在成员 ${c.member}`,
            );
          priorEnabled = listed.enabled;
          memberVersionId = listed.versionId;
          if (!listed.enabled) {
            toggledMember = c.member;
            const composition = isolated.composition();
            await isolated.setMemberEnabled({
              operationId: randomUUID(),
              compositionRevision: composition.revision,
              versionId: composition.versionId,
              pluginId: c.member,
              enabled: true,
            });
            registry = isolated.extensionRegistry();
          }
          const command = registry
            .commands()
            .find((item) => item.id === c.action);
          if (command?.providerId !== c.member)
            throw new BusinessAssertionError(
              `业务验收失败：${c.name}；动作 ${c.action} 不是成员 ${c.member} 的贡献`,
            );
        }
        try {
          const compositionRevision = isolated.composition().revision;
          const created = await isolated.command({
            type: "create",
            title: `case:${randomUUID()}`,
            compositionRevision,
            operationId: randomUUID(),
          });
          if (!created.task)
            throw new BusinessAssertionError(
              `业务验收失败：${c.name}；创建任务失败`,
            );
          const task = prepareCaseTask(isolated, created.task, c);
          caseTaskId = task.id;
          try {
            const result = await isolated.command({
              type: "action",
              taskId: task.id,
              actionId: c.action,
              expectedRevision: task.revision,
              input: c.input,
              operationId: randomUUID(),
              compositionRevision,
            });
            receipt.actual.decision = result.decision?.kind ?? "commit";
            if (c.expected.kind === "input-required") {
              const decision = result.decision;
              receipt.actual.formFields =
                decision?.kind === "input-required"
                  ? decision.fields.map(({ key, label }) => ({ key, label }))
                  : [];
              if (
                decision?.kind !== "input-required" ||
                !decision.fields.length ||
                decision.fields.some(
                  (field) =>
                    typeof field.key !== "string" ||
                    !field.key ||
                    typeof field.label !== "string" ||
                    !field.label.trim() ||
                    field.type !== "text" ||
                    (field.required !== undefined &&
                      typeof field.required !== "boolean"),
                ) ||
                new Set(decision.fields.map((field) => field.key)).size !==
                  decision.fields.length
              )
                throw new BusinessAssertionError(
                  `系统验收失败：${c.name}；缺失输入须返回有效的 input-required 表单`,
                );
              assertTaskUnchanged(isolated, task.id, task, c.name);
              receipt.actual.formSubmissions = [];
              for (const example of c.expected.examples) {
                const input = Object.fromEntries(
                  decision.fields.map((field) => [
                    field.key,
                    example.input[field.key] ?? "",
                  ]),
                );
                if (
                  decision.fields.some(
                    (field) =>
                      (field.required && !input[field.key]) ||
                      input[field.key]!.length > 10000,
                  )
                ) {
                  receipt.actual.formSubmissions.push({
                    caseName: example.name,
                    input,
                    matched: false,
                    error: "冻结输入不满足真实表单的必填或长度约束",
                  });
                  continue;
                }
                const createdSubmission = await isolated.command({
                  type: "create",
                  title: `form:${randomUUID()}`,
                  compositionRevision,
                  operationId: randomUUID(),
                });
                if (!createdSubmission.task)
                  throw new Error("无法创建表单验收任务");
                const submissionTask = prepareCaseTask(
                  isolated,
                  createdSubmission.task,
                  c,
                );
                let errorMessage: string | undefined;
                let committed = false;
                try {
                  const submitted = await isolated.command({
                    type: "action",
                    taskId: submissionTask.id,
                    actionId: c.action,
                    expectedRevision: submissionTask.revision,
                    input,
                    compositionRevision,
                    operationId: randomUUID(),
                  });
                  committed =
                    Boolean(submitted.task) &&
                    submitted.decision?.kind !== "input-required";
                } catch (error) {
                  if (
                    !(error instanceof AppError) ||
                    !["ACTION_REJECTED", "INVALID_ACTION"].includes(error.code)
                  )
                    throw error;
                  errorMessage = error.message;
                }
                const actual =
                  isolated
                    .query("", "all")
                    .tasks.find((row) => row.id === submissionTask.id) ??
                  isolated.read(submissionTask.id);
                const matched =
                  committed &&
                  !errorMessage &&
                  actual.state === example.expected.state &&
                  hash(actual.fields) === hash(example.expected.fields);
                receipt.actual.formSubmissions.push({
                  caseName: example.name,
                  input,
                  state: actual.state,
                  fields: { ...actual.fields },
                  matched,
                  ...(errorMessage ? { error: errorMessage } : {}),
                });
                if (matched) break;
              }
              if (
                !receipt.actual.formSubmissions.some(
                  (submission) => submission.matched,
                )
              )
                throw new BusinessAssertionError(
                  `系统验收失败：${c.name}；表单可收集的冻结输入不能完成动作，缺少必要输入字段`,
                );
              recordCasePass(c, memberVersionId);
              continue;
            }
            if (c.expected.kind === "reject") {
              if (result.decision?.kind === "input-required") {
                assertTaskUnchanged(isolated, task.id, task, c.name);
                recordCasePass(c, memberVersionId);
                continue;
              }
              throw new BusinessAssertionError(
                `业务验收失败：${c.name}；预期拒绝，实际 ${JSON.stringify(result.decision ?? result.task)}`,
              );
            }
            const listed =
              isolated
                .query("", "all")
                .tasks.find((row) => row.id === task.id) ??
              isolated.read(task.id);
            if (
              listed.state !== c.expected.state ||
              hash(listed.fields) !== hash(c.expected.fields)
            )
              throw new BusinessAssertionError(
                `业务验收失败：${c.name}；预期 ${JSON.stringify(c.expected)}；查询 ${JSON.stringify({ state: listed.state, fields: listed.fields })}`,
              );
            recordCasePass(c, memberVersionId);
          } catch (error) {
            receipt.actual.error =
              error instanceof Error ? error.message : String(error);
            if (
              c.expected.kind === "reject" &&
              error instanceof AppError &&
              (error.code === "ACTION_REJECTED" ||
                error.code === "INVALID_ACTION")
            ) {
              assertTaskUnchanged(isolated, task.id, task, c.name);
              recordCasePass(c, memberVersionId);
              continue;
            }
            if (
              c.expected.kind === "input-required" &&
              error instanceof AppError &&
              error.code === "ACTION_REJECTED"
            )
              throw new BusinessAssertionError(
                `系统验收失败：${c.name}；缺失输入须返回 input-required 表单，实际拒绝：${error.message}`,
              );
            throw error;
          }
        } finally {
          if (toggledMember !== null) {
            const composition = isolated.composition();
            await isolated.setMemberEnabled({
              operationId: randomUUID(),
              compositionRevision: composition.revision,
              versionId: composition.versionId,
              pluginId: toggledMember,
              enabled: priorEnabled,
            });
            checks.push(
              `workspace:member-restored:${toggledMember}:${priorEnabled ? "on" : "off"}`,
            );
            registry = isolated.extensionRegistry();
          }
        }
      } catch (error) {
        receipt.status = "failed";
        receipt.diagnostic =
          error instanceof Error ? error.message : String(error);
        receipt.actual.error ??= receipt.diagnostic;
        throw error;
      } finally {
        if (caseTaskId) {
          const actual = isolated.read(caseTaskId);
          receipt.actual.state = actual.state;
          receipt.actual.fields = { ...actual.fields };
        }
        recordCase?.(structuredClone(receipt));
      }
    }
    return checks;
  } finally {
    await isolated.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}
