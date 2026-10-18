import { isDeepStrictEqual } from "node:util";
import { hash } from "../../../src/release/storage.js";
import type { InvestigatedPlan } from "../../../src/shared/assistant.js";
import type { StabilityScenario } from "./manifest.js";
import type { Composition } from "../../../src/shared/contracts.js";
import type {
  BrowserCase,
  BrowserStep,
  BrowserEvidence,
} from "../../../src/shared/browser-cases.js";
import { browserViewports } from "../../../src/server/browser-acceptance.js";
import { workflowBrowserCases } from "../../../src/shared/workflow-browser.js";
import type { ExperienceBindings } from "./browser.js";
import type { RequestAdmission } from "../../../src/evolution/request-admission.js";
import type { Investigation } from "../../../src/server/planning.js";

export type OracleCheck = {
  id: string;
  status: "passed" | "failed" | "not-run";
  expected: unknown;
  actual: unknown;
  evidence?: string;
};
export type OracleBinding = { manifestHash: string; trialId: string };
export type OracleEvidence = {
  definitionHash: string;
  checks: OracleCheck[];
  binding?: OracleBinding;
};
export const oracleDefinitionHash = (
  scenario: StabilityScenario,
  binding?: OracleBinding,
) =>
  hash({
    request: scenario.request,
    clarification: scenario.clarification,
    oracle: scenario.oracle,
    binding,
  });
export function oracleCheck(
  id: string,
  expected: unknown,
  actual: unknown,
  evidence?: string,
): OracleCheck {
  return {
    id,
    status: isDeepStrictEqual(expected, actual) ? "passed" : "failed",
    expected,
    actual,
    ...(evidence ? { evidence } : {}),
  };
}

/** Requirements come from the frozen experiment, never from model-authored expectations. */
export function checkIndependentPlan(
  scenario: StabilityScenario,
  plan: Partial<InvestigatedPlan>,
  baseline: Partial<
    Pick<InvestigatedPlan, "workflowRules" | "requirements">
  > = {},
): OracleCheck[] {
  const oracle = scenario.oracle;
  if (!oracle || oracle.kind === "block") return [];
  const checks: OracleCheck[] = [];
  const obligations = (plan.requirements ?? []).flatMap(
    (r) => r.obligations ?? [],
  );
  const errorKey = (o: (typeof obligations)[number]) =>
    o.kind === "feedback" && o.resolution === "required" && o.text.trim()
      ? hash({ action: o.action, text: o.text })
      : o.kind === "assertion" &&
          o.expected.kind === "error" &&
          o.expected.text.trim()
        ? hash({
            action: o.steps.filter((s) => s.kind === "action").at(-1),
            text: o.expected.text,
          })
        : undefined;
  const baselineErrors = new Set(
    (baseline.requirements ?? [])
      .flatMap((r) => r.obligations ?? [])
      .map(errorKey)
      .filter(Boolean),
  );
  checks.push(
    oracleCheck(
      "plan:constraints",
      { fixedErrorText: false, unrelatedRules: false },
      {
        fixedErrorText: obligations.some(
          (o) => !!errorKey(o) && !baselineErrors.has(errorKey(o)),
        ),
        unrelatedRules: (plan.workflowRules ?? []).some(
          (rule) =>
            !(
              oracle.kind === "reflection" &&
              rule.required &&
              rule.minLength === oracle.minLength &&
              rule.maxLength === oracle.maxLength
            ) &&
            !(baseline.workflowRules ?? []).some((old) =>
              isDeepStrictEqual(rule, old),
            ),
        ),
      },
    ),
  );
  if (oracle.kind === "reflection") {
    const rules = (plan.workflowRules ?? []).filter(
      (r) =>
        r.required &&
        r.minLength === oracle.minLength &&
        r.maxLength === oracle.maxLength,
    );
    checks.push(
      oracleCheck(
        "plan:reflection",
        { rules: 1, browserObligation: true },
        {
          rules: rules.length,
          browserObligation: obligations.some(
            (o) => o.kind === "workflow-input",
          ),
        },
      ),
    );
  } else if (oracle.kind === "tags") {
    const cases = plan.memberCases ?? [];
    const normalize = (s: string) =>
      oracle.normalization === "lowercase" ? s.trim().toLowerCase() : s.trim();
    const success = cases.filter(
      (c) =>
        c.expected.kind === "commit" &&
        Object.entries(c.input).some(
          ([key, value]) =>
            value.trim() &&
            c.expected.kind === "commit" &&
            Object.values(c.expected.fields).includes(normalize(value)),
        ),
    );
    const rejection = cases.some(
      (c) =>
        c.expected.kind === "reject" &&
        Object.values(c.input).some((v) => !v.trim()),
    );
    checks.push(
      oracleCheck(
        "plan:tags",
        { normalizedWrite: true, blankRejected: true },
        { normalizedWrite: success.length > 0, blankRejected: rejection },
      ),
    );
  } else if (oracle.kind === "counter") {
    const cases = plan.memberCases ?? [];
    checks.push(
      oracleCheck(
        "plan:counter",
        true,
        cases.some(
          (c) =>
            c.state === "open" &&
            c.expected.kind === "commit" &&
            Object.entries(c.expected.fields).some(
              ([key, value]) =>
                Number(value) === Number(c.fields[key] ?? "0") + 1,
            ),
        ) &&
          cases.some((c) => c.state === "done" && c.expected.kind === "reject"),
      ),
    );
  } else {
    const expiryActions = new Set(
      (plan.memberCases ?? [])
        .filter(
          (c) =>
            c.expected.kind === "commit" &&
            Object.entries(c.expected.fields).some(
              ([key, value]) =>
                value === oracle.expiredValue && c.fields[key] !== value,
            ) &&
            !!c.input.scheduledAt,
        )
        .map((c) => c.action),
    );
    checks.push(
      oracleCheck(
        "plan:due",
        true,
        expiryActions.size > 0 &&
          !!plan.memberCases?.some(
            (c) =>
              expiryActions.has(c.action) &&
              c.state === "done" &&
              c.expected.kind === "reject",
          ) &&
          !!plan.requiredCapabilities?.some(
            (c) =>
              c.interfaceId === "schedule.runtime" &&
              c.providerId === "host:online-scheduler",
          ) &&
          !!plan.capabilityChanges?.some(
            (c) =>
              c.capability === "schedule.register" &&
              c.provider.startsWith("member:"),
          ),
      ),
    );
  }
  return checks;
}

