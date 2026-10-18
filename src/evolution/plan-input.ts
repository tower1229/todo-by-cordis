import { capabilityChecker } from "../server/capability-checkers.js";
import { executableMemberInterfaces } from "../server/extensions/registry.js";
import { hash } from "../release/storage.js";
import { schemaProblems } from "./model-protocol.js";
import type { Investigation } from "../server/planning.js";
import type { RequirementGate, WorkflowRule } from "../shared/assistant.js";
import type { MemberAcceptanceCase } from "../shared/acceptance-cases.js";
import type { BusinessExtensions } from "../server/business-verification.js";
import type { WorkflowDefinition } from "../server/business/contracts.js";
import { compilePrimaryOperations } from "./planning-operations.js";

const text = { type: "string" };
const list = <T extends Record<string, unknown>>(items: T, maxItems = 50) => ({
  type: "array",
  items,
  maxItems,
});
const object = <T extends Record<string, unknown>>(
  properties: T,
  required = Object.keys(properties),
) => ({ type: "object", properties, required, additionalProperties: false });
const kind = (...values: string[]) => ({ type: "string", enum: values });
const strings = list(text);
const optionalList = <T extends Record<string, unknown>>(items: T, maxItems = 50) => ({
  ...list(items, maxItems),
  type: ["array", "null"],
});
const dictionary = { type: "object", additionalProperties: text };
const expected = {
  anyOf: [
    object({ kind: kind("reject") }),
    object({ kind: kind("commit"), state: text, fields: dictionary }),
  ],
};
const businessCase = object(
  {
    name: text,
    state: text,
    fields: dictionary,
    action: text,
    input: dictionary,
    expected,
  },
  ["state", "fields", "action", "input", "expected"],
);
const initial = {
  anyOf: [
    object({ kind: kind("baseline", "absent") }),
    object({ kind: kind("visible"), value: text }),
  ],
};
const features = {
  commands: "command.register",
  fields: "fields.register",
  detail: "ui.slot",
  beforeCommit: "task.beforeCommit",
  events: "task.events",
  schedules: "schedule.register",
  lifecycle: "lifecycle",
  diagnostics: "diagnostics.annotate",
} as const satisfies Record<
  string,
  (typeof executableMemberInterfaces)[number]
>;
const usedFeatures = {
  ...features,
  workflow: "workflow.provide",
  scheduler: "schedule.runtime",
  filter: "query.filter",
  sort: "query.sort",
  service: "service.provide",
} as const;
export const businessExpectationsSchema = list(
  {
    anyOf: [
      object({ kind: kind("behavior", "preserve-ui") }),
      object(
        { kind: kind("field"), field: text, initial, examples: list(text, 8) },
        ["kind", "field"],
      ),
      object({ kind: kind("history"), field: text }),
      object({
        kind: kind("action-visible"),
        action: text,
        state: text,
        visible: { type: "boolean" },
      }),
      object({ kind: kind("error"), action: text, text }, ["kind", "action"]),
      object({ kind: kind("operation-rejected"), action: text }),
      object({ kind: kind("task") }),
      object({ kind: kind("edit-task"), title: text, description: text }, [
        "kind",
      ]),
    ],
  },
  30,
);
const changeProperties = {
  name: text,
  enabled: { type: "boolean" },
  modules: optionalList(text),
  data: optionalList(text),
  features: optionalList(kind(...Object.keys(features))),
  fields: optionalList(
    object({
      key: text,
      label: text,
      required: { type: "boolean" },
      minLength: { type: "integer", minimum: 0, maximum: 5000 },
      maxLength: { type: "integer", minimum: 1, maximum: 5000 },
    }),
  ),
  actions: optionalList(object({ id: text, label: text, from: strings })),
  actionFields: optionalList(
    object({ key: text, label: text, type: kind("text") }),
  ),
  cases: optionalList(businessCase),
};

