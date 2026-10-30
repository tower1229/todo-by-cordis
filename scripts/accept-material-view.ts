import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { hash } from "../src/release/storage.js";
import type { ModelRequest } from "../src/evolution/driver.js";
import { Workspace } from "../src/server/workspace.js";
import { EvolutionDomain } from "../src/server/evolution-domain.js";
import { runStabilityScenario } from "./lib/stability-eval/scenario.js";
import {
  stabilityDriverFor,
  materialExperimentStubDriver,
} from "./lib/stability-eval/driver-fixture.js";
import { runStabilityBrowserPath } from "./lib/stability-eval/browser.js";
import {
  writeVerifiedJson,
  sealArchive,
} from "./lib/stability-eval/archive.js";
import { redactSensitive } from "./lib/shortened-real-model.js";
import {
  materialExperimentManifest,
  freezeMaterialExperiment,
  assertMaterialExperiment,
  configureMaterialArm,
  measureFlow,
  evaluateMaterialPair,
  type MaterialExperiment,
  type MaterialResult,
} from "./lib/stability-eval/material-experiment.js";
import type { AssistantEvent } from "../src/shared/assistant.js";

// Preparation has no provider route or credential loading. Paid execution remains a later, gated action.
if (process.argv.some((arg) => /authorize-real|api-key|allow-dirty/.test(arg)))
  throw new Error(
    "此入口仅允许零付费准备；真实执行须另行确认固定提交、CI和第一对24次授权",
  );
const arg = (name: string) =>
  process.argv
    .find((value) => value.startsWith(name + "="))
    ?.slice(name.length + 1);
const directory = resolve(
  arg("--output") ?? ".runtime/material-view-preparation",
);
const prepare = process.argv.includes("--prepare-only");
if (!prepare && !process.argv.includes("--stub"))
  throw new Error("显式选择 --prepare-only 或 --stub");
const json = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const fileHash = (path: string) => hash(readFileSync(path).toString("base64"));
function files(root: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    readdirSync(join(root, prefix), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const name = join(prefix, entry.name);
        if (entry.isSymbolicLink()) throw new Error("冻结目录拒绝符号链接");
        return entry.isDirectory()
          ? Object.entries(files(root, name))
          : [[name, fileHash(join(root, name))]];
      }),
  );
}
function sourceFiles() {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard"],
    { encoding: "utf8" },
  )
    .trim()
    .split("\n");
  return Object.fromEntries(
    [...new Set(paths)]
      .filter(
        (p) =>
          /^(src|scripts|tests)\//.test(p) ||
          [
            "pnpm-lock.yaml",
            "package.json",
            "tsconfig.json",
            "tsconfig.server.json",
            "tsconfig.evaluation.json",
            "vite.config.ts",
            "playwright.config.ts",
            "index.html",
          ].includes(p),
      )
      .sort()
      .map((p) => [p, fileHash(p)]),
  );
}
const save = (name: string, value: unknown) =>
  writeVerifiedJson(join(directory, name), value);
