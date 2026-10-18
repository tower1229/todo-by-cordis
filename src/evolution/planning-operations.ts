import { hash } from "../release/storage.js";
import type { WorkflowRule } from "../shared/assistant.js";
import type { WorkflowDefinition } from "../server/business/contracts.js";
import type { BusinessExtensions } from "../server/business-verification.js";

type Case = BusinessExtensions["cases"][number];

/** One physical oracle for execution, human-readable catalogs and failure evidence. */
export function caseExpectation(c: Case) {
  return c.inputRequired?.length
    ? { kind: "input-required" as const, fields: c.inputRequired }
    : c.expected;
}

/** Reject model-authored examples that contradict the executable workflow/1 text rules. */
export function assertNativeCase(
  c: Case,
  base: WorkflowDefinition,
  rules: WorkflowRule[],
  previous?: BusinessExtensions,
) {
  const native = base.actions.find(
    (a) =>
      a.id === c.action && !previous?.actions.some((old) => old.id === a.id),
  );
  if (
    c.action === "reopen" &&
    native?.from?.includes(c.state) &&
    base.initialState === "open" &&
    base.states?.done
  ) {
    if (
      hash(c.expected) !==
      hash({ kind: "commit", state: base.initialState, fields: c.fields })
    )
      throw new Error(
        `原动作案例 ${c.name} 与 workflow/1 冻结重新打开保留语义冲突`,
      );
    return;
  }
  if (
    c.action !== "complete" ||
    c.state !== base.initialState ||
    previous?.actions.some((a) => a.id === c.action) ||
    !base.actions.some((a) => a.id === c.action && a.from?.includes(c.state))
  )
    return;
  const missing = rules.filter((r) => r.required && !c.input[r.key]?.trim());
  const lengths = rules
    .filter((r) => Object.hasOwn(c.input, r.key))
    .map((r) => ({ rule: r, length: [...c.input[r.key].trim()].length }));
  const invalid = lengths.filter(
    ({ rule: r, length }) =>
      (length < r.minLength && (r.required || r.minLength > 1)) ||
      length > r.maxLength,
  );
  if (c.expected.kind === "commit" && (missing.length || invalid.length))
    throw new Error(
      `原动作案例 ${c.name} 与 workflow/1 冻结字段校验冲突：缺失或长度无效时不能提交`,
    );
  if (
    c.expected.kind === "reject" &&
    !missing.length &&
    !invalid.length &&
    rules.every(
      (r) =>
        Object.hasOwn(c.input, r.key) &&
        (r.required || !!c.input[r.key].trim()),
    ) &&
    Object.keys(c.input).every((key) => rules.some((r) => r.key === key))
  )
    throw new Error(
      `原动作案例 ${c.name} 与 workflow/1 冻结规则冲突：${lengths.map(({ rule: r, length }) => `${r.key}=${length} Unicode 码点，规则 ${r.minLength}–${r.maxLength}`).join("；")}；有效完成输入不能声明拒绝`,
    );
  if (c.expected.kind === "commit") {
    if (
      base.initialState === "open" &&
      base.states?.done &&
      c.expected.state !== "done"
    )
      throw new Error(`原动作案例 ${c.name} 与 workflow/1 冻结状态语义冲突`);
    // Do not invent an optional missing-value contract. Only lower the already
    // verified nonempty text path and preserve every unrelated historical field.
    if (
      rules.every((r) => r.required || !!c.input[r.key]?.trim()) &&
      Object.keys(c.input).every((key) => rules.some((r) => r.key === key))
    ) {
      const fields = {
        ...c.fields,
        ...Object.fromEntries(
          rules
            .filter((r) => Object.hasOwn(c.input, r.key))
            .map((r) => [r.key, c.input[r.key].trim()]),
        ),
      };
      if (hash(c.expected.fields) !== hash(fields))
        throw new Error(
          `原动作案例 ${c.name} 与 workflow/1 冻结去空白及字段保留语义冲突`,
        );
    }
  }
}

/** The existing workflow/1 required-input contract, independent of model case wording. */
export function requiredCaseInputs(
  c: Pick<Case, "action" | "state" | "input" | "expected">,
  base: Pick<WorkflowDefinition, "initialState" | "actions">,
  rules: WorkflowRule[],
) {
  if (
    c.action !== "complete" ||
    c.state !== base.initialState ||
    c.expected.kind !== "reject" ||
    !base.actions.some((a) => a.id === c.action && a.from?.includes(c.state))
  )
    return [];
  return rules
    .filter((r) => r.required && !c.input[r.key]?.trim())
    .map((r) => r.key)
    .sort();
}

/** Resolve primary case roles using exact host definitions, not the presence of a cases property. */
export function compilePrimaryOperations(
  change: {
    actions?: BusinessExtensions["actions"];
    actionFields?: BusinessExtensions["fields"];
    cases?: Case[];
  },
  base: WorkflowDefinition,
  rules: WorkflowRule[],
  previous?: BusinessExtensions,
): BusinessExtensions | undefined {
  const native = (id: string) =>
    base.actions.find(
      (a) => a.id === id && !previous?.actions.some((old) => old.id === id),
    );
  const actions = (change.actions ?? []).filter((a) => {
    const old = native(a.id);
    if (!old) return true;
    const identity = (v: WorkflowDefinition["actions"][number]) => ({
      id: v.id,
      label: v.label,
      from: [...v.from].sort(),
    });
    if (hash(identity(a)) !== hash(identity(old)))
      throw new Error(`既有动作 ${a.id} 的身份或状态范围不能通过扩展声明修改`);
    return false;
  });
  const fields = (change.actionFields ?? []).filter((f) => {
    const rule = rules.find((r) => r.key === f.key);
    if (!rule) return true;
    if (f.label !== rule.label || f.type !== "text")
      throw new Error(`完成字段 ${f.key} 的声明与宿主字段定义冲突`);
    return false;
  });
  const cases = (change.cases ?? []).map((c) => {
    assertNativeCase(c, base, rules, previous);
    if (
      !base.actions.some((a) => a.id === c.action) &&
      !actions.some((a) => a.id === c.action) &&
      !previous?.actions.some((a) => a.id === c.action)
    )
      throw new Error(
        `案例 ${c.name} 的动作 ${c.action} 没有宿主身份或新增声明`,
      );
    const inputRequired = native(c.action)
      ? requiredCaseInputs(c, base, rules)
      : [];
    return { ...c, ...(inputRequired.length ? { inputRequired } : {}) };
  });
  if (!actions.length && !fields.length && !cases.length) return previous;
  return { actions, fields, cases };
}
