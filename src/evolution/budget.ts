export class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    readonly resource: "calls" | "milliseconds" = "calls",
  ) {
    super(message);
  }
}

export interface RunBudgetState {
  readonly callLimit: number;
  readonly callsUsed: number;
  readonly activeMsLimit: number;
  readonly activeMsUsed: number;
}

/**
 * Enforce bounded per-run model call count and active wall-clock time.
 * Throws BudgetExhaustedError so EvolutionLoop pauses in `awaiting_budget`
 * until the user explicitly extends the run budget.
 */
export function assertRunBudgetAvailable(budget: RunBudgetState): void {
  if (budget.callsUsed >= budget.callLimit) {
    throw new BudgetExhaustedError(
      `已达到 ${budget.callLimit} 次模型调用上限`,
      "calls",
    );
  }
  const remainingMs = budget.activeMsLimit - budget.activeMsUsed;
  if (remainingMs <= 0) {
    throw new BudgetExhaustedError(
      `已达到 ${Math.round(budget.activeMsLimit / 1000)}s 活动时间上限`,
      "milliseconds",
    );
  }
}
