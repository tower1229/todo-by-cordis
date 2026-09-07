// The host owns routing, plan identity and execution state. The UI never infers
// plugin intent from keywords or advances execution using elapsed time.
// Legacy task/plugin variants remain readable in persisted historical plans.
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
export type InvestigatedPlan = AssistantPlan & {
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
    | { status: "blocked"; message: string; plan?: InvestigatedPlan }
    | { status: "interrupted"; message: string }
    | { status: "dismissed"; message: string }
    | { status: "awaiting-input"; question: string }
    | { status: "awaiting-confirmation"; plan: AssistantPlan }
    | { status: "executing"; plan: InvestigatedPlan; steps: AssistantStep[] }
    | {
        status: "awaiting-apply";
        plan: InvestigatedPlan;
        steps: AssistantStep[];
        summary: string;
      }
    | { status: "succeeded"; summary: string; steps: AssistantStep[] }
    | { status: "failed"; message: string; steps: AssistantStep[] }
    | { status: "cancelled" }
  );
export type AssistantSnapshot = {
  availability: "ready" | "unconfigured";
  run: AssistantRun | null;
  events?: AssistantEvent[];
  eventCursor?: number;
};
export type AssistantCommand =
  | { type: "request"; operationId: string; text: string; runId?: string }
  | {
      type: "start";
      operationId: string;
      runId: string;
      planId: string;
    }
  | {
      type: "confirm";
      operationId: string;
      runId: string;
      planId: string;
      compositionRevision: number;
    }
  | {
      type: "answer" | "revise";
      operationId: string;
      runId: string;
      text: string;
    }
  | { type: "cancel"; operationId: string; runId: string };

export function isAssistantWorking(run: AssistantRun | null | undefined) {
  return run?.status === "planning" || run?.status === "executing";
}
