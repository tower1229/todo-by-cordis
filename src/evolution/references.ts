import type { InvestigatedPlan, RequirementGate } from "../shared/assistant.js";
import { hash } from "../release/storage.js";
import type { BrowserCase, BrowserStep } from "../shared/browser-cases.js";
import { compileObligations } from "./acceptance-obligations.js";
import { obligationCases } from "../shared/acceptance-obligations.js";
import {
  bindHistoricalCase,
  HistoricalPreparationBlocked,
} from "./historical-preparation.js";
import type { Requirement } from "../shared/assistant.js";
import {
  fieldLifecycle,
  deriveFieldObligations,
  changesBaselineValue,
} from "./obligation-derivation.js";
import { historicalPreparation } from "./historical-preparation.js";
import {bindAvailability,type ActionAvailability} from "./action-availability.js";
import { schedulePolicyChecks } from "../shared/schedule-policy.js";

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
  workflow: {
    id: string;
    actions: { id: string }[];
    fields?: { key: string }[];
  },
  inherited: Pick<
    InvestigatedPlan,
    "memberCases" | "browserCases" | "requirements"
  > & {
    baseVersion?: string;
    requirementGate?: RequirementGate;
    fieldIdentities?: import("./field-identity.js").FieldIdentity[];
    actionAvailability?: ActionAvailability;
    uiContributions?: {
      id: string;
      providerId: string;
      fields: { key: string }[];
      actions: { commandId: string }[];
    }[];
  } = {},
) {
  const lifecycle = {...fieldLifecycle(inherited, workflow.fields), ...(/^[\w.-]{1,100}$/.test(workflow.id ?? "") ? {workflow: {id:workflow.id, fields:(workflow.fields??[]).map(f=>({key:f.key})), actions:workflow.actions.map(a=>({id:a.id}))}} : {})};
  const newFieldPreservation: {
    requirementId: string;
    member: string;
    field: string;
    contribution?: string;
  }[] = [];
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
    expected?: { kind?: string; fields?: Row };
  }[];
  const extensions = (draft.extensions ?? {}) as {
    actions?: { id: string }[];
    fields?: { key: string }[];
    cases?: { name: string }[];
  };
  const rules = (draft.workflowRules ?? []) as {
    key: string;
    required?: boolean;
  }[];
  const owner = (key: unknown, kind: "action" | "field") => {
    if (typeof key !== "string") throw new Error("浏览器业务引用无效");
    const ids = new Set<string>();
    if (kind === "field") {
      // A command may preserve or update somebody else's field. Its case is
      // not a field registration; authoritative definitions own UI identity.
      if (
        [
          ...(workflow.fields ?? []),
          ...rules,
          ...(extensions.fields ?? []),
        ].some((f) => f.key === key)
      )
        ids.add("workflow");
      for (const c of inherited.uiContributions ?? [])
        if (c.fields.some((f) => f.key === key)) ids.add(c.providerId);
      for (const f of inherited.fieldIdentities ?? [])
        if (f.field === key) ids.add(f.member);
      if (ids.size > 1)
        throw new Error(`浏览器业务引用不存在或身份不唯一：field:${key}`);
      if (ids.size === 1) return [...ids][0];
    }
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
          : c.expected?.kind === "commit" &&
            c.expected.fields &&
            Object.hasOwn(c.expected.fields, key) &&
            c.expected.fields[key] !== c.fields?.[key]
      )
        ids.add(c.member);
    }
    if (ids.size !== 1)
      throw new Error(`浏览器业务引用不存在或身份不唯一：${kind}:${key}`);
    return [...ids][0];
  };
  const bindSteps = (steps: unknown[], caseId: unknown): BrowserStep[] => {
    const taskExpectation: Row = {};
    return steps.map((value) => {
      const s = row(value);
      if (s.kind === "ui-identity" || s.kind === "form-invalid")
        throw new Error("界面身份快照及表单原生校验由宿主生成，不得手工提交");
      if (s.kind === "edit") {
        if (s.title !== undefined) {
          if (typeof s.title !== "string") throw new Error("任务编辑标题无效");
          taskExpectation.title = s.title.trim();
        }
        if (s.description !== undefined) {
          if (typeof s.description !== "string")
            throw new Error("任务编辑备注无效");
          taskExpectation.description = s.description;
        }
      }
      if (s.kind === "task") {
        if (Object.keys(s).some((key) => key !== "kind"))
          throw new Error(
            "任务属性断言由宿主绑定合成基线及编辑步骤，不得提交手工期望",
          );
        return { kind: "task", ...taskExpectation };
      }
      if (["action", "field", "action-visible"].includes(String(s.kind))) {
        if (s.member !== undefined || s.contribution !== undefined)
          throw new Error("浏览器身份由宿主绑定，不得提交 member/contribution");
        const member = owner(
          s.kind === "field" ? s.field : s.action,
          s.kind === "field" ? "field" : "action",
        );
        if (s.kind === "action") {
          if (
            member === "workflow" &&
            s.action === "complete" &&
            s.input !== undefined
          ) {
            const input = row(s.input);
            const missing = rules.filter(
              (f) =>
                f.required &&
                (input[f.key] === undefined || input[f.key] === ""),
            );
            if (missing.length)
              throw new Error(
                `浏览器案例 ${caseId} 的动作输入被宿主原生必填校验阻止，不能提交或断言页面 alert：${missing.map((f) => f.key).join("、")}`,
              );
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
        const contribution =
          member === "workflow" ? "workflow" : matches[0]?.id;
        return { ...s, member, ...(contribution ? { contribution } : {}) };
      }
      return s;
    }) as BrowserStep[];
  };
  const browsers = list(draft.browserCases ?? []).map((value) => {
    const c = row(value);
    if (
      typeof c.id !== "string" ||
      !c.id.trim() ||
      Object.keys(c).some((k) => !["id", "task", "steps"].includes(k))
    )
      throw new Error("浏览器局部案例身份无效");
    return {
      ...c,
      id: inherited.browserCases?.some((old) => old.id === c.id)
        ? c.id
        : "browser-" + hash({ workflow: workflow.id, key: c.id }).slice(0, 24),
      steps: bindSteps(list(c.steps), c.id),
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
            "obligations",
          ].includes(k),
      )
    )
      throw new Error("需求规格含未授权或宿主派生字段");
    if (r.sourceRevision !== undefined)
      throw new Error("需求来源修订由宿主绑定");
    const source = at(sources, r.source);
    const { source: _source, obligations: rawObligations, ...definition } = r;
    const requirement = {
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
        if (["workflow", "enabled"].includes(String(check.kind))) {
          if (check.index !== undefined) at(catalog, check.index);
          return catalog;
        }
        return [at(catalog, check.index)];
      }),
    } as Requirement;
    if (!Array.isArray(rawObligations))
      throw new Error("验收义务列表无效或缺失");
    const raw = list(rawObligations);
    const declarations = raw.filter((value) => {
      const declaration = row(value);
      if (declaration.kind !== "history") return true;
      if (Object.keys(declaration).some((k) => !["kind", "field"].includes(k)))
        throw new Error("历史义务不得提交宿主派生字段");
      const target = bindSteps(
        [{ kind: "field", field: declaration.field, value: "" }],
        r.id,
      )[0];
      if (target.kind !== "field" || lifecycle.existing(target)) return true;
      newFieldPreservation.push({ requirementId: requirement.id, ...target });
      return false;
    });
    const obligations = declarations.length
      ? compileObligations(
          declarations,
          requirement,
          (steps) => bindSteps(steps, r.id),
          inherited.memberCases ?? [],
          inherited.requirements?.find((old) => old.id === r.id)?.obligations,
          inherited.baseVersion,
          (inherited.requirements ?? []).flatMap((r) => r.obligations ?? []),
          lifecycle,
          {memberCases:memberCases as import("../shared/acceptance-cases.js").MemberAcceptanceCase[],extensions:extensions as InvestigatedPlan["extensions"]},
        )
      : [];
    if (!raw.length) throw new Error("验收义务列表无效或缺失");
    for (const policy of obligations.filter(o=>o.kind==="schedule-policy"))
      requirement.checks.push(...schedulePolicyChecks(policy));
    return { ...requirement, obligations };
  });
  const canonical = requirements.flatMap((r) => r.obligations);
  const renderable = (requirement: Requirement) => (target: {member: string; contribution?: string}) =>
    target.member === "workflow" || !!target.contribution ||
    (requirement.type === "interface" && Array.isArray(draft.capabilityChanges) && draft.capabilityChanges.some(value => {
      const change = row(value);
      return change.provider === `member:${target.member}` && change.capability === "ui.slot";
    }));
  const inputObligation = (requirement:Requirement) => {
    const inputs = draft.workflowRules as import("../shared/assistant.js").WorkflowRule[];
    if (rules.length && inputs.every(r=>typeof r.required==="boolean"&&Number.isInteger(r.minLength)&&Number.isInteger(r.maxLength)) && requirement.checks.some(c=>c.checker==="workflow/1"))
      requirement.obligations!.push({version:1,id:"workflow-input-"+hash(workflow.id).slice(0,16),kind:"workflow-input",rules:structuredClone(inputs)});
  };
  for (const requirement of requirements) inputObligation(requirement);
  for (const requirement of requirements)
    requirement.obligations.push(
      ...deriveFieldObligations(
        requirement,
        memberCases as import("../shared/acceptance-cases.js").MemberAcceptanceCase[],
        rules,
        (steps) => bindSteps(steps, requirement.id),
        canonical,
        renderable(requirement),
        lifecycle.existing,
      ),
    );
  const fields = requirements
    .flatMap((r) => r.obligations)
    .filter((o) => o.kind === "field");
  for (const request of newFieldPreservation) {
    const matches = fields.filter(
      (o) =>
        o.member === request.member &&
        o.field === request.field &&
        o.contribution === request.contribution,
    );
    if (!matches.length)
      throw new Error(
        `新字段 ${request.member}:${request.field} 没有基础历史，且缺少可推导动作后义务；不能伪造历史或跳过保留验收`,
      );
    const requirement = requirements.find(
      (r) => r.id === request.requirementId,
    )!;
    for (const o of matches)
      if (
        !requirement.obligations.some((existing) => hash(existing) === hash(o))
      )
        requirement.obligations.push(structuredClone(o));
    for (const o of matches)
      if (o.derivation?.checker === "workflow/1")
        requirement.checks.push(...catalogs.workflow);
  }
  // Recompile host-generated samples when authoritative rules/cases change.
  // Evolution still compares old/new definitions through its original explicit
  // acceptance revision gate; business definitions are never rewritten here.
  for (const old of inherited.requirements ?? []) {
    if (requirements.some((r) => r.id === old.id)) continue;
    const derived =
      old.obligations?.filter((o) => o.kind === "field" && o.derivation) ?? [];
    if (!derived.length && !old.obligations?.some(o=>o.kind==="workflow-input")) continue;
    const replacement = {
      ...structuredClone(old),
      obligations: structuredClone(old.obligations ?? []).filter(
        (o) => o.kind !== "workflow-input" && (o.kind !== "field" || !o.derivation),
      ),
    };
    let rebound = false;
    replacement.checks = replacement.checks.flatMap((c) =>
      c.checker !== "workflow/1"
        ? [c]
        : rebound
          ? []
          : ((rebound = true), catalogs.workflow),
    );
    for (const o of replacement.obligations)
      if (o.kind === "backend")
        o.checks = replacement.checks.filter((c) => c.checker !== "browser/1");
    inputObligation(replacement);
    const regenerated = deriveFieldObligations(
      replacement,
      memberCases as import("../shared/acceptance-cases.js").MemberAcceptanceCase[],
      rules,
      (steps) => bindSteps(steps, old.id),
      requirements.flatMap((r) => r.obligations),
      renderable(replacement),
      lifecycle.existing,
    );
    if (derived.some((old) => !regenerated.some((next) => next.id === old.id)))
      throw new Error(
        "既有字段的宿主派生义务无法重新绑定；须显式修订原要求，不能删除旧断言",
      );
    for (const o of regenerated) {
      const prior = derived.find((old) => old.id === o.id);
      if (o.kind === "field" && prior?.kind === "field" && prior.history)
        o.history = structuredClone(prior.history);
    }
    replacement.obligations.push(...regenerated);
    requirements.push(replacement);
  }
  // Inherit accepted obligations before checker binding and technical validation.
  // Late inheritance in the execution loop must not leave their checkers unbound.
  if (inherited.requirementGate)
    for (const old of inherited.requirements??[])
      if (!requirements.some(r=>r.id===old.id)) requirements.push({...structuredClone(old),obligations:structuredClone(old.obligations??[])});
  const histories = requirements
    .flatMap((r) => r.obligations)
    .filter((o) => o.kind === "history");
  // History belongs to a field identity, not requirement ordering. Existing-task
  // action scenarios must exercise old data too; initial empty-task checks stay empty.
  for (const requirement of requirements) {
    for (const obligation of requirement.obligations) {
      if (obligation.kind !== "field") continue;
      const related = histories.filter(
        (h) =>
          h.member === obligation.member &&
          h.field === obligation.field &&
          h.contribution === obligation.contribution,
      );
      if (new Set(related.map((h) => hash(h.history))).size > 1)
        throw new HistoricalPreparationBlocked(
          "同字段的历史准备互相冲突，不能选择任意基础状态",
        );
      if (
        related.length ||
        (inherited.baseVersion &&
          lifecycle.existing(obligation) &&
          changesBaselineValue(obligation, inherited.memberCases ?? []))
      ) {
        obligation.history = related.length
          ? structuredClone(related[0].history)
          : historicalPreparation(
              obligation,
              inherited.memberCases ?? [],
              inherited.baseVersion!,
              (inherited.requirements ?? []).flatMap(
                (r) => r.obligations ?? [],
              ),
            );
        obligation.scenarios = obligation.scenarios.map((s) => ({
          ...s,
          id: hash(
            obligation.derivation
              ? { scenario: s.id, history: obligation.history!.baseVersion }
              : {
                  steps: s.steps,
                  history: obligation.history!.baseVersion,
                },
          ).slice(0, 16),
        }));
      }
    }
    bindAvailability([requirement],inherited.actionAvailability);
    for (const obligation of requirement.obligations) {
      for (const c of obligationCases(obligation)) {
        const existing = browsers.find((b) => b.id === c.id);
        if (existing && hash(existing) !== hash(c))
          throw new Error(
            "同一字段验收义务发生冲突，初始状态或相同操作不能要求不同结果",
          );
        if (!existing) browsers.push(c);
        requirement.checks.push({ checker: "browser/1", caseId: c.id });
      }
    }
    requirement.checks = requirement.checks.filter(
      (c, index, all) =>
        all.findIndex((other) => hash(other) === hash(c)) === index,
    );
  }
  return {
    requirements,
    browserCases: browsers.map((c) =>
      bindHistoricalCase(c as BrowserCase, histories),
    ),
  };
}
