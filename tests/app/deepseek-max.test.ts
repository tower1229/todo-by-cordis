import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeek } from "../../src/evolution/deepseek.js";
import { modelPolicy } from "../../src/evolution/model-policy.js";
import { replyProblems } from "../../src/evolution/model-protocol.js";
import { hash } from "../../src/release/storage.js";
import type { ModelOutputPolicy } from "../../src/evolution/model-policy.js";

for (const phase of [
  "admission",
  "planning",
  "review",
  "generation",
  "standalone",
] as const)
  test(`生产策略使用 Flash max，输出额度按阶段选择且截断保护不变：${phase}`, async () => {
    let body: Record<string, unknown> = {};
    const driver = new DeepSeek("synthetic-key", async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({
          model: "deepseek-flash",
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: "ok",
                reasoning_content: "synthetic reasoning",
              },
            },
          ],
        }),
      );
    });
    const reply = await driver.generate(
      {
        phase: phase === "standalone" ? undefined : phase,
        instruction: "fixture",
        history: [],
      },
      new AbortController().signal,
    );
    assert.deepEqual(body.thinking, { type: "enabled" });
    assert.equal(body.reasoning_effort, "max");
    assert.equal(body.max_tokens, phase === "admission" || phase === "standalone" ? 65536 : 131072);
    assert.equal(modelPolicy(phase).truncation, "block");
    assert.equal(reply.transport?.outputPolicy?.thinking, "enabled");
    assert.equal(reply.transport?.profile, "deepseek-chat/6");
  });

test("思考工具使用供应商 auto，宿主仍拒绝空调用、未授权工具和无效参数", async () => {
  let body: Record<string, unknown> = {};
  const tool = {
    name: "inspect_application",
    description: "fixture",
    parameters: { type: "object", additionalProperties: false, properties: {} },
  };
  const request = {
    phase: "planning" as const,
    instruction: "fixture",
    history: [],
    tools: [tool],
  };
  const messages = [
    { content: "只说完成" },
    {
      content: null,
      tool_calls: [
        {
          id: "a",
          type: "function",
          function: { name: "apply", arguments: "{}" },
        },
      ],
    },
    {
      content: null,
      tool_calls: [
        {
          id: "a",
          type: "function",
          function: { name: tool.name, arguments: '{"extra":true}' },
        },
      ],
    },
    {
      content: null,
      reasoning_content: "synthetic reasoning",
      tool_calls: [
        {
          id: "a",
          type: "function",
          function: { name: tool.name, arguments: "{}" },
        },
      ],
    },
  ];
  const driver = new DeepSeek("synthetic-key", async (_url, init) => {
    body = JSON.parse(String(init?.body));
    return new Response(
      JSON.stringify({
        model: "deepseek-flash",
        choices: [{ finish_reason: "stop", message: messages.shift() }],
      }),
    );
  });
  for (let index = 0; index < 4; index++) {
    const reply = await driver.generate(request, new AbortController().signal);
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.reasoning_effort, "max");
    assert.equal(reply.transport?.functionMode, "auto");
    assert.equal(replyProblems(request, reply).length > 0, index < 3);
    if (index === 3)
      assert.equal(
        (reply.history.at(-1) as { reasoning_content: string })
          .reasoning_content,
        "synthetic reasoning",
      );
  }
});

test("思考强度属于宿主冻结策略，不接受不一致参数或篡改摘要", async () => {
  let requests = 0;
  for (const change of ["effort", "digest", "tokens", "scope", "phase", "version", "retired-version"] as const) {
    const driver = new DeepSeek(
      "synthetic-key",
      async () => {
        requests++;
        throw new Error("不能发送");
      },
      "https://example.invalid",
      (phase) => {
        const { hash: _hash, ...body } = modelPolicy(phase);
        const altered = {
          ...body,
          ...(change === "effort" ? { reasoningEffort: "high" } : {}),
          ...(change === "tokens" ? { maxTokens: 65536 } : {}),
          ...(change === "scope" ? { tokenScope: "answer-only" } : {}),
          ...(change === "phase" ? { phase: "admission" } : {}),
          ...(change === "version" ? { version: 2 } : {}),
          ...(change === "retired-version" ? { version: 3 } : {}),
        };
        return {
          ...altered,
          hash: change === "digest" ? "tampered" : hash(altered),
        } as ModelOutputPolicy;
      },
    );
    await assert.rejects(
      driver.generate(
        { phase: "review", instruction: "fixture", history: [] },
        new AbortController().signal,
      ),
      /宿主模型输出策略无效/,
    );
  }
  assert.equal(requests, 0);
});
