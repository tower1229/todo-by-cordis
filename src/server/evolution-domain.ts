import {
  BusinessAssertionError,
  verifyExtensions,
  type BusinessExtensions,
} from "./business-verification.js";
import {
  capture,
  planningInstruction,
  planningTools,
  readInvestigation,
  parsePlan,
  type Investigation,
} from "./planning.js";
import type {
  PlanEvidence,
  InvestigatedPlan,
  ExperienceReport,
} from "../shared/assistant.js";
import type { Domain, Target } from "../evolution/evolution.js";
import { Workspace } from "./workspace.js";
import {
  AppError,
  type WorkflowDefinition,
  type WorkflowDecision,
  type Task,
} from "../shared/contracts.js";
import type { RuntimeLike, Version } from "../release/types.js";
import {
  parseBusinessFiles,
  ProtectedCandidateError,
  CandidateValidationError,
} from "../release/business-bundle.js";
import { hash } from "../release/storage.js";

type Rule = {
  key: string;
  label: string;
  required: boolean;
  minLength: number;
  maxLength: number;
};
type Goal = {
  pluginId: string;
  name: string;
  fields: Rule[];
  extensions?: BusinessExtensions;
  repairEvidence?: InvestigatedPlan["repairEvidence"];
  acceptanceRevision?: InvestigatedPlan["acceptanceRevision"];
  scope?: string[];
  capabilities?: InvestigatedPlan["capabilityChanges"];
};
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);
export const contract = `export type Task = { id:string; title:string; description:string; state:string; revision:number; createdAt:string; updatedAt:string; deletedAt:string|null; fields:Record<string,string> };
export type Field = { key:string; label:string; type:"text"; required?:boolean; description?:string };
export type WorkflowDefinition = { id:string; name:string; version:string; initialState:string; states:Record<string,{label:string;category:"open"|"done"}>; actions:{id:string;label:string;from:string[]}[]; fields:Field[] };
export type WorkflowDecision = {kind:"reject";message:string}|{kind:"input-required";fields:Field[]}|{kind:"commit";state:string;fields:Record<string,string>};
export type Workflow = { definition: WorkflowDefinition; decide(task:Task,action:string,input:Record<string,string>):WorkflowDecision };
export type MissPolicy = "skip"|"run-once";
export type TaskEventKind = "task.created"|"task.updated"|"task.deleted";
export type ExtensionContribution = {
  commands?:{id:string;label:string;from?:string[]}[];
  fields?:Field[];
  beforeCommit?:boolean;
  events?:TaskEventKind[];
  schedules?:{id:string;at:string;atKind?:"absolute"|"field";timezone?:string;dedupeKey:string;onFire:{type:"action";commandId:string;taskId?:string;input?:Record<string,string>};missPolicy:MissPolicy}[];
  lifecycle?:{activate?:boolean;ready?:boolean;quiesce?:boolean;dispose?:boolean};
  uiSlots?:{id:string;slot:string;order?:number}[];
  queryFilters?:{id:string;label:string}[];
  querySorts?:{id:string;label:string;primary?:boolean}[];
  diagnostics?:boolean;
  services?:{id:string;version:string}[];
};
export type BeforeCommitInput = { task:Task; draft:Task; action:string; input:Record<string,string>; decision:Extract<WorkflowDecision,{kind:"commit"}> };
export type BeforeCommitResult = {kind:"ok";fields?:Record<string,string>;state?:string;annotations?:string[]}|{kind:"reject";message:string};
export type TaskEvent = { kind:TaskEventKind; task:Task; changedPaths:string[]; revision:number; source:string };
export type HookAnnotations = { annotations?:string[] };
export type Plugin = {
  describe():WorkflowDefinition;
  decide(data:{task:Task; action:string; input:Record<string,string>}):WorkflowDecision;
  contribute?():ExtensionContribution;
  lifecycleActivate?(data?:Record<string,never>):void|HookAnnotations;
  lifecycleReady?(data?:Record<string,never>):void|HookAnnotations;
  lifecycleQuiesce?(data?:Record<string,never>):void|HookAnnotations;
  lifecycleDispose?(data?:Record<string,never>):void|HookAnnotations;
  beforeCommit?(data:BeforeCommitInput):BeforeCommitResult;
  onTaskEvent?(data:TaskEvent):void|HookAnnotations;
};
`;
export class EvolutionDomain implements Domain {
  constructor(private workspace: Workspace) {}
  context() {
    return capture(this.workspace);
  }
  planningInstruction = planningInstruction;
  planningTools = planningTools;
  read(name: string, args: Record<string, unknown>, context: Investigation) {
    return readInvestigation(name, args, context);
  }
  parse(value: unknown, context: Investigation, seen: PlanEvidence[]) {
    const parsed = parsePlan(value, context, seen);
    if (
      this.workspace.composition().revision !== context.revision ||
      this.workspace.activeVersion().id !== context.versionId
    )
      parsed.blockers.push("基础版本已变化，请重新调查");
    const current = capture(this.workspace);
    if (hash(current.files) !== hash(context.files))
      parsed.blockers.push("调查期间实现资料已变化，请重新调查");
    return parsed;
  }
  async reproduce(plan: InvestigatedPlan, signal: AbortSignal) {
    const base = this.workspace.release.get(plan.baseVersion!);
    this.check(this.target(plan), plan.compositionRevision);
    const runtime = await this.workspace.release.start(base);
    const abort = () => {
      void runtime.close();
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      const definition = await runtime.invoke<WorkflowDefinition>("describe");
      try {
        await verifyWorkflow(
          runtime,
          definition,
          base,
          this.target(plan).payload as Goal,
        );
        if (plan.extensions) await verifyExtensions(runtime, plan.extensions);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof BusinessAssertionError)) throw error;
        return {
          baseVersion: base.id,
          definitionHash: hash({
            rules: plan.workflowRules,
            extensions: plan.extensions,
          }),
          diagnostic: error.message,
        };
      }
      return undefined;
    } finally {
      signal.removeEventListener("abort", abort);
      await runtime.close();
    }
  }
  target(plan: InvestigatedPlan): Target {
    const base = this.workspace.release.get(plan.baseVersion!);
    const priorCapabilities =
      (
        base.evidence as {
          capabilities?: {
            capability: string;
            provider: string;
            consumers: string[];
          }[];
        }
      ).capabilities ?? [];
    const capabilities = [
      ...plan.capabilityChanges,
      ...priorCapabilities
        .filter(
          (old) =>
            !plan.capabilityChanges.some(
              (c) => c.capability === old.capability,
            ),
        )
        .map((old) => ({
          capability: old.capability,
          provider: old.provider,
          consumers: old.consumers,
          change: "保留已有能力",
        })),
    ];
    return {
      kind: "plugin",
      baseVersion: plan.baseVersion!,
      payload: {
        pluginId: base.pluginId,
        name: base.name,
        repairEvidence: plan.repairEvidence,
        acceptanceRevision: plan.acceptanceRevision,
        fields: plan.workflowRules,
        extensions: plan.extensions,
        scope: plan.writableScope,
        capabilities,
      },
    };
  }
  check(target: Target, revision: number) {
    if (
      this.workspace.composition().revision !== revision ||
      this.workspace.activeVersion().id !== target.baseVersion
    )
      throw new AppError("PLAN_STALE", "基础版本已变化，请重新规划并确认", 409);
  }
  isActiveVersion(versionId: string) {
    return this.workspace.activeVersion().id === versionId;
  }
  isReadyVersion(versionId: string) {
    return (
      this.isActiveVersion(versionId) &&
      this.workspace.composition().status === "ready"
    );
  }
  generation(target: Target) {
    const base = this.workspace.release.get(target.baseVersion);
    return {
      contract,
      source: base.source,
      instruction: `Implement the frozen plan using submit_candidate with files [{path,content}]. Read read_contract and read_current_source first. The business artifact requires business/entry.ts (default Plugin), business/view.ts (default JSON serializable presentation {title,fields:string[]}), business/config.json (business data only), business/compatibility.json ({"preserveUnknownFields":true}), and optional business/*.ts providers/interfaces. Only exact planned writable paths are allowed; business/contract.ts is supplied by the trusted host, never submit it. Imports may only be relative './*.js' resolving within submitted TS files; no runtime dependencies, IO, globals, eval, any or enum. Config can be represented in a typed business module when used; JSON config and compatibility are versioned data, not scripts. Keep pluginId, name, existing states/actions, fields and unknown task.fields. workflowRules require trimmed Unicode lengths and required-input form on complete; reopen preserves fields. extensions define additional actions/fields with frozen cases; implement all of them, do not weaken cases. view fields must exactly match describe().fields keys in order. Host builds and independently checks; repair real errors within scope. report_blocker if scope/control changes are necessary. Never publish or invent a pass report. Successful validation waits for user apply.`,
    };
  }
  async candidate(
    source: string,
    target: Target,
    signal: AbortSignal,
    stage: (label: string) => void,
  ) {
    const base = this.workspace.release.get(target.baseVersion);
    const goal = target.payload as Goal;
    if (
      goal.repairEvidence &&
      (goal.repairEvidence.baseVersion !== base.id ||
        goal.repairEvidence.definitionHash !==
          hash({ rules: goal.fields, extensions: goal.extensions }))
    )
      throw new ProtectedCandidateError("修复断言与旧版证据不一致");
    stage("构建候选");
    if (
      !source.startsWith('{"files":') &&
      (!goal.scope?.includes("active-source") || !!base.bundle)
    )
      throw new ProtectedCandidateError(
        "单源码入口未获冻结范围授权，请提交完整候选文件",
      );
    const files = source.startsWith('{"files":')
      ? parseBusinessFiles((JSON.parse(source) as { files: unknown }).files)
      : {
          "business/entry.ts": source,
          "business/view.ts": `export default ${JSON.stringify({ title: goal.name, fields: goal.fields.map((f) => f.key) })};`,
          "business/config.json": "{}",
          "business/compatibility.json": '{"preserveUnknownFields":true}',
        };
    if (
      source.startsWith('{"files":') &&
      goal.scope &&
      [
        ...new Set([
          ...Object.keys(files),
          ...Object.keys(base.bundle?.files ?? {}),
        ]),
      ].some(
        (path) =>
          path !== "business/contract.ts" &&
          !goal.scope!.includes(path) &&
          files[path] !== base.bundle?.files[path],
      )
    )
      throw new ProtectedCandidateError(
        "候选超出冻结可写范围，必须重新 Plan 和 start",
      );
    const bundle = await this.workspace.release.buildBundle(
      files,
      contract,
      signal,
    );
    const code = bundle.outputs["business/entry.js"];
    signal.throwIfAborted();
    const definition: WorkflowDefinition = {
      ...(base.definition as WorkflowDefinition),
      id: goal.pluginId,
      name: goal.name,
      version: "generated",
      actions: [
        ...(base.definition as WorkflowDefinition).actions,
        ...(goal.extensions?.actions ?? []).filter(
          (a) =>
            !(base.definition as WorkflowDefinition).actions.some(
              (old) => old.id === a.id,
            ),
        ),
      ],
      fields: [
        ...goal.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: "text" as const,
          required: f.required,
        })),
        ...(goal.extensions?.fields ?? []),
      ],
    };
    const candidate = this.workspace.release.record({
      pluginId: goal.pluginId,
      name: goal.name,
      parentId: base.pluginId === goal.pluginId ? base.id : undefined,
      service: "workflow",
      contractVersion: "workflow/1",
      source,
      code,
      bundle,
      definition,
      evidence: { passed: false, rules: goal.fields },
    });
    stage("验证行为");
    let actual: WorkflowDefinition = definition;
    let checks: string[] = [];
    let systemChecks: string[] = [];
    let capabilities: unknown[] = [];
    const prepared = await this.workspace.release
      .prepare(candidate, async (runtime) => {
        const abort = () => {
          void runtime.close();
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          actual = await runtime.invoke<WorkflowDefinition>("describe");
          const info = await runtime.invoke<{
            presentation: { title: string; fields: string[] };
            modules: { path: string; status: string; exports: string[] }[];
          }>("__business_info");
          if (
            !info ||
            typeof info.presentation?.title !== "string" ||
            !equal(
              info.presentation.fields,
              actual.fields.map((f) => f.key),
            )
          )
            throw new Error("前端资源与业务接口字段不一致");
          capabilities = (goal.capabilities ?? []).map((c) => {
            const provider =
              c.provider === "active-source" ? "business/entry.ts" : c.provider;
            if (!provider.startsWith("business/"))
              return {
                id: hash({ pluginId: goal.pluginId, capability: c.capability }),
                declared: true,
                ready: false,
                provider,
              };
            const module = info.modules.find(
              (m) => m.path === provider.replace(/\.ts$/, ".js"),
            );
            if (
              !module ||
              module.status !== "evaluated" ||
              !module.exports.length
            )
              throw new Error(`能力提供者未实际加载：${provider}`);
            return {
              id: hash({ pluginId: goal.pluginId, capability: c.capability }),
              capability: c.capability,
              provider,
              version: hash(bundle.outputs[provider.replace(/\.ts$/, ".js")]),
              interface: module.exports,
              dependencies: [
                ...bundle.files[provider].matchAll(/from\s*["']([^"']+)["']/g),
              ].map((m) => m[1]),
              consumers: c.consumers,
              declared: true,
              ready: true,
              evidence: candidate.id,
            };
          });
          systemChecks = await verifyProtection(runtime, actual);
          checks = await verifyWorkflow(runtime, actual, base, goal);
          if (goal.extensions)
            checks.push(...(await verifyExtensions(runtime, goal.extensions)));
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener("abort", abort);
        }
      })
      .catch((error: unknown) => {
        throw new CandidateValidationError(
          error instanceof Error ? error.message : "候选验证失败",
          candidate.id,
        );
      });
    await prepared.runtime.close();
    const verified = this.workspace.release.record({
      pluginId: goal.pluginId,
      name: goal.name,
      parentId: candidate.parentId,
      service: "workflow",
      contractVersion: "workflow/1",
      source,
      code,
      bundle,
      definition: actual,
      evidence: {
        passed: true,
        acceptanceRevision: goal.acceptanceRevision,
        repairEvidence: goal.repairEvidence,
        rules: goal.fields,
        extensions: goal.extensions,
        checks,
        systemChecks,
        capabilities,
        definitionHash: hash({
          rules: goal.fields,
          extensions: goal.extensions,
        }),
        environment: {
          node: process.version,
          lockHash: bundle.lockHash,
          builder: bundle.builder,
        },
        verifier: "workspace/1",
        baseVersion: base.id,
      },
    });
    return verified.id;
  }
  async experience(
    versionId: string,
    candidateId: string,
    signal: AbortSignal,
  ): Promise<ExperienceReport> {
    const version = this.workspace.release.get(versionId);
    const runtime = await this.workspace.release.start(version);
    try {
      signal.throwIfAborted();
      const definition = await runtime.invoke<WorkflowDefinition>("describe");
      const info = await runtime.invoke<{
        presentation: { title: string; fields: string[] };
      }>("__business_info");
      const sample = await runtime.invoke<WorkflowDecision>("decide", {
        task: {
          state: definition.initialState,
          fields: { retained: "preview-only" },
        },
        action: "complete",
        input: {},
      });
      const checks = [
        `describe:${definition.id}`,
        `presentation:${info.presentation.title}`,
        `fields:${info.presentation.fields.join(",")}`,
        `decide:${sample.kind}`,
      ];
      const evidence = version.evidence as { extensions?: BusinessExtensions };
      if (evidence.extensions) {
        signal.throwIfAborted();
        checks.push(
          ...(await verifyExtensions(runtime, evidence.extensions)).map(
            (name) => `extension:${name}`,
          ),
        );
      }
      signal.throwIfAborted();
      return {
        candidateId,
        marked: "not-applied",
        isolated: true,
        simulated: true,
        checks,
        presentation: info.presentation,
        note: "候选体验使用隔离环境与模拟数据，结果已标注为尚未应用，未写入正式任务。",
      };
    } finally {
      await runtime.close();
    }
  }
  async apply(
    versionId: string,
    target: Target,
    revision: number,
    operationId: string,
    complete: () => void,
    signal: AbortSignal,
  ) {
    this.check(target, revision);
    await this.workspace.activate(
      { versionId, compositionRevision: revision, operationId },
      () => {
        signal.throwIfAborted();
        complete();
      },
      signal,
    );
  }
}

