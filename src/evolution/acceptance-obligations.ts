import type { Requirement } from "../shared/assistant.js";
import type { BrowserCase, BrowserStep } from "../shared/browser-cases.js";
import type { AcceptanceObligation } from "../shared/acceptance-obligations.js";
import type { MemberAcceptanceCase } from "../shared/acceptance-cases.js";
import { historicalPreparation } from "./historical-preparation.js";
import { obligationCases } from "../shared/acceptance-obligations.js";
import { hash } from "../release/storage.js";
import { readOnlyFieldText } from "../shared/field-presentation.js";
import { schedulePolicyChecks, schedulePolicySemantics, type SchedulePolicyCheck } from "../shared/schedule-policy.js";
type Outcomes = Pick<
  import("../shared/assistant.js").InvestigatedPlan,
  "memberCases" | "extensions"
>;
export function rejectionReferences(
  action: Extract<BrowserStep, { kind: "action" }>,
  outcomes: Outcomes,
) {
  return [
    ...(outcomes.memberCases ?? [])
      .filter(
        (c) =>
          c.member === action.member &&
          c.action === action.action &&
          c.expected.kind === "reject",
      )
      .map((c) => ({
        checker: "workspace/1",
        caseId: `member:${c.member}:${c.name}`,
        definitionHash: hash(c),
      })),
    ...(action.member === "workflow"
      ? (outcomes.extensions?.cases ?? [])
          .filter(
            (c) => c.action === action.action && c.expected.kind === "reject",
          )
          .map((c) => ({
            checker: "business-actions/1",
            caseId: `action:${c.name}`,
            definitionHash: hash(c),
          }))
      : []),
  ];
}

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

