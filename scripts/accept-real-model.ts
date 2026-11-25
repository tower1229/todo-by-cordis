import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Browser } from "playwright";
import {
  createDeepSeekDriver,
  type DeepSeekCallRecord,
} from "../src/evolution/model/deepseek.js";
import type { EvolutionRunView, ModelDriver } from "../src/evolution/loop.js";
import {
  loadDotEnvIfPresent,
  startHostApp,
  type HostAppHandle,
} from "../src/main.js";
import {
  acceptTodoTagUpgrade,
  seedTodoTagUpgrade,
} from "./todo-tag-upgrade-acceptance.js";

export type RealModelScenario = "todo-six-step" | "inventory-migration" | "all";

export interface RealModelAcceptanceOptions {
  readonly authorizePaidRun: boolean;
  readonly envAuthorized: boolean;
  readonly apiKey: string | undefined;
  readonly scenario: RealModelScenario;
  readonly maxCalls: number;
  readonly maxCostCny: number;
  readonly outDir: string;
}

export interface RealModelGuardrailResult {
  readonly allowed: boolean;
  readonly reason?: string;
}

export interface UsageAccounting {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  unknownUsageCalls: number;
  estimatedCostCny: number;
}

// Conservative upper-bound pricing estimate in CNY per 1M tokens for guardrail enforcement.
const ESTIMATED_PROMPT_CNY_PER_MILLION = 4.0;
const ESTIMATED_COMPLETION_CNY_PER_MILLION = 16.0;
const UNKNOWN_USAGE_CONSERVATIVE_COST_CNY = 0.2;

export const DEFAULT_REAL_MODEL_MAX_CALLS = 24;
export const DEFAULT_REAL_MODEL_MAX_COST_CNY = 8.0;

/** Per-run EvolutionLoop budget for real DeepSeek reasoner latency (outer call/cost caps still apply). */
export const REAL_MODEL_EVOLUTION_BUDGET = {
  callLimit: 24,
  activeMsLimit: 20 * 60_000,
} as const;

const TODO_TAG_UPGRADE_STEP = 3;

export const TODO_SIX_STEP_PROMPTS: readonly string[] = [
  "新增一个 todo-tags 标签插件：为任务提供自有标签表、标签增删查接口，以及在任务行展示标签和编辑标签的界面。旧版应原样保存标签大小写。请提供稳定接口：POST /api/app/todo-tags/tags 接收 { taskId, label }，GET /api/app/todo-tags/tags?taskId=... 返回 { tags: [{ id, label }] }。",
  "新增一个 todo-counter 计数插件，在页面顶部状态插槽展示当前未完成与已完成任务数量，不要修改 todo-core 与 todo-tags。",
  "升级 todo-tags 插件：新保存的标签自动标准化为小写并去重，同时保留历史标签的 id 和原始大小写，并同步更新 todo-tags 测试。保持原有标签 HTTP 接口，重复提交可幂等成功或返回 HTTP 409。",
  "新增一个 todo-review 复盘插件：完成任务前必须填写复盘总结，通过为 todo-core 开放通用双端拦截接缝并在 todo-review 中弹窗收集与服务端强校验实现，不得把复盘逻辑写进 todo-core。",
  "停用 todo-tags 插件（零业务代码变更），确认计数与复盘功能继续正常运行且历史标签数据未丢失。",
  "重新启用 todo-tags 插件（零业务代码变更），确认标签界面、功能与历史标签数据完整恢复。",
];

export const INVENTORY_MIGRATION_PROMPTS: readonly string[] = [
  "新增一个 inventory-expiry 效期预警插件：为库存批次提供效期登记与临期预警展示，不破坏 inventory-core 原有功能。",
  "新增一个 inventory-approval 出库审批插件：当单次出库数量大于 50 时拦截并要求填写审批理由，且卸载该插件后 inventory-core 仍独立正常出库。",
];

