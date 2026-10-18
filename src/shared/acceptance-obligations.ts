import type { BrowserCase, BrowserStep } from "./browser-cases.js";
import { workflowBrowserCases } from "./workflow-browser.js";

export type FieldExpectation =
  | { kind: "visible"; value: string }
  | { kind: "absent" };
export type BaselinePreparation = {
  baseVersion: string;
  actions: Extract<BrowserStep, { kind: "action" }>[];
  expected: { state: string; fields: Record<string, string> };
  sourceHash: string;
};
type Identity = { version: 1; id: string };
export type FeedbackUnavailable = {
  code: "action-hidden" | "state-unreachable" | "missing-rejection";
  state?: string;
};
export type RejectionReference = {
  checker: string;
  caseId: string;
  definitionHash: string;
};
export type AcceptanceObligation = Identity &
  (
    | {
        kind: "backend-rejection";
        action: Extract<BrowserStep, { kind: "action" }>;
        cases: RejectionReference[];
      }
    | {
        kind: "feedback";
        action: Extract<BrowserStep, { kind: "action" }>;
        text: string;
        resolution: "pending" | "required" | "not-requested";
        scenarios: { steps: BrowserStep[] }[];
        unavailable: FeedbackUnavailable[];
      }
    | { kind: "workflow-input"; rules: import("./assistant.js").WorkflowRule[] }
    | {
        kind: "ui-identity";
        workflow?: import("./browser-cases.js").WorkflowUiIdentity;
        contributions: {
          member: string;
          contribution: string;
          fields: string[];
          actions: string[];
        }[];
      }
    | {
        kind: "backend";
        scope: "checker-suite";
        checks: { checker: string; caseId: string }[];
      }
    | {
        kind: "history";
        member: string;
        contribution?: string;
        field: string;
        history: BaselinePreparation;
      }
    | {
        kind: "field";
        member: string;
        contribution?: string;
        field: string;
        initial: FieldExpectation;
        initialOrigin: "host" | "requirement";
        derivation?: { checker: "workflow/1" | "workspace/1" };
        history?: BaselinePreparation;
        scenarios: { id: string; steps: BrowserStep[]; value: string }[];
      }
    | {
        kind: "assertion";
        availability?: {origin:"host";state:string};
        steps: BrowserStep[];
        expected: Extract<
          BrowserStep,
          { kind: "action-visible" | "error" | "task" }
        >;
      }
  );

export function obligationCases(
  obligation: AcceptanceObligation,
): BrowserCase[] {
  if (obligation.kind === "backend" || obligation.kind === "backend-rejection")
    return [];
  if (obligation.kind === "workflow-input")
    return workflowBrowserCases(obligation.id, obligation.rules);
  const cases: BrowserCase[] = [];
  const add = (
    key: string,
    task: BrowserCase["task"],
    steps: BrowserStep[],
    prepare?: BaselinePreparation,
    classification: BrowserCase["classification"] = "frozen-business",
  ) =>
    cases.push({
      id: `${obligation.id}-${key}`,
      task,
      steps,
      ...(prepare ? { prepare } : {}),
      obligationId: obligation.id,
      classification,
    });
  const persist = (assertion: BrowserStep): BrowserStep[] => [
    assertion,
    { kind: "refresh" },
    assertion,
    { kind: "restart" },
    assertion,
  ];
  if (obligation.kind === "feedback") {
    if (obligation.resolution !== "required" || obligation.unavailable.length)
      return [];
    obligation.scenarios.forEach((scenario, index) => {
      for (const task of ["existing", "new"] as const)
        add(`${index + 1}-${task}`, task, [
          ...scenario.steps,
          { kind: "error", text: obligation.text },
        ]);
    });
    return cases;
  }
  if (obligation.kind === "ui-identity") {
    for (const task of ["existing", "new"] as const)
      add(
        task,
        task,
        persist({
          kind: "ui-identity",
          contributions: obligation.contributions,
          ...(obligation.workflow ? { workflow: obligation.workflow } : {}),
        }),
      );
    return cases;
  }
  if (obligation.kind === "assertion") {
    for (const task of ["existing", "new"] as const)
      add(task, task, [...obligation.steps, obligation.expected],undefined,obligation.availability?"system-protection":"frozen-business");
    return cases;
  }
  const field = (value: string, visible = true): BrowserStep => ({
    kind: "field",
    member: obligation.member,
    ...(obligation.contribution
      ? { contribution: obligation.contribution }
      : {}),
    field: obligation.field,
    value,
    ...(visible ? {} : { visible: false }),
  });
  const history = obligation.history;
  const historical = () => {
    if (!history) return;
    const value = history.expected.fields[obligation.field];
    if (value === undefined) throw new Error("历史准备未产生目标字段");
    add(
      `historical-${history.baseVersion.slice(0, 12)}-${history.sourceHash.slice(0, 12)}`,
      "existing",
      persist(field(value)),
      history,
    );
  };
  if (obligation.kind === "history") {
    historical();
    return cases;
  }
  const initial =
    obligation.initial.kind === "absent"
      ? field("", false)
      : field(obligation.initial.value);
  for (const task of ["existing", "new"] as const) {
    add(
      `initial-${obligation.initialOrigin}-${task}`,
      task,
      persist(initial),
      undefined,
      obligation.initialOrigin === "host"
        ? "system-protection"
        : "frozen-business",
    );
    for (const scenario of obligation.scenarios)
      add(
        `after-${scenario.id}-${task}`,
        task,
        [...scenario.steps, ...persist(field(scenario.value))],
        task === "existing" ? obligation.history : undefined,
      );
  }
  historical();
  return cases;
}
