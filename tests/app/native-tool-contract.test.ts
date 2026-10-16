import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeek } from "../../src/evolution/deepseek.js";
import { replyProblems } from "../../src/evolution/model-protocol.js";
const schema = {
  type: "object",
  properties: {
    input: {
      type: "object",
      additionalProperties: { type: "string", minLength: 1 },
    },
    optional: { type: "string", minLength: 2 },
    files: { type: "array", maxItems: 0, items: { type: "string" } },
    content: { type: ["string", "null"] },
  },
  required: ["input", "files", "content"],
  additionalProperties: false,
};
const request = {
  history: [],
  instruction: "业务契约",
  tools: [{ name: "business", description: "业务", parameters: schema }],
};
async function run(args: string) {
  let requests = 0;
  const raw = {
    model: "deepseek-flash",
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "1",
              type: "function",
              function: { name: "business", arguments: args },
            },
          ],
        },
      },
    ],
    usage: { total_tokens: 7 },
  };
  const reply = await new DeepSeek("synthetic-key", async (_url, init) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.tools[0].function.parameters, schema);
    assert.notEqual(body.tools[0].function.strict, true);
    return new Response(JSON.stringify(raw));
  }).generate(request, new AbortController().signal);
  assert.equal(requests, 1);
  assert.deepEqual(reply.raw, raw);
  assert.deepEqual(reply.usage, { total_tokens: 7 });
  return reply;
}
test("原生契约无损表达可选属性、动态字段和 null；无需供应商投影标记", async () => {
  for (const value of [
    { input: { 中文: "值" }, files: [], content: null },
    { input: {}, optional: "保留", files: [], content: "源码" },
  ]) {
    const reply = await run(JSON.stringify(value));
    assert.deepEqual(reply.calls[0].args, value);
    assert.deepEqual(replyProblems(request, reply), []);
  }
});
test("供应商完全不约束输出时，宿主仍拒绝原始长度、字典、空授权及 nullable 类型反例", async () => {
  for (const value of [
    { input: { x: "" }, files: [], content: null },
    { input: {}, optional: "短", files: [], content: null },
    { input: {}, files: ["host.ts"], content: null },
    { input: {}, files: [], content: 42 },
    { input: {}, files: [], content: null, expected: "伪造" },
  ])
    assert.ok(replyProblems(request, await run(JSON.stringify(value))).length);
});
test("重复 JSON 键不能覆盖冻结期望，非法 JSON 不补造参数；单次请求、原始响应和 usage 均保留", async () => {
  for (const args of [
    '{"input":{"x":"old","x":"new"},"files":[],"content":null}',
    '{"input":{},"files":[],"content"::null}',
  ])
    assert.ok(replyProblems(request, await run(args)).length);
});