export function parseRealModelArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): RealModelAcceptanceOptions {
  let authorizePaidRun = false;
  let scenario: RealModelScenario = "all";
  let maxCalls = DEFAULT_REAL_MODEL_MAX_CALLS;
  let maxCostCny = DEFAULT_REAL_MODEL_MAX_COST_CNY;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  let outDir = resolve("docs/reports/v3-real-model", stamp);

  for (const arg of argv) {
    if (arg === "--authorize-paid-run") {
      authorizePaidRun = true;
    } else if (arg.startsWith("--scenario=")) {
      const value = arg.slice("--scenario=".length);
      if (
        value === "todo-six-step" ||
        value === "inventory-migration" ||
        value === "all"
      ) {
        scenario = value;
      } else {
        throw new Error(`Unsupported --scenario value: ${value}`);
      }
    } else if (arg.startsWith("--max-calls=")) {
      const parsed = Number(arg.slice("--max-calls=".length));
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new Error(`Invalid --max-calls value: ${arg}`);
      }
      maxCalls = parsed;
    } else if (arg.startsWith("--max-cost-cny=")) {
      const parsed = Number(arg.slice("--max-cost-cny=".length));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`Invalid --max-cost-cny value: ${arg}`);
      }
      maxCostCny = parsed;
    } else if (arg.startsWith("--out-dir=")) {
      outDir = resolve(arg.slice("--out-dir=".length));
    }
  }

  return {
    authorizePaidRun,
    envAuthorized: env.REAL_MODEL_AUTHORIZED === "1",
    apiKey: env.DEEPSEEK_API_KEY,
    scenario,
    maxCalls,
    maxCostCny,
    outDir,
  };
}

export function validateRealModelAuthorization(
  options: RealModelAcceptanceOptions,
): RealModelGuardrailResult {
  if (!options.authorizePaidRun) {
    return {
      allowed: false,
      reason:
        "STOP_SERIES guardrail: missing explicit --authorize-paid-run flag. Paid real-model acceptance is disabled by default.",
    };
  }
  if (!options.envAuthorized) {
    return {
      allowed: false,
      reason:
        "STOP_SERIES guardrail: missing REAL_MODEL_AUTHORIZED=1 environment confirmation.",
    };
  }
  if (!options.apiKey || options.apiKey.trim().length === 0) {
    return {
      allowed: false,
      reason:
        "STOP_SERIES guardrail: missing DEEPSEEK_API_KEY environment variable.",
    };
  }
  return { allowed: true };
}

export function createBudgetGuardedDriver(
  inner: ModelDriver,
  limits: { readonly maxCalls: number; readonly maxCostCny: number },
  accounting: UsageAccounting,
): ModelDriver {
  return {
    async generate(request, signal) {
      if (accounting.calls >= limits.maxCalls) {
        throw new Error(
          `Real-model call limit exceeded (${accounting.calls}/${limits.maxCalls})`,
        );
      }
      if (accounting.estimatedCostCny >= limits.maxCostCny) {
        throw new Error(
          `Real-model cost guardrail exceeded (${accounting.estimatedCostCny.toFixed(4)}/${limits.maxCostCny} CNY)`,
        );
      }
      accounting.calls += 1;
      const reply = await inner.generate(request, signal);
      if (reply.usage?.unknown) {
        accounting.unknownUsageCalls += 1;
        accounting.estimatedCostCny += UNKNOWN_USAGE_CONSERVATIVE_COST_CNY;
      } else {
        const prompt = reply.usage?.promptTokens ?? 0;
        const completion = reply.usage?.completionTokens ?? 0;
        accounting.promptTokens += prompt;
        accounting.completionTokens += completion;
        accounting.estimatedCostCny +=
          (prompt / 1_000_000) * ESTIMATED_PROMPT_CNY_PER_MILLION +
          (completion / 1_000_000) * ESTIMATED_COMPLETION_CNY_PER_MILLION;
      }
      return reply;
    },
  };
}

type TagUpgradeAcceptance =
  | Awaited<ReturnType<typeof acceptTodoTagUpgrade>>
  | {
      readonly status: "failed";
      readonly candidateId: string | null;
      readonly error: string;
    };

