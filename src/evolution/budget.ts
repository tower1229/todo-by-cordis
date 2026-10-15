export class BudgetExhaustedError extends Error {}
export type BudgetLimits = {
  calls: number;
  candidates: number;
  milliseconds: number;
};
export type ModelPhase = "admission" | "planning" | "review" | "generation";

/** Admission, not a second budget. Every API attempt is still charged once. */
export class BudgetScheduler {
  constructor(readonly limits: BudgetLimits) {}
  get executionReserve() {
    return Math.min(3, this.limits.candidates);
  }
  remaining(used: number) {
    return Math.max(0, this.limits.calls - used);
  }
  canClarify(used: number, admission = false) {
    return this.remaining(used) >= this.executionReserve + 2 + Number(admission);
  }
  canAuditQuestion(used: number) {
    return this.remaining(used) >= this.executionReserve + 3;
  }
  conclusionOnly(used: number) {
    return this.remaining(used) <= this.executionReserve + 2;
  }
  admit(used: number, phase: ModelPhase) {
    const required =
      phase === "generation"
        ? 1
        : this.executionReserve + (phase === "review" ? 1 : phase === "admission" ? 3 : 2);
    if (this.remaining(used) < required)
      throw new BudgetExhaustedError(
        phase === "generation"
          ? `已达到 ${this.limits.calls} 次模型调用上限`
          : "预算不足：剩余调用无法容纳完整需求复核与候选执行，保留原预算并停止规划",
      );
  }
  ready(used: number) {
    return this.remaining(used) >= this.executionReserve;
  }
}
