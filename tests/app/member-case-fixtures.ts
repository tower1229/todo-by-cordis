/** Shared frozen member-case fixtures for planning / acceptance gate tests. */

/** Phase 1 shortened trial: trim and reject blank; case preserved. */
export const tagsTrimOnlyMemberCases = [
  {
    name: "标签去空格",
    member: "tags",
    state: "open",
    fields: {},
    action: "setTags",
    input: { tags: "  Hello " },
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { tags: "Hello" },
    },
  },
  {
    name: "空白标签拒绝",
    member: "tags",
    state: "open",
    fields: {},
    action: "setTags",
    input: { tags: "   " },
    expected: { kind: "reject" as const },
  },
];

export const tagsMemberCases = [
  {
    name: "标签去空格转小写",
    member: "tags",
    state: "open",
    fields: {},
    action: "setTags",
    input: { tags: "  Hello " },
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { tags: "hello" },
    },
  },
  {
    name: "空白标签拒绝",
    member: "tags",
    state: "open",
    fields: {},
    action: "setTags",
    input: { tags: "   " },
    expected: { kind: "reject" as const },
  },
];

export const panelMemberCases = [
  {
    name: "打备注标记成功",
    member: "panel",
    state: "open",
    fields: {},
    action: "markNote",
    input: {},
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { noteMark: "ok" },
    },
  },
  {
    name: "已完成不可打备注",
    member: "panel",
    state: "done",
    fields: {},
    action: "markNote",
    input: {},
    expected: { kind: "reject" as const },
  },
];

export const dueMemberCases = [
  {
    name: "设置截止日期成功",
    member: "due",
    state: "open",
    fields: {},
    action: "setDue",
    input: { dueAt: "2026-09-20T00:00:00Z" },
    expected: {
      kind: "commit" as const,
      state: "open",
      fields: { dueAt: "2026-09-20T00:00:00Z" },
    },
  },
  {
    name: "已完成不可设截止",
    member: "due",
    state: "done",
    fields: {},
    action: "setDue",
    input: { dueAt: "2026-09-21T00:00:00Z" },
    expected: { kind: "reject" as const },
  },
];
