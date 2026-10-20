/** One executable source of truth for workflow/1 vectors and their descriptions. */
export const workflowTextSemantics = {
  validationNormalization: "trim",
  persistenceNormalization: "trim",
  lengthMetric: "unicode-code-point",
  unit: "Unicode 码点",
} as const;
export const workflowTextVector = (count: number, boundary = false) =>
  (boundary ? "🙂" : "字").repeat(count);

/** The schedule oracle emits only these receipts after its assertions pass. */
export const scheduleCheckSemantics = {
  execution: "isolated-controlled-clock-real-scheduler",
  assertions: {
    "on-time":
      "未设截止不武装；设置后武装；提前一毫秒不触发；到点通过真实调度提交冻结状态或字段",
    "completed-safe": "截止前完成的任务，到点不改写任务版本或字段",
    "updated-once":
      "修改截止后旧时间不触发，新时间提交预期效果；再次 tick 不重复提交",
    cleared: "清除截止撤销计时，到原时间不提交",
    deleted: "删除任务撤销计时，到原时间不恢复任务或保留注册",
    "recovery-run-once":
      "停止隔离调度服务并跨过截止再重启，run-once 补执行有效任务且再次重启不重复",
    "recovery-skip":
      "停止隔离调度服务并跨过截止再重启，skip 不补执行错过的截止",
  },
  limits:
    "仅验证候选实际登记的字段型调度与冻结成功案例所定义的效果；完成后重新打开和已过期再完成的保留仅在对应 schedule-policy 冻结义务存在时验证；不证明任意业务分支或页面呈现",
} as const;

export const scheduleCheckId = (
  schedule: string,
  check: keyof typeof scheduleCheckSemantics.assertions,
) => `schedule/1:${schedule}:${check}`;
