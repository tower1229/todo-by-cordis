// The host owns routing, plan identity and execution state. The UI never infers
// plugin intent from keywords or advances execution using elapsed time.
// Historical plans are retained as records, not executable routing commands.
export type AssistantRoute =
  | { kind: "application" }
  | { kind: "task" }
  | { kind: "create-plugin"; name: string }
  | { kind: "modify-plugin"; pluginId: string; name: string };

export type AssistantPlan = {
  id: string;
  compositionRevision: number;
  route: AssistantRoute;
  summary: string;
  changes: string[];
  outcome: string;
  dataImpact: string;
  baseVersion?: string;
  target?: { kind: "plugin" | "command"; id?: string };
  acceptance?: string[];
};
export type AssistantStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "succeeded" | "failed";
  attempt?: number;
};
export type AssistantEvent = {
  sequence: number;
  stepId: string;
  attempt: number;
  label: string;
  status: "started" | "succeeded" | "failed";
  tool?: string;
  detail?: string;
  at: string;
};
export type WorkflowRule = {
  key: string;
  label: string;
  required: boolean;
  minLength: number;
  maxLength: number;
};
export type PlanEvidence = { ref: string; hash: string };
export type AcceptanceRevision = {
  id: string;
  planId: string;
  baseVersion: string;
  changes: { rule: string; before: string; after: string; reason: string }[];
  confirmedAt?: string;
};
export type RepairEvidence = {
  baseVersion: string;
  definitionHash: string;
  diagnostic: string;
};
export type InvestigatedPlan = AssistantPlan & {
  intent?: "improve" | "repair";
  repairEvidence?: RepairEvidence;
  acceptanceChanges?: AcceptanceRevision["changes"];
  acceptanceRevision?: AcceptanceRevision;
  extensions?: import("../server/business-verification.js").BusinessExtensions;
  requestRevision: number;
  workflowRules: WorkflowRule[];
  ruleChanges: string[];
  excluded: string[];
  evidence: PlanEvidence[];
  capabilityChanges: {
    capability: string;
    provider: string;
    consumers: string[];
    change: string;
  }[];
  /** Host-allocated identities for auxiliary members to overlay on the base composition. */
  memberAdditions?: { pluginId: string; name: string }[];
  cases: { given: string; when: string; then: string; checker: string }[];
  steps: {
    id: string;
    purpose: string;
    dependsOn: string[];
    artifact: string;
    evidence: string;
  }[];
  writableScope: string[];
  compatibility: string;
  rollback: string;
  preview: string;
  application: string;
  restartImpact: string;
  dependencies: string[];
  unresolved: string[];
};
export type RequestRevision = {
  revision: number;
  type: "request" | "answer" | "revise";
  text: string;
  createdAt: string;
};
type Run = {
  historicalPlan?: AssistantPlan;
  diagnostics?: string[];
  intent?: "improve" | "repair";
  acceptanceRevisions?: AcceptanceRevision[];
  parentRunId?: string;
  baseVersion?: string;
  capabilityId?: string;
  parent?: { status: string; message?: string; budget?: Run["budget"] };
  id: string;
  request: string;
  updatedAt: string;
  versionId?: string;
  requestRevision?: number;
  revisions?: RequestRevision[];
  plans?: InvestigatedPlan[];
  evidence?: PlanEvidence[];
  budget?: {
    callsUsed: number;
    callsRemaining: number;
    candidatesRemaining: number;
    millisecondsRemaining: number;
  };
};
export const blockReasons = [
  "maintainer-capability",
  "missing-checker",
  "investigation",
  "protection",
  "execution",
  "other",
] as const;
export type BlockReason = (typeof blockReasons)[number];