export function requiredOracleChecks(scenario: StabilityScenario): string[] {
  if (!scenario.oracle) return [];
  if (scenario.oracle.kind === "block") return ["block:reason"];
  return [
    `plan:${scenario.oracle.kind}`,
    "plan:constraints",
    "candidate:browser",
    "path:experience",
    "path:apply",
    ...(scenario.clarification ? ["path:clarification"] : []),
  ];
}

export function oracleComplete(
  scenario: StabilityScenario,
  evidence?: OracleEvidence,
  binding = evidence?.binding,
): boolean {
  const required = requiredOracleChecks(scenario);
  if (!required.length) return true;
  return (
    !!evidence &&
    evidence.definitionHash === oracleDefinitionHash(scenario, binding) &&
    new Set(evidence.checks.map((c) => c.id)).size === evidence.checks.length &&
    required.every((id) =>
      evidence.checks.some(
        (c) =>
          c.id === id &&
          c.status === "passed" &&
          isDeepStrictEqual(c.expected, c.actual),
      ),
    )
  );
}

export function pendingOracle(
  scenario: StabilityScenario,
  binding?: OracleBinding,
): OracleEvidence {
  return {
    definitionHash: oracleDefinitionHash(scenario, binding),
    ...(binding ? { binding } : {}),
    checks: requiredOracleChecks(scenario).map((id) => ({
      id,
      status: "not-run",
      expected: "独立断言通过",
      actual: null,
    })),
  };
}

export function oracleRecorded(
  scenario: StabilityScenario,
  evidence?: OracleEvidence,
  binding = evidence?.binding,
): boolean {
  const required = requiredOracleChecks(scenario);
  return (
    !required.length ||
    (!!evidence &&
      evidence.definitionHash === oracleDefinitionHash(scenario, binding) &&
      evidence.checks.length === required.length &&
      new Set(evidence.checks.map((c) => c.id)).size === required.length &&
      required.every((id) => evidence.checks.some((c) => c.id === id)))
  );
}

