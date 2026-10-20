import type { BudgetLimits } from "../evolution/budget.js";

/** Maintenance configuration only; never part of the model's tool contract. */
export function evolutionBudget(config: {
  EVOLUTION_MAX_CALLS?: string;
  EVOLUTION_ACTIVE_MINUTES?: string;
}): BudgetLimits {
  const integer = (value: string | undefined, fallback: number, label: string) => {
    if (value === undefined) return fallback;
    const number = Number(value);
    if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(number))
      throw new Error(`${label}必须为正整数`);
    return number;
  };
  const calls = integer(config.EVOLUTION_MAX_CALLS, 12, "模型调用上限");
  const milliseconds = integer(config.EVOLUTION_ACTIVE_MINUTES, 30, "活动时间分钟数") * 60_000;
  if (!Number.isSafeInteger(milliseconds)) throw new Error("活动时间超出安全整数范围");
  return { calls, candidates: 3, milliseconds };
}
