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
  scheduledMembers,
} from "./obligation-derivation.js";
import { historicalPreparation } from "./historical-preparation.js";
import {bindAvailability,type ActionAvailability} from "./action-availability.js";
import { schedulePolicyChecks } from "../shared/schedule-policy.js";

/** Inherit accepted browser cases and report every explicit revision to the caller. */
export function inheritBrowserCases(
  plan: Pick<InvestigatedPlan, "requirements" | "browserCases">,
  inherited: Pick<InvestigatedPlan, "requirements" | "browserCases">,
  reason: unknown,
) {
  const compiled = plan.browserCases ?? [];
  const browserCases = [...compiled];
  const changes: NonNullable<InvestigatedPlan["acceptanceChanges"]> = [];
  const blockers: string[] = [];
  const reboundFieldCase = (old: BrowserCase) => {
    if (old.classification !== "frozen-business" || !old.obligationId) return;
    const matches: BrowserCase[] = [];
    for (const owner of inherited.requirements ?? []) {
      const previous = owner.obligations?.find(o => o.id === old.obligationId);
      const current = plan.requirements?.find(r => r.id === owner.id);
      if (previous?.kind !== "field" || !current || hash(current) === hash(owner)) continue;
      const scopes = new Set((plan.requirements ?? []).flatMap(r => r.obligations ?? [])
        .filter(o => o.kind === "field" && o.member === previous.member && o.field === previous.field)
        .map(o => o.kind === "field" ? o.contribution : undefined));
      if (!previous.contribution && scopes.size !== 1) continue;
      const fields = (current.obligations ?? []).filter(o => o.kind === "field" &&
        o.member === previous.member && o.field === previous.field &&
        (!previous.contribution || o.contribution === previous.contribution));
      if (fields.length !== 1 || fields[0].kind !== "field") continue;
      const field = fields[0];
      // An old unqualified field may acquire its unique host-bound UI scope.
      // Preserve every operation, input, other field, and refresh/restart check.
      const changesValue = old.steps.some(s =>
        (s.kind === "action" || s.kind === "case-action") && s.member === previous.member);
      const shape = (steps: BrowserStep[]) => steps.map(s => s.kind === "field" &&
        s.member === field.member && s.field === field.field &&
        (!s.contribution || s.contribution === field.contribution)
        ? {...s,contribution:field.contribution,...(changesValue ? {value:undefined} : {})} : s);
      for (const candidate of compiled) {
        if (candidate.classification !== "frozen-business" || candidate.task !== old.task ||
          candidate.obligationId !== field.id ||
          (old.prepare && hash(old.prepare) !== hash(candidate.prepare)) ||
          (!changesValue && !old.prepare && candidate.prepare) ||
          hash(shape(old.steps)) !== hash(shape(candidate.steps))) continue;
        if (!matches.some(c => c.id === candidate.id)) matches.push(candidate);
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  };
  for (const old of inherited.browserCases ?? []) {
    const replacement = compiled.find(item => item.id === old.id) ?? reboundFieldCase(old);
    if (!replacement) browserCases.push(structuredClone(old));
    else if (hash(replacement) !== hash(old)) {
      if (typeof reason !== "string" || !reason.trim()) {
        blockers.push(`既有浏览器案例 ${old.id} 改变，须说明验收修订原因`);
        if (replacement.id !== old.id) browserCases.push(structuredClone(old));
      }
      else changes.push({rule:`浏览器案例 ${old.id}`,before:JSON.stringify(old),after:JSON.stringify(replacement),reason});
    }
  }
  return {browserCases,changes,blockers};
}
type Row = Record<string, unknown>;
type FieldObligation = Extract<NonNullable<Requirement["obligations"]>[number], {kind:"field"}>;
const sameFieldIdentity = (a: FieldObligation, b: FieldObligation) =>
  a.member === b.member && a.field === b.field && a.contribution === b.contribution;
/** Callers prove a unique host binding before reusing a legacy projection. */
function reuseFieldIdentity(next: FieldObligation, prior: FieldObligation) {
  next.id = prior.id;
  if (prior.contribution === undefined) delete next.contribution;
  // Only complete, unchanged operation paths keep an accepted case identity.
  // Value changes still require an explicit acceptance revision.
  next.scenarios = next.scenarios.map(scenario => {
    const matches = prior.scenarios.filter(old => hash(old.steps) === hash(scenario.steps));
    return matches.length === 1 ? { ...scenario, id: matches[0].id } : scenario;
  });
  if (prior.history) next.history = structuredClone(prior.history);
}
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
      if (s.kind === "case-action") {
        const source = memberCases.find((c) => `member:${c.member}:${c.name}` === s.caseId && c.member === s.member);
        if (!source || hash(source) !== s.definitionHash || typeof s.field !== "string")
          throw new Error("宿主动作案例引用与冻结来源不一致");
        return s;
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
  const frozenFields = inherited.requirementGate
    ? (inherited.requirements ?? []).flatMap(r => r.obligations ?? [])
        .filter((o): o is FieldObligation => o.kind === "field")
    : [];
  // Unchanged accepted auxiliary fields already have complete operation samples.
  // Reuse them for implicit projections; a new declaration or changed member
  // cases must still pass the ordinary revision and independent review gates.
  const acceptedFields = frozenFields.filter(
    o => o.member !== "workflow" &&
      !canonical.some(current => current.kind === "field" && current.member === o.member && current.field === o.field) &&
      hash(memberCases.filter(c => c.member === o.member)) ===
        hash((inherited.memberCases ?? []).filter(c => c.member === o.member)),
  );
  // Changed accepted fields need their update paths too. bindSteps has already
  // proved a unique UI scope; a different explicit scope cannot authorize it.
  const includeAcceptedUpdates = (target: {member: string; field: string; contribution?: string}) =>
    frozenFields.some(o => o.member === target.member && o.field === target.field &&
      (o.contribution === undefined || o.contribution === target.contribution));
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
  // Reuse the accepted host projection only when a declaration has exactly the
  // same initial state and operation/value samples. Source authority stays on
  // each requirement; explicit initial values and different samples stay distinct.
  for (const requirement of requirements) {
    for (const field of requirement.obligations) {
      if (field.kind !== "field" || field.derivation || field.initialOrigin !== "host") continue;
      const previous = new Map((inherited.requirements ?? []).flatMap(r => r.obligations ?? [])
        .filter((o): o is FieldObligation => o.kind === "field" && !!o.derivation &&
          o.member === field.member && o.field === field.field &&
          (o.contribution === undefined || o.contribution === field.contribution))
        .map(o => [hash(o),o]));
      if (previous.size !== 1) continue;
      const prior = [...previous.values()][0];
      const projected = deriveFieldObligations(
        {...requirement,obligations:requirement.obligations.filter(o=>o!==field)},
        memberCases as import("../shared/acceptance-cases.js").MemberAcceptanceCase[], rules,
        steps=>bindSteps(steps,requirement.id), [], renderable(requirement), lifecycle.existing,
        scheduledMembers(draft as Pick<InvestigatedPlan,"capabilityChanges"|"requiredCapabilities">),
        () => true, // Compare the explicit field against every frozen update, not just fresh saves.
      ).filter((o): o is FieldObligation => o.kind === "field" && sameFieldIdentity(field,o));
      const samples = (o: FieldObligation) => hash(o.scenarios.map(s=>hash({steps:s.steps,value:s.value})).sort());
      if (projected.length !== 1 || hash(field.initial) !== hash(projected[0].initial) ||
          samples(field) !== samples(projected[0]) ||
          (field.history && prior.history && hash(field.history) !== hash(prior.history))) continue;
      field.derivation = structuredClone(projected[0].derivation);
      field.scenarios = structuredClone(projected[0].scenarios);
      reuseFieldIdentity(field, prior);
    }
  }
  for (const requirement of requirements)
    requirement.obligations.push(
      ...deriveFieldObligations(
        requirement,
        memberCases as import("../shared/acceptance-cases.js").MemberAcceptanceCase[],
        rules,
        (steps) => bindSteps(steps, requirement.id),
        [...canonical, ...acceptedFields],
        renderable(requirement),
        lifecycle.existing,
        scheduledMembers(draft as Pick<InvestigatedPlan, "capabilityChanges" | "requiredCapabilities">),
        includeAcceptedUpdates,
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
  // Rebound copies must not become competing definitions for later owners.
  const currentDefinitions = requirements.flatMap(r => r.obligations);
  for (const old of inherited.requirements ?? []) {
    if (requirements.some((r) => r.id === old.id)) continue;
    const derived =
      old.obligations?.filter((o): o is FieldObligation => o.kind === "field" && !!o.derivation) ?? [];
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
    // Only rebind derived fields whose member cases have changed in the current proposal.
    // Fields depending on unchanged members can be preserved as-is without regeneration.
    const memberTouchedInCurrent = (member: string) =>
      memberCases.some(c => c.member === member);
    const memberCasesChanged = (member: string) =>
      memberTouchedInCurrent(member) &&
      hash(memberCases.filter(c => c.member === member)) !==
      hash((inherited.memberCases ?? []).filter(c => c.member === member));
    const memberExistsInInherited = (member: string) =>
      (inherited.memberCases ?? []).some(c => c.member === member);
    const needsRebind = derived.filter(o => memberCasesChanged(o.member) || !memberExistsInInherited(o.member));
    const canPreserve = derived.filter(o => !memberCasesChanged(o.member) && memberExistsInInherited(o.member));
    const regenerated = needsRebind.length ? deriveFieldObligations(
      replacement,
      memberCases as import("../shared/acceptance-cases.js").MemberAcceptanceCase[],
      rules,
      (steps) => bindSteps(steps, old.id),
      currentDefinitions,
      renderable(replacement),
      lifecycle.existing,
    ) : [];
    const reboundFields = needsRebind.map((prior) => {
      const matches = regenerated.filter((next): next is FieldObligation =>
        next.kind === "field" && next.member === prior.member && next.field === prior.field &&
        // deriveFieldObligations already bound a unique current UI target.
        // An unqualified legacy projection may follow it; an explicit scope may not change.
        (prior.contribution === undefined || next.contribution === prior.contribution));
      return matches.length === 1 && needsRebind.filter(other => other.member === prior.member && other.field === prior.field).length === 1
        ? matches[0] : undefined;
    });
    if (reboundFields.some((next) => !next))
      throw new Error(
        "既有字段的宿主派生义务无法重新绑定；须显式修订原要求，不能删除旧断言",
      );
    for (const [index,prior] of needsRebind.entries()) {
      const next = reboundFields[index]!;
      // A canonical declaration can supply new samples without changing the
      // inherited host projection's identity, provenance, or baseline history.
      next.derivation = structuredClone(prior.derivation);
      reuseFieldIdentity(next, prior);
    }
    // Preserved fields keep their complete identity, derivation, and browser cases unchanged.
    const allRebound = [...reboundFields, ...canPreserve.map(o => structuredClone(o))];
    const priorCaseIds = new Set(allRebound.flatMap(o=>obligationCases(o).map(c=>c.id)));
    replacement.checks = replacement.checks.filter(c=>c.checker!=="browser/1"||!priorCaseIds.has(c.caseId));
    replacement.obligations.push(...regenerated.filter(o => !reboundFields.includes(o as FieldObligation)), ...allRebound);
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
