/** Auxiliary contributor: tags field + setTags command. No workflow describe. */
export default {
  contribute() {
    return {
      fields: [{ key: "tags", label: "标签", type: "text" }],
      commands: [{ id: "setTags", label: "设标签", from: ["open", "done"] }],
    };
  },
  decide(data) {
    const { task, action, input } = data;
    if (action === "setTags")
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, tags: input?.tags ?? "" },
      };
    return { kind: "reject", message: "未知动作" };
  },
};
