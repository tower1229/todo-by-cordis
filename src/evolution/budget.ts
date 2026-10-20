export class BudgetExhaustedError extends Error {
  constructor(
    message: string,
    readonly resource: "calls" | "candidates" | "milliseconds" = "calls",
    readonly phase?: ModelPhase,
  ) {
    super(message);
  }
}
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
  /** Whole-second allocations scale with the original run limit, never add time. */
  private reserve(fraction: number) {
    return Math.floor((this.limits.milliseconds * fraction) / 1000) * 1000;
  }
  get verificationMilliseconds() {
    return this.reserve(0.075);
  }
  private after(phase: ModelPhase) {
    return (
      this.verificationMilliseconds +
      (phase === "generation" ? 0 : this.reserve(0.15)) +
      (phase === "planning" || phase === "admission" ? this.reserve(0.15) : 0)
    );
  }
  modelWindow(phase: ModelPhase, milliseconds = this.limits.milliseconds) {
    // If the configured limit cannot allocate a whole-second reserve, its original
    // run deadline remains the sole timer (also preserves sub-second cancel tests).
    if (!this.after(phase)) return Math.max(1, milliseconds);
    const available = milliseconds - this.after(phase);
    if (available < Math.max(1, Math.min(10000, this.reserve(0.02))))
      throw new BudgetExhaustedError(
        "活动时间不足以完成后续复核、候选与浏览器验收，保留原预算并停止",
        "milliseconds",
        phase,
      );
    return available;
  }
  canClarify(
    used: number,
    admission = false,
    milliseconds = this.limits.milliseconds,
  ) {
    return (
      this.remaining(used) >= this.executionReserve + 2 + Number(admission) &&
      milliseconds > this.after("planning") + this.reserve(0.1)
    );
  }
  canAuditQuestion(used: number, milliseconds = this.limits.milliseconds) {
    return (
      this.remaining(used) >= this.executionReserve + 3 &&
      milliseconds > this.after("planning") + this.reserve(0.1)
    );
  }
  requireClarification(
    used: number,
    admission: boolean,
    milliseconds: number,
    audit = false,
  ) {
    const minimum = this.executionReserve + (audit ? 3 : 2 + Number(admission));
    if (this.remaining(used) < minimum)
      throw new BudgetExhaustedError(
        "剩余调用不足以审查澄清并完成后续规划、复核与候选执行",
      );
    if (milliseconds <= this.after("planning") + this.reserve(0.1))
      throw new BudgetExhaustedError(
        "剩余活动时间不足以审查澄清并完成后续阶段",
        "milliseconds",
        "planning",
      );
  }
  requireReady(used: number, milliseconds: number) {
    if (this.remaining(used) < this.executionReserve)
      throw new BudgetExhaustedError(
        "需求复核已耗尽执行调用预留，不能进入执行",
      );
    if (milliseconds < this.after("review"))
      throw new BudgetExhaustedError(
        "需求复核后活动时间不足以执行候选与浏览器验收",
        "milliseconds",
        "review",
      );
  }
  conclusionOnly(used: number, milliseconds = this.limits.milliseconds) {
    return (
      this.remaining(used) <= this.executionReserve + 2 ||
      milliseconds <= this.after("planning") + this.reserve(0.1)
    );
  }
  admit(
    used: number,
    phase: ModelPhase,
    milliseconds = this.limits.milliseconds,
  ) {
    const required =
      phase === "generation"
        ? 1
        : this.executionReserve +
          (phase === "review" ? 1 : phase === "admission" ? 3 : 2);
    if (this.remaining(used) < required)
      throw new BudgetExhaustedError(
        phase === "generation"
          ? `已达到 ${this.limits.calls} 次模型调用上限`
          : "预算不足：剩余调用无法容纳完整需求复核与候选执行，保留原预算并停止规划",
      );
    this.modelWindow(phase, milliseconds);
  }
  ready(used: number, milliseconds = this.limits.milliseconds) {
    return (
      this.remaining(used) >= this.executionReserve &&
      milliseconds >= this.after("review")
    );
  }
}
