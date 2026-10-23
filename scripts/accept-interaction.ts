// Explicitly authorized, isolated real-model acceptance. Never activates candidates.
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { chromium } from "playwright";
import { Workspace } from "../src/server/workspace.js";
import { Evolution } from "../src/evolution/evolution.js";
import { EvolutionDomain } from "../src/server/evolution-domain.js";
import { ExperienceSessionHost } from "../src/server/experience-session.js";
import { createApp } from "../src/server/app.js";
import { DeepSeek, DEEPSEEK_MODEL } from "../src/evolution/deepseek.js";
import { evolutionBudget } from "../src/server/evolution-budget.js";
import type { AssistantSnapshot } from "../src/shared/assistant.js";
import { redactSensitive } from "./lib/shortened-real-model.js";

if (process.env.ACCEPT_REAL_MODEL !== "1")
  throw new Error("真实模型验证需要显式授权 ACCEPT_REAL_MODEL=1");
if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.DEEPSEEK_API_KEY?.trim())
  throw new Error("DEEPSEEK_API_KEY is not configured");
const maxPaidCalls = Number(process.env.ACCEPT_MAX_PAID_CALLS ?? 24);
if (!Number.isSafeInteger(maxPaidCalls) || maxPaidCalls < 1)
  throw new Error("ACCEPT_MAX_PAID_CALLS must be a positive integer");
const directory = mkdtempSync(resolve(".runtime/interaction-real-"));
const write = (file: string, value: unknown) =>
  writeFileSync(
    join(directory, file),
    JSON.stringify(redactSensitive(value), null, 2),
  );
const paths = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter((path) => statSync(path).isFile());
const manifest = () =>
  Object.fromEntries(
    paths.map((path) => [
      path,
      createHash("sha256").update(readFileSync(path)).digest("hex"),
    ]),
  );
