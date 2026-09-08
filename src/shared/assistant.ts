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
export type AssistantRun = Run &
  (
    | { status: "planning" }
    | { status: "ready"; plan: InvestigatedPlan }
    | {
        status: "awaiting-acceptance";
        plan: InvestigatedPlan;
        acceptanceRevision: AcceptanceRevision;
      }
    | { status: "blocked"; message: string; plan?: InvestigatedPlan }
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
export type ExperienceReport = {
  candidateId: string;
  marked: "not-applied";
  isolated: true;
  simulated: true;
  checks: string[];
  presentation?: { title: string; fields: string[] };
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
