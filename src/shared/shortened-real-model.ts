import { execSync } from "node:child_process";
import type { Composition, TaskList } from "./contracts.js";
import type { AssistantSnapshot } from "./assistant.js";

/** Distinguishes PR4 shortened trial from full six-step real-model evidence. */
export const REAL_MODEL_SHORTENED_KIND = "real-model-shortened-trial" as const;
export const REAL_MODEL_FULL_SIX_STEP_KIND = "real-model-full-six-step" as const;

export type RealModelEvidenceKind =
  | typeof REAL_MODEL_SHORTENED_KIND
  | typeof REAL_MODEL_FULL_SIX_STEP_KIND;

export type ShortenedTrialHeader = {
  kind: typeof REAL_MODEL_SHORTENED_KIND;
  issue: string;
  parentIssue: string;
  baseCommit: string;
  startedAt: string;
  runner: { user: string; host: string; node: string };
  businessRequests: string[];
  maxAttemptsPerPhase: number;
  experienceInteraction: false;
  note: string;
};

export function requireRealModelAuthorization(): void {
  if (process.env.ACCEPT_REAL_MODEL !== "1")
    throw new Error(
      "缩短真实模型试跑需要显式授权：设置 ACCEPT_REAL_MODEL=1",
    );
  if (!process.env.GEMINI_API_KEY?.trim())
    throw new Error("GEMINI_API_KEY is not configured");
}

export function resolveBaseCommit(fallback = "HEAD"): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return fallback;
  }
}

export function buildShortenedTrialHeader(input: {
  issue: string;
  parentIssue: string;
  businessRequests: string[];
  baseCommit?: string;
}): ShortenedTrialHeader {
  return {
    kind: REAL_MODEL_SHORTENED_KIND,
    issue: input.issue,
    parentIssue: input.parentIssue,
    baseCommit: input.baseCommit ?? resolveBaseCommit(),
    startedAt: new Date().toISOString(),
    runner: {
      user: process.env.USER ?? process.env.USERNAME ?? "unknown",
      host: process.env.HOSTNAME ?? "unknown",
      node: process.version,
    },
    businessRequests: input.businessRequests,
    maxAttemptsPerPhase: 1,
    experienceInteraction: false,
    note:
      "缩短试跑证据；完整六步场景使用 real-model-full-six-step，不覆盖 issue-8 等历史验收记录。",
  };
}

const SENSITIVE_KEY =
  /^(authorization|api[_-]?key|gemini[_-]?api[_-]?key|token|secret)$/i;

export function redactSensitive(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/AIza[0-9A-Za-z_-]{30,}/.test(value))
      return value.replace(/AIza[0-9A-Za-z_-]{30,}/g, "[REDACTED_GEMINI_KEY]");
    return value;
  }
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value)) {
      if (SENSITIVE_KEY.test(key)) out[key] = "[REDACTED]";
      else out[key] = redactSensitive(nested);
    }
    return out;
  }
  return value;
}

export function summarizeCandidateResults(snapshot: AssistantSnapshot) {
  return (snapshot.candidates ?? []).map((candidate) => ({
    id: candidate.id,
    passed: candidate.passed,
    diagnostic: candidate.diagnostic,
    evidenceHash: candidate.evidenceHash,
    versionId: candidate.versionId,
  }));
}

export function summarizeRunConfirmation(snapshot: AssistantSnapshot) {
  const run = snapshot.run;
  if (!run) return null;
  const planSummary =
    "plan" in run && run.plan ? run.plan.summary : undefined;
  const planId = "plan" in run && run.plan ? run.plan.id : undefined;
  return {
    id: run.id,
    status: run.status,
    planId,
    planSummary,
    acceptanceRevisions: run.acceptanceRevisions?.map((revision) => ({
      id: revision.id,
      confirmedAt: revision.confirmedAt,
      changes: revision.changes.map((change) => ({
        rule: change.rule,
        reason: change.reason,
      })),
    })),
    pendingAcceptanceRevision:
      run.status === "awaiting-acceptance"
        ? {
            id: run.acceptanceRevision.id,
            changes: run.acceptanceRevision.changes.map((change) => ({
              rule: change.rule,
              reason: change.reason,
            })),
          }
        : undefined,
  };
}

export function formalWorkspaceFingerprint(input: {
  composition: Composition;
  tasks: TaskList;
}) {
  return {
    compositionRevision: input.composition.revision,
    versionId: input.composition.versionId,
    taskTotal: input.tasks.total,
    tasks: input.tasks.tasks.map((task) => ({
      id: task.id,
      state: task.state,
      fields: task.fields,
      revision: task.revision,
    })),
  };
}

export function assertFormalFingerprintUnchanged(
  label: string,
  before: ReturnType<typeof formalWorkspaceFingerprint>,
  after: ReturnType<typeof formalWorkspaceFingerprint>,
): void {
  if (JSON.stringify(before) !== JSON.stringify(after))
    throw new Error(
      `正式任务数据或组合指针在 ${label} 阶段被改动：${JSON.stringify({ before, after })}`,
    );
}
