import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  appendFileSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Gemini } from "../src/evolution/gemini.js";
import { redactSensitive } from "./lib/shortened-real-model.js";
import { runV1Acceptance, v1Requests } from "./lib/v1-scenario.js";
import { v1Browser } from "./lib/v1-browser.js";

// A command-line flag cannot be accidentally enabled by a saved .env file.
if (!process.argv.includes("--authorize-real-model"))
  throw new Error(
    "需要显式授权付费模型调用：pnpm accept:v1 --authorize-real-model",
  );
if (existsSync(".env")) process.loadEnvFile(".env");
if (!process.env.GEMINI_API_KEY?.trim())
  throw new Error("GEMINI_API_KEY is not configured");
const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
function assertCleanCommit() {
  if (
    git("status", "--porcelain", "--untracked-files=all") ||
    git("rev-parse", "HEAD") !== commit
  )
    throw new Error(
      "完整验收要求固定提交与干净源码；修复后在新提交重验，不复用旧通过记录",
    );
}
assertCleanCommit();
// Build the browser bundle from this exact source, never reuse an unbound dist.
execFileSync("pnpm", ["build"], { stdio: "inherit" });
const root = mkdtempSync(join(tmpdir(), "cordis-v1-pair-"));
console.log(`证据与失败现场：${root}`);
const pairId = randomUUID();
const runs: { id: string; directory: string; status: string }[] = [];
const repairs: Record<string, unknown>[] = [];
let passed = false;
try {
  for (let index = 0; index < 2; index++) {
    assertCleanCommit();
    const directory = mkdtempSync(join(root, `run-${index + 1}-`));
    const id = randomUUID();
    const events = join(directory, "events.jsonl");
    writeFileSync(events, "", { flag: "wx", mode: 0o600 });
    const record = (event: Record<string, unknown>) => {
      if (event.type === "generated-candidate-correction")
        repairs.push({ trialId: id, ...event });
      appendFileSync(
        events,
        JSON.stringify(
          redactSensitive({ at: new Date().toISOString(), ...event }),
        ) + "\n",
      );
    };
    record({
      type: "header",
      kind: "real-model-full-six-step",
      issue: 35,
      pairId,
      id,
      commit,
      clean: true,
      node: process.version,
      requests: v1Requests,
      model: "gemini-3.1-pro-preview",
      faultBaseline: "none",
      faultOrigin: "natural-flow",
      limitsPerChange: { calls: 12, candidates: 3, milliseconds: 600_000 },
      externalRetries: 0,
      independentSyntheticWorkspace: true,
    });
    const run = { id, directory, status: "failed" };
    runs.push(run);
    try {
      const result = await runV1Acceptance({
        directory,
        driver: new Gemini(process.env.GEMINI_API_KEY!),
        mode: "real-model-full-six-step",
        record,
        browser: v1Browser(directory),
      });
      assertCleanCommit();
      run.status = result.status;
      record({ type: "result", ...result });
    } catch (error) {
      record({
        type: "result",
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
      throw error; // No rerun, budget reset, manual candidate edits, or second trial after failure.
    }
  }
  passed = runs.length === 2 && runs.every((run) => run.status === "passed");
} finally {
  const summary = {
    schema: "cordis.v1-acceptance-pair/1",
    pairId,
    commit,
    passed,
    runs: runs.map((run) => ({
      ...run,
      evidenceSha256: createHash("sha256")
        .update(readFileSync(join(run.directory, "events.jsonl")))
        .digest("hex"),
    })),
    repairEvidence: repairs.length
      ? "generated-candidate-correction-observed"
      : "not-exercised",
    repairs: redactSensitive(repairs),
    note: "未执行故障修复不得声称 Agent 自修复通过；失败现场保留，不覆盖旧报告。",
  };
  writeFileSync(join(root, "pair.json"), JSON.stringify(summary, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  console.log(JSON.stringify(summary, null, 2));
}
