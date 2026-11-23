import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { startV3App } from "../../src/v3/main.js";
import {
  createBudgetGuardedDriver,
  parseRealModelArgs,
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
