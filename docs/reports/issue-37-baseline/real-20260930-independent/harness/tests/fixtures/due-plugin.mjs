/** Auxiliary contributor: dueAt field + setDue command. No workflow describe. */
export default {
  contribute() {
    return {
      fields: [{ key: "dueAt", label: "截止日期", type: "text" }],
      commands: [{ id: "setDue", label: "设截止", from: ["open"] }],
      querySorts: [{ id: "due", label: "截止", primary: true }],
    };
  },
  decide(data) {
    const { task, action, input } = data;
    if (action === "setDue")
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, dueAt: input?.dueAt ?? "" },
      };
    return { kind: "reject", message: "未知动作" };
  },
};
