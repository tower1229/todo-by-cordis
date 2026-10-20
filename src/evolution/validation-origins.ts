import type { InvestigatedPlan } from "../shared/assistant.js";
import { isInheritedAvailability } from "./action-availability.js";

export type ValidationOrigin = {
  requirementId: string;
  obligationId: string;
  aspect: string;
  origin: "requirement" | "host" | "observation" | "pending";
  sourceRevision?: string;
  scope:
    | { kind: "action"; member: string; action: string }
    | { kind: "field"; member: string; field: string }
    | { kind: "checker" };
};
/** A check's subject and role come from the compiled obligation, never review prose.
 * Action input rejection says nothing about task-wide requiredness. Observing an
 * alert says nothing about user-requested error text. Source review remains required.
 */
export function validationOrigins(
  plan: Pick<InvestigatedPlan, "requirements" | "binding">,
): ValidationOrigin[] {
  return (plan.requirements ?? []).flatMap((r) =>
    (r.obligations ?? []).flatMap((o): ValidationOrigin[] => {
      const base = { requirementId: r.id, obligationId: o.id };
      const claim = {
        origin: "requirement" as const,
        sourceRevision: r.sourceRevision,
      };
      if (o.kind === "workflow-input")
        return [
          {
            ...base,
            aspect: "generated-input-steps",
            origin: "host",
            scope: { kind: "checker" },
          },
          ...o.rules.map(
            (f): ValidationOrigin => ({
              ...base,
              aspect: "required-and-length",
              ...claim,
              scope: { kind: "field", member: "workflow", field: f.key },
            }),
          ),
        ];
      if (o.kind === "field")
        return [
          {
            ...base,
            aspect: "initial-display",
            origin: o.initialOrigin,
            ...(o.initialOrigin === "requirement"
              ? { sourceRevision: r.sourceRevision }
              : {}),
            scope: { kind: "field", member: o.member, field: o.field },
          },
          {
            ...base,
            aspect: "post-action-value",
            ...claim,
            scope: { kind: "field", member: o.member, field: o.field },
          },
        ];
      if (o.kind === "feedback" || o.kind === "backend-rejection")
        return [
          {
            ...base,
            aspect:
              o.kind === "feedback" ? "error-feedback" : "operation-rejection",
            ...(o.kind === "feedback" && o.resolution !== "required"
              ? {
                  origin:
                    o.resolution === "pending"
                      ? ("pending" as const)
                      : ("observation" as const),
                }
              : claim),
            scope: {
              kind: "action",
              member: o.action.member,
              action: o.action.action,
            },
          },
        ];
      if (o.kind === "assertion" && o.expected.kind === "action-visible")
        return [
          {
            ...base,
            aspect: "action-availability",
            ...(isInheritedAvailability(o, plan.binding?.actionAvailability)
              ? { origin: "host" as const }
              : claim),
            scope: {
              kind: "action",
              member: o.expected.member,
              action: o.expected.action,
            },
          },
        ];
      return [
        {
          ...base,
          aspect: o.kind,
          ...(o.kind === "ui-identity" ? { origin: "host" as const } : claim),
          scope: { kind: "checker" },
        },
      ];
    }),
  );
}
