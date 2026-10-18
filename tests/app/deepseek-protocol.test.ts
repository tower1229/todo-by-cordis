import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DeepSeek } from "../../src/evolution/deepseek.js";
import { admissionSchema } from "../../src/evolution/request-admission.js";
import { ModelTransportError } from "../../src/evolution/driver.js";
import { replyProblems } from "../../src/evolution/model-protocol.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";

test("DeepSeek 实际本机 HTTP：精确 JSON 契约、授权工具、原生回执和完整历史；每次只发送一次", async () => {
  const bodies: Record<string, unknown>[] = [];
  const headers: (string | undefined)[] = [];
  const assistant = {
    role: "assistant",
    content: null,
    reasoning_content: "synthetic-reasoning",
    tool_calls: [
      {
        id: "call-a",
        type: "function",
        function: { name: "inspect_application", arguments: "{}" },
      },
    ],
  };
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
    headers.push(req.headers.authorization);
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        model: "deepseek-flash",
        choices: [
          {
            message:
              bodies.length === 1
                ? {
                    role: "assistant",
                    content:
                      '{"result":{"presentations":[],"questions":[]}}',
                  }
                : assistant,
            finish_reason: "stop",
          },
        ],
        usage: { total_tokens: 8 },
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const a = server.address();
    if (!a || typeof a === "string") throw new Error("缺少端口");
    const g = new DeepSeek(
      "synthetic-key",
      fetch,
      `http://127.0.0.1:${a.port}/chat/completions`,
    );
    const signal = new AbortController().signal;
    const review = await g.generate(
      { instruction: "合成", history: [], schema: admissionSchema() },
      signal,
    );
    assert.deepEqual(JSON.parse(review.text), {
      presentations: [],
      questions: [],
    });
    assert.equal(review.transport?.actualModel, "deepseek-flash");
    assert.deepEqual(bodies[0].response_format, { type: "json_object" });
    assert.ok(
      JSON.stringify(bodies[0].messages).includes("minLength"),
      "完整约束不能投影丢失",
    );
    assert.ok(!Object.hasOwn(bodies[0], "tools"), "独立复核不声明工具");
    const tools = [
      {
        name: "inspect_application",
        description: "合成",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
    ];
    const first = await g.generate(
      { instruction: "合成", history: [], message: "开始", tools },
      signal,
    );
    assert.equal(first.calls[0].id, "call-a");
    await g.generate(
      {
        instruction: "合成",
        history: [
          ...first.history,
          {
            role: "user",
            parts: [
              {
                functionResponse: {
                  id: "call-a",
                  name: "inspect_application",
                  response: { result: "synthetic" },
                },
              },
            ],
          },
        ],
        tools,
      },
      signal,
    );
    assert.equal(bodies.length, 3);
    assert.ok(bodies.every(body => body.reasoning_effort === "max"));
    assert.equal(bodies[1].tool_choice, "auto");
    assert.notEqual(((bodies[1].tools as {function:{strict?:boolean}}[])[0]).function.strict,true);
    assert.deepEqual(bodies[1].thinking, { type: "enabled" });
    assert.deepEqual((bodies[2].messages as unknown[]).slice(-2), [
      assistant,
      {
        role: "tool",
        tool_call_id: "call-a",
        content: '{"result":"synthetic"}',
      },
    ]);
    assert.ok(headers.every((v) => v === "Bearer synthetic-key"));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("空 JSON、非法工具和截断参数保留原始证据，不能被默认为有效复核或成功工具", async () => {
  for (const message of [
    { role: "assistant", content: "{}" },
    {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "a",
          type: "function",
          function: { name: "invented", arguments: "{" },
        },
      ],
    },
  ]) {
    const raw = {
      choices: [{ message, finish_reason: "length" }],
      usage: { total_tokens: 5 },
    };
    const g = new DeepSeek("synthetic-key", async () => Response.json(raw));
    const request = {
      instruction: "合成",
      history: [],
      schema: admissionSchema(),
    };
    const reply = await g.generate(request, new AbortController().signal);
    assert.ok(replyProblems(request, reply).length);
    assert.deepEqual(reply.raw, raw);
    assert.equal(reply.transport?.finishReason, "length");
  }
});

test("DeepSeek 断连仅请求一次并保留底层分类；HTTP 400 保留契约摘要并脱敏", async () => {
  for (const kind of ["socket", "http"] as const) {
    let count = 0;
    const server = createServer((req, res) => {
      count++;
      if (kind === "socket") req.socket.destroy();
      else {
        res.writeHead(400);
        res.end("invalid synthetic-key contract");
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const a = server.address();
      if (!a || typeof a === "string") throw new Error("缺少端口");
      const g = new DeepSeek(
        "synthetic-key",
        fetch,
        `http://127.0.0.1:${a.port}/chat/completions`,
      );
      await assert.rejects(
        g.generate(
          { instruction: "合成", history: [], schema: admissionSchema() },
          new AbortController().signal,
        ),
        (error) => {
          assert.ok(error instanceof ModelTransportError);
          assert.equal(error.transport.profile, "deepseek-chat/6");
          assert.ok(error.transport.schemaHash);
          assert.ok(!error.message.includes("synthetic-key"));
          if (kind === "socket") {
            assert.equal(error.transport.failure?.kind, "connection");
            assert.ok(
              error.transport.failure.causes.some(
                (c) => c.code === "UND_ERR_SOCKET",
              ),
            );
          } else assert.equal(error.httpStatus, 400);
          return true;
        },
      );
      assert.equal(count, 1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  }
});

test("原生工具参数与供应商历史无损保留；字典非法值不能执行",async()=>{
 const parameters={type:"object",additionalProperties:false,required:["input"],properties:{input:{type:"object",additionalProperties:{type:"string"}},optional:{type:"string",minLength:2}}};let count=0;
 const request={instruction:"合成",history:[],tools:[{name:"save",description:"合成",parameters}]};
 const driver=new DeepSeek("synthetic-key",async(url,init)=>{
   count++;assert.equal(String(url),"https://api.deepseek.com/chat/completions");
   const body=JSON.parse(String(init?.body));assert.notEqual(body.tools[0].function.strict,true);assert.deepEqual(body.tools[0].function.parameters,parameters);
   const args={input:{review:count===2?42:"原文"}};
   return Response.json({model:"deepseek-flash",choices:[{finish_reason:"tool_calls",message:{role:"assistant",content:null,tool_calls:[{id:"a",type:"function",function:{name:"save",arguments:JSON.stringify(args)}}]}}]});
 });
 const reply=await driver.generate(request,new AbortController().signal);assert.deepEqual(reply.calls[0].args,{input:{review:"原文"}});assert.deepEqual(replyProblems(request,reply),[]);
 assert.ok(JSON.stringify(reply.history).includes("原文"));
 const invalid=await driver.generate(request,new AbortController().signal);assert.ok(replyProblems(request,invalid).length);assert.equal(count,2);
});

test("分块正文保留 UTF-8 原文，保活与最终模型响应分开记录", async () => {
  const payload = {
    model: "deepseek-flash",
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: '{"result":{"value":"复盘"}}' },
      },
    ],
    usage: { total_tokens: 5 },
  };
  const bytes = Buffer.from(JSON.stringify(payload));
  const split = bytes.indexOf(Buffer.from("复")) + 1;
  const updates: NonNullable<
    import("../../src/evolution/driver.js").ModelReply["transport"]
  >[] = [];
  const driver = new DeepSeek(
    "synthetic-key",
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const part of [
              Buffer.from(" \n"),
              bytes.subarray(0, split),
              bytes.subarray(split),
            ]) {
              controller.enqueue(part);
              await new Promise((resolve) => setImmediate(resolve));
            }
            controller.close();
          },
        }),
      ),
  );
  const reply = await driver.generate(
    {
      instruction: "合成 JSON",
      history: [],
      schema: { type: "object", properties: { value: { type: "string" } } },
    },
    new AbortController().signal,
    (transport) => {
      updates.push(transport);
    },
  );
  assert.deepEqual(JSON.parse(reply.text), { value: "复盘" });
  assert.equal(updates[0].http?.stage, "request");
  assert.equal(updates[0].http?.bodyBytes, 0);
  assert.equal(reply.transport?.http?.stage, "complete");
  assert.equal(reply.transport?.http?.bodyBytes, bytes.byteLength + 2);
  assert.equal(reply.transport?.http?.whitespaceBytes, 2);
  assert.ok(reply.transport?.http?.firstContentMs !== undefined);
});

