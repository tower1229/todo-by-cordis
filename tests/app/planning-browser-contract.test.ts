import test from "node:test";
import assert from "node:assert/strict";
import { planningTools } from "../../src/server/planning.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import type { BrowserStep } from "../../src/shared/browser-cases.js";

test("业务义务逐类声明浏览器必填字段，与真实解析器一致；整套案例由宿主生成", () => {
  const tool = planningTools.find((tool) => tool.name === "propose_plan")!;
  const parameters=tool.parameters;
  assert.ok(!Object.hasOwn(parameters.properties,"browserCases"));
  const variants=parameters.properties.requirements.items.properties.obligations.items.anyOf.find(s=>s.properties.kind.enum.includes("assertion"))!.properties.steps.items.anyOf;
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
    assert.deepEqual([...schema.required].sort(), Object.keys(step).filter(key => !["member", "contribution"].includes(key)).sort());
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
