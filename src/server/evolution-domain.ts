import {
  capture,
  planningInstruction,
  planningTools,
  readInvestigation,
  parsePlan,
  type Investigation,
} from "./planning.js";
import type { PlanEvidence } from "../shared/assistant.js";
import type { Domain, Target } from "../evolution/evolution.js";
import { Workspace } from "./workspace.js";
import {
  AppError,
  type WorkflowDefinition,
  type WorkflowDecision,
  type Task,
} from "../shared/contracts.js";
import type { RuntimeLike, Version } from "../release/types.js";
import { hash } from "../release/storage.js";

type Rule = {
  key: string;
  label: string;
  required: boolean;
  minLength: number;
  maxLength: number;
};
type Goal = { pluginId: string; name: string; fields: Rule[] };
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);
export const contract = `export type Task = { id:string; title:string; description:string; state:string; revision:number; createdAt:string; updatedAt:string; deletedAt:string|null; fields:Record<string,string> };
export type Field = { key:string; label:string; type:"text"; required?:boolean; description?:string };
export type WorkflowDefinition = { id:string; name:string; version:string; initialState:string; states:Record<string,{label:string;category:"open"|"done"}>; actions:{id:string;label:string;from:string[]}[]; fields:Field[] };
export type WorkflowDecision = {kind:"reject";message:string}|{kind:"input-required";fields:Field[]}|{kind:"commit";state:string;fields:Record<string,string>};
export type Plugin = { describe():WorkflowDefinition; decide(data:{task:Task; action:string; input:Record<string,string>}):WorkflowDecision };
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
  check(target: Target, revision: number) {
    if (
      this.workspace.composition().revision !== revision ||
      this.workspace.activeVersion().id !== target.baseVersion
    )
      throw new AppError("PLAN_STALE", "基础版本已变化，请重新规划并确认", 409);
  }
  async candidate(
    source: string,
    target: Target,
    signal: AbortSignal,
    stage: (label: string) => void,
  ) {
    const base = this.workspace.release.get(target.baseVersion);
    const goal = target.payload as Goal;
    stage("构建候选");
    const code = await this.workspace.release.build(source, contract, signal);
    signal.throwIfAborted();
    const definition: WorkflowDefinition = {
      ...(base.definition as WorkflowDefinition),
      id: goal.pluginId,
      name: goal.name,
      version: "generated",
      fields: goal.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: "text",
        required: f.required,
      })),
    };
    const candidate = this.workspace.release.record({
      pluginId: goal.pluginId,
      name: goal.name,
      parentId: base.pluginId === goal.pluginId ? base.id : undefined,
      service: "workflow",
      contractVersion: "workflow/1",
      source,
      code,
      definition,
      evidence: { passed: false, rules: goal.fields },
    });
    stage("验证行为");
    let actual: WorkflowDefinition = definition;
    let checks: string[] = [];
    const prepared = await this.workspace.release.prepare(
      candidate,
      async (runtime) => {
        const abort = () => {
          void runtime.close();
        };
        signal.addEventListener("abort", abort, { once: true });
        try {
          signal.throwIfAborted();
          actual = await runtime.invoke<WorkflowDefinition>("describe");
          checks = await verifyWorkflow(runtime, actual, base, goal);
          signal.throwIfAborted();
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
    );
    await prepared.runtime.close();
    const verified = this.workspace.release.record({
      pluginId: goal.pluginId,
      name: goal.name,
      parentId: candidate.parentId,
      service: "workflow",
      contractVersion: "workflow/1",
      source,
      code,
      definition: actual,
      evidence: {
        passed: true,
        rules: goal.fields,
        checks,
        verifier: "workspace/1",
        baseVersion: base.id,
      },
    });
    return verified.id;
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
    !equal(definition.actions, expected.actions) ||
    !equal(
      definition.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        required: !!f.required,
      })),
      goal.fields.map((f) => ({
        key: f.key,
        label: f.label,
        type: "text",
        required: f.required,
      })),
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
    if (!ok) throw new Error(`行为验收失败：${name}`);
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