for (const mode of [
  "overloaded",
  "waiting-timeout",
  "empty-timeout",
  "waiting-cancel",
] as const)
  test(`真实 HTTP ${mode}：宿主终止仍保存响应阶段，只计一次调用且不生成候选`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "cordis-model-wait-"));
    const workspace = await Workspace.open(join(directory, "workspace.db"));
    let requests = 0;
    let entered!: () => void;
    const headers = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = createServer((_req, response) => {
      requests++;
      response.setHeader("content-type", "application/json");
      response.setHeader("x-ds-trace-id", "synthetic-trace");
      if (mode === "overloaded") {
        response.writeHead(503);
        response.end('{"error":{"message":"Service is too busy"}}');
      } else {
        response.writeHead(200);
        if (mode === "empty-timeout") response.flushHeaders();
        else response.write(" \n"); // The documented waiting keep-alive is not a model reply.
      }
      entered();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("缺少端口");
    const evolution = new Evolution(
      workspace.db,
      new DeepSeek(
        "synthetic-key",
        fetch,
        `http://127.0.0.1:${address.port}/chat/completions`,
      ),
      new EvolutionDomain(workspace),
      { calls: 12, candidates: 3, milliseconds: 1500 },
    );
    t.after(async () => {
      await evolution.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await workspace.close();
      rmSync(directory, { recursive: true, force: true });
    });
    const before = {
      composition: workspace.composition(),
      tasks: workspace.query(),
    };
    await evolution.command({
      type: "request",
      text: "合成完成流程改进",
      operationId: "request",
    });
    await headers;
    if (mode === "waiting-cancel") {
      // Wait for the adapter to read the actual HTTP chunk before cancellation.
      await new Promise((resolve) => setTimeout(resolve, 50));
      await evolution.command({
        type: "cancel",
        runId: (await evolution.observe()).run!.id,
        operationId: "cancel",
      });
    }
    const deadline = Date.now() + 4000;
    while (
      (await evolution.observe()).run?.status === "planning" &&
      Date.now() < deadline
    )
      await new Promise((resolve) => setTimeout(resolve, 10));
    await evolution.close();
    const snapshot = await evolution.observe();
    assert.equal(
      snapshot.run?.status,
      mode === "waiting-cancel" ? "cancelled" : "failed",
    );
    assert.equal(snapshot.run.budget?.callsUsed, 1);
    assert.equal(snapshot.run.budget?.callsRemaining, 11);
    assert.equal(snapshot.candidates?.length, 0);
    assert.equal(requests, 1);
    assert.deepEqual(
      { composition: workspace.composition(), tasks: workspace.query() },
      before,
    );
    const rows = workspace.db.prepare("SELECT body FROM evolution_calls").all();
    assert.equal(rows.length, 1);
    const call = JSON.parse(String(rows[0].body));
    assert.equal(call.status, "failed");
    assert.equal(call.usage, null);
    assert.equal(call.transport.http.status, mode === "overloaded" ? 503 : 200);
    assert.equal(call.transport.http.requestId, "synthetic-trace");
    assert.equal(
      call.transport.http.stage,
      mode === "overloaded" ? "complete" : "body",
    );
    assert.equal(
      call.transport.failure.kind,
      mode === "overloaded"
        ? "http"
        : mode.endsWith("timeout")
          ? "timeout"
          : "cancelled",
    );
    assert.ok(call.transport.http.headersMs >= 0);
    if (mode !== "overloaded") {
      assert.equal(
        call.transport.http.bodyBytes,
        mode === "empty-timeout" ? 0 : 2,
      );
      assert.equal(
        call.transport.http.whitespaceBytes,
        mode === "empty-timeout" ? 0 : 2,
      );
      assert.equal(call.transport.http.firstContentMs, undefined);
    }
  });
