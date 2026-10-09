export default {
  contribute() {
    return {
      uiSlots: [
        {
          id: "important-detail",
          slot: "task.detail",
          title: "优先级",
          fields: [{ key: "isImportant", label: "优先级" }],
          actions: [
            { commandId: "markImportant", label: "标记为重要" },
            { commandId: "unmarkImportant", label: "取消重要标记" }
          ]
        }
      ],
      fields: [
        { key: "isImportant", label: "优先级", type: "text" }
      ],
      commands: [
        { id: "markImportant", label: "标记为重要", from: ["open", "done"] },
        { id: "unmarkImportant", label: "取消重要标记", from: ["open", "done"] }
      ]
    };
  },
  decide({ task, action }) {
    if (action === "markImportant") {
      if (task.fields.isImportant === "重要") {
        return { kind: "reject", message: "已标记为重要" };
      }
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, isImportant: "重要" }
      };
    }
    if (action === "unmarkImportant") {
      if (task.fields.isImportant !== "重要") {
        return { kind: "reject", message: "未标记为重要" };
      }
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, isImportant: "普通" }
      };
    }
    return { kind: "reject", message: "未知动作" };
  }
};