/** Binding uses real identities only; every expected value is evaluator-authored. */
export function independentBrowserCases(
  scenario: StabilityScenario,
  composition: Composition,
  bindings: ExperienceBindings,
): BrowserCase[] {
  const oracle = scenario.oracle;
  if (!oracle || oracle.kind === "block")
    throw new Error("独立判定没有可执行的正向需求");
  if (oracle.kind === "reflection") {
    const fields = composition.workflow.fields.filter(
      (f) => f.label === bindings.reflection?.fieldLabel,
    );
    if (fields.length !== 1) throw new Error("独立判定无法唯一绑定复盘字段");
    return workflowBrowserCases("oracle:reflection", [
      {
        key: fields[0].key,
        label: fields[0].label,
        required: true,
        minLength: oracle.minLength,
        maxLength: oracle.maxLength,
      },
    ]);
  }
  const fieldKey =
    oracle.kind === "tags"
      ? bindings.tags?.fieldKey
      : oracle.kind === "counter"
        ? bindings.counter?.fieldKey
        : bindings.due?.inputKey;
  const label =
    oracle.kind === "tags"
      ? bindings.tags?.actionLabel
      : oracle.kind === "counter"
        ? bindings.counter?.actionLabel
        : bindings.due?.actionLabel;
  const actions = composition.workflow.actions.filter(
    (a) =>
      a.label === label ||
      composition.uiContributions.some(
        (c) =>
          c.providerId === a.providerId &&
          c.actions.some((x) => x.commandId === a.id && x.label === label),
      ),
  );
  if (!fieldKey || actions.length !== 1)
    throw new Error("独立判定无法唯一绑定字段与真实动作");
  const member = actions[0].providerId!;
  const fieldSurface = composition.uiContributions.some(
    (c) => c.providerId === member && c.fields.some((f) => f.key === fieldKey),
  )
    ? member
    : "workflow";
  const actionSurface = composition.uiContributions.some(
    (c) =>
      c.providerId === member &&
      c.actions.some((a) => a.commandId === actions[0].id),
  )
    ? member
    : "workflow";
  const action = (input?: Record<string, string>): BrowserStep => ({
    kind: "action",
    member,
    action: actions[0].id,
    ...(input ? { input } : {}),
  });
  const field = (value: string): BrowserStep => ({
    kind: "field",
    member: fieldSurface,
    field: fieldKey,
    value,
  });
  const persist = (value: string): BrowserStep[] => [
    field(value),
    { kind: "refresh" },
    field(value),
    { kind: "restart" },
    field(value),
  ];
  let scenarios: BrowserStep[][];
  if (oracle.kind === "tags") {
    if (!bindings.tags) throw new Error("独立判定缺少标签输入绑定");
    const expected =
      oracle.normalization === "lowercase" ? "browsertag" : "BrowserTag";
    scenarios = [
      [
        action({ [bindings.tags.inputKey]: "  BrowserTag  " }),
        ...persist(expected),
        { kind: "action", member: "workflow", action: "complete" },
        { kind: "action", member: "workflow", action: "reopen" },
        field(expected),
      ],
      [
        action({ [bindings.tags.inputKey]: "   " }),
        { kind: "error", text: "" },
      ],
    ];
  } else if (oracle.kind === "counter") {
    scenarios = [
      [
        action(),
        ...persist("1"),
        { kind: "action", member: "workflow", action: "complete" },
        {
          kind: "action-visible",
          member: actionSurface,
          action: actions[0].id,
          visible: false,
        },
        { kind: "action", member: "workflow", action: "reopen" },
        action(),
        field("2"),
      ],
    ];
  } else {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    scenarios = [
      [
        action({ [fieldKey]: at }),
        ...persist(at),
        action({ [fieldKey]: "" }),
        field("（空）"),
      ],
    ];
  }
  return scenarios.flatMap((steps, i) =>
    (["existing", "new"] as const).map((task) => ({
      id: `oracle:${oracle.kind}:${i + 1}:${task}`,
      task,
      steps,
    })),
  );
}

export function checkIndependentBlock(
  scenario: StabilityScenario,
  run: {
    status: string;
    blockReason?: string;
    requestAdmissions?: RequestAdmission[];
    protocolFailures?: unknown[];
    resourceFailures?: unknown[];
  },
  context: Pick<Investigation, "environment" | "capabilities">,
): OracleCheck {
  const oracle = scenario.oracle;
  let proven = false;
  if (
    oracle?.kind === "block" &&
    run.status === "blocked" &&
    run.blockReason === "maintainer-capability" &&
    !run.protocolFailures?.length &&
    !run.resourceFailures?.length
  ) {
    if (oracle.reason === "blank-presentation")
      proven = (run.requestAdmissions ?? []).some((admission) =>
        admission.technicalChecks.some(
          (check) =>
            check.factId === "host-fact:initial-field-presentation" &&
            check.outcome === "unsupported" &&
            check.expected.kind === "visible" &&
            check.expected.value === "" &&
            oracle.sources.some((q) => check.sourceQuote.includes(q)) &&
            admission.claims.some(
              (claim) =>
                claim.sourceRevision === check.sourceRevision &&
                claim.sourceQuote === check.sourceQuote &&
                admission.semanticReview?.decisions.some(
                  (d) => d.claimId === claim.id && d.verdict === "entailed",
                ),
            ),
        ),
      );
    else
      proven =
        context.environment.missing.length === 0 &&
        !context.capabilities.some((c) =>
          [
            "notification.deliver",
            "notification.send",
            "offline.delivery",
          ].includes(c.interfaceId),
        );
  }
  return oracleCheck("block:reason", true, proven);
}

export function checkIndependentBrowser(
  cases: BrowserCase[],
  evidence: BrowserEvidence,
): OracleCheck {
  const ids = new Set(cases.map((c) => c.id));
  const expected = cases
    .flatMap((c) =>
      browserViewports.map((v) => `${c.id}@${v.width}x${v.height}`),
    )
    .sort();
  const actual = evidence.results
    .filter((r) => ids.has(r.caseId) && r.status === "passed")
    .map((r) => `${r.caseId}@${r.viewport.width}x${r.viewport.height}`)
    .sort();
  return oracleCheck(
    "candidate:browser",
    { cases: expected, failures: 0 },
    {
      cases: actual,
      failures: evidence.results.filter((r) => r.status !== "passed").length,
    },
    "independent-browser.json",
  );
}