const executionEnvironment = () => ({
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  frontendFiles: files("dist/web"),
});
if (prepare) {
  if (existsSync(directory))
    throw new Error("准备目录必须为新目录，不能覆盖既有证据");
  const baseline = arg("--baseline");
  if (!baseline) throw new Error("缺少 --baseline=已封存的业务基线目录");
  const original = resolve(baseline),
    before = files(original);
  mkdirSync(directory, { recursive: true });
  cpSync(original, join(directory, "baseline"), {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  const w = await Workspace.open(join(directory, "baseline/workspace.db"));
  let baselineIdentity: unknown;
  try {
    if (
      w.db
        .prepare("SELECT name FROM sqlite_master WHERE name='evolution_runs'")
        .get()
    )
      throw new Error("基线不能携带旧运行或待执行冻结");
    const domain = new EvolutionDomain(w),
      context = domain.context();
    const inspected = domain.read("inspect_application", {}, context, []);
    if (
      !("ref" in inspected) ||
      !inspected.documents?.some(
        (doc) => doc.source?.ref === "active-acceptance",
      )
    )
      throw new Error("基线没有可靠业务视图，不能建立有效对照");
    baselineIdentity = {
      composition: w.composition(),
      documents: Object.fromEntries(
        Object.entries(context.files).map(([ref, value]) => [ref, value.hash]),
      ),
      view: inspected.documents.find((doc) => doc.source),
      tasks: w.query(),
      environment: context.environment,
    };
  } finally {
    await w.close();
  }
  if (hash(before) !== hash(files(original)))
    throw new Error("准备过程改变了原基线");
  const baselineFiles = files(join(directory, "baseline"));
  save("baseline-identity.json", baselineIdentity);
  const ledgerPath = resolve(
    arg("--ledger") ??
      ".runtime/counter-path-real-awsdzznz/paid-evidence/ledger.json",
  );
  const ledger = json<{ baseCumulative: number; calls: { ordinal: number }[] }>(
    ledgerPath,
  );
  if (
    ledger.baseCumulative !== 130 ||
    ledger.calls.length !== 4 ||
    ledger.calls.some((call, i) => call.ordinal !== 131 + i)
  )
    throw new Error("付费台账与134次基数不符，先重新核账");
  const manifest = materialExperimentManifest(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  );
  const sources = sourceFiles();
  const preflight = {
    ledgerPath,
    ledgerHash: fileHash(ledgerPath),
    originalBaseline: original,
    originalBaselineFiles: before,
    executionEnvironment: executionEnvironment(),
  };
  const experiment = freezeMaterialExperiment({
    manifest,
    baselineHash: hash(baselineFiles),
    baselineDirectory: join(directory, "baseline"),
    sourceHash: hash(sources),
    preflightHash: hash(preflight),
    baseCumulative: 134,
    globalLimit: 234,
  });
  save("baseline-files.json", baselineFiles);
  save("source-files.json", sources);
  save("experiment.frozen.json", experiment);
  save("preparation.json", {
    mode: "zero-paid-only",
    sourceCommit: manifest.productCommit,
    dirty: !!execFileSync("git", ["status", "--porcelain"], {
      encoding: "utf8",
    }).trim(),
    ...preflight,
    paidCalls: 0,
    paidExecutionReady: false,
    firstPair: {
      maximumCalls: 24,
      cumulativeCeiling: 158,
      authorization: null,
      required: [
        "fixed clean commit matching source/harness hashes",
        "CI for exact commit",
        "explicit human confirmation of first pair only",
      ],
    },
    secondPair: { maximumCalls: 24, automatic: false },
    metrics: {
      primary: "sum actual prompt_tokens across every attempt; cache included",
      requestBytes: "UTF8 encoded JSON handed to HTTP, not provider receipt",
      unknownUsage: "unknown, never zero",
      timing:
        "whole wall and host active separately; model/check/browser intervals overlap",
      failureRate:
        "failed/started, started/4 and unrun listed; no population-rate claim",
    },
  });
  console.log(
    JSON.stringify({
      mode: "prepared",
      directory,
      experimentHash: experiment.contentHash,
      paidCalls: 0,
      paidExecutionReady: false,
    }),
  );
} else {
  const experiment = json<MaterialExperiment>(
    join(directory, "experiment.frozen.json"),
  );
  assertMaterialExperiment(experiment);
  const prepared = json<{
    ledgerPath: string;
    ledgerHash: string;
    originalBaseline: string;
    originalBaselineFiles: Record<string, string>;
    executionEnvironment: ReturnType<typeof executionEnvironment>;
  }>(join(directory, "preparation.json"));
  const frozenSources = json<Record<string, string>>(
    join(directory, "source-files.json"),
  );
  const baselineIdentity = json<{
    composition: { versionId: string };
    documents: Record<string, string>;
  }>(join(directory, "baseline-identity.json"));
  const integrity = () => {
    const {
      ledgerPath,
      ledgerHash,
      originalBaseline,
      originalBaselineFiles,
      executionEnvironment: environment,
    } = prepared;
    if (
      hash({
        ledgerPath,
        ledgerHash,
        originalBaseline,
        originalBaselineFiles,
        executionEnvironment: environment,
      }) !== experiment.preflightHash
    )
      throw new Error("预检、环境或台账的冻结身份不一致");
    if (hash(executionEnvironment()) !== hash(prepared.executionEnvironment))
      throw new Error("运行环境或实际前端产物在冻结后变化");
    if (
      hash(sourceFiles()) !== experiment.sourceHash ||
      hash(frozenSources) !== experiment.sourceHash
    )
      throw new Error("产品或评测器冻结后发生变化");
    if (hash(files(experiment.baselineDirectory)) !== experiment.baselineHash)
      throw new Error("冻结基线发生变化");
    if (fileHash(prepared.ledgerPath) !== prepared.ledgerHash)
      throw new Error("台账发生变化");
    if (
      hash(files(prepared.originalBaseline)) !==
      hash(prepared.originalBaselineFiles)
    )
      throw new Error("原始基线发生变化");
  };
  const results: MaterialResult[] = [];
  let stop: string | undefined;
  for (const trial of experiment.trials) {
    let started = false;
    try {
      integrity();
      const trialDirectory = join(directory, trial.trialId);
      if (existsSync(trialDirectory))
        throw new Error("预注册运行已存在，禁止重跑");
      cpSync(experiment.baselineDirectory, trialDirectory, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
      started = true;
      let browserJourneyMs = 0;
      const delegate = stabilityDriverFor(
        "counter-add",
        experiment.manifest.scenarios[0],
      );
      const wireCalls: { request: ModelRequest; body: unknown }[] = [];
      const driver = materialExperimentStubDriver(delegate, (value) => {
        wireCalls.push(value);
        writeFileSync(
          join(trialDirectory, "wire-requests.jsonl"),
          JSON.stringify(redactSensitive(value)) + "\n",
          { flag: "a", mode: 0o600 },
        );
      });
      const result = await runStabilityScenario({
        directory: trialDirectory,
        scenario: experiment.manifest.scenarios[0],
        manifest: experiment.manifest,
        evidenceKind: "model-stub",
        driver,
        trialId: trial.trialId,
        retainWorkspace: true,
        configureDomain: (domain) => {
          const actual = domain.context();
          if (
            actual.versionId !== baselineIdentity.composition.versionId ||
            actual.files["active-acceptance"].hash !==
              baselineIdentity.documents["active-acceptance"]
          )
            throw new Error("评测准备改变了冻结业务基线，禁止调用模型");
          configureMaterialArm(domain, trial.arm);
        },
        browserRun: async (input) => {
          const at = performance.now();
          try {
            return await runStabilityBrowserPath(input);
          } finally {
            browserJourneyMs = performance.now() - at;
          }
        },
      });
      writeVerifiedJson(
        join(trialDirectory, "wire-requests.json"),
        redactSensitive(wireCalls),
      );
      const db = new DatabaseSync(join(trialDirectory, "workspace.db"), {
        readOnly: true,
      });
      let measurement: ReturnType<typeof measureFlow>;
      try {
        const calls = db
          .prepare("SELECT body FROM evolution_calls ORDER BY id")
          .all()
          .map(
            (r) =>
              JSON.parse(String(r.body)) as Parameters<
                typeof measureFlow
              >[0]["calls"][number],
          );
        const events = db
          .prepare("SELECT body FROM evolution_events ORDER BY id")
          .all()
          .map((r) => JSON.parse(String(r.body)) as AssistantEvent);
        const timed = readFileSync(join(trialDirectory, "events.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map(
            (line) =>
              JSON.parse(line) as {
                type: string;
                phase?: string;
                durationMs?: number;
              },
          );
        measurement = measureFlow({
          durationMs: result.record.durationMs,
          activeMilliseconds: result.record.resources?.activeMilliseconds,
          browserJourneyMs,
          calls,
          events,
          independentBrowserMs: timed
            .filter(
              (e) => e.type === "timing" && e.phase === "independent-browser",
            )
            .reduce((sum, e) => sum + (e.durationMs ?? 0), 0),
        });
        writeVerifiedJson(
          join(trialDirectory, "measurement.json"),
          measurement,
        );
        const rows = db
          .prepare(
            "SELECT body FROM evolution_runs ORDER BY rowid DESC LIMIT 1",
          )
          .get();
        const run = rows
          ? (JSON.parse(String(rows.body)) as {
              investigation: {
                deliveries: {
                  materials: { source?: unknown; ref: string }[];
                }[];
              };
            })
          : undefined;
        const delivered =
          run?.investigation.deliveries.flatMap((d) => d.materials) ?? [];
        if (trial.arm === "view" && !delivered.some((d) => d.source))
          throw new Error("B组没有实际交付视图");
        if (trial.arm === "raw" && delivered.some((d) => d.source))
          throw new Error("A组混入视图");
        writeVerifiedJson(join(trialDirectory, "exposure.json"), {
          arm: trial.arm,
          delivered,
          wireCalls: wireCalls.length,
        });
      } finally {
        db.close();
      }
      results.push({
        trialId: trial.trialId,
        arm: trial.arm,
        evidenceKind: "model-stub",
        passed:
          result.record.fullPathSucceeded &&
          result.record.evidenceComplete === true,
        metrics: measurement,
      });
      integrity();
      if (!results.at(-1)!.passed) {
        stop = "run-failed-or-budget-paused";
        break;
      }
      if (measurement.input.requestBodyBytes === null) {
        stop = "request-measurement-missing";
        break;
      }
    } catch (error) {
      stop = error instanceof Error ? error.message : String(error);
      if (started && !results.some((r) => r.trialId === trial.trialId))
        results.push({
          trialId: trial.trialId,
          arm: trial.arm,
          evidenceKind: "model-stub",
          passed: false,
          metrics: null,
        });
      writeFileSync(
        join(directory, `${trial.trialId}-failure.json`),
        JSON.stringify({ trial, started, stop, paidCalls: 0 }, null, 2),
        { flag: "wx" },
      );
      break;
    }
  }
  const report = {
    mode: "model-stub",
    paidCalls: 0,
    experimentHash: experiment.contentHash,
    results,
    assessment: evaluateMaterialPair(experiment, results),
    stop: stop ?? null,
    realBenefitClaim: false,
    paidExecutionReady: false,
  };
  save("rehearsal.json", report);
  const archiveHash = sealArchive(directory);
  console.log(
    JSON.stringify({
      mode: "rehearsed",
      directory,
      completed: results.length,
      passed: results.filter((r) => r.passed).length,
      stop: stop ?? null,
      archiveHash,
      paidCalls: 0,
    }),
  );
  if (stop || results.length !== 4 || results.some((r) => !r.passed))
    process.exitCode = 1;
}
