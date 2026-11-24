import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  createDeepSeekModelDriver,
  type DeepSeekCallRecord,
} from "../../src/v3/deepseek-driver.js";
import { loadDotEnvIfPresent, startV3App } from "../../src/v3/main.js";
import {
  assertRealModelScenarioPassed,
  createBudgetGuardedDriver,
  parseRealModelArgs,
  REAL_MODEL_EVOLUTION_BUDGET,
  TODO_SIX_STEP_PROMPTS,
  validateRealModelAuthorization,
  type UsageAccounting,
} from "../../scripts/accept-v3-real-model.js";

test("V3 default entry starts SupervisorShell with todo-core seed plugin and serves CRUD + HTML", async () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-main-smoke-"));
  const app = await startV3App({
    dataDir: dir,
    seedPluginDir: resolve("plugins/todo-core"),
    port: 0,
  });

  try {
    const htmlRes = await fetch(app.url);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /supervisor-root/);
    assert.match(html, /app-root/);
    assert.match(html, /importmap/);

    const createRes = await fetch(`${app.url}/api/app/todo-core/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "V3 cutover smoke task" }),
    });
    assert.equal(createRes.status, 201);

    const listRes = await fetch(`${app.url}/api/app/todo-core/tasks`);
    assert.equal(listRes.status, 200);
    const listJson = (await listRes.json()) as {
      tasks: Array<{ title: string }>;
    };
    assert.equal(listJson.tasks.length, 1);
    assert.equal(listJson.tasks[0]?.title, "V3 cutover smoke task");
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SupervisorShell client has zero hardcoded business domain terms", () => {
  const shellSource = readFileSync(
    resolve("src/v3/client/supervisor-shell.tsx"),
    "utf8",
  );
  assert.doesNotMatch(shellSource, /todo-core|inventory-core|plg_todo/i);
});

test("Real-model acceptance entry fails closed without explicit authorization flags", () => {
  const missingFlag = parseRealModelArgs([], {
    V3_REAL_MODEL_AUTHORIZED: "1",
    DEEPSEEK_API_KEY: "test-key",
  });
  assert.equal(validateRealModelAuthorization(missingFlag).allowed, false);

  const missingEnv = parseRealModelArgs(["--authorize-paid-run"], {
    DEEPSEEK_API_KEY: "test-key",
  });
  assert.equal(validateRealModelAuthorization(missingEnv).allowed, false);

  const missingKey = parseRealModelArgs(["--authorize-paid-run"], {
    V3_REAL_MODEL_AUTHORIZED: "1",
  });
  assert.equal(validateRealModelAuthorization(missingKey).allowed, false);

  const authorized = parseRealModelArgs(
    [
      "--authorize-paid-run",
      "--scenario=todo-six-step",
      "--max-calls=12",
      "--max-cost-cny=3.5",
    ],
    {
      V3_REAL_MODEL_AUTHORIZED: "1",
      DEEPSEEK_API_KEY: "test-key",
    },
  );
  assert.equal(validateRealModelAuthorization(authorized).allowed, true);
  assert.equal(authorized.scenario, "todo-six-step");
  assert.equal(authorized.maxCalls, 12);
  assert.equal(authorized.maxCostCny, 3.5);
});

test("Real-model budget guardrail blocks calls once callLimit or costLimit is reached", async () => {
  const accounting: UsageAccounting = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    unknownUsageCalls: 0,
    estimatedCostCny: 0,
  };
  const stub = createBudgetGuardedDriver(
    {
      async generate() {
        return {
          text: "ok",
          raw: {},
          usage: { promptTokens: 500_000, completionTokens: 200_000 },
        };
      },
    },
    { maxCalls: 5, maxCostCny: 5.0 },
    accounting,
  );

  const ac = new AbortController();
  await stub.generate({ system: "", history: [], tools: [] }, ac.signal);
  assert.equal(accounting.calls, 1);
  assert.ok(accounting.estimatedCostCny > 5.0);

  await assert.rejects(
    () => stub.generate({ system: "", history: [], tools: [] }, ac.signal),
    /cost guardrail exceeded/,
  );
});

test("Production deepseek-driver normalizes assistant messages for multi-turn history and preserves onRecord rawUsage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "v3-deepseek-driver-prod-"));
  const outboundBodies: Array<{ messages: Array<Record<string, unknown>> }> = [];
  const records: DeepSeekCallRecord[] = [];
  let turn = 0;

  const mockFetch: typeof fetch = async (_input, init) => {
    turn += 1;
    outboundBodies.push(
      JSON.parse(String(init?.body ?? "{}")) as {
        messages: Array<Record<string, unknown>>;
      },
    );
    const payload =
      turn === 1
        ? {
            id: "resp-1",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "",
                  reasoning_content: "inspect todo-core first",
                  tool_calls: [
                    {
                      id: "call_1",
                      type: "function",
                      function: {
                        name: "inspect_plugin",
                        arguments: JSON.stringify({ pluginId: "todo-core" }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 120, completion_tokens: 20, total_tokens: 140 },
          }
        : {
            id: "resp-2",
            choices: [
              {
                finish_reason: "tool_calls",
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [
                    {
                      id: "call_2",
                      type: "function",
                      function: {
                        name: "clarify_request",
                        arguments: JSON.stringify({
                          question: "需要区分大小写吗？",
                        }),
                      },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 180, completion_tokens: 30, total_tokens: 210 },
          };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const driver = createDeepSeekModelDriver({
    apiKey: "test-key",
    http: mockFetch,
    onRecord: (record) => records.push(record),
  });

  const app = await startV3App({
    dataDir: dir,
    seedPluginDir: resolve("plugins/todo-core"),
    port: 0,
    driver,
  });

  try {
    const started = await app.evolution.startRun("测试真实入口 DeepSeek 多轮驱动");
    const settled = await app.evolution.waitForRun(started.runId);
    assert.equal(settled.status, "awaiting_clarification");
    assert.equal(turn, 2);
    assert.equal(records.length, 2);
    assert.deepEqual(records[0]?.rawUsage, {
      prompt_tokens: 120,
      completion_tokens: 20,
      total_tokens: 140,
    });

    // Turn 2 outbound HTTP request must contain only valid role messages (no raw { choices } envelope)
    const turn2Messages = outboundBodies[1]!.messages;
    for (const msg of turn2Messages) {
      assert.equal(typeof msg.role, "string");
      assert.equal("choices" in msg, false);
    }
    const assistantMsg = turn2Messages.find((m) => m.role === "assistant");
    assert.equal(assistantMsg?.reasoning_content, "inspect todo-core first");
    const toolMsg = turn2Messages.find(
      (m) => m.role === "tool" && m.tool_call_id === "call_1",
    );
    assert.ok(toolMsg);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Real-model six-step prompts match 5-tool contract (step 6 re-enables todo-tags) and loadDotEnvIfPresent populates missing keys", () => {
  assert.equal(TODO_SIX_STEP_PROMPTS.length, 6);
  assert.match(TODO_SIX_STEP_PROMPTS[5]!, /重新启用.*todo-tags/);
  assert.doesNotMatch(TODO_SIX_STEP_PROMPTS[5]!, /撤回/);

  const dir = mkdtempSync(join(tmpdir(), "v3-dotenv-"));
  try {
    const envFile = join(dir, ".env");
    writeFileSync(
      envFile,
      '# comment\nDEEPSEEK_API_KEY="from-dotenv-key"\nEXISTING_KEY=ignored\n',
      "utf8",
    );
    const targetEnv: NodeJS.ProcessEnv = { EXISTING_KEY: "keep-me" };
    loadDotEnvIfPresent(envFile, targetEnv);
    assert.equal(targetEnv.DEEPSEEK_API_KEY, "from-dotenv-key");
    assert.equal(targetEnv.EXISTING_KEY, "keep-me");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Real-model acceptance uses elevated EvolutionLoop budget and fails closed on incomplete steps", () => {
  assert.ok(REAL_MODEL_EVOLUTION_BUDGET.activeMsLimit >= 15 * 60_000);
  assert.ok(REAL_MODEL_EVOLUTION_BUDGET.callLimit >= 10);

  assert.doesNotThrow(() =>
    assertRealModelScenarioPassed({
      scenario: "todo-six-step",
      expectedSteps: 1,
      steps: [{ step: 1, status: "preview_ready", prompt: "ok" }],
    }),
  );

  assert.throws(
    () =>
      assertRealModelScenarioPassed({
        scenario: "todo-six-step",
        expectedSteps: 6,
        steps: [
          {
            step: 1,
            status: "awaiting_budget",
            prompt: "tags",
            error: "已达到 180s 活动时间上限",
          },
        ],
      }),
    /stopped after 1\/6/,
  );
});
