import { isDeepStrictEqual } from "node:util";
import type { InvestigatedPlan } from "../../../src/shared/assistant.js";
import type { Composition } from "../../../src/shared/contracts.js";
import type { WorkspaceCaseEvidence } from "../../../src/server/workspace-acceptance.js";
import type { ExperienceBindings } from "./browser.js";

export function resolveExperienceBindings(input: {
  scenarioId: string;
  plan: InvestigatedPlan;
  composition: Composition;
  evidence: { passed?: boolean; workspaceCases?: WorkspaceCaseEvidence[] };
}): ExperienceBindings {
  const { scenarioId, plan, composition, evidence } = input;
  if (!evidence.passed)
    throw new Error("Evaluator binding: candidate not verified");
  const receipts = evidence.workspaceCases ?? [];
  const verified = (action: string, member?: string) =>
    receipts.some(
      (r) =>
        r.status === "passed" &&
        r.action === action &&
        Boolean(r.compositionVersionId) &&
        (!member || r.member === member),
    );
  if (scenarioId === "rule-revision-reflection") {
    const rules = plan.workflowRules.filter(
      (r) => r.required && r.minLength === 1 && r.maxLength === 5000,
    );
    if (rules.length !== 1 || !verified("complete"))
      throw new Error(
        "Evaluator binding: ambiguous reflection rule or missing receipt",
      );
    const field = composition.workflow.fields.find(
      (f) => f.key === rules[0].key,
    );
    if (!field) throw new Error("Evaluator binding: reflection field absent");
    return { reflection: { fieldLabel: field.label } };
  }
  const candidates: ExperienceBindings[] = [];
  for (const c of plan.memberCases ?? []) {
    if (c.expected.kind !== "commit" || !verified(c.action, c.member)) continue;
    if (
      !plan.capabilityChanges.some(
        (change) =>
          change.provider === `member:${c.member}` &&
          change.capability === "command.register",
      )
    )
      continue;
    const action = composition.workflow.actions.find(
      (a) => a.id === c.action && a.providerId === c.member,
    );
    if (!action) continue;
    const registeredLabels = [
      ...new Set(
        composition.uiContributions.flatMap((contribution) =>
          contribution.actions
            .filter((item) => item.commandId === action.id)
            .map((item) => item.label),
        ),
      ),
    ];
    if (registeredLabels.length > 1)
      throw new Error("Evaluator binding: ambiguous registered action labels");
    const actionLabel = registeredLabels[0] ?? action.label;
    for (const [key, value] of Object.entries(c.expected.fields)) {
      const field = composition.workflow.fields.find(
        (f) => f.key === key && f.providerId === c.member,
      );
      if (!field) continue;
      if (
        scenarioId === "counter-add" &&
        c.state === "open" &&
        Number(value) === Number(c.fields[key] ?? "0") + 1
      ) {
        candidates.push({
          counter: { actionLabel, fieldKey: key },
        });
      } else if (
        scenarioId === "tags-add" ||
        scenarioId === "member-upgrade-tags"
      ) {
        for (const [inputKey, inputValue] of Object.entries(c.input)) {
          if (
            !inputValue.trim() ||
            value !==
              (scenarioId === "tags-add"
                ? inputValue.trim()
                : inputValue.trim().toLowerCase())
          )
            continue;
          const labels = [
            ...new Set(
              receipts
                .filter(
                  (r) =>
                    r.status === "passed" &&
                    r.member === c.member &&
                    r.action === c.action,
                )
                .flatMap((r) => r.actual.formFields ?? [])
                .filter((f) => f.key === inputKey)
                .map((f) => f.label),
            ),
          ];
          if (labels.length > 1) continue;
          candidates.push({
            tags: {
              actionLabel,
              fieldLabel: labels[0] ?? field.label,
              inputKey,
              fieldKey: key,
              expected: scenarioId === "tags-add" ? "BrowserTag" : "browsertag",
            },
          });
        }
      }
    }
  }
  const unique = [...new Set(candidates.map((c) => JSON.stringify(c)))];
  if (unique.length !== 1)
    throw new Error(
      "Evaluator binding: cannot uniquely bind frozen business case to verified UI",
    );
  return JSON.parse(unique[0]) as ExperienceBindings;
}
