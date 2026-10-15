import type { Requirement } from "../shared/assistant.js";
import type { BrowserCase, BrowserStep } from "../shared/browser-cases.js";
import type {
  AcceptanceObligation,
  BaselinePreparation,
} from "../shared/acceptance-obligations.js";
import type { MemberAcceptanceCase } from "../shared/acceptance-cases.js";
import { obligationCases } from "../shared/acceptance-obligations.js";
import { hash } from "../release/storage.js";
import { readOnlyFieldText } from "../shared/field-presentation.js";

type Row = Record<string, unknown>;
function row(value: unknown, keys: string[], required = keys): Row {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("验收义务结构无效");
  const r = value as Row;
  if (
    Object.keys(r).some((k) => !keys.includes(k)) ||
    required.some((k) => !Object.hasOwn(r, k))
  )
    throw new Error("验收义务缺少必需字段或包含宿主派生字段");
  return r;
}
function list(value: unknown, minimum = 1, maximum = 30): unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum)
    throw new Error("验收义务列表无效或缺失");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || value.length > 10000)
    throw new Error("验收义务文本无效");
  return value;
}

/** History is a replay of trusted baseline cases, never a model-supplied database seed. */
export function compileHistory(
  value: unknown,
  baseline: MemberAcceptanceCase[],
  baseVersion: string,
): BaselinePreparation {
  const h = row(value, ["actions"]);
  let state = "open";
  let fields: Record<string, string> = {};
  const origins: MemberAcceptanceCase[] = [];
  const actions = list(h.actions, 1, 8).map((value) => {
    const a = row(value, ["action", "input"]);
    const action = text(a.action);
    const input = row(a.input, Object.keys(a.input as Row));
    if (
      Object.values(input).some(
        (v) => typeof v !== "string" || v.length > 10000,
      )
    )
      throw new Error("历史准备输入无效");
    const matches = baseline.filter(
      (c) =>
        c.action === action &&
        c.state === state &&
        hash(c.fields) === hash(fields) &&
        hash(c.input) === hash(input) &&
        c.expected.kind === "commit",
    );
    if (matches.length !== 1)
      throw new Error(`历史准备必须唯一匹配基础版本冻结成功案例：${action}`);
    const c = matches[0];
    if (c.expected.kind !== "commit")
      throw new Error("历史准备不能使用拒绝案例");
    state = c.expected.state!;
    fields = structuredClone(c.expected.fields!);
    origins.push(c);
    return {
      kind: "action" as const,
      member: c.member,
      action,
      input: input as Record<string, string>,
    };
  });
  if (!baseVersion) throw new Error("历史准备缺少精确基础版本");
  return {
    baseVersion,
    actions,
    expected: { state, fields },
    sourceHash: hash(origins),
  };
}

