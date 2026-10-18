import { execFileSync, spawnSync } from "node:child_process";
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
  sealArchive,
  verifyArchive,
} from "./lib/stability-eval/archive.js";
import { linkDependencies } from "./lib/stability-eval/environment.js";
import { assertRealModelAuthorization } from "./lib/stability-eval/authorization.js";
import { postchangeManifest } from "./lib/stability-eval/postchange.js";
import { currentManifest } from "./lib/stability-eval/current.js";
import { evaluateSuite } from "./lib/stability-eval/report.js";
import { browserEnvironment } from "../src/server/browser-acceptance.js";
import { createRequire } from "node:module";

const postchange = process.argv.includes("--postchange");
const current = process.argv.includes("--current");
const prepare = process.argv.includes("--prepare-only");
const real =
  process.argv.includes("--authorize-real-model") &&
  !process.argv.includes("--stub");
if (process.env.STABILITY_CONTINUATION_ROOT)
  process.env.STABILITY_CONTINUATION_ROOT = resolve(
    process.env.STABILITY_CONTINUATION_ROOT,
  );
const child = process.argv.includes("--isolated-baseline");
if (process.argv.some((arg) => arg.startsWith("--allow-dirty")))
  throw new Error("基线不允许跳过产品版本检查；请使用自动隔离运行入口");