/** Map host blockers to a short user-facing explanation; keep full text in message. */
export function describeBlockers(blockers: string[]): {
  message: string;
  userMessage: string;
  blockReason: BlockReason;
} {
  const parts = blockers.map((b) => b.trim()).filter(Boolean);
  const message = parts.join("；") || "当前无法开始执行";
  const text = message;
  if (
    /维护者|外部\s*IO|外部IO|通知交付|定时|调度|推送|沙箱|控制协议|尚未分离的混合文件/.test(
      text,
    )
  )
    return {
      message,
      blockReason: "maintainer-capability",
      userMessage:
        "这项改进需要系统级能力（例如到点提醒、外部通知或宿主升级），当前不能自行完成。可改成不依赖这些能力的需求，或等待维护者补齐后再试。",
    };
  if (/缺少可靠.*检查器|验证能力补齐|检查器/.test(text))
    return {
      message,
      blockReason: "missing-checker",
      userMessage:
        "当前还没有可靠方式验收这类行为，因此不能开始执行。请调整需求范围，或等待维护者补齐验收能力。",
    };
  if (/系统保护|保护范围|Agent 策略|伪造|未授权/.test(text))
    return {
      message,
      blockReason: "protection",
      userMessage:
        "该改动触及受保护的控制能力，普通改进不能修改。请缩小到业务范围内的需求。",
    };
  if (
    /调查证据|可写范围|尚未调查|基础版本已变化|依赖不可用|步骤依赖无效|业务规则修订必须说明/.test(
      text,
    )
  )
    return {
      message,
      blockReason: "investigation",
      userMessage:
        "调查尚未满足开始条件（证据、范围或依赖不完整）。请修改需求后重新规划。",
    };
  if (/冻结可写范围|保护验收|候选/.test(text))
    return {
      message,
      blockReason: "execution",
      userMessage:
        "执行过程中遇到保护边界或不可继续的障碍，已停止。请查看详情后修改需求或放弃。",
    };
  return {
    message,
    blockReason: "other",
    userMessage:
      "当前还不能开始执行这次改进。请修改需求或放弃计划；技术细节可在下方展开查看。",
  };
}

export type AssistantRun = Run &
  (
    | { status: "planning" }
    | { status: "ready"; plan: InvestigatedPlan }
    | {
        status: "awaiting-acceptance";
        plan: InvestigatedPlan;
        acceptanceRevision: AcceptanceRevision;
      }
    | {
        status: "blocked";
        message: string;
        userMessage: string;
        blockReason: BlockReason;
        plan?: InvestigatedPlan;
      }
    | { status: "interrupted"; message: string }
    | { status: "dismissed"; message: string }
    | { status: "awaiting-input"; question: string }
    | { status: "executing"; plan: InvestigatedPlan; steps: AssistantStep[] }
    | {
        status: "awaiting-apply";
        plan: InvestigatedPlan;
        steps: AssistantStep[];
        summary: string;
        experience?: ExperienceReport;
      }
    | {
        status: "applying";
        plan: InvestigatedPlan;
        steps: AssistantStep[];
        summary: string;
      }
    | { status: "succeeded"; summary: string; steps: AssistantStep[] }
    | { status: "failed"; message: string; steps: AssistantStep[] }
    | { status: "cancelled" }
  );
import type { ResolvedUiContribution } from "../server/business/contracts.js";

export type ExperienceReport = {
  candidateId: string;
  marked: "not-applied";
  isolated: true;
  simulated: true;
  checks: string[];
  presentation?: { title: string; fields: string[] };
  uiContributions?: ResolvedUiContribution[];
  note: string;
};
export type CandidateAttempt = {
  id: string;
  planId: string;
  baseVersion: string;
  attempt: number;
  passed: boolean;
  diagnostic?: string;
  evidenceHash?: string;
  versionId?: string;
  sourceHash: string;
};
export type AssistantSnapshot = {
  candidates?: CandidateAttempt[];
  availability: "ready" | "unconfigured";
  run: AssistantRun | null;
  events?: AssistantEvent[];
  eventCursor?: number;
};
export type AssistantCommand =
  | {
      type: "confirm-acceptance";
      operationId: string;
      runId: string;
      planId: string;
      revisionId: string;
    }
  | {
      type: "continue";
      operationId: string;
      runId: string;
      baseVersion: string;
      text: string;
      intent?: "improve" | "repair";
    }
  | {
      type: "request";
      operationId: string;
      text: string;
      runId?: string;
      intent?: "improve" | "repair";
    }
  | {
      type: "start";
      operationId: string;
      runId: string;
      planId: string;
    }
  | {
      type: "answer" | "revise";
      operationId: string;
      runId: string;
      text: string;
    }
  | { type: "cancel"; operationId: string; runId: string }
  | {
      type: "experience";
      operationId: string;
      runId: string;
      candidateId: string;
    }
  | {
      type: "apply";
      operationId: string;
      runId: string;
      candidateId: string;
      evidenceHash: string;
      compositionRevision: number;
    };

export function isAssistantWorking(run: AssistantRun | null | undefined) {
  return (
    run?.status === "planning" ||
    run?.status === "executing" ||
    run?.status === "applying"
  );
}