interface ScenarioStep {
  readonly step: number;
  readonly prompt: string;
  readonly runId?: string;
  readonly status: string;
  readonly highlights?: readonly string[];
  readonly changeBrief?: unknown;
  readonly budget?: unknown;
  readonly error?: string | null;
  readonly events?: readonly unknown[];
  readonly screenshotPath: string;
  readonly activeCompositionId?: string;
  readonly independentAcceptance?: TagUpgradeAcceptance;
}

interface ScenarioResult {
  readonly scenario: Exclude<RealModelScenario, "all">;
  readonly seedPluginDir: string;
  readonly steps: readonly ScenarioStep[];
}

async function runPaidScenario(
  scenario: ScenarioResult["scenario"],
  seedPluginDir: string,
  prompts: readonly string[],
  options: RealModelAcceptanceOptions,
  accounting: UsageAccounting,
): Promise<ScenarioResult> {
  const callsLogPath = join(options.outDir, scenario, "calls.jsonl");
  const rawDriver = createDeepSeekDriver({
    apiKey: options.apiKey!,
    onRecord: (record: DeepSeekCallRecord) => {
      appendFileSync(callsLogPath, `${JSON.stringify(record)}\n`, "utf8");
    },
  });
  const driver = createBudgetGuardedDriver(rawDriver, options, accounting);
  return await runAcceptanceScenario({
    scenario,
    seedPluginDir,
    prompts,
    outDir: options.outDir,
    driver,
  });
}

export async function runAcceptanceScenario({
  scenario,
  seedPluginDir,
  prompts,
  outDir,
  driver,
}: {
  readonly scenario: ScenarioResult["scenario"];
  readonly seedPluginDir: string;
  readonly prompts: readonly string[];
  readonly outDir: string;
  readonly driver: ModelDriver;
}): Promise<ScenarioResult> {
  const scenarioDir = join(outDir, scenario);
  mkdirSync(scenarioDir, { recursive: true });
  const dataDir = mkdtempSync(join(tmpdir(), `host-real-model-${scenario}-`));
  const steps: ScenarioStep[] = [];
  let app: HostAppHandle | undefined;
  let browser: Browser | undefined;

  try {
    app = await startHostApp({
      dataDir,
      seedPluginDir,
      port: 0,
      driver,
      defaultBudget: REAL_MODEL_EVOLUTION_BUDGET,
    });
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.goto(app.url, { waitUntil: "networkidle" });
    await page.screenshot({
      path: join(scenarioDir, "step-0-initial.png"),
      fullPage: true,
    });

    for (let i = 0; i < prompts.length; i += 1) {
      const prompt = prompts[i]!;
      const step = i + 1;
      const isTagUpgrade =
        scenario === "todo-six-step" && step === TODO_TAG_UPGRADE_STEP;
      let run: EvolutionRunView | undefined;
      let independentAcceptance: TagUpgradeAcceptance | undefined;

      try {
        const fixture = isTagUpgrade
          ? await seedTodoTagUpgrade(page.request, app.url)
          : undefined;
        const started = await app.evolution.startRun(prompt);
        run = await app.evolution.waitForRun(started.runId);
        if (run.status === "preview_ready") {
          if (fixture) {
            independentAcceptance = await acceptTodoTagUpgrade(
              app,
              page.request,
              run,
              fixture,
            );
          } else {
            await app.evolution.applyRun(run.runId);
          }
        }
      } catch (error) {
        if (!isTagUpgrade) throw error;
        independentAcceptance = {
          status: "failed",
          candidateId: run?.candidateId ?? null,
          error: error instanceof Error ? error.message : String(error),
        };
      }

      await page.reload({ waitUntil: "networkidle" });
      const screenshotPath = join(scenarioDir, `step-${step}.png`);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      steps.push({
        step,
        prompt,
        runId: run?.runId,
        status: run?.status ?? "not_started",
        highlights: run?.highlights,
        changeBrief: run?.changeBrief,
        budget: run?.budget,
        error: run?.error,
        events: run?.events,
        screenshotPath,
        activeCompositionId:
          app.release.getStatus().activeComposition?.compositionId,
        independentAcceptance,
      });
      if (
        run?.status !== "preview_ready" ||
        independentAcceptance?.status === "failed"
      ) {
        break;
      }
    }
  } finally {
    await browser?.close();
    await app?.close();
    rmSync(dataDir, { recursive: true, force: true });
  }

  return { scenario, seedPluginDir, steps };
}