if (real) assertRealModelAuthorization(process.argv);
if (prepare && !current) throw new Error("--prepare-only 只用于当前版本清单");
if (current && postchange) throw new Error("当前版本与历史后测不能混用");
if (prepare && real) throw new Error("准备模式禁止真实模型授权标记");
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
  if (
    (postchange || (current && real)) &&
    execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim()
  )
    throw new Error("真实当前评测及历史后测必须从干净提交运行");
  if (
    current &&
    execFileSync("git", ["diff", "HEAD", "--", "src", "pnpm-lock.yaml"], {
      encoding: "utf8",
    }).trim()
  )
    throw new Error("当前产品源码和依赖锁须与固定提交一致，评测器改动单独冻结");
  const productCommit =
    postchange || current
      ? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()
      : BASELINE_PRODUCT_COMMIT;
  const root = resolve(
    process.env.STABILITY_EVAL_PATH ??
      join(
        current
          ? ".runtime/stability-current"
          : postchange
            ? "docs/reports/issue-46-postchange"
            : "docs/reports/issue-37-baseline",
        `${real ? "real" : "stub"}-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      ),
  );
  reserveArchive(root);
  if (real && existsSync(".env")) process.loadEnvFile(".env");
  if (real && !process.env.DEEPSEEK_API_KEY?.trim())
    throw new Error("DEEPSEEK_API_KEY is not configured");
  const source = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "cordis-baseline-product-"));
  const archiveDirectory = mkdtempSync(
    join(tmpdir(), "cordis-product-archive-"),
  );
  const archivePath = join(archiveDirectory, "product.tar");
  try {
    execFileSync("git", ["archive", productCommit, "--output", archivePath]);
    execFileSync("tar", ["-xf", archivePath, "-C", directory]);
  } finally {
    rmSync(archiveDirectory, { recursive: true, force: true });
  }
  const productFiles = treeHashes(join(directory, "src"));
  const harnessFiles = [
    "scripts/accept-stability-baseline.ts",
    "scripts/lib/shortened-real-model.ts",
    "tsconfig.evaluation.json",
    "tests/app/dual-composition-fixture.ts",
    "tests/app/planning-fixture.ts",
    "tests/app/evolution-fixture.ts",
    "tests/app/evolution-adapter.ts",
    "tests/app/member-case-fixtures.ts",
    "tests/fixtures/member-ui.ts",
    "tests/fixtures/aux-workflow.mjs",
    "tests/fixtures/tags-plugin.mjs",
    "tests/fixtures/due-plugin.mjs",
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
    productCommit,
    productTreeHash: digest(JSON.stringify(productFiles)),
    productFiles,
    harnessCommit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    harnessDirty: !!execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
    harnessContentHash: digest(JSON.stringify(harness)),
    harnessFiles: harness,
    lockHash: digest(readFileSync(join(directory, "pnpm-lock.yaml"))),
  };
  writeVerifiedJson(join(root, "identity.json"), identity);
  try {
    execFileSync("pnpm", ["build"], { cwd: directory, stdio: "inherit" });
    const childResult = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/accept-stability-baseline.ts",
        "--isolated-baseline",
        ...(postchange ? ["--postchange"] : []),
        ...(current ? ["--current"] : []),
        ...(prepare ? ["--prepare-only"] : []),
        real ? "--authorize-real-model" : "--stub",
      ],
      {
        cwd: directory,
        stdio: "inherit",
        env: { ...process.env, STABILITY_EVAL_PATH: root },
      },
    );
    if (childResult.error) throw childResult.error;
    if (childResult.status !== 0) {
      const summaryPath = join(root, "summary.json");
      if (!existsSync(summaryPath))
        throw new Error(
          `隔离评测异常结束：${childResult.signal ?? childResult.status}`,
        );
      const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
        verdict?: { exitCode: number };
      };
      if (summary.verdict?.exitCode !== childResult.status)
        throw new Error("评测退出状态与封存结论不一致");
      verifyArchive(
        root,
        digest(readFileSync(join(root, "archive-index.json"))),
      );
      process.exitCode = childResult.status;
    }
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    writeVerifiedJson(join(root, "runner-failure.json"), {
      message: error instanceof Error ? error.message : String(error),
      preservedDirectory: directory,
    });
    process.exitCode = 2;
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
    (!postchange &&
      !current &&
      identity.productCommit !== BASELINE_PRODUCT_COMMIT) ||
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
  const { DeepSeek } = await import("../src/evolution/deepseek.js");
  const manifest = freezeManifest(
    current
      ? currentManifest(identity.productCommit)
      : postchange
        ? postchangeManifest(identity.productCommit)
        : STABILITY_EVAL_MANIFEST,
  );
  if (current) {
    const environment = browserEnvironment();
    if (environment.missing.length)
      throw new Error(`当前评测环境缺失：${environment.missing.join("；")}`);
    const require = createRequire(import.meta.url);
    cpSync(resolve("dist/web"), join(root, "frontend"), {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    writeVerifiedJson(join(root, "environment.frozen.json"), {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      typescript: require("typescript/package.json").version,
      playwright: require("playwright/package.json").version,
      browser: {
        ...environment,
        executableHash: digest(readFileSync(environment.executable)),
      },
      frontendFiles: treeHashes(resolve("dist/web")),
      budget: manifest.budget,
      outputPolicies: manifest.model.outputPolicies,
      externalRetries: 0,
      productionDatabaseAccess: false,
    });
  }
  if (prepare) {
    writeVerifiedJson(join(root, "manifest.frozen.json"), manifest);
    writeVerifiedJson(join(root, "prepared.json"), {
      status: "prepared",
      apiCalls: 0,
      expectedTrials:
        manifest.scenarios.length * manifest.runs.independentRunsPerScenario,
      executionComplete: false,
      acceptancePassed: null,
    });
    const archiveHash = sealArchive(root);
    verifyArchive(root, archiveHash);
    console.log(
      JSON.stringify({ root, status: "prepared", apiCalls: 0, archiveHash }),
    );
  } else {
    const evidenceKind = real ? "real-model" : "model-stub";
    const { records } = await runFrozenBaselineSuite({
      root,
      manifest,
      evidenceKind,
      harnessCommit: identity.harnessCommit,
      continuationRoot: process.env.STABILITY_CONTINUATION_ROOT,
      driverFactory: real
        ? () => new DeepSeek(process.env.DEEPSEEK_API_KEY!)
        : undefined,
    });
    const verdict = evaluateSuite(manifest, records);
    const integrity = {
      productUnchanged:
        identity.productTreeHash === digest(JSON.stringify(treeHashes("src"))),
      lockUnchanged:
        identity.lockHash === digest(readFileSync("pnpm-lock.yaml")),
      harnessUnchanged: Object.entries(identity.harnessFiles).every(
        ([file, d]) => digest(readFileSync(file)) === d,
      ),
      frontendUnchanged:
        !current ||
        JSON.stringify(treeHashes("dist/web")) ===
          JSON.stringify(treeHashes(join(root, "frontend"))),
    };
    writeVerifiedJson(join(root, "integrity.json"), integrity);
    if (!Object.values(integrity).every(Boolean)) {
      verdict.executionComplete = false;
      verdict.acceptancePassed = false;
      verdict.exitCode = 2;
      verdict.accountingErrors.push(
        "运行期间产品、评测器、依赖锁或前端产物变化",
      );
    }
    const summaryHash = writeVerifiedJson(join(root, "summary.json"), {
      schema: current
        ? "cordis.stability-eval-current/1"
        : postchange
          ? "cordis.stability-eval-postchange/1"
          : "cordis.stability-eval-baseline/2",
      evidenceKind,
      ...identity,
      contentHash: manifest.contentHash,
      records,
      metrics: computeStabilityMetrics(records),
      verdict,
    });
    writeFileSync(join(root, "summary.sha256"), summaryHash + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    process.exitCode = verdict.exitCode;
    const archiveHash = sealArchive(root);
    verifyArchive(root, archiveHash);
    console.log(
      JSON.stringify({
        root,
        evidenceKind,
        runs: records.length,
        executionComplete: verdict.executionComplete,
        acceptancePassed: verdict.acceptancePassed,
        archiveHash,
        outcomes: records.map((r) => ({
          scenario: r.scenarioId,
          outcome: r.observedOutcomeClass,
        })),
      }),
    );
  }
}
