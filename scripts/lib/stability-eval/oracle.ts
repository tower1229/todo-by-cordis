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
import {
  admissionResolved,
  type RequestAdmission,
} from "../../../src/evolution/request-admission.js";
import {
  capabilityFacts,
  effectReviewResolved,
} from "../../../src/evolution/capability-admission.js";
import type { Investigation } from "../../../src/server/planning.js";
import { schedulePolicyChecks } from "../../../src/shared/schedule-policy.js";
import { scheduleCheckSemantics } from "../../../src/shared/checker-semantics.js";

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
export const duePolicyCheckIds = [
  "past-due",
  "complete-retains-expired",
  "modify-clears-expired",
  "clear-removes-deadline-and-expired",
  "complete-before-due",
  "reopen-past-due",
] as const;
export function checkDuePolicy(checks: OracleCheck[]): OracleCheck {
  return oracleCheck(
    "path:due-policy",
    { checks: [...duePolicyCheckIds].sort(), failures: 0 },
    {
      checks: checks
        .filter(
          (c) =>
            c.status === "passed" && isDeepStrictEqual(c.expected, c.actual),
        )
        .map((c) => c.id)
        .sort(),
      failures: checks.filter(
        (c) =>
          c.status !== "passed" || !isDeepStrictEqual(c.expected, c.actual),
      ).length,
    },
  );
}
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
    const firing = (plan.memberCases ?? [])
        .filter(
          (c) =>
            c.expected.kind === "commit" &&
            Object.entries(c.expected.fields).some(
              ([key, value]) =>
                value === oracle.expiredValue && c.fields[key] !== value,
            ) &&
            !!c.input.scheduledAt,
        );
    const expiryActions = new Set(firing.map(c => c.action));
    const scheduledCompletionProtection = hasBoundCompletedSafety(plan);
    checks.push(
      oracleCheck(
        "plan:due",
        true,
        firing.some(fired =>
          plan.capabilityChanges?.some(change => change.capability === "schedule.register" && change.provider === `member:${fired.member}`) &&
          (scheduledCompletionProtection || plan.memberCases?.some(c =>
            c.member === fired.member && c.action === fired.action && c.state === "done" && c.expected.kind === "reject")),
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
    if (oracle.lifecyclePolicy)
      checks.push(
        oracleCheck(
          "plan:due-policy",
          true,
          hasDeadlineResetCases(plan, expiryActions),
        ),
      );
  }
  return checks;
}

/** A plan may rely on the frozen scheduler's executable completion protection.
 * This is pending checker coverage, never evidence that a candidate already passed.
 * The independent browser path still completes before the deadline and checks the real task.
 */
function hasBoundCompletedSafety(plan: Partial<InvestigatedPlan>) {
  const checker = plan.binding?.checkers.find(c => c.id === "schedule/1");
  const fact = plan.changeSpec?.hostFacts.find(f => f.id === "host-fact:checker:schedule/1");
  if (!checker || !/^[a-f0-9]{64}$/.test(checker.version) || !fact) return false;
  const {evidenceHash, ...definition} = fact;
  return plan.changeSpec!.baseVersion === plan.baseVersion &&
    evidenceHash === hash({fact: definition, checkers: plan.binding!.checkers, rules: plan.workflowRules}) &&
    fact.properties.checker === checker.id && fact.properties.checkerHash === checker.version &&
    fact.properties.stage === "candidate-verification-required" &&
    fact.properties.execution === scheduleCheckSemantics.execution &&
    fact.properties["assert:completed-safe"] === scheduleCheckSemantics.assertions["completed-safe"];
}

function hasDeadlineResetCases(
  plan: Partial<InvestigatedPlan>,
  expiryActions: Set<string>,
): boolean {
  const cases = plan.memberCases ?? [];
  for (const fired of cases) {
    if (!expiryActions.has(fired.action) || fired.expected.kind !== "commit")
      continue;
    for (const [expired, value] of Object.entries(fired.expected.fields)) {
      if (value !== "true" || fired.fields[expired] === value) continue;
      const deadline = Object.keys(fired.fields).find(
        (key) => fired.fields[key] === fired.input.scheduledAt,
      );
      if (!deadline) continue;
      if (plan.requirements?.some(requirement =>
        requirement.obligations?.some(obligation =>
          obligation.kind === "schedule-policy" &&
          obligation.version === 1 &&
          obligation.action.member === fired.member &&
          obligation.action.action === fired.action &&
          obligation.fireCase.caseId === `member:${fired.member}:${fired.name}` &&
          obligation.fireCase.definitionHash === hash(fired) &&
          obligation.checks.includes("reset-clears-effect") &&
          schedulePolicyChecks(obligation).every(check =>
            requirement.checks.some(bound => hash(bound) === hash(check))),
        ),
      )) return true;
      const resets = cases.filter(
        (c) =>
          c.member === fired.member &&
          c.state === "open" &&
          c.fields[expired] === "true" &&
          !!c.fields[deadline] &&
          Object.hasOwn(c.input, deadline) &&
          c.expected.kind === "commit" &&
          c.expected.fields[expired] !== "true",
      );
      if (
        resets.some(
          (c) =>
            c.input[deadline] === "" &&
            c.expected.kind === "commit" &&
            !c.expected.fields[deadline],
        ) &&
        resets.some(
          (c) =>
            !!c.input[deadline] &&
            c.input[deadline] !== c.fields[deadline] &&
            c.expected.kind === "commit" &&
            c.expected.fields[deadline] === c.input[deadline],
        )
      )
        return true;
    }
  }
  return false;
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
    ...(scenario.oracle.kind === "due" && scenario.oracle.lifecyclePolicy
      ? ["plan:due-policy", "path:due-policy"]
      : []),
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
          kind: "action-blocked",
          member,
          action: actions[0].id,
        },
        { kind: "action", member: "workflow", action: "reopen" },
        action(),
        field("2"),
      ],
    ];
  } else {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    scenarios = [
      [action({ [fieldKey]: at }), ...persist(at), action({ [fieldKey]: "" })],
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
    stop?: import("../../../src/shared/assistant.js").RunStop;
    clarificationReviews?: {
      decision: import("../../../src/evolution/clarification-review.js").ClarificationDecision;
    }[];
  },
  context: Pick<Investigation, "environment" | "capabilities">,
): OracleCheck {
  const oracle = scenario.oracle;
  let proven = false;
  if (
    oracle?.kind === "block" &&
    run.status === "blocked" &&
    run.blockReason === "maintainer-capability" &&
    !["protocol", "output-budget", "transport", "environment"].includes(
      run.stop?.kind ?? "",
    )
  ) {
    if (oracle.reason === "blank-presentation")
      proven = (run.requestAdmissions ?? [])
        .filter(admissionResolved)
        .some((admission) =>
          admission.technicalChecks.some(
            (check) =>
              check.factId === "host-fact:initial-field-presentation" &&
              check.outcome === "unsupported" &&
              check.expected.kind === "visible" &&
              check.expected.value === "" &&
              admission.claims.some(
                (claim) =>
                  claim.sourceRevision === check.sourceRevision &&
                  claim.sourceQuote === check.sourceQuote &&
                  admission.semanticReview?.decisions.some(
                    (d) =>
                      d.claimId === claim.id &&
                      d.sourceRevision === check.sourceRevision &&
                      d.verdict === "entailed" &&
                      d.layer === "initial-display" &&
                      oracle.sources.some((q) => d.sourceQuote.includes(q)),
                  ),
              ),
          ),
        );
    else
      proven =
        context.environment.missing.length === 0 &&
        !context.environment.browser?.missing.length &&
        (run.requestAdmissions ?? []).filter(admissionResolved).some((a) => {
          const checks = [
            ...a.capabilityChecks.filter((c) =>
              a.semanticReview?.decisions.some(
                (decision) => decision.claimId === c.claimId &&
                  decision.layer === "capability" && decision.verdict === "entailed",
              ),
            ),
            ...(run.clarificationReviews ?? []).flatMap((r) =>
              effectReviewResolved(
                r.decision.effects,
                a.sources,
                a.factsSnapshot,
              )
                ? r.decision.effects!.checks.filter(
                    (c) => c.verdict === "required",
                  )
                : [],
            ),
          ];
          return (
            a.sources.some((s) => s.text === scenario.request) &&
            checks.some(
              (c) =>
                ["external-delivery", "offline-delivery"].includes(c.effect) &&
                c.outcome === "unsupported" &&
                capabilityFacts(context.capabilities).some(
                  (f) =>
                    f.id === c.factId &&
                    f.evidenceHash === c.factHash &&
                    f.properties.availability === "unsupported",
                ) &&
                scenario.request.includes(c.sourceQuote),
            )
          );
        });
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
