import type { Workflow } from "../../shared/contracts.js";
export const workflow: Workflow = {
  definition: {
    id: "review",
    name: "完成，也有收获",
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
    fields: [
      {
        key: "review",
        label: "这次，有什么收获？",
        type: "text",
        required: true,
        description: "留下一句复盘，让每一次完成都有回响。",
      },
    ],
  },
  decide(task, action, input) {
    if (
      !this.definition.actions.some(
        (a) => a.id === action && a.from.includes(task.state),
      )
    )
      return { kind: "reject", message: "当前状态不能执行此操作" };
    if (action === "reopen")
      return { kind: "commit", state: "open", fields: task.fields };
    if (!input.review?.trim())
      return { kind: "input-required", fields: this.definition.fields };
    if (input.review.length > 5000)
      return { kind: "reject", message: "复盘最多 5000 字" };
    return {
      kind: "commit",
      state: "done",
      fields: { ...task.fields, review: input.review.trim() },
    };
  },
};
