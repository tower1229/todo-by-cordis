import test from "node:test";
import assert from "node:assert/strict";
import { compileToolContract } from "../../src/evolution/tool-contract.js";
import { planningTools } from "../../src/server/planning.js";
import { candidateDeltaSchema } from "../../src/evolution/candidate-delta.js";

test("严格工具传输无损表达可选属性、动态字段、分支和删除；原始宿主约束仍强制执行", () => {
  const schema = {
    type: "object",
    description: "原始对象说明",
    additionalProperties: false,
    required: ["input", "variant"],
    properties: {
      input: {
        type: "object",
        additionalProperties: { type: "string", minLength: 1 },
      },
      optional: { type: "string", minLength: 2 },
      variant: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["kind"],
            properties: { kind: { type: "string", enum: ["open"] } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["kind", "value"],
            properties: {
              kind: { type: "string", enum: ["set"] },
              value: { type: ["string", "null"] },
            },
          },
        ],
      },
    },
  };
  const contract = compileToolContract(schema);
  assert.equal(contract.schema.description, schema.description);
  for (const value of [
    { input: { 中文: "原值" }, variant: { kind: "open" } },
    { input: {}, optional: "保留", variant: { kind: "set", value: null } },
    { input: { x: "v" }, variant: { kind: "set", value: "value" } },
  ])
    assert.deepEqual(contract.decode(contract.encode(value)), value);
  assert.throws(
    () => contract.encode({ input: { x: "" }, variant: { kind: "open" } }),
    /契约/,
  );
  assert.throws(
    () =>
      contract.encode({ input: {}, optional: "a", variant: { kind: "open" } }),
    /契约/,
  );
  const wire = contract.encode({
    input: {},
    variant: { kind: "open" },
  }) as Record<string, unknown>;
  assert.throws(
    () => contract.decode({ ...wire, expected: "injected" }),
    /契约/,
  );
  assert.throws(
    () =>
      contract.decode({
        ...wire,
        input: [
          { key: "x", value: "one" },
          { key: "x", value: "two" },
        ],
      }),
    /重复/,
  );
});

test("全部规划与差异候选工具可编译为闭合且属性全必填的严格契约", () => {
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const node = value as Record<string, unknown>;
    if (node.type === "object") {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(node.required, Object.keys(node.properties as object));
    }
    if (node.type || node.anyOf) {
      assert.ok(!Object.hasOwn(node, "minLength"));
      assert.ok(!Object.hasOwn(node, "minItems"));
    }
    for (const v of Object.values(node))
      if (Array.isArray(v)) v.forEach(visit);
      else visit(v);
  };
  for (const tool of [...planningTools, { parameters: candidateDeltaSchema }])
    visit(compileToolContract(tool.parameters).schema);
  assert.throws(
    () =>
      compileToolContract({
        type: "object",
        properties: { known: { type: "string" } },
        additionalProperties: true,
      }),
    /不支持/,
  );
  assert.throws(
    () => compileToolContract({ type: "object", additionalProperties: true }),
    /不支持/,
  );
});

test("零长度授权集合通过空标记严格表达，不能在供应商不支持 maxItems 时扩大写入范围", () => {
  const contract = compileToolContract({
    type: "array",
    maxItems: 0,
    items: { type: "string" },
  });
  assert.deepEqual(contract.encode([]), {});
  assert.deepEqual(contract.decode({}), []);
  assert.throws(() => contract.encode(["business/host.ts"]), /契约/);
  assert.throws(
    () => contract.decode({ entries: ["business/host.ts"] }),
    /契约/,
  );
});
