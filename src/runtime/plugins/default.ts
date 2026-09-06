import type { Workflow } from "../../shared/contracts.js";
export const workflow: Workflow = {
  definition: {
    id: "default",
    name: "轻快完成",
    version: "1.0.0",
    initialState: "open",
    states: {
      open: { label: "未完成", category: "open" },
      done: { label: "已完成", category: "done" },
    },
    actions: [
      { id: "complete", label: "完成", from: ["open"] },
      { id: "reopen", label: "重新打开", from: ["done"] },
    ],
    fields: [],
  },
  decide(task, action) {
    if (
      !this.definition.actions.some(
        (a) => a.id === action && a.from.includes(task.state),
      )
    )
      return { kind: "reject", message: "当前状态不能执行此操作" };
    return {
      kind: "commit",
      state: action === "complete" ? "done" : "open",
      fields: task.fields,
    };
  },
};
