export const browserErrorAssertionDescription =
  'error.text 必须提供字符串。空字符串 "" 断言页面存在可见 alert，不限定错误文案；非空字符串断言可见 alert 的文本包含该字符串，不要求全文相等。未要求具体文案时使用 {kind:"error",text:""}，不要省略 text，也不要额外固定错误文案。';
export const browserTaskAssertionDescription =
  "task 断言任务名称和备注。未编辑属性引用本次宿主合成基线，已编辑属性由宿主按实际 edit 契约编译期望。模型只提交 kind，不填写 title/description 派生字段；实际基线绑定在 fixtureHash 中。";
type Property = {
  type: "string" | "boolean" | "object";
  description?: string;
  additionalProperties?: { type: "string" };
};
const text: Property = { type: "string" };
const step = (
  kind: string,
  properties: Record<string, Property> = {},
  required = Object.keys(properties),
) => ({
  type: "object",
  additionalProperties: false,
  properties: { kind: { type: "string", enum: [kind] }, ...properties },
  required: ["kind", ...required],
});

/** The parser, model schema and review description consume this same definition. */
export const browserSteps = [
  step("open"),
  step("refresh"),
  step("restart"),
  step("edit", { title: text, description: text }, []),
  step(
    "action",
    {
      member: text,
      action: text,
      input: { type: "object", additionalProperties: { type: "string" } },
    },
    ["member", "action"],
  ),
  step(
    "field",
    {
      member: text,
      contribution: text,
      field: text,
      value: text,
      visible: { type: "boolean" },
    },
    ["member", "field", "value"],
  ),
  step(
    "action-visible",
    {
      member: text,
      contribution: text,
      action: text,
      visible: { type: "boolean" },
    },
    ["member", "action", "visible"],
  ),
  step("error", {
    text: { type: "string", description: browserErrorAssertionDescription },
  }),
  {...step("task", { title: text, description: text }, []), description: browserTaskAssertionDescription},
];
export const browserCasesSchema = {
  type: "array",
  maxItems: 30,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["id", "task", "steps"],
    properties: {
      id: { type: "string" },
      task: { type: "string", enum: ["existing", "new"] },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: 40,
        items: { anyOf: browserSteps },
      },
    },
  },
};
