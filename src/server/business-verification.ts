import type {
  Field,
  Action,
  WorkflowDefinition,
  WorkflowDecision,
  Task,
} from "./business/contracts.js";
import type { RuntimeLike } from "../release/types.js";
import { hash } from "../release/storage.js";

export class BusinessAssertionError extends Error {}

export type BusinessExtensions = {
  actions: Action[];
  fields: Field[];
  cases: {
    name: string;
    state: string;
    fields: Record<string, string>;
    action: string;
    input: Record<string, string>;
    expected:
      | { kind: "reject" }
      | { kind: "commit"; state: string; fields: Record<string, string> };
  }[];
};
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown): v is Record<string, string> =>
  record(v) &&
  Object.entries(v).every(
    ([k, v]) =>
      !["__proto__", "constructor", "prototype"].includes(k) &&
      typeof v === "string" &&
      v.length <= 5000,
  );
const id = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-z][a-zA-Z0-9_-]{0,63}$/.test(v) &&
  !["constructor", "prototype"].includes(v);
const text = (v: unknown): v is string =>
  typeof v === "string" && !!v.trim() && v.length <= 5000;

/** Bounded data cases interpreted by the host. No executable tests or model reports. */
export function parseExtensions(
  value: unknown,
  base: WorkflowDefinition,
  previous?: BusinessExtensions,
): BusinessExtensions | undefined {
  if (
    value === undefined ||
    (record(value) &&
      ["actions", "fields", "cases"].every(
        (key) => Array.isArray(value[key]) && value[key].length === 0,
      ))
  )
    return previous ? structuredClone(previous) : undefined;
  if (
    !record(value) ||
    !Array.isArray(value.actions) ||
    !Array.isArray(value.fields) ||
    !Array.isArray(value.cases) ||
    !value.actions.length ||
    value.actions.length > 8 ||
    value.fields.length > 8 ||
    value.cases.length > 40
  )
    throw new Error("业务扩展契约无效");
  for (const action of value.actions)
    if (
      !record(action) ||
      !id(action.id) ||
      !text(action.label) ||
      base.actions.some(
        (a) =>
          a.id === action.id &&
          (!previous?.actions.some((old) => old.id === action.id) ||
            hash(a) !== hash(action)),
      ) ||
      !Array.isArray(action.from) ||
      !action.from.length ||
      action.from.some(
        (s) => typeof s !== "string" || !Object.hasOwn(base.states, s),
      )
    )
      throw new Error("扩展动作无效或覆盖既有动作");
  for (const field of value.fields)
    if (
      !record(field) ||
      !id(field.key) ||
      !text(field.label) ||
      field.type !== "text" ||
      base.fields.some(
        (f) =>
          f.key === field.key &&
          (!previous?.fields.some((old) => old.key === field.key) ||
            hash(f) !== hash(field)),
      )
    )
      throw new Error("扩展字段无效或覆盖既有字段");
  for (const c of value.cases) {
    if (
      !record(c) ||
      !text(c.name) ||
      !id(c.state) ||
      !Object.hasOwn(base.states, c.state) ||
      !id(c.action) ||
      !value.actions.some((a) => a.id === c.action) ||
      !strings(c.fields) ||
      !strings(c.input) ||
      !record(c.expected)
    )
      throw new Error("业务案例无效");
    if (
      c.expected.kind !== "reject" &&
      !(
        c.expected.kind === "commit" &&
        id(c.expected.state) &&
        Object.hasOwn(base.states, c.expected.state) &&
        strings(c.expected.fields)
      )
    )
      throw new Error("业务案例期望无效");
  }
  const extension = structuredClone(value) as BusinessExtensions;
  if (
    new Set(extension.cases.map((c) => c.name)).size !==
      extension.cases.length ||
    new Set(extension.actions.map((a) => a.id)).size !==
      extension.actions.length ||
    new Set(extension.fields.map((f) => f.key)).size !== extension.fields.length
  )
    throw new Error("业务身份重复");
  for (const action of extension.actions) {
    if (
      !extension.cases.some(
        (c) => c.action === action.id && c.expected.kind === "commit",
      ) ||
      !extension.cases.some(
        (c) => c.action === action.id && c.expected.kind === "reject",
      )
    )
      throw new Error("每个新增动作必须有正例和反例");
  }
  if (previous) {
    extension.actions = [
      ...previous.actions,
      ...extension.actions.filter(
        (a) => !previous.actions.some((old) => old.id === a.id),
      ),
    ];
    extension.fields = [
      ...previous.fields,
      ...extension.fields.filter(
        (f) => !previous.fields.some((old) => old.key === f.key),
      ),
    ];
    extension.cases = [
      ...previous.cases.map(
        (old) => extension.cases.find((c) => c.name === old.name) ?? old,
      ),
      ...extension.cases.filter(
        (c) => !previous.cases.some((old) => old.name === c.name),
      ),
    ];
  }
  return extension;
}
export function extensionCases(extension: BusinessExtensions | undefined) {
  return (
    extension?.cases.map((c) => ({
      given: JSON.stringify({ state: c.state, fields: c.fields }),
      when: JSON.stringify({ action: c.action, input: c.input }),
      then: JSON.stringify(c.expected),
      checker: "business-actions/1",
    })) ?? []
  );
}
export async function verifyExtensions(
  runtime: RuntimeLike,
  extension: BusinessExtensions,
) {
  const checks: string[] = [];
  for (const c of extension.cases) {
    const task: Task = {
      id: "synthetic",
      title: "保留任务",
      description: "保留描述",
      state: c.state,
      fields: { ...c.fields, host_retained: "preserve" },
      revision: 7,
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      deletedAt: null,
    };
    const d = await runtime.invoke<WorkflowDecision>("decide", {
      task,
      action: c.action,
      input: c.input,
    });
    const expected =
      c.expected.kind === "commit"
        ? {
            ...c.expected,
            fields: { ...c.expected.fields, host_retained: "preserve" },
          }
        : c.expected;
    if (
      expected.kind === "reject"
        ? d.kind !== "reject"
        : hash(d) !== hash(expected)
    )
      throw new BusinessAssertionError(
        `业务验收失败：${c.name}；预期 ${JSON.stringify(expected)}；实际 ${JSON.stringify(d)}`,
      );
    checks.push(c.name);
  }
  return checks;
}
