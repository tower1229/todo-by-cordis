import type { InvestigatedPlan, RequirementGate } from "../shared/assistant.js";
import { hash } from "../release/storage.js";

type Row = Record<string, unknown>;
function row(value: unknown): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("需求引用结构无效");
  return value as Row;
}
function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("需求引用列表无效");
  return value;
}
function at<T>(values: readonly T[], index: unknown): T {
  if (
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > values.length
  )
    throw new Error("需求案例或来源引用不存在");
  return values[index - 1];
}

/** Bind structured local references to host identities, before semantic validation. */
export function compileReferences(
  draft: Row,
  sources: RequirementGate["sources"],
  workflowCases: InvestigatedPlan["cases"],
  workflow: { id: string; actions: { id: string }[] },
  inherited: Pick<InvestigatedPlan, "memberCases" | "browserCases"> & {
    uiContributions?: {
      id: string;
      providerId: string;
      fields: { key: string }[];
      actions: { commandId: string }[];
    }[];
  } = {},
) {
  const memberCases = (
    Array.isArray(draft.memberCases) && draft.memberCases.length
      ? draft.memberCases
      : (inherited.memberCases ?? [])
  ) as {
    member: string;
    action: string;
    name: string;
    fields?: Row;
    input?: Row;
    expected?: { fields?: Row };
  }[];
  const extensions = (draft.extensions ?? {}) as {
    actions?: { id: string }[];
    fields?: { key: string }[];
    cases?: { name: string }[];
  };
  const rules = (draft.workflowRules ?? []) as { key: string; required?: boolean }[];
  const owner = (key: unknown, kind: "action" | "field") => {
    if (typeof key !== "string") throw new Error("浏览器业务引用无效");
    const ids = new Set<string>();
    if (
      kind === "action"
        ? [...workflow.actions, ...(extensions.actions ?? [])].some(
            (a) => a.id === key,
          )
        : [...rules, ...(extensions.fields ?? [])].some((f) => f.key === key)
    )
      ids.add("workflow");
    for (const c of memberCases) {
      if (
        kind === "action"
          ? c.action === key
          : [c.fields, c.input, c.expected?.fields].some(
              (fields) => fields && Object.hasOwn(fields, key),
            )
      )
        ids.add(c.member);
    }
    if (ids.size !== 1)
      throw new Error(`浏览器业务引用不存在或身份不唯一：${kind}:${key}`);
    return [...ids][0];
  };
  const browsers = list(draft.browserCases ?? []).map((value) => {
    const c = row(value);
    if (
      typeof c.id !== "string" ||
      !c.id.trim() ||
      Object.keys(c).some((k) => !["id", "task", "steps"].includes(k))
    )
      throw new Error("浏览器局部案例身份无效");
    const taskExpectation: Row = {};
    return {
      ...c,
      id: inherited.browserCases?.some((old) => old.id === c.id)
        ? c.id
        : "browser-" + hash({ workflow: workflow.id, key: c.id }).slice(0, 24),
      steps: list(c.steps).map((value) => {
        const s = row(value);
        if (s.kind === "edit") {
          if (s.title !== undefined) {
            if (typeof s.title !== "string") throw new Error("任务编辑标题无效");
            taskExpectation.title = s.title.trim();
          }
          if (s.description !== undefined) {
            if (typeof s.description !== "string") throw new Error("任务编辑备注无效");
            taskExpectation.description = s.description;
          }
        }
        if (s.kind === "task") {
          if (Object.keys(s).some(key => key !== "kind"))
            throw new Error("任务属性断言由宿主绑定合成基线及编辑步骤，不得提交手工期望");
          return {kind: "task", ...taskExpectation};
        }
        if (["action", "field", "action-visible"].includes(String(s.kind))) {
          if (s.member !== undefined || s.contribution !== undefined)
            throw new Error(
              "浏览器身份由宿主绑定，不得提交 member/contribution",
            );
          const member = owner(
            s.kind === "field" ? s.field : s.action,
            s.kind === "field" ? "field" : "action",
          );
          if (s.kind === "action") {
            // The trusted form uses native required validation. Such input cannot
            // reach the command or produce the visible alert asserted by error.
            if (member === "workflow" && s.action === "complete" && s.input !== undefined) {
              const input = row(s.input);
              const missing = rules.filter(f => f.required && (input[f.key] === undefined || input[f.key] === ""));
              if (missing.length)
                throw new Error(`浏览器案例 ${c.id} 的动作输入被宿主原生必填校验阻止，不能提交或断言页面 alert：${missing.map(f => f.key).join("、")}`);
            }
            return { ...s, member };
          }
          const matches = (inherited.uiContributions ?? []).filter(
            (c) =>
              c.providerId === member &&
              (s.kind === "field"
                ? c.fields.some((f) => f.key === s.field)
                : c.actions.some((a) => a.commandId === s.action)),
          );
          if (matches.length > 1) throw new Error("浏览器基线贡献身份不唯一");
          // Existing UI identities stay pinned; a renamed candidate cannot pass by matching the same field elsewhere.
          const contribution =
            member === "workflow" ? "workflow" : matches[0]?.id;
          return { ...s, member, ...(contribution ? { contribution } : {}) };
        }
        return s;
      }),
    };
  });
  const catalogs = {
    workflow: workflowCases.map((c, index) => ({
      checker: c.checker,
      caseId: `${c.checker}:${index + 1}`,
    })),
    member: memberCases.map((c) => ({
      checker: "workspace/1",
      caseId: `member:${c.member}:${c.name}`,
    })),
    action: (extensions.cases ?? []).map((c) => ({
      checker: "business-actions/1",
      caseId: `action:${c.name}`,
    })),
    browser: browsers.map((c) => ({ checker: "browser/1", caseId: c.id })),
    enabled: draft.memberEnabled
      ? [
          {
            checker: "host-member-enabled/1",
            caseId: "host-member-enabled/1:1",
          },
        ]
      : [],
  };
  const requirements = list(draft.requirements ?? []).map((value) => {
    const r = row(value);
    if (
      Object.keys(r).some(
        (k) =>
          ![
            "id",
            "description",
            "source",
            "sourceQuote",
            "type",
            "checks",
          ].includes(k),
      )
    )
      throw new Error("需求规格含未授权或宿主派生字段");
    if (r.sourceRevision !== undefined)
      throw new Error("需求来源修订由宿主绑定");
    const source = at(sources, r.source);
    const { source: _source, ...definition } = r;
    return {
      ...definition,
      sourceRevision: source.id,
      checks: list(r.checks).flatMap((value) => {
        const check = row(value);
        if (
          Object.keys(check).some((k) => !["kind", "index"].includes(k)) ||
          !Object.hasOwn(catalogs, String(check.kind))
        )
          throw new Error("需求案例引用无效，使用结构化 kind/index");
        const catalog = catalogs[check.kind as keyof typeof catalogs];
        if (
          ["workflow", "enabled"].includes(String(check.kind)) &&
          check.index === undefined
        )
          return catalog;
        return [at(catalog, check.index)];
      }),
    };
  });
  return { requirements, browserCases: browsers };
}