const sourceManifest = manifest();
write("source-manifest.json", sourceManifest);
const requests = [
  {
    id: "defaults",
    request: "给待办加一个可选的截止时间，到点后任务还没完成就自动标记过期。",
    calls: evolutionBudget(process.env).calls,
  },
  {
    id: "continuation",
    request:
      "在任务详情增加一个可选的备注标签，通过显式动作填写或修改，保留已有任务和其他行为。",
    calls: 5,
    answer:
      "已完成任务也可以填写或修改备注标签，填写或修改备注标签不改变任务状态。",
  },
].filter((scenario) => !process.env.ACCEPT_SCENARIO || scenario.id === process.env.ACCEPT_SCENARIO);
if (!requests.length) throw new Error("Unknown ACCEPT_SCENARIO");
write("authorization.json", {
  model: DEEPSEEK_MODEL,
  maxPaidCalls,
  requests,
  sourceClean: false,
  productionApplication: false,
  startedAt: new Date().toISOString(),
});
console.log(`Evidence: ${directory}`);
let paidCalls = 0;
const results: unknown[] = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const scenario of requests) {
    const w = await Workspace.open(join(directory, `${scenario.id}.db`));
    const sessions = new ExperienceSessionHost(w);
    const provider = new DeepSeek(process.env.DEEPSEEK_API_KEY);
    const evolution = new Evolution(
      w.db,
      {
        async generate(request, signal, progress) {
          if (paidCalls >= maxPaidCalls)
            throw new Error(`真实验证已达到${maxPaidCalls}次付费调用总额，保留当前结果`);
          paidCalls++;
          write("usage-counter.json", { paidCalls, maxPaidCalls });
          console.log(
            `${scenario.id}: call ${paidCalls}/${maxPaidCalls} (${request.phase})`,
          );
          return provider.generate(request, signal, progress);
        },
      },
      new EvolutionDomain(w),
      sessions,
      { ...evolutionBudget(process.env), calls: scenario.calls },
    );
    const app = createApp(w, evolution, sessions);
    app.use("/*", serveStatic({ root: "./dist/web" }));
    app.get("*", serveStatic({ path: "./dist/web/index.html" }));
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    if (!server.listening) await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("测试服务地址无效");
    const page = await browser.newPage({
      viewport: { width: scenario.id === "defaults" ? 1360 : 390, height: 900 },
    });
    const base = w.composition();
    const observations: unknown[] = [];
    const callStart = paidCalls;
    let final: AssistantSnapshot | undefined;
    let experienced = false;
    let answered = false;
    try {
      await page.goto(`http://127.0.0.1:${address.port}/`);
      await page.getByRole("button", { name: "改进应用", exact: true }).click();
      await page
        .getByRole("textbox", { name: "告诉 AI 你的需求" })
        .fill(scenario.request);
      await page.getByRole("button", { name: "发送需求", exact: true }).click();
      let previous = "",
        resumed = 0;
      const deadline = Date.now() + 45 * 60_000;
      while (Date.now() < deadline) {
        const snapshot = await evolution.observe();
        const run = snapshot.run;
        if (!run) {
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        if (run.status !== previous) {
          console.log(`${scenario.id}: ${run.status}`);
          observations.push(snapshot);
          previous = run.status;
        }
        if (run.status === "awaiting-budget") {
          if (paidCalls >= maxPaidCalls || resumed >= 12) {
            final = snapshot;
            break;
          }
          await page
            .getByRole("button", { name: "继续进行", exact: true })
            .click();
          resumed++;
        } else if (run.status === "ready") {
          if (paidCalls >= maxPaidCalls) {
            final = snapshot;
            break;
          }
          await page.screenshot({
            path: join(directory, `${scenario.id}-plan.png`),
            fullPage: true,
          });
          await page
            .getByRole("button", { name: "开始执行", exact: true })
            .click();
        } else if (run.status === "awaiting-input" && scenario.answer && !answered &&
          run.questions?.length === 1 && /备注标签|填写备注/.test(run.questions[0].title)) {
          write(`${scenario.id}-answer.json`, { question: run.questions[0], answer: scenario.answer });
          await page.getByRole("form", { name: "回答当前问题" }).getByRole("textbox").fill(scenario.answer);
          await page.getByRole("button", { name: "提交回答", exact: true }).click();
          answered = true;
        } else if (run.status === "awaiting-apply") {
          await page.getByRole("button", { name: "体验", exact: true }).click();
          await page.getByRole("status", { name: "候选体验提示" }).waitFor();
          await page.screenshot({ path: join(directory, `${scenario.id}-experience.png`), fullPage: true });
          await page.getByRole("button", { name: "结束体验", exact: true }).click();
          await page.getByRole("status", { name: "候选体验提示" }).waitFor({state:"hidden"});
          await page.getByRole("button", { name: "改进应用", exact: true }).click();
          await page.getByRole("button", { name: "确认应用", exact: true }).waitFor();
          experienced = true;
          final = await evolution.observe();
          break;
        } else if (
          !["planning", "executing", "applying"].includes(run.status)
        ) {
          final = snapshot;
          break;
        }
        await new Promise((r) => setTimeout(r, 1000));
      }
      final ??= await evolution.observe();
      await page.screenshot({
        path: join(directory, `${scenario.id}-final.png`),
        fullPage: true,
      });
      const unchanged =
        JSON.stringify(w.composition()) === JSON.stringify(base);
      results.push({
        scenario: scenario.id,
        runId: final.run?.id,
        status: final.run?.status,
        calls: paidCalls - callStart,
        grants: final.run?.budget?.grants,
        passed:
          final.run?.status === "awaiting-apply" &&
          experienced &&
          unchanged &&
          (scenario.id !== "continuation" ||
            !!final.run.budget?.grants?.length),
        efficiencyTarget: scenario.calls,
        experienced,
        efficiencyMet: paidCalls - callStart <= scenario.calls,
        unchanged,
        final,
      });
    } catch (error) {
      results.push({
        scenario: scenario.id,
        error: error instanceof Error ? error.message : String(error),
        calls: paidCalls - callStart,
        final: await evolution.observe(),
      });
    } finally {
      write(`${scenario.id}-observations.json`, observations);
      write(
        `${scenario.id}-calls.json`,
        w.db
          .prepare("SELECT body FROM evolution_calls ORDER BY id")
          .all()
          .map((row) => JSON.parse(String(row.body))),
      );
      await page.close();
      await evolution.close();
      await sessions.close();
      await new Promise<void>((r) => server.close(() => r()));
      await w.close();
      write("result.json", { paidCalls, maxPaidCalls, results });
    }
  }
} finally {
  await browser.close();
  const passed =
    results.length === requests.length &&
    results.every((value) => (value as { passed?: boolean }).passed === true);
  if (!passed) process.exitCode = 1;
  const sourceUnchanged =
    JSON.stringify(manifest()) === JSON.stringify(sourceManifest);
  if (!sourceUnchanged) process.exitCode = 1;
  write("result.json", {
    paidCalls,
    maxPaidCalls,
    sourceUnchanged,
    passed: passed && sourceUnchanged,
    results,
    endedAt: new Date().toISOString(),
  });
  console.log(
    JSON.stringify({
      paidCalls,
      sourceUnchanged,
      results: results.map((value) => {
        const r = value as {
          scenario: string;
          status?: string;
          passed?: boolean;
          calls: number;
          error?: string;
        };
        return {
          scenario: r.scenario,
          status: r.status,
          passed: r.passed,
          calls: r.calls,
          error: r.error,
        };
      }),
    }),
  );
}
