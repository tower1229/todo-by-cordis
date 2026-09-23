export default {
  contribute() {
    return {
      commands: [
        { id: "set-tag", label: "设置标签" }
      ],
      fields: [
        { key: "tag", label: "标签", type: "text" }
      ],
      uiSlots: [
        {
          id: "tag-detail",
          slot: "task.detail",
          title: "标签",
          fields: [{ key: "tag", label: "标签" }],
          actions: [{ commandId: "set-tag", label: "设置标签" }]
        }
      ]
    };
  },
  decide(data) {
    if (data.action === "set-tag") {
      if (!data.input || typeof data.input.tag !== "string") {
        return {
          kind: "input-required",
          fields: [{ key: "tag", label: "标签", type: "text", required: true }]
        };
      }
      const trimmedTag = data.input.tag.trim();
      if (!trimmedTag) {
        return {
          kind: "reject",
          message: "标签不能为空"
        };
      }
      return {
        kind: "commit",
        state: data.task.state,
        fields: {
          ...data.task.fields,
          tag: trimmedTag
        }
      };
    }
    return {
      kind: "reject",
      message: "未知的动作"
    };
  }
};