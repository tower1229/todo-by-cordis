import test from "node:test";
import assert from "node:assert/strict";
import { compileReferences } from "../../src/evolution/references.js";
import { obligationFailure } from "../../src/evolution/acceptance-obligations.js";
import { planningTools } from "../../src/server/planning.js";
import { schemaProblems } from "../../src/evolution/model-protocol.js";

const compile = () =>
  compileReferences(
    {
      workflowRules: [
        {
          key: "review",
          label: "复盘",
          required: true,
          minLength: 2,
          maxLength: 4,
        },
      ],
      requirements: [
        {
          id: "review",
          description: "填写复盘后完成并保留",
          source: 1,
          sourceQuote: "填写复盘后完成并保留",
          type: "interface",
          checks: [{ kind: "workflow" }],
          obligations: [{ kind: "backend" }],
        },
      ],
    },
    [{ id: "s:1", text: "填写复盘后完成并保留" }],
    [
      {
        checker: "workflow/1",
        given: "未完成",
        when: "complete",
        then: "完成",
      },
    ],
    { id: "workflow", actions: [{ id: "complete" }, { id: "reopen" }] },
  );

test("无需模型手写浏览器步骤：宿主从规则生成原生必填、业务拒绝、Unicode边界与重新打开验收", () => {
  const c = compile();
  const steps = c.browserCases.flatMap((b) => b.steps);
  assert.ok(steps.some((s) => s.kind === "form-invalid"));
  assert.ok(steps.some((s) => s.kind === "error" && s.text === ""));
  assert.ok(steps.some((s) => s.kind === "action" && s.action === "reopen"));
  assert.ok(
    c.browserCases.some((b) =>
      b.steps.some(
        (s) => s.kind === "action" && s.input?.review === "😀😀😀😀",
      ),
    ),
  );
  assert.ok(
    c.requirements[0].obligations.some((o) => o.kind === "workflow-input"),
  );
  assert.deepEqual(obligationFailure(c.requirements[0], c.browserCases), []);
  assert.ok(
    obligationFailure(
      c.requirements[0],
      c.browserCases.filter(
        (b) => !b.steps.some((s) => s.kind === "form-invalid"),
      ),
    ).length,
  );
  const tampered = structuredClone(c.browserCases);
  const error = tamperedError(tampered);
  error.text = "临时替换";
  assert.ok(obligationFailure(c.requirements[0], tampered).length);
});
function tamperedError(cases: ReturnType<typeof compile>["browserCases"]) {
  const step = cases.flatMap((b) => b.steps).find((s) => s.kind === "error");
  if (!step || step.kind !== "error") throw new Error("缺少错误断言");
  return step;
}

test("规划工具不再授权手工浏览器案例；宿主检查器与业务义务仍是必需输入", () => {
  const schema = planningTools.find(
    (t) => t.name === "propose_plan",
  )!.parameters;
  assert.ok(!Object.hasOwn(schema.properties, "browserCases"));
  assert.ok(
    schemaProblems({ browserCases: [{ expected: "fake" }] }, schema).some((e) =>
      e.includes("browserCases: 未授权字段"),
    ),
  );
});
