/** Minimal main workflow provider for multi-plugin composition fixtures. */
const definition = {
  id: "aux-workflow",
  name: "组合主流程",
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
};

export default {
  describe() {
    return definition;
  },
  decide(data) {
    const { task, action } = data;
    if (action === "complete")
      return { kind: "commit", state: "done", fields: task.fields };
    if (action === "reopen")
      return { kind: "commit", state: "open", fields: task.fields };
    return { kind: "reject", message: "未知动作" };
  },
  contribute() {
    return {};
  },
};
