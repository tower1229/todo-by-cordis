const definition = {
  id: "hooked",
  name: "钩子夹具",
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

const life = [];

export default {
  describe() {
    return definition;
  },
  decide(data) {
    const { task, action, input } = data;
    if (action === "complete")
      return {
        kind: "commit",
        state: "done",
        fields: { ...task.fields, ...(input?.note ? { note: input.note } : {}) },
      };
    if (action === "reopen")
      return { kind: "commit", state: "open", fields: task.fields };
    if (action === "ping")
      return { kind: "commit", state: task.state, fields: task.fields };
    if (action === "setDue")
      return {
        kind: "commit",
        state: task.state,
        fields: { ...task.fields, dueAt: input?.dueAt ?? "" },
      };
    return { kind: "reject", message: "未知动作" };
  },
  contribute() {
    return {
      beforeCommit: true,
      events: ["task.created", "task.updated", "task.deleted"],
      diagnostics: true,
      lifecycle: {
        activate: true,
        ready: true,
        quiesce: true,
        dispose: true,
      },
      fields: [{ key: "dueAt", label: "截止", type: "text" }],
      commands: [
        { id: "ping", label: "轻触", from: ["open", "done"] },
        { id: "setDue", label: "设截止", from: ["open"] },
      ],
      schedules: [
        {
          id: "due-field",
          at: "dueAt",
          atKind: "field",
          dedupeKey: "due-field",
          onFire: { type: "action", commandId: "complete" },
          missPolicy: "skip",
        },
      ],
      uiSlots: [{ id: "due-badge", slot: "task-row" }],
      queryFilters: [{ id: "overdue", label: "已过期" }],
      querySorts: [{ id: "due", label: "截止", primary: true }],
      services: [{ id: "reminder", version: "1" }],
    };
  },
  lifecycleActivate() {
    life.push("activate");
    return { annotations: ["life:activate"] };
  },
  lifecycleReady() {
    life.push("ready");
  },
  lifecycleQuiesce() {
    life.push("quiesce");
  },
  lifecycleDispose() {
    life.push("dispose");
  },
  beforeCommit(data) {
    if (data.input?.block === "1")
      return { kind: "reject", message: "钩子拒绝提交" };
    return {
      kind: "ok",
      annotations: ["beforeCommit:ok"],
    };
  },
  onTaskEvent(data) {
    return {
      annotations: [`event:${data.kind}:${data.task.id}`],
    };
  },
  __life() {
    return life;
  },
};