export function compileObligations(
  value: unknown,
  requirement: Omit<Requirement, "obligations">,
  bind: (steps: unknown[]) => BrowserStep[],
  baseline: MemberAcceptanceCase[],
  inherited: AcceptanceObligation[] = [],
  baseVersion = "",
  accepted: AcceptanceObligation[] = inherited,
  lifecycle?: {
    existing: (target: { member: string; field: string }) => boolean;
    ui: Extract<AcceptanceObligation, { kind: "ui-identity" }>["contributions"];
    workflow?: import("../shared/browser-cases.js").WorkflowUiIdentity;
  },
  outcomes: Outcomes = {},
): AcceptanceObligation[] {
  return list(value).map((value, index) => {
    const v = row(
      value,
      [
        "kind",
        "field",
        "initial",
        "history",
        "scenarios",
        "steps",
        "expected",
        "action",
        "text",
        "resolution",
        "unavailable",
        "policies",
      ],
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
    if (v.kind === "schedule-policy") {
      row(v,["kind","action","policies"]);
      const action=bind([{kind:"action",action:text(v.action)}])[0];
      if (action.kind!=="action" || action.member==="workflow") throw new Error("时序策略必须绑定辅助成员的到期动作");
      const checks=list(v.policies,1,Object.keys(schedulePolicySemantics).length).map(policy=>text(policy));
      if (checks.some(check=>!Object.hasOwn(schedulePolicySemantics,check)) || new Set(checks).size!==checks.length)
        throw new Error("时序策略检查不支持或重复");
      const cases=(outcomes.memberCases??[]).filter(c=>c.member===action.member&&c.action===action.action&&c.expected.kind==="commit");
      if (cases.length !== 1) throw new Error(
        `时序策略 action 绑定 ${action.member}/${action.action}，匹配 ${cases.length} 个 commit 案例：${cases.map(c => `member:${c.member}:${c.name}`).join("、") || "无"}；须绑定 schedule.onFire 的到期触发动作及其唯一成功案例，不是设置或清除时间的动作。请修正动作引用或补全对应案例，不得删除所需策略或改写验收效果`,
      );
      const fired=cases[0];
      if (fired.expected.kind!=="commit" || !Object.entries(fired.expected.fields).some(([key,value])=>fired.fields[key]!==value))
        throw new Error("时序策略仅支持具有冻结字段变化的到期效果");
      const canonicalChecks=Object.keys(schedulePolicySemantics).filter(check=>checks.includes(check)) as SchedulePolicyCheck[];
      return {...identity,kind:"schedule-policy",action:{kind:"action",member:action.member,action:action.action},checks:canonicalChecks,fireCase:{caseId:`member:${action.member}:${cases[0].name}`,definitionHash:hash(cases[0])}};
    }
    if (v.kind === "backend-rejection" || v.kind === "feedback") {
      const action = bind([{ kind: "action", action: text(v.action) }])[0];
      if (action.kind !== "action") throw new Error("动作拒绝绑定失败");
      if (v.kind === "backend-rejection") {
        row(v, ["kind", "action"]);
        const cases = rejectionReferences(action, outcomes);
        if (!cases.length) throw new Error("后端拒绝义务缺少精确拒绝案例");
        return { ...identity, kind: "backend-rejection", action, cases };
      }
      row(v, [
        "kind",
        "action",
        "text",
        "resolution",
        "scenarios",
        "unavailable",
      ]);
      if (v.resolution !== "pending")
        throw new Error("反馈裁决只能由独立来源复核产生");
      const scenarios = list(v.scenarios, 0, 40).map((value) => {
        const s = row(value, ["steps"]);
        const steps = bind(list(s.steps, 1, 40));
        if (
          !steps.some(
            (s) =>
              s.kind === "action" &&
              s.action === action.action &&
              s.member === action.member,
          )
        )
          throw new Error("反馈缺少目标动作");
        return { steps };
      });
      const unavailable = list(v.unavailable, 0, 40).map((value) => {
        const d = row(value, ["code", "state"], ["code"]);
        if (
          !["action-hidden", "state-unreachable", "missing-rejection"].includes(
            String(d.code),
          )
        )
          throw new Error("反馈编译冲突无效");
        return {
          code: d.code as import("../shared/acceptance-obligations.js").FeedbackUnavailable["code"],
          ...(d.state === undefined ? {} : { state: text(d.state) }),
        };
      });
      return {
        ...identity,
        kind: "feedback",
        action,
        text: text(v.text),
        resolution: "pending",
        scenarios,
        unavailable,
      };
    }
    if (v.kind === "backend") {
      row(v, ["kind"]);
      const checks = requirement.checks.filter(
        (c) => c.checker !== "browser/1",
      );
      if (!checks.length) throw new Error("后端验收义务缺少检查器映射");
      return { ...identity, kind: "backend", scope: "checker-suite", checks };
    }
    if (v.kind === "preserve-ui") {
      row(v, ["kind"]);
      if (!lifecycle?.ui.length && !lifecycle?.workflow)
        throw new Error("界面身份保护没有可信基础贡献，无法推导");
      return {
        ...identity,
        kind: "ui-identity",
        contributions: structuredClone(lifecycle!.ui),
        ...(lifecycle?.workflow
          ? { workflow: structuredClone(lifecycle.workflow) }
          : {}),
      };
    }
    if (v.kind === "history") {
      row(v, ["kind", "field"]);
      const bound = bind([{ kind: "field", field: v.field, value: "" }])[0];
      if (bound.kind !== "field") throw new Error("历史字段绑定失败");
      if (lifecycle && !lifecycle.existing(bound))
        throw new Error(
          `新字段 ${bound.member}:${bound.field} 不存在基础历史；请用字段业务定义表达动作后保留，宿主负责旧任务矩阵`,
        );
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
        history: historicalPreparation(bound, baseline, baseVersion, accepted),
      };
    }
    if (v.kind === "field") {
      row(
        v,
        ["kind", "field", "initial", "scenarios"],
        ["kind", "field", "initial", "scenarios"],
      );
      const initial = row(v.initial, ["kind", "value"], ["kind"]);
      if (!["visible", "absent", "baseline"].includes(String(initial.kind)))
        throw new Error("字段义务必须明确初始可见值或不存在");
      row(initial, initial.kind === "visible" ? ["kind", "value"] : ["kind"]);
      const bound = bind([{ kind: "field", field: v.field, value: "" }])[0];
      if (bound.kind !== "field") throw new Error("字段义务绑定失败");
      const scenarios = list(v.scenarios, 1, 8).map((value) => {
        const s = row(value, ["steps", "value"]);
        const steps = bind(list(s.steps, 1, 40));
        if (!steps.some((s) => s.kind === "action" || s.kind === "case-action" || s.kind === "edit"))
          throw new Error("字段动作后义务缺少真实操作");
        return {
          id: hash({ steps, history: undefined }).slice(0, 16),
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
  outcomes: Outcomes = {},
): string[] {
  const obligations = requirement.obligations;
  if (!obligations?.length) return ["缺少可执行验收义务，请重新规划"];
  const reasons: string[] = [];
  if (
    requirement.type === "interface" &&
    !obligations.some((o) => obligationCases(o).length)
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
    if (o.kind === "schedule-policy") {
      const cases=(outcomes.memberCases??[]).filter(c=>c.member===o.action.member&&c.action===o.action.action&&c.expected.kind==="commit");
      if (!o.checks.length || new Set(o.checks).size!==o.checks.length || o.checks.some(c=>!Object.hasOwn(schedulePolicySemantics,c)) ||
          cases.length!==1 || o.fireCase.caseId!==`member:${o.action.member}:${cases[0].name}` || o.fireCase.definitionHash!==hash(cases[0]) ||
          schedulePolicyChecks(o).some(c=>!requirement.checks.some(ref=>hash(ref)===hash(c))))
        reasons.push("时序策略义务与冻结案例或检查器映射不一致");
      continue;
    }
    if (o.kind === "backend-rejection") {
      if (
        !o.cases.length ||
        hash(o.cases) !== hash(rejectionReferences(o.action, outcomes)) ||
        o.cases.some(
          (c) =>
            !requirement.checks.some(
              (ref) => ref.checker === c.checker && ref.caseId === c.caseId,
            ),
        )
      )
        reasons.push("后端拒绝义务与冻结案例不一致");
      continue;
    }
    if (o.kind === "feedback") {
      if (o.resolution === "pending")
        reasons.push(`页面反馈 ${o.id} 尚未完成独立来源裁决`);
      if (
        o.resolution === "required" &&
        (!o.scenarios.length || o.unavailable.length)
      )
        reasons.push(
          `页面反馈 ${o.id} 不可执行：${o.unavailable.map((d) => d.code + (d.state ? ":" + d.state : "")).join("、") || "missing-scenario"}`,
        );
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
