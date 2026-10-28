import test from "node:test";
import assert from "node:assert/strict";
import { planningTools } from "../../src/server/planning.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import { browserSteps } from "../../src/shared/browser-contract.js";
import type { BrowserStep } from "../../src/shared/browser-cases.js";
import { businessExpectationsSchema } from "../../src/evolution/plan-input.js";

test("公开字段和历史预期使用精确字段键，不能用中文显示名替换", () => {
  const parameters = planningTools.find(tool => tool.name === "propose_plan")!.parameters;
  for (const kind of ["field", "history"]) {
    const branch = businessExpectationsSchema.items.anyOf.find(
      branch => branch.properties.kind.enum.includes(kind),
    )!;
    assert.ok("field" in branch.properties);
    const field = branch.properties.field;
    assert.ok(field && typeof field === "object" && "description" in field);
    assert.equal(typeof field.description, "string");
    const description = String(field.description);
    for (const word of ["字段键", "显示名", "key", "expected.fields", "新字段"])
      assert.ok(description.includes(word), `公开 ${kind} 契约缺少 ${word}`);
    assert.ok(JSON.stringify(parameters).includes(description));
  }
});

test("公开字段契约说明真实操作前置，initial 不能替代准备路径", () => {
  const parameters = planningTools.find(tool => tool.name === "propose_plan")!.parameters;
  const field = businessExpectationsSchema.items.anyOf.find(
    branch => branch.properties.kind.enum.includes("field"),
  )!;
  assert.ok("field" in field.properties);
  const schema = field.properties.field;
  assert.ok(schema && typeof schema === "object" && "description" in schema);
  const description = schema.description;
  assert.ok(typeof description === "string");
  assert.match(description, /空任务.*commit/);
  assert.match(description, /initial/);
  assert.match(description, /保留.*案例/);
  assert.ok(JSON.stringify(parameters).includes(description), "说明必须随公开工具契约交付");
});

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