export function assertRealModelScenarioPassed(result: {
  readonly scenario: string;
  readonly steps: ReadonlyArray<{
    readonly step: number;
    readonly status: string;
    readonly prompt: string;
    readonly error?: string | null;
    readonly independentAcceptance?: TagUpgradeAcceptance;
  }>;
  readonly expectedSteps: number;
}): void {
  for (const step of result.steps) {
    if (step.independentAcceptance?.status === "failed") {
      throw new Error(
        `Real-model scenario ${result.scenario} step ${step.step} failed independent acceptance: ${step.independentAcceptance.error}`,
      );
    }
  }
  if (result.steps.length < result.expectedSteps) {
    const last = result.steps[result.steps.length - 1];
    throw new Error(
      `Real-model scenario ${result.scenario} stopped after ${result.steps.length}/${result.expectedSteps} steps` +
        (last
          ? ` (last status=${last.status}${last.error ? `, error=${last.error}` : ""})`
          : ""),
    );
  }
  for (const step of result.steps) {
    if (step.status !== "preview_ready" && step.status !== "applied") {
      throw new Error(
        `Real-model scenario ${result.scenario} step ${step.step} did not reach preview_ready (status=${step.status}${step.error ? `, error=${step.error}` : ""})`,
      );
    }
  }
  if (
    result.scenario === "todo-six-step" &&
    result.expectedSteps >= TODO_TAG_UPGRADE_STEP &&
    result.steps.find((step) => step.step === TODO_TAG_UPGRADE_STEP)
      ?.independentAcceptance?.status !== "passed"
  ) {
    throw new Error("Todo tag upgrade did not pass independent acceptance");
  }
}

export async function runRealModelAcceptance(
  options: RealModelAcceptanceOptions,
): Promise<void> {
  const auth = validateRealModelAuthorization(options);
  if (!auth.allowed) {
    throw new Error(auth.reason);
  }

  mkdirSync(options.outDir, { recursive: true });
  const accounting: UsageAccounting = {
    calls: 0,
    promptTokens: 0,
    completionTokens: 0,
    unknownUsageCalls: 0,
    estimatedCostCny: 0,
  };

  const results: ScenarioResult[] = [];
  if (options.scenario === "todo-six-step" || options.scenario === "all") {
    results.push(
      await runPaidScenario(
        "todo-six-step",
        resolve("plugins/todo-core"),
        TODO_SIX_STEP_PROMPTS,
        options,
        accounting,
      ),
    );
  }
  if (
    (options.scenario === "inventory-migration" ||
      options.scenario === "all") &&
    !results.some((result) =>
      result.steps.some(
        (step) => step.independentAcceptance?.status === "failed",
      ),
    )
  ) {
    results.push(
      await runPaidScenario(
        "inventory-migration",
        resolve("plugins/inventory-core"),
        INVENTORY_MIGRATION_PROMPTS,
        options,
        accounting,
      ),
    );
  }

  writeFileSync(
    join(options.outDir, "summary.json"),
    JSON.stringify(
      {
        executedAt: new Date().toISOString(),
        scenario: options.scenario,
        limits: {
          maxCalls: options.maxCalls,
          maxCostCny: options.maxCostCny,
        },
        evolutionBudget: REAL_MODEL_EVOLUTION_BUDGET,
        usage: accounting,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );

  for (const result of results) {
    const expectedSteps =
      result.scenario === "todo-six-step"
        ? TODO_SIX_STEP_PROMPTS.length
        : INVENTORY_MIGRATION_PROMPTS.length;
    assertRealModelScenarioPassed({ ...result, expectedSteps });
  }
}

const isDirectEntry =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectEntry) {
  loadDotEnvIfPresent();
  const options = parseRealModelArgs(process.argv.slice(2), process.env);
  runRealModelAcceptance(options).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
