/** Auxiliary contributor: task.detail UI contribution + markNote command. */
export default {
  contribute() {
    return {
      fields: [{ key: "noteMark", label: "备注标记", type: "text" }],
      commands: [{ id: "markNote", label: "打备注标记", from: ["open"] }],
      uiSlots: [
        {
          id: "note-panel",
          slot: "task.detail",
          title: "备注面板",
          body: "仅用于验证成员停用后 UI 贡献退出。",
          actions: [{ commandId: "markNote", label: "打备注标记" }],
          fields: [{ key: "noteMark", label: "备注标记" }],
        },
      ],
    };
  },
  decide(data) {
    const { task, action } = data;
    if (action === "markNote") {
      if (task.state !== "open")
        return { kind: "reject", message: "仅未完成任务可打备注标记" };
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, noteMark: "ok" },
      };
    }
    return { kind: "reject", message: "未知动作" };
  },
};