/** Both the advertised contract and host validation use the real target identity. */
export function planSchemaFor(
  context?: Pick<Investigation, "pluginId" | "members">,
) {
  const primary = [
    ...new Set([
      ...(context?.members.some(
        (m) => m.pluginId === "workflow" && m.role !== "workflow",
      )
        ? []
        : ["workflow"]),
      ...(context ? [context.pluginId] : []),
    ]),
  ];
  const escaped = primary.map((id) =>
    id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  const auxiliary = {
    type: "string",
    pattern: `^(?!(?:${escaped.join("|")})$)[\\w.-]{1,100}$`,
  };
  const pick = (keys: (keyof typeof changeProperties)[]) =>
    Object.fromEntries(keys.map((key) => [key, changeProperties[key]]));
  return object(
    {
      summary: text,
      changes: optionalList(
        {
          anyOf: [
            object(
              {
                target: kind(...primary),
                ...pick([
                  "modules",
                  "data",
                  "fields",
                  "actions",
                  "actionFields",
                  "cases",
                ]),
              },
              ["target"],
            ),
            object(
              { target: auxiliary, ...pick(["name", "features", "cases"]) },
              ["target"],
            ),
            object({
              target: context
                ? kind(
                    ...context.members
                      .filter((m) => m.role === "auxiliary")
                      .map((m) => m.pluginId),
                  )
                : auxiliary,
              enabled: { type: "boolean" },
            }),
          ],
        },
        2,
      ),
      requirements: list(
        object({
          description: text,
          quote: text,
          type: kind("behavior", "interface", "compatibility", "constraint"),
          expectations: businessExpectationsSchema,
        }),
        50,
      ),
      uses: optionalList(
        object({ member: text, feature: kind(...Object.keys(usedFeatures)) }),
      ),
      intent: kind("improve", "repair"),
      acceptanceReason: text,
    },
    ["summary", "requirements"],
  );
}
export const planInputSchema = planSchemaFor();

type CaseInput = Omit<MemberAcceptanceCase, "member" | "name"> & {
  name?: string;
};
type Expectation =
  | { kind: "behavior" | "preserve-ui" }
  | {
      kind: "field";
      field: string;
      initial?:
        | { kind: "baseline" | "absent" }
        | { kind: "visible"; value: string };
      examples?: string[];
    }
  | { kind: "history"; field: string }
  | { kind: "action-visible"; action: string; state: string; visible: boolean }
  | { kind: "error"; action: string; text?: string }
  | { kind: "operation-rejected"; action: string }
  | { kind: "task" }
  | { kind: "edit-task"; title?: string; description?: string };
type NormalizedInput = {
  summary: string;
  workflow: null | {
    modules: string[];
    data?: string[];
    fields: WorkflowRule[];
    actions?: NonNullable<BusinessExtensions>["actions"];
    actionFields?: NonNullable<BusinessExtensions>["fields"];
    cases?: CaseInput[];
  };
  members: (
    | {
        operation: "add" | "upgrade";
        pluginId: string;
        name?: string;
        features?: (keyof typeof features)[];
        cases: CaseInput[];
      }
    | { operation: "enable" | "disable"; pluginId: string }
  )[];
  requirements: {
    description: string;
    quote: string;
    type: string;
    expectations: Expectation[];
  }[];
  uses?: { member: string; feature: keyof typeof usedFeatures }[];
  intent?: "improve" | "repair";
  acceptanceReason?: string;
};
export type PlanInput = Omit<
  NormalizedInput,
  "workflow" | "members" | "uses"
> & {
  changes?:
    | {
        target: string;
        name?: string;
        enabled?: boolean;
        modules?: string[] | null;
        data?: string[] | null;
        fields?: WorkflowRule[] | null;
        actions?: NonNullable<BusinessExtensions>["actions"] | null;
        actionFields?: NonNullable<BusinessExtensions>["fields"] | null;
        cases?: CaseInput[] | null;
        features?: (keyof typeof features)[] | null;
      }[]
    | null;
  uses?: NormalizedInput["uses"] | null;
};
type PlanContext = Pick<
  Investigation,
  "pluginId" | "files" | "capabilities" | "members"
>;
function resolveTarget(target: string, context: PlanContext): string {
  if (target !== "workflow") return target;
  if (
    context.members.some(
      (m) => m.pluginId === "workflow" && m.role !== "workflow",
    )
  )
    throw new Error("主工作流别名与辅助成员身份冲突，请使用精确主工作流身份");
  return context.pluginId;
}

/** Resolve write roles from the installed composition, never from model-authored operations. */
function normalizeInput(
  value: PlanInput,
  context: PlanContext,
): NormalizedInput {
  const { changes, uses, ...business } = value;
  const input: NormalizedInput = {
    ...business,
    workflow: null,
    members: [],
    uses: (uses ?? []).map((need) => ({
      ...need,
      member: resolveTarget(need.member, context),
    })),
  };
  const targets = new Set<string>();
  const previous = JSON.parse(context.files["active-acceptance"].content) as {
    rules?: WorkflowRule[];
  };
  for (const raw of changes ?? []) {
    const change = { ...raw };
    // Only properties admitted by the target-specific schema reach normalization.
    // Null is omitted; empty rules/actions remain explicit revisions.
    // Empty additive sets carry no write intent.
    for (const key of [
      "modules",
      "data",
      "features",
      "cases",
      "fields",
      "actions",
      "actionFields",
    ] as const)
      if (change[key] === null) delete change[key];
    for (const key of ["modules", "data", "features", "cases"] as const)
      if (change[key]?.length === 0) delete change[key];
    const target = resolveTarget(change.target, context);
    if (targets.has(target)) throw new Error("同一写入目标重复");
    targets.add(target);
    const member = context.members.find((m) => m.pluginId === target);
    const primary = target === context.pluginId;
    if (primary && member && member.role !== "workflow")
      throw new Error("宿主主工作流身份与组合角色冲突");
    if (change.enabled !== undefined) {
      if (primary) throw new Error("不能启停主工作流");
      if (!member || member.role !== "auxiliary")
        throw new Error("启停目标不是已安装辅助成员");
      if (Object.keys(change).some((k) => !["target", "enabled"].includes(k)))
        throw new Error("启停不能混入源码或验收声明");
      input.members.push({
        pluginId: target,
        operation: change.enabled ? "enable" : "disable",
      });
    } else if (primary) {
      if (change.features?.length || change.name !== undefined)
        throw new Error("主工作流不能声明辅助成员能力或重命名");
      input.workflow = {
        modules: change.modules?.length ? change.modules : ["workflow"],
        fields: change.fields ?? previous.rules ?? [],
        ...(change.data?.length ? { data: change.data } : {}),
        ...(change.actions ? { actions: change.actions } : {}),
        ...(change.actionFields ? { actionFields: change.actionFields } : {}),
        ...(change.cases?.length ? { cases: change.cases } : {}),
      };
    } else {
      if (
        ["modules", "data", "fields", "actions", "actionFields"].some((k) =>
          Object.hasOwn(change, k),
        )
      )
        throw new Error("辅助成员不能声明主工作流字段或模块");
      if (member && member.role !== "auxiliary")
        throw new Error("目标不是辅助成员");
      input.members.push({
        pluginId: target,
        operation: member ? "upgrade" : "add",
        ...(change.name ? { name: change.name } : {}),
        features: change.features ?? [],
        cases: change.cases ?? [],
      });
    }
  }
  if (input.members.length > 1) throw new Error("本次仅允许一个辅助成员变更");
  return input;
}
type Row = Record<string, unknown>;
const caseKey = (c: Omit<CaseInput, "name">) =>
  hash({ state: c.state, fields: c.fields, action: c.action, input: c.input });

/** Business statements in, host-bound draft out. No transport tags or model-authored references. */
export function compilePlanInput(
  value: unknown,
  context: PlanContext,
  sources: RequirementGate["sources"],
) {
  const errors = schemaProblems(value, planSchemaFor(context));
  if (errors.length) throw new Error("业务计划契约：" + errors.join("；"));
  const input = normalizeInput(value as PlanInput, context);
  if (
    !input.requirements.length ||
    input.requirements.some((r) => !r.expectations.length)
  )
    throw new Error("需求及业务验收预期不能为空");
  const previous = JSON.parse(context.files["active-acceptance"].content) as {
    rules?: WorkflowRule[];
    memberCases?: MemberAcceptanceCase[];
    extensions?: BusinessExtensions;
    requirements?: {
      id: string;
      description: string;
      sourceQuote: string;
      sourceRevision: string;
      type: string;
    }[];
  };
  const workflow = JSON.parse(context.files["active-contract"].content) as WorkflowDefinition;
  const rules = input.workflow?.fields ?? previous.rules ?? [];
  const existingFields=new Set([...(workflow.fields??[]).map(f=>f.key),...context.capabilities.flatMap(c=>c.registeredFields??[])]);
  if (rules.some((r) => r.minLength > r.maxLength))
    throw new Error("字段长度规则无效");
  const scope: string[] = [];
  for (const module of input.workflow?.modules ?? []) {
    if (module === "workflow" && !context.files["business/entry.ts"]) {
      scope.push("active-source");
      continue;
    }
    const name = module === "workflow" ? "entry" : module;
    if (
      !/^[a-zA-Z][\w-]{0,80}$/.test(name) ||
      ["contract", "view", "config", "compatibility"].includes(name)
    )
      throw new Error("业务模块不能引用受保护文件或任意路径");
    scope.push(`business/${name}.ts`);
    if (name === "entry")
      scope.push(
        "business/view.ts",
        "business/config.json",
        "business/compatibility.json",
      );
  }
  for (const name of input.workflow?.data ?? []) {
    if (
      !/^[a-zA-Z][\w-]{0,80}$/.test(name) ||
      ["config", "compatibility"].includes(name)
    )
      throw new Error("业务资产不能引用受保护文件或任意路径");
    scope.push(`business/${name}.json`);
  }
  if (new Set(scope).size !== scope.length) throw new Error("业务模块重复");
  const memberCases: MemberAcceptanceCase[] = [];
  const named = (c: CaseInput, member?: string) => {
    const old =
      (member ? previous.memberCases : previous.extensions?.cases)?.filter(
        (old) =>
          (!member || ("member" in old && old.member === member)) &&
          caseKey(old) === caseKey(c),
      ) ?? [];
    if (new Set(old.map((c) => c.name)).size > 1)
      throw new Error("同一业务操作对应多个基础案例身份，须先裁决");
    return {
      ...c,
      name: old[0]?.name ?? c.name ?? `${c.action}-${caseKey(c).slice(0, 16)}`,
      ...(member ? { member } : {}),
    };
  };
  const additions: { pluginId: string; name: string }[] = [],
    upgrades: { pluginId: string }[] = [],
    changes: {
      capability: string;
      provider: string;
      consumers: string[];
      change: string;
    }[] = [];
  let enabled: { pluginId: string; enabled: boolean } | undefined;
  for (const member of input.members) {
    if (!/^[\w.-]{1,100}$/.test(member.pluginId))
      throw new Error("成员业务身份无效");
    if (member.operation === "enable" || member.operation === "disable") {
      enabled = {
        pluginId: member.pluginId,
        enabled: member.operation === "enable",
      };
      continue;
    }
    if (!("cases" in member)) throw new Error("成员操作结构无效");
    if (member.operation === "add")
      additions.push({
        pluginId: member.pluginId,
        name: member.name ?? member.pluginId,
      });
    else upgrades.push({ pluginId: member.pluginId });
    for (const c of member.cases)
      memberCases.push(named(c, member.pluginId) as MemberAcceptanceCase);
    const selected = new Set(member.features ?? []);
    if (member.operation === "upgrade")
      for (const feature of Object.keys(features) as (keyof typeof features)[])
        if (
          context.capabilities.some(
            (c) =>
              c.providerId === member.pluginId &&
              c.interfaceId === features[feature] &&
              c.status === "active" &&
              c.authorized,
          )
        )
          selected.add(feature);
    if (member.cases.length) selected.add("commands");
    for (const feature of selected)
      changes.push({
        capability: features[feature],
        provider: `member:${member.pluginId}`,
        consumers: [
          feature === "detail"
            ? "src/web/TaskEditor.tsx"
            : "src/server/workspace.ts",
        ],
        change: input.summary,
      });
  }
  if (enabled && (input.workflow || input.members.length !== 1))
    throw new Error("启停候选只能改变 enabled，不得混入源码或验收变更");
  for (const path of scope.filter(
    (p) =>
      p === "active-source" || (p.endsWith(".ts") && p !== "business/view.ts"),
  ))
    changes.push({
      capability:
        path === "active-source" || path === "business/entry.ts"
          ? "workflow"
          : path.slice(9, -3),
      provider: path,
      consumers:
        path === "active-source" || path === "business/entry.ts"
          ? ["src/web/ActionForm.tsx"]
          : ["business/entry.ts", "business/view.ts"],
      change: input.summary,
    });
  const extensionCases = (input.workflow?.cases ?? []).map((c) => named(c));
  const extensions = input.workflow
    ? compilePrimaryOperations({...input.workflow,cases:extensionCases},workflow,rules,previous.extensions)
    : previous.extensions;
  const mergedCases = [
    ...(previous.memberCases ?? []).filter(
      (old) =>
        !memberCases.some(
          (c) => c.member === old.member && c.name === old.name,
        ),
    ),
    ...memberCases,
  ];
  const operations = [...mergedCases, ...(extensions?.cases ?? [])];
  const requiredCapabilities = [
    {
      interfaceId: "workflow.provide",
      providerId: context.pluginId,
      checker: "workflow/1",
    },
    ...(input.uses ?? []).map((need) => {
      const interfaceId = usedFeatures[need.feature];
      const current = context.capabilities.find(
        (c) => c.providerId === need.member && c.interfaceId === interfaceId,
      );
      const checker = capabilityChecker(interfaceId);
      if (
        current?.ready &&
        (!checker || !current.checkerCoverage.includes(checker))
      )
        throw new Error(
          `缺少可靠业务验收检查器：${interfaceId} / ${need.member}；不得猜测检查器或删除依赖`,
        );
      return {
        interfaceId,
        providerId: need.member,
        ...(current?.contractVersion
          ? { contractVersion: current.contractVersion }
          : {}),
        ...(checker && current?.checkerCoverage.includes(checker)
          ? { checker }
          : {}),
      };
    }),
  ];
  const checks = [
    { kind: "workflow" },
    ...(enabled ? [{ kind: "enabled" }] : []),
    ...mergedCases.map((_, i) => ({ kind: "member", index: i + 1 })),
    ...(extensions?.cases ?? []).map((_, i) => ({
      kind: "action",
      index: i + 1,
    })),
  ];
  const requirements = input.requirements.map((r) => {
    const matches = sources
      .map((s, i) => ({ ...s, index: i + 1 }))
      .filter((s) => r.quote.trim() && s.text.includes(r.quote));
    if (!matches.length) throw new Error("需求原文引用不存在");
    if (new Set(matches.map((s) => s.text)).size > 1)
      throw new Error("需求原文对应多个修订，请使用可唯一绑定的完整连续原文");
    const source = matches.at(-1)!;
    const old = (previous.requirements ?? []).filter(
      (o) => o.sourceQuote === r.quote && o.type === r.type,
    );
    const prior =
      old.find((o) => o.description === r.description) ??
      (old.length === 1 ? old[0] : undefined);
    const id =
      prior?.id ??
      "claim-" +
        hash({
          quote: r.quote,
          type: r.type,
          description: r.description,
        }).slice(0, 24);
    const obligations: Row[] = [];
    for (const e of r.expectations.filter(
      (e, i, all) => all.findIndex((other) => hash(other) === hash(e)) === i,
    )) {
      if (e.kind === "behavior") {
        obligations.push({ kind: "backend" });
        continue;
      }
      if (e.kind === "preserve-ui" || e.kind === "history") {
        obligations.push(e);
        continue;
      }
      if (e.kind === "field") {
        const rule = rules.find((f) => f.key === e.field);
        let scenarios: { steps: Row[]; value: string }[] = [];
        if (rule) {
          const base = Object.fromEntries(
            rules.map((f) => [f.key, "验".repeat(Math.max(1, f.minLength))]),
          );
          scenarios = (e.examples ?? [base[e.field]]).map((value) => ({
            steps: [
              {
                kind: "action",
                action: "complete",
                input: { ...base, [e.field]: value },
              },
              { kind: "action", action: "reopen" },
            ],
            value: value.trim(),
          }));
        } else
          // These are independent fresh-task field probes. Backend cases retain
          // their complete historical fields and expectations; no fields are seeded here.
          scenarios = operations
            .filter(
              (c) =>
                c.expected.kind === "commit" &&
                c.state === workflow.initialState &&
                (!Object.keys(c.fields).length||!existingFields.has(e.field)) &&
                Object.hasOwn(c.expected.fields, e.field) &&
                c.expected.fields[e.field] !== c.fields[e.field] &&
                (!e.examples ||
                  e.examples.includes(c.expected.fields[e.field])),
            )
            .map((c) => ({
              steps: [{ kind: "action", action: c.action, input: c.input }],
              value:
                c.expected.kind === "commit" ? c.expected.fields[e.field] : "",
            }));
        if (!scenarios.length)
          throw new Error(
            `字段 ${e.field} 没有可推导的冻结成功操作，不能伪造浏览器步骤`,
          );
        obligations.push({
          kind: "field",
          field: e.field,
          initial: e.initial ?? { kind: "baseline" },
          scenarios,
        });
        continue;
      }
      if (e.kind === "task" || e.kind === "edit-task") {
        const { kind: _kind, ...edit } = e;
        obligations.push({
          kind: "assertion",
          steps: Object.keys(edit).length ? [{ kind: "edit", ...edit }] : [],
          expected: { kind: "task" },
        });
        continue;
      }
      if (e.kind === "error" || e.kind === "operation-rejected") {
        const reject = operations.filter(c => c.action === e.action && c.expected.kind === "reject");
        if (reject.length)
          obligations.push({kind:"backend-rejection",action:e.action});
        if (e.kind === "operation-rejected") {
          if (!reject.length) throw new Error(`动作 ${e.action} 缺少冻结的后端拒绝案例`);
          continue;
        }
        if (e.text && !r.quote.includes(e.text))
          throw new Error("固定错误文案没有对应来源原文，不能新增用户未要求的文字限制");
        const scenarios: {steps:Row[]}[] = [];
        const unavailable: import("../shared/acceptance-obligations.js").FeedbackUnavailable[] = [];
        const valid = Object.fromEntries(rules.map(f=>[f.key,"验".repeat(Math.max(1,f.minLength))]));
        const hidden = (state:string) => input.requirements.some(r => r.expectations.some(e => e.kind === "action-visible" && e.action === action && e.state === state && !e.visible));
        const action=e.action;
        if (e.action === "complete" && rules.length) {
          if (hidden(workflow.initialState)) unavailable.push({code:"action-hidden",state:workflow.initialState});
          else for (const f of rules)
            for (const value of [...(f.required ? [" "] : []), "验".repeat(f.maxLength + 1)])
              scenarios.push({steps:[{kind:"action",action:e.action,input:{...valid,[f.key]:value}}]});
        } else {
          if (!reject.length) unavailable.push({code:"missing-rejection"});
          for (const c of reject) {
            if (hidden(c.state)) {unavailable.push({code:"action-hidden",state:c.state});continue;}
            const steps:Row[]=[];
            if (Object.keys(c.fields).length || c.state !== workflow.initialState && (rules.length > 0 || c.state !== "done" || !workflow.actions.some(a=>a.id==="complete"))) {
              unavailable.push({code:"state-unreachable",state:c.state});continue;
            }
            if (c.state !== workflow.initialState) steps.push({kind:"action",action:"complete",...(rules.length ? {input:valid} : {})});
            steps.push({kind:"action",action:c.action,input:c.input});
            scenarios.push({steps});
          }
        }
        obligations.push({kind:"feedback",action:e.action,text:e.text??"",resolution:"pending",scenarios,unavailable});
        continue;
      }
      if (e.kind === "action-visible") {
        const steps: Row[] = [];
        if (e.state !== workflow.initialState) {
          if (
            e.state !== "done" ||
            !workflow.actions.some((a) => a.id === "complete")
          )
            throw new Error("无法从冻结业务规则到达动作可见性断言的状态");
          steps.push({
            kind: "action",
            action: "complete",
            ...(rules.length
              ? {
                  input: Object.fromEntries(
                    rules.map((f) => [
                      f.key,
                      "验".repeat(Math.max(1, f.minLength)),
                    ]),
                  ),
                }
              : {}),
          });
        }
        obligations.push({
          kind: "assertion",
          steps,
          expected: {
            kind: "action-visible",
            action: e.action,
            visible: e.visible,
          },
        });
      }
    }
    return {
      id,
      description: r.description,
      source: source.index,
      sourceQuote: r.quote,
      type: r.type,
      checks,
      obligations,
    };
  });
  for (const r of input.requirements)
    for (const e of r.expectations) {
      if (e.kind !== "field" || rules.some((f) => f.key === e.field)) continue;
      const owners = new Set(
        mergedCases
          .filter(
            (c) =>
              c.expected.kind === "commit" &&
              Object.hasOwn(c.expected.fields, e.field) &&
              c.expected.fields[e.field] !== c.fields[e.field],
          )
          .map((c) => c.member),
      );
      for (const member of owners)
        if (
          input.members.some(
            (m) =>
              m.pluginId === member &&
              (m.operation === "add" || m.operation === "upgrade"),
          ) &&
          !changes.some(
            (c) =>
              c.provider === `member:${member}` && c.capability === "ui.slot",
          )
        )
          changes.push({
            capability: "ui.slot",
            provider: `member:${member}`,
            consumers: ["src/web/TaskEditor.tsx"],
            change: input.summary,
          });
    }
  if (new Set(requirements.map((r) => r.id)).size !== requirements.length)
    throw new Error("相同业务要求重复，请合并预期");
  return {
    requirements,
    summary: input.summary,
    changes: [input.summary],
    outcome: input.summary,
    dataImpact: "仅改变声明的业务模块或成员，保留其他成员及任务数据",
    excluded: [],
    workflowRules: rules,
    writableScope: scope,
    capabilityChanges: changes.length
      ? changes
      : [
          {
            capability: "workflow",
            provider: "active-source",
            consumers: ["src/web/ActionForm.tsx"],
            change: input.summary,
          },
        ],
    requiredCapabilities,
    compatibility: "保留未知字段及既有任务数据",
    dependencies: [],
    ...(extensions ? { extensions } : {}),
    ...(additions.length ? { memberAdditions: additions } : {}),
    ...(upgrades.length ? { memberUpgrades: upgrades } : {}),
    ...(memberCases.length ? { memberCases } : {}),
    ...(enabled ? { memberEnabled: enabled } : {}),
    ...(input.intent ? { intent: input.intent } : {}),
    ...(input.acceptanceReason
      ? { acceptanceReason: input.acceptanceReason }
      : {}),
  };
}
