import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Gemini } from "../src/evolution/gemini.js";
import { redactSensitive } from "./lib/shortened-real-model.js";
import {
  BASELINE_PRODUCT_COMMIT,
  STABILITY_EVAL_MANIFEST,
  freezeManifest,
  assertManifestFrozen,
} from "./lib/stability-eval/manifest.js";
import { computeStabilityMetrics } from "./lib/stability-eval/metrics.js";
import { runFrozenBaselineSuite } from "./lib/stability-eval/scenario.js";
import { stabilityDriverFor } from "./lib/stability-eval/driver-fixture.js";

import { assertRealModelAuthorization } from "./lib/stability-eval/authorization.js";
import {
  BASELINE_PRODUCT_COMMIT,
  STABILITY_EVAL_MANIFEST,
  freezeManifest,
  assertManifestFrozen,
} from "./lib/stability-eval/manifest.js";
import { computeStabilityMetrics } from "./lib/stability-eval/metrics.js";
import { runFrozenBaselineSuite } from "./lib/stability-eval/scenario.js";
import { stabilityDriverFor } from "./lib/stability-eval/driver-fixture.js";

const authorizeReal = process.argv.includes("--authorize-real-model");
const stubOnly = process.argv.includes("--stub") || !authorizeReal;
const allowDirtyHead = process.argv.includes("--allow-dirty-head");
const allowDirtyWorktree = process.argv.includes("--allow-dirty-worktree");

/** Paths that may diverge from productCommit / be dirty while archiving. */
const HARNESS_PATH_PREFIXES = [
  "scripts/lib/stability-eval/",
  "scripts/accept-stability-baseline.ts",
  "tests/app/stability-",
  "tests/e2e/stability-",
  "docs/reports/issue-37-baseline/",
  "package.json",
  "README.md",
] as const;

const PRODUCT_PATHS = ["src/"] as const;

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

function isHarnessPath(path: string): boolean {
  return HARNESS_PATH_PREFIXES.some(
    (prefix) => path === prefix.replace(/\/$/, "") || path.startsWith(prefix),
  );
}

function assertProductTreeMatchesBaseline(productCommit: string): void {
  const diff = git("diff", "--name-only", productCommit, "--", ...PRODUCT_PATHS);
  if (diff) {
    throw new Error(
      `产品树相对 productCommit ${productCommit} 有差异（${diff.split("\n").join(", ")}）。` +
        `改造后比较请使用新归档目录；调试可用 --allow-dirty-head 跳过本闸门。`,
    );
  }
}

function assertWorktreeCleanOrHarnessOnly(): void {
  const porcelain = git("status", "--porcelain", "--untracked-files=all");
  if (!porcelain) return;
  const dirty = porcelain
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
  const nonHarness = dirty.filter((path) => !isHarnessPath(path));
  if (nonHarness.length) {
    throw new Error(
      `完整基线要求产品源码干净；非 harness 路径有未提交改动：${nonHarness.join(", ")}。` +
        `仅本地桩验证可用 --stub --allow-dirty-worktree。`,
    );
  }
}

if (!stubOnly) assertRealModelAuthorization(process.argv);
if (authorizeReal && existsSync(".env")) process.loadEnvFile(".env");
if (authorizeReal && !process.env.GEMINI_API_KEY?.trim())
  throw new Error("GEMINI_API_KEY is not configured");

const head = git("rev-parse", "HEAD");
if (!allowDirtyHead) assertProductTreeMatchesBaseline(BASELINE_PRODUCT_COMMIT);
if (!allowDirtyWorktree) assertWorktreeCleanOrHarnessOnly();

execFileSync("pnpm", ["build"], { stdio: "inherit" });

const frozenAt = new Date().toISOString();
const manifest = freezeManifest(STABILITY_EVAL_MANIFEST, frozenAt);
assertManifestFrozen(manifest);

const stamp = frozenAt.replace(/[:.]/g, "-");
const root =
  process.env.STABILITY_EVAL_PATH ??
  join(
    "docs/reports/issue-37-baseline",
    stubOnly ? `stub-${stamp}` : `real-${stamp}`,
  );
if (existsSync(root)) rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

const evidenceKind = stubOnly ? "model-stub" : "real-model";
const { records } = await runFrozenBaselineSuite({
  root,
  manifest,
  evidenceKind,
  harnessCommit: head,
  driverFactory: stubOnly
    ? (id) => stabilityDriverFor(id)
    : () => new Gemini(process.env.GEMINI_API_KEY!),
});

const metrics = computeStabilityMetrics(records);
const summary = {
  schema: "cordis.stability-eval-baseline/1",
  issue: 37,
  parentIssue: 36,
  evidenceKind,
  productCommit: manifest.productCommit,
  sourceCommit: manifest.productCommit,
  harnessCommit: head,
  contentHash: manifest.contentHash,
  frozenAt: manifest.frozenAt,
  records: redactSensitive(records),
  metrics,
  note: stubOnly
    ? "模型桩基线；不得标为真实 LLM 能力证据。真实模型需 --authorize-real-model。"
    : "授权真实模型基线；不手改候选、不外层重试、不重置预算。",
  immutability:
    "后续代码变化不得覆盖或重新解释本目录；改造后比较写入新归档。",
};
writeFileSync(
  join(root, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
  { mode: 0o600 },
);
writeFileSync(
  join(root, "summary.sha256"),
  createHash("sha256").update(readFileSync(join(root, "summary.json"))).digest(
    "hex",
  ) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
