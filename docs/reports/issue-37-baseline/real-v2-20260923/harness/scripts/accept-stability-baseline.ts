import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  BASELINE_PRODUCT_COMMIT,
  STABILITY_EVAL_MANIFEST,
  freezeManifest,
} from "./lib/stability-eval/manifest.js";
import {
  reserveArchive,
  writeVerifiedJson,
} from "./lib/stability-eval/archive.js";
import { linkDependencies } from "./lib/stability-eval/environment.js";
import { assertRealModelAuthorization } from "./lib/stability-eval/authorization.js";

const real =
  process.argv.includes("--authorize-real-model") &&
  !process.argv.includes("--stub");
const child = process.argv.includes("--isolated-baseline");
if (process.argv.some((arg) => arg.startsWith("--allow-dirty")))
  throw new Error("基线不允许跳过产品版本检查；请使用自动隔离运行入口");
if (real) assertRealModelAuthorization(process.argv);
const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
function treeHashes(directory: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const relative = join(prefix, entry.name);
        return entry.isDirectory()
          ? Object.entries(treeHashes(join(directory, entry.name), relative))
          : [[relative, digest(readFileSync(join(directory, entry.name)))]];
      }),
  );
}

if (!child) {
  const root = resolve(
    process.env.STABILITY_EVAL_PATH ??
      join(
        "docs/reports/issue-37-baseline",
        `${real ? "real" : "stub"}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      ),
  );
  reserveArchive(root);
  if (real && existsSync(".env")) process.loadEnvFile(".env");
  if (real && !process.env.GEMINI_API_KEY?.trim())
    throw new Error("GEMINI_API_KEY is not configured");
  const source = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "cordis-baseline-product-"));
  const archive = execFileSync("git", ["archive", BASELINE_PRODUCT_COMMIT], {
    maxBuffer: 64 * 1024 * 1024,
  });
  execFileSync("tar", ["-x", "-C", directory], { input: archive });
  const productFiles = treeHashes(join(directory, "src"));
  const harnessFiles = [
    "scripts/accept-stability-baseline.ts",
    ...Object.keys(treeHashes("scripts/lib/stability-eval")).map(
      (path) => `scripts/lib/stability-eval/${path}`,
    ),
  ];
  const harness = Object.fromEntries(
    harnessFiles.map((path) => [path, digest(readFileSync(path))]),
  );
  for (const path of harnessFiles) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    cpSync(path, join(directory, path));
    mkdirSync(dirname(join(root, "harness", path)), { recursive: true });
    cpSync(path, join(root, "harness", path));
  }
  linkDependencies(
    join(source, "node_modules"),
    join(directory, "node_modules"),
  );
  const identity = {
    productCommit: BASELINE_PRODUCT_COMMIT,
    productTreeHash: digest(JSON.stringify(productFiles)),
    productFiles,
    harnessCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    harnessContentHash: digest(JSON.stringify(harness)),
    harnessFiles: harness,
    lockHash: digest(readFileSync(join(directory, "pnpm-lock.yaml"))),
  };
  writeVerifiedJson(join(root, "identity.json"), identity);
  try {
    execFileSync("pnpm", ["build"], { cwd: directory, stdio: "inherit" });
    execFileSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/accept-stability-baseline.ts",
        "--isolated-baseline",
        real ? "--authorize-real-model" : "--stub",
      ],
      {
        cwd: directory,
        stdio: "inherit",
        env: { ...process.env, STABILITY_EVAL_PATH: root },
      },
    );
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    writeVerifiedJson(join(root, "runner-failure.json"), {
      message: error instanceof Error ? error.message : String(error),
      preservedDirectory: directory,
    });
    process.exitCode = 1;
  }
} else {
  const root = process.env.STABILITY_EVAL_PATH;
  if (!root) throw new Error("Missing reserved archive");
  const identity = JSON.parse(
    readFileSync(join(root, "identity.json"), "utf8"),
  ) as {
    productCommit: string;
    productTreeHash: string;
    harnessContentHash: string;
    harnessCommit: string;
    harnessFiles: Record<string, string>;
    lockHash: string;
  };
  if (
    identity.productCommit !== BASELINE_PRODUCT_COMMIT ||
    identity.productTreeHash !== digest(JSON.stringify(treeHashes("src"))) ||
    identity.lockHash !== digest(readFileSync("pnpm-lock.yaml"))
  )
    throw new Error("隔离产品树或依赖锁与冻结版本不符");
  for (const [path, expected] of Object.entries(identity.harnessFiles))
    if (digest(readFileSync(path)) !== expected)
      throw new Error(`评估器内容已改变：${path}`);
  const { runFrozenBaselineSuite } = await import(
    "./lib/stability-eval/scenario.js"
  );
  const { computeStabilityMetrics } = await import(
    "./lib/stability-eval/metrics.js"
  );
  const { Gemini } = await import("../src/evolution/gemini.js");
  const manifest = freezeManifest(STABILITY_EVAL_MANIFEST);
  const evidenceKind = real ? "real-model" : "model-stub";
  const { records } = await runFrozenBaselineSuite({
    root,
    manifest,
    evidenceKind,
    harnessCommit: identity.harnessCommit,
    driverFactory: real
      ? () => new Gemini(process.env.GEMINI_API_KEY!)
      : undefined,
  });
  const summaryHash = writeVerifiedJson(join(root, "summary.json"), {
    schema: "cordis.stability-eval-baseline/2",
    evidenceKind,
    ...identity,
    contentHash: manifest.contentHash,
    records,
    metrics: computeStabilityMetrics(records),
  });
  writeFileSync(join(root, "summary.sha256"), summaryHash + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  if (
    records.length !== manifest.scenarios.length ||
    records.some((record) => !record.evidenceComplete)
  )
    process.exitCode = 1;
  console.log(
    JSON.stringify({
      root,
      evidenceKind,
      runs: records.length,
      outcomes: records.map((r) => ({
        scenario: r.scenarioId,
        outcome: r.observedOutcomeClass,
      })),
    }),
  );
}
