/** One executable checker catalog for documentation, live coverage and plan binding. */
const checkers: Record<string, string> = {
  "workflow.provide": "workflow/1",
  "command.register": "workspace/1",
  "fields.register": "workspace/1",
  "task.beforeCommit": "beforeCommit/1",
  "ui.slot": "browser/1",
  "schedule.register": "schedule/1",
  "schedule.runtime": "schedule/1",
};
export const capabilityChecker = (interfaceId: string) => checkers[interfaceId];
export function capabilityCheckerContract(interfaceId: string) {
  const checker = capabilityChecker(interfaceId);
  return {
    checkers: checker ? [checker] : [],
    verificationSupport: checker ? "available" : "unavailable",
    verificationReason: checker
      ? "须满足对应检查器的覆盖条件并通过精确候选验收"
      : "运行时可登记不代表自迭代可验证；尚无可信检查器，不得作为可验收依赖",
    coverageRequirement:
      interfaceId === "fields.register"
        ? "实际字段注册、提供者身份、全部动作成对成功/拒绝案例及字段写入案例"
        : interfaceId === "command.register"
          ? "全部已注册动作的成对成功/拒绝案例"
          : interfaceId === "task.beforeCommit"
            ? "冻结主工作流动作案例、精确钩子真实调用及同候选仅跳过该钩子后的可观察差异"
          : "以精确提供者的动态 checkerCoverage 和运行环境为准",
  };
}
export function capabilityCheckerCoverage(
  interfaceId: string,
  evidence: { commands: boolean; fields: boolean; beforeCommit?: boolean },
) {
  const checker = capabilityChecker(interfaceId);
  if (
    !checker ||
    (interfaceId === "task.beforeCommit" && !evidence.beforeCommit) ||
    (interfaceId === "command.register" && !evidence.commands) ||
    (interfaceId === "fields.register" && !evidence.fields)
  )
    return [];
  return [checker];
}
