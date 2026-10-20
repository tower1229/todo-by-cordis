import { hash } from "../release/storage.js";
import type { Investigation } from "../server/planning.js";
import type { InvestigatedPlan } from "../shared/assistant.js";

export type FieldIdentity = {
  member: string;
  field: string;
  label: string;
  contribution?: string;
};
export type FieldTarget = FieldIdentity & { targetId: string };
export type FieldReference =
  | { kind: "existing"; targetId: string }
  | { kind: "new"; name: string };

export const fieldIdentityKey = (
  f: Pick<FieldIdentity, "member" | "field" | "contribution">,
) => `${f.member}:${f.contribution ?? ""}:${f.field}`;
export const fieldTargetId = (
  f: Pick<FieldIdentity, "member" | "field" | "contribution">,
) =>
  "field-target:" +
  hash([f.member, f.contribution ?? "", f.field]).slice(0, 24);

/** One canonical registry serves native schemas, intake binding and frozen plan checks. */
export function fieldTargets(
  facts: import("./technical-facts.js").TechnicalFact[],
): FieldTarget[] {
  const targets = new Map<string, FieldTarget>();
  for (const fact of facts.filter((f) =>
    f.id.startsWith("host-fact:field-identity:"),
  )) {
    const { member, field, label, contribution, targetId } = fact.properties;
    const identity = {
      member,
      field,
      label,
      ...(contribution ? { contribution } : {}),
    };
    if (
      !member ||
      !field ||
      !label ||
      targetId !== fieldTargetId(identity) ||
      fact.evidenceHash !== hash({ id: fact.id, properties: fact.properties })
    )
      throw new Error("宿主字段目标目录证据无效");
    const target = { ...identity, targetId };
    const old = targets.get(targetId);
    if (old && hash(old) !== hash(target))
      throw new Error("宿主字段目标身份冲突");
    targets.set(targetId, target);
  }
  return [...targets.values()].sort((a, b) =>
    a.targetId.localeCompare(b.targetId),
  );
}
export function fieldReferenceSchema(catalog: FieldTarget[]) {
  const object = (properties: Record<string, unknown>) => ({
    type: "object",
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  });
  return {
    anyOf: [
      ...(catalog.length
        ? [
            object({
              kind: { type: "string", enum: ["existing"] },
              targetId: {
                type: "string",
                enum: catalog.map((t) => t.targetId),
              },
            }),
          ]
        : []),
      object({
        kind: { type: "string", enum: ["new"] },
        name: { type: "string", minLength: 1, maxLength: 120 },
      }),
    ],
  };
}
export function bindFieldReference(
  reference: FieldReference,
  catalog: FieldTarget[],
) {
  if (reference.kind === "existing") {
    const target = catalog.find((f) => f.targetId === reference.targetId);
    if (!target) throw new Error("字段目标不存在于当前宿主目录");
    return {
      field: target.field,
      target,
      surface:
        target.member === "workflow"
          ? ("workflow" as const)
          : ("auxiliary" as const),
    };
  }
  // These aliases are generated from the registry, never parsed to guess an owner.
  const name = reference.name.trim();
  if (
    !name ||
    catalog.some((f) =>
      [f.field, f.label, `${f.member}.${f.field}`].includes(name),
    )
  )
    throw new Error("已有字段必须引用宿主字段目标，不能声明为新字段");
  return { field: name, surface: "unbound" as const };
}
export function baselineFields(
  context: Pick<Investigation, "files" | "pluginId" | "uiContributions" | "registeredFields">,
): FieldIdentity[] {
  const workflow = JSON.parse(context.files["active-contract"].content) as {
    fields?: { key: string; label: string; providerId?: string }[];
  };
  return [
    ...(workflow.fields ?? [])
      .filter((f) => !f.providerId || f.providerId === context.pluginId)
      .map((f) => ({ member: "workflow", field: f.key, label: f.label })),
    ...(context.registeredFields ?? [])
      .filter(f=>f.providerId!==context.pluginId && !(context.uiContributions??[]).some(c=>c.providerId===f.providerId && c.fields.some(field=>field.key===f.key)))
      .map(f=>({member:f.providerId,field:f.key,label:f.label})),
    ...(context.uiContributions ?? []).flatMap((c) =>
      c.fields.map((f) => ({
        member: c.providerId,
        contribution: c.id,
        field: f.key,
        label: f.label,
      })),
    ),
  ];
}
export function fieldFacts(fields: FieldIdentity[]) {
  return fields.map((f) => {
    const fact = {
      id: "host-fact:field-identity:" + hash(f).slice(0, 24),
      properties: {
        ...f,
        targetId: fieldTargetId(f),
        surface: f.member === "workflow" ? "workflow" : "auxiliary",
      },
    };
    return { ...fact, evidenceHash: hash(fact) };
  });
}
/** Shared source resolution before and after obligation compilation. A display name
 * may bind through its cited requirement, but multiple actual fields remain ambiguous. */
export function sourceFieldCandidates<T extends {
  requirement: {sourceRevision:string;sourceQuote:string};
  field: {field:string};
}>(fields:T[], source:{field:string;sourceRevision:string;sourceQuote:string}, rules:{key:string;label:string}[]) {
  const keys = new Set([source.field, ...rules.filter(f=>f.label===source.field).map(f=>f.key)]);
  const named = fields.filter(({field:f})=>keys.has(f.field));
  return named.length ? named : fields.filter(({requirement:r})=>
    r.sourceRevision === source.sourceRevision &&
    (r.sourceQuote.includes(source.sourceQuote)||source.sourceQuote.includes(r.sourceQuote)));
}
/** Existing targets cannot drift; new targets must bind uniquely to an actually new compiled field. */
export function admissionFieldTargets(
  plan: Pick<InvestigatedPlan, "requirements" | "workflowRules">,
  source: {
    field: string;
    target?: FieldTarget;
    sourceRevision: string;
    sourceQuote: string;
  },
  catalog: FieldTarget[],
) {
  const fields = (plan.requirements ?? []).flatMap((r) =>
    (r.obligations ?? []).flatMap((o) =>
      o.kind === "field" ? [{ requirement: r, field: o }] : [],
    ),
  );
  if (source.target)
    return [
      ...new Set(
        fields
          .filter(
            ({ field: f }) =>
              fieldIdentityKey(f) === fieldIdentityKey(source.target!),
          )
          .map(({ field: f }) => fieldIdentityKey(f)),
      ),
    ];
  const matches = sourceFieldCandidates(fields, source, plan.workflowRules);
  if (
    matches.some(({ field: f }) =>
      catalog.some((t) => t.member === f.member && t.field === f.field),
    )
  )
    return [];
  return [...new Set(matches.map(({ field: f }) => fieldIdentityKey(f)))];
}
