// The host owns routing, plan identity and execution state. The UI never infers
// plugin intent from keywords or advances execution using elapsed time.
export type AssistantRoute =
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
};
export type AssistantStep = {
  id: string;
  label: string;
  status: "pending" | "running" | "succeeded" | "failed";
};
type Run = { id: string; request: string; updatedAt: string };
export type AssistantRun = Run &
  (
    | { status: "planning" }
    | { status: "awaiting-input"; question: string }
    | { status: "awaiting-confirmation"; plan: AssistantPlan }
    | { status: "executing"; plan: AssistantPlan; steps: AssistantStep[] }
    | { status: "succeeded"; summary: string; steps: AssistantStep[] }
    | { status: "failed"; message: string; steps: AssistantStep[] }
    | { status: "cancelled" }
  );
export type AssistantSnapshot = {
  availability: "ready" | "unconfigured";
  run: AssistantRun | null;
};
export type AssistantCommand =
  | { type: "request"; operationId: string; text: string; runId?: string }
  | {
      type: "confirm";
      operationId: string;
      runId: string;
      planId: string;
      compositionRevision: number;
    }
  | { type: "cancel"; operationId: string; runId: string };

export function isAssistantWorking(run: AssistantRun | null | undefined) {
  return run?.status === "planning" || run?.status === "executing";
}
