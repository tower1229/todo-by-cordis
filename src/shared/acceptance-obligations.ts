import type { BrowserCase, BrowserStep } from "./browser-cases.js";
import { modelBrowserCasesSchema } from "./browser-contract.js";

export type FieldExpectation =
  | { kind: "visible"; value: string }
  | { kind: "absent" };
export type BaselinePreparation = {
  baseVersion: string;
  actions: Extract<BrowserStep, { kind: "action" }>[];
  expected: { state: string; fields: Record<string, string> };
  sourceHash: string;
};
type Identity = { version: 1; id: string };
export type AcceptanceObligation = Identity &
  (
    | {
        kind: "backend";
        scope: "checker-suite";
        checks: { checker: string; caseId: string }[];
      }
    | {
        kind: "history";
        member: string;
        contribution?: string;
        field: string;
        history: BaselinePreparation;
      }
    | {
        kind: "field";
        member: string;
        contribution?: string;
        field: string;
        initial: FieldExpectation;
        initialOrigin: "host" | "requirement";
        history?: BaselinePreparation;
        scenarios: { id: string; steps: BrowserStep[]; value: string }[];
      }
    | {
        kind: "assertion";
        steps: BrowserStep[];
        expected: Extract<
          BrowserStep,
          { kind: "action-visible" | "error" | "task" }
        >;
      }
  );

const text = { type: "string" };
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, properties, required });
const steps = modelBrowserCasesSchema.items.properties.steps;
export const historySchema = object({
  actions: {
    type: "array",
    minItems: 1,
    maxItems: 8,
    items: object({
      action: text,
      input: { type: "object", additionalProperties: text },
    }),
  },
});
export const obligationsSchema = {
  type: "array",
  minItems: 1,
  maxItems: 30,
  items: {
    anyOf: [
      object({ kind: { type: "string", enum: ["backend"] } }),
      object(
        {
          kind: { type: "string", enum: ["field"] },
          field: text,
          initial: {
            anyOf: [
              object({ kind: { type: "string", enum: ["baseline"] } }, [
                "kind",
              ]),
              object({
                kind: { type: "string", enum: ["visible"] },
                value: text,
              }),
              object({ kind: { type: "string", enum: ["absent"] } }),
            ],
          },
          history: historySchema,
          scenarios: {
            type: "array",
            minItems: 1,
            maxItems: 8,
            items: object({ steps, value: text }),
          },
        },
        ["kind", "field", "initial", "scenarios"],
      ),
      object({
        kind: { type: "string", enum: ["assertion"] },
        steps: { ...steps, minItems: 0 },
        expected: {
          anyOf: steps.items.anyOf.filter((s) =>
            ["action-visible", "error", "task"].includes(
              s.properties.kind.enum[0],
            ),
          ),
        },
      }),
      object({
        kind: { type: "string", enum: ["history"] },
        field: text,
        history: historySchema,
      }),
    ],
  },
  description:
    "可执行验收义务。backend 绑定宿主完整检查器，案例关联不增加动作限制。field.initial 必须选择 baseline（沿用宿主当前展示，属于系统保护，不添加业务期望）、visible/value 或 absent（用户明确要求的初始呈现）；scenarios 描述操作后业务值。宿主复用相同字段检查并强制新旧任务、刷新和重启。独立 history 义务只验证历史值：通过原基础版本冻结成功动作准备，不把历史值当成新任务初始值。assertion 仅验动作可见性、错误和任务属性。",
};

export function obligationCases(
  obligation: AcceptanceObligation,
): BrowserCase[] {
  if (obligation.kind === "backend") return [];
  const cases: BrowserCase[] = [];
  const add = (
    key: string,
    task: BrowserCase["task"],
    steps: BrowserStep[],
    prepare?: BaselinePreparation,
    classification: BrowserCase["classification"] = "frozen-business",
  ) =>
    cases.push({
      id: `${obligation.id}-${key}`,
      task,
      steps,
      ...(prepare ? { prepare } : {}),
      obligationId: obligation.id,
      classification,
    });
  const persist = (assertion: BrowserStep): BrowserStep[] => [
    assertion,
    { kind: "refresh" },
    assertion,
    { kind: "restart" },
    assertion,
  ];
  if (obligation.kind === "assertion") {
    for (const task of ["existing", "new"] as const)
      add(task, task, [...obligation.steps, obligation.expected]);
    return cases;
  }
  const field = (value: string, visible = true): BrowserStep => ({
    kind: "field",
    member: obligation.member,
    ...(obligation.contribution
      ? { contribution: obligation.contribution }
      : {}),
    field: obligation.field,
    value,
    ...(visible ? {} : { visible: false }),
  });
  const history = obligation.history;
  const historical = () => {
    if (!history) return;
    const value = history.expected.fields[obligation.field];
    if (value === undefined) throw new Error("历史准备未产生目标字段");
    add(
      `historical-${history.baseVersion.slice(0, 12)}-${history.sourceHash.slice(0, 12)}`,
      "existing",
      persist(field(value)),
      history,
    );
  };
  if (obligation.kind === "history") {
    historical();
    return cases;
  }
  const initial =
    obligation.initial.kind === "absent"
      ? field("", false)
      : field(obligation.initial.value);
  for (const task of ["existing", "new"] as const) {
    add(
      `initial-${obligation.initialOrigin}-${task}`,
      task,
      persist(initial),
      undefined,
      obligation.initialOrigin === "host"
        ? "system-protection"
        : "frozen-business",
    );
    for (const scenario of obligation.scenarios)
      add(
        `after-${scenario.id}-${task}`,
        task,
        [...scenario.steps, ...persist(field(scenario.value))],
        task === "existing" ? obligation.history : undefined,
      );
  }
  historical();
  return cases;
}
