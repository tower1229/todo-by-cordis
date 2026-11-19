import { hash } from "../release/storage.js";
import type { AcceptanceObligation } from "../shared/acceptance-obligations.js";
import type { BrowserStep } from "../shared/browser-cases.js";
import type { Requirement } from "../shared/assistant.js";

/** Strip host-injected complete/setup payloads; keep action identity. */
function surfaceStep(step: BrowserStep): BrowserStep {
  if (step.kind !== "action" || step.input === undefined) return step;
  const { input: _input, ...rest } = step;
  return rest;
}

/**
 * Business acceptance skeleton for revision gating.
 * Drops host projections (checks, workflow-input, host-derived fields,
 * assertion.availability, injected action.input) so compile-time churn on
 * unrelated inherited requirements does not demand acceptanceReason.
 */
export function acceptanceSurface(requirement: Requirement) {
  const obligations = (requirement.obligations ?? [])
    .filter((o) => o.kind !== "workflow-input")
    .filter(
      (o) =>
        !(
          o.kind === "field" &&
          (!!o.derivation || o.initialOrigin === "host")
        ),
    )
    .map((o) => surfaceObligation(o));
  return {
    id: requirement.id,
    description: requirement.description,
    sourceRevision: requirement.sourceRevision,
    sourceQuote: requirement.sourceQuote,
    type: requirement.type,
    obligations,
  };
}

function surfaceObligation(obligation: AcceptanceObligation) {
  if (obligation.kind === "assertion") {
    const { availability: _availability, ...rest } = obligation;
    return {
      ...rest,
      steps: obligation.steps.map(surfaceStep),
    };
  }
  if (obligation.kind === "field") {
    const {
      derivation: _derivation,
      history: _history,
      ...rest
    } = obligation;
    return {
      ...rest,
      scenarios: obligation.scenarios.map((s) => ({
        id: s.id,
        value: s.value,
        steps: s.steps.map(surfaceStep),
      })),
    };
  }
  if (obligation.kind === "feedback") {
    return {
      version: obligation.version,
      id: obligation.id,
      kind: obligation.kind,
      action: surfaceStep(obligation.action),
      text: obligation.text,
      resolution: obligation.resolution,
      scenarios: obligation.scenarios.map((s) => ({
        steps: s.steps.map(surfaceStep),
      })),
      unavailable: obligation.unavailable,
    };
  }
  if (obligation.kind === "history") {
    return {
      version: obligation.version,
      id: obligation.id,
      kind: obligation.kind,
      member: obligation.member,
      contribution: obligation.contribution,
      field: obligation.field,
    };
  }
  if (obligation.kind === "backend") {
    return {
      version: obligation.version,
      id: obligation.id,
      kind: obligation.kind,
      scope: obligation.scope,
    };
  }
  if (obligation.kind === "backend-rejection") {
    return {
      version: obligation.version,
      id: obligation.id,
      kind: obligation.kind,
      action: surfaceStep(obligation.action),
      cases: obligation.cases.map((c) => ({
        checker: c.checker,
        caseId: c.caseId,
      })),
    };
  }
  return obligation;
}

export function requirementAcceptanceChanged(
  old: Requirement,
  next: Requirement,
) {
  return hash(acceptanceSurface(old)) !== hash(acceptanceSurface(next));
}

/** Same gate as evolution.ts when an accepted requirement's business surface changes. */
export function requirementRevisionBlockers(
  inherited: Requirement[],
  next: Requirement[],
  acceptanceReason: unknown,
) {
  const blockers: string[] = [];
  for (const old of inherited) {
    const replacement = next.find((item) => item.id === old.id);
    if (!replacement || !requirementAcceptanceChanged(old, replacement))
      continue;
    if (typeof acceptanceReason !== "string" || !acceptanceReason.trim())
      blockers.push(`既有需求 ${old.id} 改变，须说明验收修订原因`);
  }
  return blockers;
}
