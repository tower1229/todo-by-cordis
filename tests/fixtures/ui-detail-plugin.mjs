/** Test-only main workflow: task.detail UI contribution + proof command. */
const definition = {
  id: "ui-detail",
  name: "UI 贡献证明",
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
    if (action === "markProof") {
      if (task.state !== "open")
        return { kind: "reject", message: "仅未完成任务可打证明标记" };
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, proofMark: "ok" },
      };
    }
    return { kind: "reject", message: "未知动作" };
  },
  contribute() {
    return {
      fields: [{ key: "proofMark", label: "证明标记", type: "text" }],
      commands: [{ id: "markProof", label: "打证明标记", from: ["open"] }],
      uiSlots: [
        {
          id: "proof-panel",
          slot: "task.detail",
          title: "扩展证明",
          body: "仅用于验证 UI 贡献闭环。",
          actions: [{ commandId: "markProof", label: "打证明标记" }],
          fields: [{ key: "proofMark", label: "证明标记" }],
        },
      ],
    };
  },
};
