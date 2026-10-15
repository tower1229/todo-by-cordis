import test from "node:test";
import assert from "node:assert/strict";
import { GenerateContentResponse, GoogleGenAI } from "@google/genai";
import { createServer } from "node:http";
import { Gemini } from "../../src/evolution/gemini.js";
import { clarificationSchema } from "../../src/evolution/clarification-review.js";
import { admissionSchema } from "../../src/evolution/request-admission.js";
import { ModelTransportError } from "../../src/evolution/driver.js";
import { replyProblems } from "../../src/evolution/model-protocol.js";

test("Gemini空Content保留raw与usage但不能污染下一次SDK历史，原预算内协议修正保持完整签名", async () => {
  const empty = Object.assign(new GenerateContentResponse(), {
    candidates: [{ content: {}, finishReason: "UNEXPECTED_TOOL_CALL" }],
    usageMetadata: { promptTokenCount: 10, totalTokenCount: 10 },
  });
  const part = {
    functionCall: { id: "call-a", name: "inspect_application", args: {} },
    thoughtSignature: "synthetic-signature",
  };
  const valid = Object.assign(new GenerateContentResponse(), {
    candidates: [{ content: { role: "model", parts: [part] } }],
    usageMetadata: { totalTokenCount: 20 },
  });
  const seen: Parameters<GoogleGenAI["models"]["generateContent"]>[0][] = [];
  const responses = [empty, valid];
  const gemini = new Gemini("synthetic-key", {
    models: {
      async generateContent(input) {
        seen.push(input);
        return responses.shift()!;
      },
    },
  });
  const signal = new AbortController().signal;
  const first = await gemini.generate(
    { instruction: "fixture", history: [], message: "合成请求" },
    signal,
  );
  assert.equal(first.calls.length, 0);
  assert.equal(first.raw, empty);
  assert.equal(first.usage?.promptTokenCount, 10);
  assert.equal(first.history.length, 1);
  const second = await gemini.generate(
    {
      instruction: "fixture",
      history: first.history,
      message: "同一预算内纠正工具协议",
    },
    signal,
  );
  assert.equal(seen.length, 2);
  assert.ok(
    (seen[1].contents as { parts?: unknown[] }[]).every((c) =>
      Array.isArray(c.parts),
    ),
  );
  assert.equal(seen[1].config?.httpOptions?.retryOptions?.attempts, 1);
  assert.equal(second.history.at(-1)?.parts[0], part);
  assert.equal(second.calls[0].name, "inspect_application");
  assert.deepEqual(empty.candidates[0].content, {});
  assert.equal(first.history.length, 1);
});

test("实际Google SDK向隔离本机传输发出供应商子集schema及ANY，字符串约束保留在宿主", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        candidates: [
          {
            content: {
              role: "model",
              parts: [
                { text: '{"result":{"presentations":[],"questions":[],"facts":[]}}' },
              ],
            },
            finishReason: "STOP",
          },
        ],
        usageMetadata: { totalTokenCount: 1 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("缺少本机传输端口");
    const client = new GoogleGenAI({
      apiKey: "synthetic-key",
      httpOptions: { baseUrl: `http://127.0.0.1:${address.port}` },
    });
    const g = new Gemini("synthetic-key", client);
    const decoded = await g.generate(
      {
        instruction: "合成预检",
        history: [],
        message: "合成需求",
        schema: admissionSchema,
      },
      new AbortController().signal,
    );
    assert.equal(decoded.transport.envelopeValid,true);
    assert.deepEqual(JSON.parse(decoded.text),{presentations:[],questions:[],facts:[]});
    await g.generate(
      {
        instruction: "合成工具",
        history: [],
        message: "合成需求",
        tools: [
          {
            name: "inspect_application",
            description: "合成",
            parameters: { type: "object", properties: {} },
          },
        ],
      },
      new AbortController().signal,
    );
    assert.equal(bodies.length, 2, "每次交换只发送一次HTTP，不启动传输重试");
    const serialized = JSON.stringify(bodies[0].generationConfig);
    assert.ok(serialized.includes("responseJsonSchema"));
    assert.ok(serialized.includes('"required"'));
    assert.ok(
      !serialized.includes('"minLength"') &&
        !serialized.includes('"maxLength"'),
    );
    assert.deepEqual(
      (bodies[1].toolConfig as { functionCallingConfig: unknown })
        .functionCallingConfig,
      { mode: "ANY", allowedFunctionNames: ["inspect_application"] },
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("实际SDK的HTTP400保留供应商契约分类和摘要，密钥脱敏且只发一次请求", async () => {
  let count = 0;
  const server = createServer((_req, res) => {
    count++;
    res.writeHead(400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          code: 400,
          status: "INVALID_ARGUMENT",
          message: "invalid synthetic-key contract",
        },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = server.address();
    if (!a || typeof a === "string") throw new Error("缺少本机端口");
    const g = new Gemini(
      "synthetic-key",
      new GoogleGenAI({
        apiKey: "synthetic-key",
        httpOptions: { baseUrl: `http://127.0.0.1:${a.port}` },
      }),
    );
    await assert.rejects(
      g.generate(
        {
          instruction: "合成",
          history: [],
          message: "合成",
          schema: admissionSchema,
        },
        new AbortController().signal,
      ),
      (error) => {
        assert.ok(error instanceof ModelTransportError);
        assert.equal(error.httpStatus, 400);
        assert.equal(error.transport.profile, "gemini-3.1-shape/2");
        assert.ok(error.transport.schemaHash);
        assert.ok(!error.message.includes("synthetic-key"));
        return true;
      },
    );
    assert.equal(count, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("Gemini适配器投影结构化schema并强制授权工具，保留原契约且无SDK重试", async () => {
  const seen: Parameters<GoogleGenAI["models"]["generateContent"]>[0][] = [];
  const g = new Gemini("synthetic-key", {
    models: {
      async generateContent(v) {
        seen.push(v);
        return Object.assign(new GenerateContentResponse(), {
          candidates: [{ content: { role: "model", parts: [{ text: "{}" }] } }],
        });
      },
    },
  });
  const strict = clarificationSchema();
  const emptyResponse = await g.generate(
    { instruction: "合成复核", history: [], message: "{}", schema: strict },
    new AbortController().signal,
  );
  assert.equal(emptyResponse.transport.envelopeValid,false);
  assert.match(replyProblems({instruction:"合成",history:[],schema:strict},emptyResponse).join(";"),/result 信封/);
  const projected = seen[0].config?.responseJsonSchema as {
    required: string[];
    anyOf?: unknown;
    properties: { result: { anyOf?: unknown } };
  };
  assert.deepEqual(projected.required, ["result"]);
  assert.ok(projected.properties.result.anyOf);
  assert.equal(projected.anyOf, undefined);
  assert.ok(strict.anyOf);
  await g.generate(
    {
      instruction: "合成工具",
      history: [],
      tools: [
        {
          name: "report_blocker",
          description: "合成",
          parameters: {
            type: "object",
            properties: { reason: { type: "string" } },
            required: ["reason"],
          },
        },
      ],
    },
    new AbortController().signal,
  );
  assert.equal(seen[1].config?.toolConfig?.functionCallingConfig?.mode, "ANY");
  assert.deepEqual(
    seen[1].config?.toolConfig?.functionCallingConfig?.allowedFunctionNames,
    ["report_blocker"],
  );
  assert.ok(
    seen.every((v) => v.config?.httpOptions?.retryOptions?.attempts === 1),
  );
});