// Host-owned oracle: frozen field rules plus existing workflow behavior, never model-written tests.
export async function verifyWorkflow(
  runtime: RuntimeLike,
  definition: WorkflowDefinition,
  base: Version,
  goal: Goal,
) {
  const expected = base.definition as WorkflowDefinition;
  if (
    definition.id !== goal.pluginId ||
    definition.name !== goal.name ||
    !definition.version ||
    definition.initialState !== expected.initialState ||
    !equal(definition.states, expected.states) ||
    !equal(definition.actions, [
      ...expected.actions,
      ...(goal.extensions?.actions ?? []).filter(
        (a) => !expected.actions.some((old) => old.id === a.id),
      ),
    ]) ||
    !equal(
      definition.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: !!f.required,
      })),
      [
        ...goal.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: "text" as const,
          required: f.required,
        })),
        ...(goal.extensions?.fields ?? []).map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          required: !!f.required,
        })),
      ],
    )
  )
    throw new Error("工作流定义不符合已确认契约");
  const task: Task = {
    id: "oracle",
    title: "Existing item",
    description: "Preserve",
    state: "open",
    revision: 7,
    createdAt: "2026-01-01",
    updatedAt: "2026-01-01",
    deletedAt: null,
    fields: { retained: "historical" },
  };
  const checks: string[] = [];
  const decide = (
    state: string,
    action: string,
    input: Record<string, string>,
    fields = task.fields,
  ) =>
    runtime.invoke<WorkflowDecision>("decide", {
      task: { ...task, state, fields },
      action,
      input,
    });
  const valid = Object.fromEntries(
    goal.fields.map((f) => [
      f.key,
      "文".repeat(Math.max(f.required ? 1 : 0, f.minLength)),
    ]),
  );
  const assert = (ok: boolean, name: string) => {
    if (!ok) throw new BusinessAssertionError(`行为验收失败：${name}`);
    checks.push(name);
  };
  for (const f of goal.fields) {
    if (f.required) {
      for (const value of [undefined, "", "   "]) {
        const input = { ...valid };
        if (value === undefined) delete input[f.key];
        else input[f.key] = value;
        const d = await decide("open", "complete", input, {
          ...task.fields,
          [f.key]: "已有历史文字",
        });
        assert(
          d.kind === "input-required" && d.fields.some((x) => x.key === f.key),
          `${f.key}:missing-input-form`,
        );
      }
    }
    if (f.minLength > 1) {
      const d = await decide("open", "complete", {
        ...valid,
        [f.key]: "字".repeat(f.minLength - 1),
      });
      assert(d.kind === "reject", `${f.key}:minimum`);
    }
    const d = await decide("open", "complete", {
      ...valid,
      [f.key]: "字".repeat(f.maxLength + 1),
    });
    assert(d.kind === "reject", `${f.key}:maximum`);
    const boundary = await decide("open", "complete", {
      ...valid,
      [f.key]: "🙂".repeat(f.maxLength),
    });
    assert(boundary.kind === "commit", `${f.key}:unicode-boundary`);
  }
  const d = await decide(
    "open",
    "complete",
    Object.fromEntries(Object.entries(valid).map(([k, v]) => [k, ` ${v} `])),
  );
  assert(
    d.kind === "commit" &&
      d.state === "done" &&
      equal(d.fields, { ...task.fields, ...valid }),
    "complete-preserve-fields",
  );
  const reopened = await decide(
    "done",
    "reopen",
    {},
    { ...task.fields, ...valid },
  );
  assert(
    reopened.kind === "commit" &&
      reopened.state === "open" &&
      equal(reopened.fields, { ...task.fields, ...valid }),
    "reopen-preserve-fields",
  );
  for (const [state, action] of [
    ["done", "complete"],
    ["open", "reopen"],
    ["open", "unknown"],
  ])
    assert(
      (await decide(state, action, valid)).kind === "reject",
      `invalid:${state}:${action}`,
    );
  return checks;
}

// Independent host protection checks; candidate code cannot supply this report.
async function verifyProtection(
  runtime: RuntimeLike,
  definition: WorkflowDefinition,
) {
  if (!equal(await runtime.invoke("describe"), definition))
    throw new Error("保护验收失败：业务定义不稳定");
  let rejected = false;
  try {
    await runtime.invoke("__host_unknown_method");
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("保护验收失败：未知方法未拒绝");
  for (const state of Object.keys(definition.states)) {
    const result = await runtime.invoke<WorkflowDecision>("decide", {
      task: { id: "protected", state, fields: { retained: "keep" } },
      action: "__host_unknown_action",
      input: {},
    });
    if (result.kind !== "reject")
      throw new Error("保护验收失败：未知动作未拒绝");
  }
  return [
    "deterministic-definition",
    "unknown-method-rejected",
    "unknown-actions-rejected",
    "json-only-runtime-boundary",
  ];
}
