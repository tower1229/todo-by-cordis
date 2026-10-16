import test from "node:test";
import assert from "node:assert/strict";
import { planningTools } from "../../src/server/planning.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import { browserSteps } from "../../src/shared/browser-contract.js";
import type { BrowserStep } from "../../src/shared/browser-cases.js";

test("浏览器内部步骤契约逐类校验必填字段；公开计划不接受步骤，由宿主生成", () => {
  const tool = planningTools.find((tool) => tool.name === "propose_plan")!;
  const parameters=tool.parameters;
  assert.ok(!Object.hasOwn(parameters.properties,"browserCases"));
  const variants=browserSteps;
  assert.ok(!JSON.stringify(parameters).includes('"steps":'));
  const steps: BrowserStep[] = [
    { kind: "open" },
    { kind: "refresh" },
    { kind: "restart" },
    { kind: "edit" },
    { kind: "action", member: "panel", action: "save" },
    {
      kind: "field",
      member: "panel",
      contribution: "detail",
      field: "note",
      value: "",
    },
    {
      kind: "action-visible",
      member: "panel",
      contribution: "detail",
      action: "save",
      visible: false,
    },
    { kind: "error", text: "" },
    { kind: "task" },
  ];
  assert.equal(variants.length, steps.length);
  for (const step of steps) {
    const schema = variants.find((variant) =>
      variant.properties.kind.enum.includes(step.kind),
    )!;
    assert.deepEqual([...schema.required].sort(), Object.keys(step).filter(key => key !== "contribution").sort());
    assert.doesNotThrow(() =>
      parseBrowserCases([{ id: "valid", task: "new", steps: [step] }]),
    );
    for (const key of schema.required) {
      const incomplete: Record<string, unknown> = { ...step };
      delete incomplete[key];
      assert.throws(() =>
        parseBrowserCases([
          { id: "invalid", task: "new", steps: [incomplete] },
        ]),
      );
    }
  }
});
