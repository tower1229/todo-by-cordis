import type { WorkflowRule } from "../shared/assistant.js";
import type { WorkflowDefinition, WorkflowDecision, Task } from "../shared/contracts.js";
import type { RuntimeLike, Version } from "../release/types.js";
import { BusinessAssertionError, type BusinessExtensions } from "./business-verification.js";
import { workflowTextVector } from "../shared/checker-semantics.js";
import { hash } from "../release/storage.js";

type Rule = WorkflowRule;
type Goal = {
  pluginId: string;
  name: string;
  fields: Rule[];
  extensions?: BusinessExtensions;
};
const equal = (a: unknown, b: unknown) => hash(a) === hash(b);

/** Shared valid complete-input map for decide and Workspace acceptance cases. */
export function validFieldInputs(fields: Rule[]) {
  return Object.fromEntries(
    fields.map((f) => [
      f.key,
      "文".repeat(Math.max(f.required ? 1 : 0, f.minLength)),
    ]),
  );
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
  const valid = validFieldInputs(goal.fields);
  const assert = (ok: boolean, name: string, detail?: Record<string, unknown>) => {
    if (!ok)
      throw new BusinessAssertionError(
        `行为验收失败：${name}${detail ? `；${JSON.stringify(detail)}` : ""}`,
      );
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
          {
            state: "open",
            action: "complete",
            input,
            fields: { ...task.fields, [f.key]: "已有历史文字" },
            expected: { kind: "input-required", field: f.key },
            actual: d,
          },
        );
      }
    }
    if (f.minLength > 1) {
      const d = await decide("open", "complete", {
        ...valid,
        [f.key]: workflowTextVector(f.minLength - 1),
      });
      assert(d.kind === "reject", `${f.key}:minimum`);
    }
    const d = await decide("open", "complete", {
      ...valid,
      [f.key]: workflowTextVector(f.maxLength + 1),
    });
    assert(d.kind === "reject", `${f.key}:maximum`);
    const boundary = await decide("open", "complete", {
      ...valid,
      [f.key]: workflowTextVector(f.maxLength, true),
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
