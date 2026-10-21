/** Accepted synthetic baseline: lowercase conversion is added by the later upgrade. */
export default {
  contribute() {
    return {
      fields: [{ key: "tags", label: "标签", type: "text" }],
      commands: [{ id: "setTags", label: "设标签", from: ["open", "done"] }],
      uiSlots: [{ id: "tag-detail", slot: "task.detail", title: "标签",
        fields: [{ key: "tags", label: "标签" }],
        actions: [{ commandId: "setTags", label: "编辑标签" }] }],
    };
  },
  decide({ task, action, input }) {
    if (action !== "setTags") return { kind: "reject", message: "未知动作" };
    if (!Object.hasOwn(input ?? {}, "tags"))
      return { kind: "input-required", fields: [{ key: "tags", label: "标签", type: "text", required: true }] };
    const tags = String(input.tags).trim();
    if (!tags) return { kind: "reject", message: "标签为空" };
    return { kind: "commit", state: task.state, fields: { ...task.fields, tags } };
  },
};
