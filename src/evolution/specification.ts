import type { InvestigatedPlan } from "../shared/assistant.js";
import type { ChangeDefinition, ChangeSpec } from "../shared/change-spec.js";
import { hash } from "../release/storage.js";
import { hostCheckerRules } from "./checker-rules.js";

const keys = [
  "semanticState",
  "requirements",
  "browserCases",
  "workflowRules",
  "cases",
  "memberCases",
  "extensions",
  "memberAdditions",
  "memberUpgrades",
  "memberEnabled",
  "writableScope",
  "capabilityChanges",
  "requiredCapabilities",
  "binding",
  "acceptanceChanges",
  "affectedAcceptance",
  "excluded",
  "compatibility",
  "summary",
  "changes",
  "outcome",
  "dataImpact",
  "steps",
  "dependencies",
  "rollback",
  "preview",
  "application",
  "restartImpact",
  "intent",
] as const satisfies readonly (keyof ChangeDefinition)[];

export function changeDefinition(plan: InvestigatedPlan): ChangeDefinition {
  return Object.fromEntries(
    keys.filter((k) => plan[k] !== undefined).map((k) => [k, plan[k]]),
  ) as ChangeDefinition;
}

export function compileSpec(
  plan: InvestigatedPlan,
  runId: string,
  baseHash: string,
  baseline?: import("../server/business/contracts.js").WorkflowDefinition,
): ChangeSpec {
  return {
    version: "change/3",
    runId,
    requestRevision: plan.requestRevision,
    baseVersion: plan.baseVersion!,
    compositionRevision: plan.compositionRevision,
    baseHash,
    definition: structuredClone(changeDefinition(plan)),
    ...(baseline
      ? {
          workflowDefinition: {
            ...structuredClone(baseline),
            version: "generated",
            actions: [
              ...baseline.actions,
              ...(plan.extensions?.actions ?? []).filter(
                (a) => !baseline.actions.some((old) => old.id === a.id),
              ),
            ],
            fields: [
              ...plan.workflowRules.map((f) => ({
                key: f.key,
                label: f.label,
                type: "text" as const,
                required: f.required,
              })),
              ...(plan.extensions?.fields ?? []),
            ],
          },
        }
      : {}),
    requirementOrigins: (plan.requirements ?? []).map((r) => ({
      id: r.id,
      sourceRevision: r.sourceRevision,
      origin: !r.sourceRevision.startsWith(runId + ":")
        ? "inherited"
        : r.sourceRevision.endsWith(":1")
          ? "request"
          : "clarification",
    })),
    choices: ["writableScope", "dependencies", "capabilityChanges"].map(
      (field) => ({
        field,
        origin: "implementation",
        value: structuredClone(
          plan[field as "writableScope" | "dependencies" | "capabilityChanges"],
        ),
      }),
    ),
    materials: structuredClone(plan.binding?.materials ?? plan.evidence),
    hostRules: hostCheckerRules(plan),
    invariants: [
      {
        id: "preserve-data",
        origin: "host",
        contract: "preserveUnknownFields=true",
      },
      {
        id: "protected-controls",
        origin: "host",
        contract: "frozen-scope;trusted-checkers;independent-apply",
      },
      {
        id: "verification-order",
        origin: "host",
        contract: "build;backend;browser/1",
      },
    ],
  };
}

export function specificationFailure(plan: InvestigatedPlan) {
  const spec = plan.changeSpec;
  if (!spec || spec.version !== "change/3")
    return "缺少统一变更规格，请重新规划";
  if (
    spec.requestRevision !== plan.requestRevision ||
    spec.baseVersion !== plan.baseVersion ||
    spec.compositionRevision !== plan.compositionRevision ||
    hash(spec.definition) !== hash(changeDefinition(plan)) ||
    hash(spec.hostRules) !== hash(hostCheckerRules(plan))
  )
    return "冻结需求的统一变更规格与执行投影不一致，请重新规划";
}
