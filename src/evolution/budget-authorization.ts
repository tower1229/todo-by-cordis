import type { BudgetLimits } from "./budget.js";
import { BudgetScheduler } from "./budget.js";
import type {
  BudgetPause,
  ResourceAmounts,
} from "../shared/evolution-interaction.js";

export function budgetPause(input: {
  revision: number;
  resume: "plan" | "execute";
  phase: string;
  resource: keyof ResourceAmounts;
  limits: BudgetLimits;
  calls: number;
  candidates: number;
  elapsed: number;
  message: string;
}): BudgetPause {
  const requiredCalls = input.resume === "execute" ? 1 : 6;
  const minimum: ResourceAmounts = {
    calls: Math.max(0, input.calls + requiredCalls - input.limits.calls),
    candidates: Math.max(0, input.candidates + 1 - input.limits.candidates),
    milliseconds: 0,
  };
  // Reservations scale with the authorized limit. Solve for enough time after
  // extension as well, so the proposed grant actually passes phase admission.
  const enoughTime = (extra: number) => {
    const limits = {
      ...input.limits,
      milliseconds: input.limits.milliseconds + extra,
    };
    try {
      new BudgetScheduler(limits).modelWindow(
        input.resume === "execute" ? "generation" : "planning",
        limits.milliseconds - input.elapsed,
      );
      return (
        input.resume === "execute" ||
        limits.milliseconds - input.elapsed > limits.milliseconds * 0.475
      );
    } catch {
      return false;
    }
  };
  if (!enoughTime(0)) {
    let extra = 1000;
    while (!enoughTime(extra)) extra *= 2;
    minimum.milliseconds = extra;
  }
  if (input.resource === "calls" && !minimum.calls) minimum.calls = 1;
  if (input.resource === "candidates" && !minimum.candidates)
    minimum.candidates = 1;
  if (input.resource === "milliseconds" && !minimum.milliseconds)
    minimum.milliseconds = 1000;
  const suggested = {
    calls: minimum.calls ? Math.max(6, minimum.calls) : 0,
    candidates: minimum.candidates,
    milliseconds: minimum.milliseconds
      ? Math.ceil(Math.max(900_000, minimum.milliseconds) / 60_000) * 60_000
      : 0,
  };
  return {
    revision: input.revision,
    resource: input.resource,
    resume: input.resume,
    phase: input.phase,
    minimum,
    suggested,
    message: input.message,
  };
}
