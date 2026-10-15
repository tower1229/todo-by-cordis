import type { AcceptanceObligation } from "../shared/acceptance-obligations.js";
import type { MemberAcceptanceCase } from "../shared/acceptance-cases.js";
import type { BrowserStep } from "../shared/browser-cases.js";
import type { Requirement } from "../shared/assistant.js";
import { hash } from "../release/storage.js";
import { readOnlyFieldText } from "../shared/field-presentation.js";

type Ui = {
  id: string;
  providerId: string;
  fields: { key: string }[];
  actions: { commandId: string }[];
};
type Rule = { key: string; minLength?: number };
export type ObligationBaseline = {
  uiContributions?: Ui[];
  memberCases?: MemberAcceptanceCase[];
  requirements?: Requirement[];
};

/** A new output for the same frozen operation is an upgrade, not merely an existing field. */
export function changesBaselineValue(
  obligation: Extract<AcceptanceObligation, { kind: "field" }>,
  baseline: MemberAcceptanceCase[],
) {
  return obligation.scenarios.some((s) => {
    const actions = s.steps.filter((step) => step.kind === "action");
    if (actions.length !== 1) return false;
    const action = actions[0];
    return baseline.some(
      (c) =>
        c.member === obligation.member &&
        c.action === action.action &&
        hash(c.input) === hash(action.input ?? {}) &&
        c.state === "open" &&
        !Object.keys(c.fields).length &&
        c.expected.kind === "commit" &&
        Object.hasOwn(c.expected.fields, obligation.field) &&
        c.expected.fields[obligation.field] !== s.value,
    );
  });
}

/** Facts come only from the frozen baseline, never candidate inputs or cases. */
export function fieldLifecycle(
  baseline: ObligationBaseline,
  workflowFields: { key: string }[] = [],
) {
  const fields = new Set(workflowFields.map((f) => `workflow:${f.key}`));
  for (const ui of baseline.uiContributions ?? [])
    for (const f of ui.fields) fields.add(`${ui.providerId}:${f.key}`);
  for (const c of baseline.memberCases ?? [])
    if (c.expected.kind === "commit")
      for (const [key, value] of Object.entries(c.expected.fields))
        if (c.fields[key] !== value) fields.add(`${c.member}:${key}`);
  for (const r of baseline.requirements ?? [])
    for (const o of r.obligations ?? [])
      if (o.kind === "field" || o.kind === "history")
        fields.add(`${o.member}:${o.field}`);
  return {
    existing: (target: { member: string; field: string }) =>
      fields.has(`${target.member}:${target.field}`),
    ui: (baseline.uiContributions ?? []).map((c) => ({
      member: c.providerId,
      contribution: c.id,
      fields: c.fields.map((f) => f.key),
      actions: c.actions.map((a) => a.commandId),
    })),
  };
}

/** Project executable browser consequences of selected structured backend cases.
 * This does not interpret natural language or claim unrelated UI requirements covered.
 * Explicit business expectations remain authoritative; an unbound UI target still fails coverage.
 */
export function deriveFieldObligations(
  requirement: Requirement,
  memberCases: MemberAcceptanceCase[],
  rules: Rule[],
  bind: (steps: unknown[]) => BrowserStep[],
  canonical: AcceptanceObligation[] = [],
  renderable: (target: {
    member: string;
    field: string;
    contribution?: string;
  }) => boolean = () => true,
): AcceptanceObligation[] {
  const projections: {
    field: string;
    steps: unknown[];
    value: string;
    checker: "workflow/1" | "workspace/1";
    caseKey: string;
  }[] = [];
  for (const c of memberCases) {
    if (
      !requirement.checks.some(
        (ref) =>
          ref.checker === "workspace/1" &&
          ref.caseId === `member:${c.member}:${c.name}`,
      ) ||
      c.expected.kind !== "commit" ||
      c.state !== "open" ||
      Object.keys(c.fields).length
    )
      continue;
    for (const [field, value] of Object.entries(c.expected.fields))
      projections.push({
        field,
        value,
        checker: "workspace/1",
        caseKey: c.name,
        steps: [{ kind: "action", action: c.action, input: c.input }],
      });
  }
  if (
    requirement.checks.some((ref) => ref.checker === "workflow/1") &&
    rules.length
  ) {
    const input = Object.fromEntries(
      rules.map((r) => [r.key, "验".repeat(Math.max(1, r.minLength ?? 1))]),
    );
    for (const r of rules)
      projections.push({
        field: r.key,
        checker: "workflow/1",
        caseKey: r.key,
        value: input[r.key],
        steps: [{ kind: "action", action: "complete", input }],
      });
  }
  const result: Extract<AcceptanceObligation, { kind: "field" }>[] = [];
  for (const p of projections) {
    // Binding rejects ambiguous owners; a backend-only field with no UI target is not
    // promoted into a UI assertion. The original backend check is retained.
    let target: BrowserStep;
    try {
      target = bind([{ kind: "field", field: p.field, value: "" }])[0];
    } catch {
      continue;
    }
    if (target.kind !== "field") continue;
    const declared = canonical.filter(
      (o) =>
        o.kind === "field" &&
        o.member === target.member &&
        o.field === target.field &&
        o.contribution === target.contribution,
    );
    if (!renderable(target) && !declared.length) continue;
    if (
      (requirement.obligations ?? []).some(
        (o) =>
          o.kind === "field" &&
          o.member === target.member &&
          o.field === target.field,
      )
    )
      continue;
    if (declared.length) {
      for (const d of declared)
        if (!result.some((o) => hash(o) === hash(d)))
          result.push(
            structuredClone(d) as Extract<
              AcceptanceObligation,
              { kind: "field" }
            >,
          );
      continue;
    }
    const id =
      "field-" +
      hash({
        member: target.member,
        contribution: target.contribution,
        field: target.field,
      }).slice(0, 24);
    const o =
      result.find((o) => o.id === id) ??
      ({
        version: 1,
        id,
        kind: "field",
        member: target.member,
        ...(target.contribution ? { contribution: target.contribution } : {}),
        field: target.field,
        initialOrigin: "host",
        initial:
          target.member === "workflow"
            ? { kind: "absent" }
            : { kind: "visible", value: readOnlyFieldText(undefined) },
        scenarios: [],
        derivation: { checker: p.checker },
      } satisfies Extract<AcceptanceObligation, { kind: "field" }>);
    const steps = bind(p.steps);
    const scenario = {
      id: hash({
        checker: p.checker,
        field: p.field,
        caseKey: p.caseKey,
      }).slice(0, 16),
      steps,
      value: p.value,
    };
    if (!o.scenarios.some((s) => hash(s) === hash(scenario)))
      o.scenarios.push(scenario);
    if (!result.includes(o)) result.push(o);
  }
  return result;
}