export function compileObligations(
  value: unknown,
  requirement: Omit<Requirement, "obligations">,
  bind: (steps: unknown[]) => BrowserStep[],
  baseline: MemberAcceptanceCase[],
  inherited: AcceptanceObligation[] = [],
  baseVersion = "",
): AcceptanceObligation[] {
  return list(value).map((value, index) => {
    const v = row(
      value,
      ["kind", "field", "initial", "history", "scenarios", "steps", "expected"],
      ["kind"],
    );
    const identity = {
      version: 1 as const,
      id:
        inherited[index]?.id ??
        "obligation-" +
          hash({
            source: requirement.sourceRevision,
            key: requirement.id,
            index,
          }).slice(0, 24),
    };
    if (v.kind === "backend") {
      row(v, ["kind"]);
      const checks = requirement.checks.filter(
        (c) => c.checker !== "browser/1",
      );
      if (!checks.length) throw new Error("后端验收义务缺少检查器映射");
      return { ...identity, kind: "backend", scope: "checker-suite", checks };
    }
    if (v.kind === "history") {
      row(v, ["kind", "field", "history"]);
      const bound = bind([{ kind: "field", field: v.field, value: "" }])[0];
      if (bound.kind !== "field") throw new Error("历史字段绑定失败");
      return {
        ...identity,
        id:
          "history-" +
          hash({
            member: bound.member,
            contribution: bound.contribution,
            field: bound.field,
          }).slice(0, 24),
        kind: "history",
        member: bound.member,
        ...(bound.contribution ? { contribution: bound.contribution } : {}),
        field: bound.field,
        history: compileHistory(v.history, baseline, baseVersion),
      };
    }
    if (v.kind === "field") {
      row(
        v,
        ["kind", "field", "initial", "history", "scenarios"],
        ["kind", "field", "initial", "scenarios"],
      );
      const initial = row(v.initial, ["kind", "value"], ["kind"]);
      if (!["visible", "absent", "baseline"].includes(String(initial.kind)))
        throw new Error("字段义务必须明确初始可见值或不存在");
      row(initial, initial.kind === "visible" ? ["kind", "value"] : ["kind"]);
      const bound = bind([{ kind: "field", field: v.field, value: "" }])[0];
      if (bound.kind !== "field") throw new Error("字段义务绑定失败");
      const history =
        v.history === undefined
          ? undefined
          : compileHistory(v.history, baseline, baseVersion);
      const scenarios = list(v.scenarios, 1, 8).map((value) => {
        const s = row(value, ["steps", "value"]);
        const steps = bind(list(s.steps, 1, 40));
        if (!steps.some((s) => s.kind === "action" || s.kind === "edit"))
          throw new Error("字段动作后义务缺少真实操作");
        return {
          id: hash({ steps, history: history?.baseVersion }).slice(0, 16),
          steps,
          value: text(s.value),
        };
      });
      return {
        ...identity,
        id:
          inherited[index]?.id ??
          "field-" +
            hash({
              member: bound.member,
              contribution: bound.contribution,
              field: bound.field,
            }).slice(0, 24),
        kind: "field",
        member: bound.member,
        ...(bound.contribution ? { contribution: bound.contribution } : {}),
        field: bound.field,
        initialOrigin: initial.kind === "baseline" ? "host" : "requirement",
        initial:
          initial.kind === "baseline"
            ? bound.member === "workflow"
              ? { kind: "absent" }
              : { kind: "visible", value: readOnlyFieldText(undefined) }
            : initial.kind === "visible"
              ? { kind: "visible", value: text(initial.value) }
              : { kind: "absent" },
        scenarios,
        ...(history ? { history } : {}),
      };
    }
    if (v.kind === "assertion") {
      row(v, ["kind", "steps", "expected"]);
      const bound = bind([...list(v.steps, 0, 40), v.expected]);
      const expected = bound.pop()!;
      if (
        expected.kind !== "action-visible" &&
        expected.kind !== "error" &&
        expected.kind !== "task"
      )
        throw new Error("一般断言义务不能代替字段初始及持久化验收");
      return { ...identity, kind: "assertion", steps: bound, expected };
    }
    throw new Error("验收义务类型不支持");
  });
}

/** Recompile expected cases on every gate check. Merely naming a case is insufficient. */
export function obligationFailure(
  requirement: Requirement,
  browsers: BrowserCase[],
): string[] {
  const obligations = requirement.obligations;
  if (!obligations?.length) return ["缺少可执行验收义务，请重新规划"];
  const reasons: string[] = [];
  if (
    requirement.type === "interface" &&
    !obligations.some((o) => o.kind !== "backend")
  )
    reasons.push("界面要求缺少可执行浏览器义务");
  for (const o of obligations) {
    if (o.version !== 1) {
      reasons.push("验收义务版本不支持");
      continue;
    }
    if (o.kind === "backend") {
      if (
        !o.checks.length ||
        o.checks.some(
          (c) =>
            c.checker === "browser/1" ||
            !requirement.checks.some((ref) => hash(ref) === hash(c)),
        )
      )
        reasons.push("后端义务映射不一致");
      continue;
    }
    if (o.kind === "field" && (!o.initial || !o.scenarios.length)) {
      reasons.push("字段义务缺少初始或动作后状态");
      continue;
    }
    for (const c of obligationCases(o))
      if (
        !requirement.checks.some(
          (ref) => ref.checker === "browser/1" && ref.caseId === c.id,
        ) ||
        hash(browsers.find((b) => b.id === c.id)) !== hash(c)
      )
        reasons.push(`验收义务未完整执行或断言已变化：${c.id}`);
  }
  return reasons;
}
