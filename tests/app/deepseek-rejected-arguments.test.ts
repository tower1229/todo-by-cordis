import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeepSeek } from "../../src/evolution/deepseek.js";
import { replyProblems } from "../../src/evolution/model-protocol.js";
import type { ModelRequest } from "../../src/evolution/driver.js";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";

const object = (properties: Record<string, unknown>) => ({
  type: "object", additionalProperties: false, properties,
});
const rawReply = (argumentsText: string, name = "propose_plan") => ({
  model: "deepseek-flash",
  choices: [{ finish_reason: "tool_calls", message: {
    role: "assistant", content: null,
    tool_calls: [{ id: "rejected-call", type: "function", function: { name, arguments: argumentsText } }],
  } }],
});

for (const scenario of [
  {
    name: "已审默认的宿主 ID",
    args: { defaults: [{ scope: "task", id: "host-default" }] },
    schema: object({ defaults: { type: "array", items: object({ scope: { type: "string" } }) } }),
    problem: /defaults\[0\]\.id: 未授权字段/,
  },
  {
    name: "放错层级的验收修订原因",
    args: { requirements: [{ quote: "较新的业务要求", acceptanceReason: "修订旧要求" }] },
    schema: object({ requirements: { type: "array", items: object({ quote: { type: "string" } }) }, acceptanceReason: { type: "string" } }),
    problem: /requirements\[0\]\.acceptanceReason: 未授权字段/,
  },
]) test(`已解析的拒绝参数供纠错读取，同时仍拒绝执行：${scenario.name}`, async () => {
  const raw = rawReply(JSON.stringify(scenario.args));
  const driver = new DeepSeek("synthetic-key", async () => Response.json(raw));
  const request: ModelRequest = { instruction: "合成", history: [], tools: [
    { name: "propose_plan", description: "合成", parameters: scenario.schema },
  ] };
  const reply = await driver.generate(request, new AbortController().signal);
  assert.match(replyProblems(request, reply).join("；"), scenario.problem);
  assert.deepEqual(reply.raw, raw);
  assert.deepEqual(reply.calls[0].args, scenario.args, "拒绝对象不能被空对象替代，纠错需要原提案");
});

test("去掉最小非法字段或对应 schema 限制后，不再产生该拒绝", async () => {
  for (const [args, parameters] of [
    [{}, object({})],
    [{ unexpected: true }, { type: "object", properties: {} }],
  ] as const) {
    const driver = new DeepSeek("synthetic-key", async () => Response.json(rawReply(JSON.stringify(args))));
    const request: ModelRequest = { instruction: "合成", history: [], tools: [
      { name: "propose_plan", description: "合成", parameters },
    ] };
    const reply = await driver.generate(request, new AbortController().signal);
    assert.deepEqual(replyProblems(request, reply), []);
    assert.deepEqual(reply.calls[0].args, args);
  }
});

test("解析失败、重复属性和数组参数仍拒绝，不产生可解释的对象参数", async () => {
  for (const text of ["{", '{"x":1,"x":2}', "[]"]) {
    const driver = new DeepSeek("synthetic-key", async () => Response.json(rawReply(text)));
    const request: ModelRequest = { instruction: "合成", history: [], tools: [
      { name: "propose_plan", description: "合成", parameters: object({}) },
    ] };
    const reply = await driver.generate(request, new AbortController().signal);
    assert.ok(replyProblems(request, reply).length);
    assert.deepEqual(reply.calls[0].args, {});
  }
});

test("原生协议纠错收到拒绝对象，连续非法回执仍按原预算停止且零候选", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "cordis-rejected-args-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  const rejected = { unexpected: true };
  const bodies: { messages: { role: string; content: string }[] }[] = [];
  const driver = new DeepSeek("synthetic-key", async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(rawReply(JSON.stringify(rejected), "inspect_application"));
  });
  const evolution = new Evolution(workspace.db, driver, new EvolutionDomain(workspace),
    { calls: 12, candidates: 3, milliseconds: 600000 });
  t.after(async () => {
    await evolution.close(); await workspace.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const before = { composition: workspace.composition(), tasks: workspace.query() };
  await evolution.command({ type: "request", operationId: "request", text: "合成完成流程改进" });
  const deadline = Date.now() + 30000;
  while ((await evolution.observe()).run?.status === "planning" && Date.now() < deadline)
    await new Promise(resolve => setTimeout(resolve, 10));
  const snapshot = await evolution.observe();
  assert.equal(snapshot.run?.status, "blocked");
  assert.equal(bodies.length, 2);
  assert.equal(snapshot.run.budget?.callsUsed, 2);
  assert.equal(snapshot.run.budget?.callsRemaining, 10);
  assert.equal(snapshot.candidates?.length, 0);
  assert.deepEqual({ composition: workspace.composition(), tasks: workspace.query() }, before);
  const input = JSON.parse(bodies[1].messages.filter(m => m.role === "user").at(-1)!.content);
  assert.deepEqual(input.protocolCorrection.rejected.calls[0].args, rejected);
  assert.equal(input.protocolCorrection.attempt, 1);
});
