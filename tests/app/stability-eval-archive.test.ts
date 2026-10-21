import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reserveArchive,
  usageFromCalls,
  firstPlanResult,
  sealArchive,
  verifyArchive,
} from "../../scripts/lib/stability-eval/archive.js";
import { runStabilityScenario } from "../../scripts/lib/stability-eval/scenario.js";
import {
  freezeManifest,
  STABILITY_EVAL_MANIFEST,
} from "../../scripts/lib/stability-eval/manifest.js";
import { dependencyFault } from "../../scripts/lib/stability-eval/environment.js";
import { execFileSync } from "node:child_process";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";

test("证据处理异常覆盖已观察到的正确阻塞，保留原始终态且不得记为完整通过", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cordis-evidence-processing-"));
  const manifest = freezeManifest(currentManifest("a".repeat(40)));
  const scenario = manifest.scenarios.find(
    (s) => s.id === "missing-capability-push",
  )!;
  try {
    let reads = 0;
    const result = await runStabilityScenario({
      directory,
      scenario,
      manifest,
      evidenceKind: "model-stub",
      browserRun: async ({ app }) => {
        await app.request("/api/assistant/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "request",
            operationId: crypto.randomUUID(),
            text: scenario.request,
          }),
        });
        let status: string | undefined;
        for (let i = 0; i < 1000; i++) {
          status = (await (await app.request("/api/assistant")).json()).run
            ?.status;
          if (status === "blocked") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(status, "blocked");
        const observed = {
          status: "blocked-observed" as const,
          viewport: { width: 390, height: 844 },
          openedImprovePanel: true,
          recoveryEntryVisible: true,
          screenshot: "",
          pageErrors: [],
          observedRunStatus: "blocked",
        };
        // Fault at the public browser-result interface, during evidence projection.
        Object.defineProperty(observed, "confirmedPlan", {
          get() {
            if (++reads === 1)
              throw new Error("injected evidence processing failure");
            return false;
          },
        });
        return observed;
      },
    });
    assert.equal(result.record.observedOutcomeClass, "failed");
    assert.equal(result.record.evidenceComplete, false);
    assert.equal(result.record.failureClass, "evaluator");
    assert.equal(result.record.failure?.code, "evidence-processing-failed");
    assert.equal(result.record.terminal?.status, "blocked");
    assert.equal(result.record.fullPathSucceeded, false);
    assert.ok(existsSync(join(directory, "workspace.db")));
    assert.match(
      readFileSync(result.eventsPath, "utf8"),
      /injected evidence processing failure/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("预期完整路径成功的场景被真实规划门禁阻塞时，归档记为失败而非正确阻塞", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cordis-positive-blocked-"));
  const manifest = freezeManifest(currentManifest("a".repeat(40)));
  const scenario = manifest.scenarios.find((s) => s.id === "tags-add")!;
  assert.equal(scenario.expectedOutcomeClass, "full-path-success");
  try {
    const result = await runStabilityScenario({
      directory, scenario, manifest, evidenceKind: "model-stub",
      driver: { async generate() { return { text: "{}", history: [], calls: [], usage: {}, raw: {} }; } },
      browserRun: async ({ app }) => {
        await app.request("/api/assistant/commands", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ type: "request", operationId: crypto.randomUUID(), text: scenario.request }),
        });
        let status: string | undefined;
        for (let i = 0; i < 1000; i++) {
          status = (await (await app.request("/api/assistant")).json()).run?.status;
          if (status === "blocked") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(status, "blocked");
        return { status: "blocked-observed", viewport: { width: 390, height: 844 }, openedImprovePanel: true,
          recoveryEntryVisible: true, screenshot: "", pageErrors: [], observedRunStatus: "blocked" };
      },
    });
    assert.equal(result.record.terminal?.status, "blocked");
    assert.equal(result.record.evidenceComplete, true);
    assert.equal(result.record.fullPathSucceeded, false);
    assert.equal(result.record.observedOutcomeClass, "failed");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("归档封存后替换通过记录、删除证据或追加文件都会破坏身份", () => {
  const root = mkdtempSync(join(tmpdir(), "cordis-seal-"));
  try {
    writeFileSync(join(root, "record.json"), JSON.stringify({ passed: false }));
    const digest = sealArchive(root);
    assert.doesNotThrow(() => verifyArchive(root, digest));
    writeFileSync(join(root, "record.json"), JSON.stringify({ passed: true }));
    assert.throws(() => verifyArchive(root, digest), /归档|摘要/);
    writeFileSync(join(root, "record.json"), JSON.stringify({ passed: false }));
    writeFileSync(join(root, "extra.json"), "{}");
    assert.throws(() => verifyArchive(root, digest), /归档|文件/);
    rmSync(join(root, "extra.json"));
    rmSync(join(root, "record.json"));
    assert.throws(() => verifyArchive(root, digest), /归档|文件/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing archive is refused without changing historical content", () => {
  const root = mkdtempSync(join(tmpdir(), "cordis-archive-test-"));
  try {
    const path = join(root, "run");
    reserveArchive(path);
    writeFileSync(join(path, "sentinel"), "historical");
    assert.throws(() => reserveArchive(path), /EEXIST/);
    assert.equal(readFileSync(join(path, "sentinel"), "utf8"), "historical");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const archiveFails of [false, true])
  test(`browser exception archives evidence; archive failure preserves source: ${archiveFails}`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "cordis-archive-failure-"));
    try {
      const result = await runStabilityScenario({
        directory,
        scenario: STABILITY_EVAL_MANIFEST.scenarios[0],
        manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
        evidenceKind: "model-stub",
        browserRun: async () => {
          throw new Error("browser interrupted mid-run");
        },
        ...(archiveFails
          ? {
              archive: () => {
                throw new Error("disk full");
              },
            }
          : {}),
      });
      assert.equal(result.record.observedOutcomeClass, "failed");
      assert.equal(result.record.usage, null);
      assert.equal(existsSync(join(directory, "workspace.db")), true);
      assert.equal(result.record.evidenceComplete, false);
      const events = readFileSync(result.eventsPath, "utf8");
      assert.match(events, /formal-fingerprint-after/);
      assert.match(events, /"type":"calls"/);
      if (archiveFails) assert.match(events, /archive-error/);
      else {
        const evidence = JSON.parse(
          readFileSync(join(directory, "workspace-evidence.json"), "utf8"),
        );
        assert.ok(evidence.database.evolution_calls);
        assert.ok(evidence.database.evolution_runs);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

test("partial usage is unknown and thinking tokens are included", () => {
  assert.deepEqual(
    usageFromCalls([
      { usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } },
    ]),
    { promptTokens: 8, completionTokens: 5 },
  );
  assert.equal(usageFromCalls([{ usage: null }]), null);
  assert.equal(
    usageFromCalls([
      { usage: { promptTokens: 2, completionTokens: 3 } },
      { usage: null },
    ]),
    null,
  );
  assert.deepEqual(
    usageFromCalls([
      {
        usage: {
          promptTokenCount: 2,
          candidatesTokenCount: 3,
          thoughtsTokenCount: 4,
        },
      },
    ]),
    { promptTokens: 2, completionTokens: 7 },
  );
  assert.deepEqual(
    usageFromCalls([{ usage: { promptTokenCount: 5, totalTokenCount: 5 } }]),
    { promptTokens: 5, completionTokens: 0 },
  );
  assert.equal(
    usageFromCalls([{ usage: { promptTokenCount: 5, totalTokenCount: 6 } }]),
    null,
  );
});

test("first-plan metric counts rejected proposals rather than eventual confirmation", () => {
  const proposal = {
    response: {
      candidates: [
        { content: { parts: [{ functionCall: { name: "propose_plan" } }] } },
      ],
    },
  };
  assert.equal(firstPlanResult([], false, false), null);
  assert.equal(firstPlanResult([proposal], true, false), true);
  assert.equal(firstPlanResult([proposal, proposal], true, false), false);
  const deepseek = {
    response: {
      choices: [
        { message: { tool_calls: [{ function: { name: "propose_plan" } }] } },
      ],
    },
  };
  assert.equal(firstPlanResult([deepseek], true, false), true);
  assert.equal(firstPlanResult([deepseek, deepseek], true, false), false);
});

test("dependency fault is real and the original environment stays healthy", () => {
  const original = process.cwd();
  const directory = mkdtempSync(join(tmpdir(), "cordis-env-test-"));
  const fault = dependencyFault(directory);
  try {
    assert.throws(() =>
      execFileSync(
        process.execPath,
        ["-e", "require.resolve('@types/node/package.json')"],
        { stdio: "pipe" },
      ),
    );
  } finally {
    fault.restore();
    rmSync(directory, { recursive: true, force: true });
  }
  assert.equal(process.cwd(), original);
  assert.doesNotThrow(() =>
    execFileSync(
      process.execPath,
      ["-e", "require.resolve('@types/node/package.json')"],
      { stdio: "pipe" },
    ),
  );
});

test("setup failure restores the dependency environment and retains a failed run", async () => {
  const { mkdirSync } = await import("node:fs");
  const directory = mkdtempSync(join(tmpdir(), "cordis-setup-failure-"));
  const original = process.cwd();
  mkdirSync(join(directory, "workspace.db"));
  try {
    const result = await runStabilityScenario({
      directory,
      scenario: STABILITY_EVAL_MANIFEST.scenarios[6],
      manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
      evidenceKind: "model-stub",
    });
    assert.equal(process.cwd(), original);
    assert.equal(result.record.observedOutcomeClass, "failed");
    assert.equal(result.record.evidenceComplete, false);
    assert.match(
      readFileSync(result.eventsPath, "utf8"),
      /setup-or-finalization-error/,
    );
    assert.ok(existsSync(join(directory, "workspace.db")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("archive failure takes precedence over a genuine blocked run", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cordis-blocked-archive-"));
  try {
    const result = await runStabilityScenario({
      directory,
      scenario: STABILITY_EVAL_MANIFEST.scenarios[5],
      manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
      evidenceKind: "model-stub",
      browserRun: async ({ app }) => {
        await app.request("/api/assistant/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "request",
            operationId: crypto.randomUUID(),
            text: STABILITY_EVAL_MANIFEST.scenarios[5].request,
          }),
        });
        let status: string | undefined;
        for (let i = 0; i < 100; i++) {
          status = (await (await app.request("/api/assistant")).json()).run
            ?.status;
          if (status === "blocked") break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.equal(status, "blocked");
        return {
          status: "blocked-observed",
          viewport: { width: 390, height: 844 },
          openedImprovePanel: true,
          recoveryEntryVisible: true,
          screenshot: "",
          pageErrors: [],
          observedRunStatus: "blocked",
        };
      },
      archive: () => {
        throw new Error("disk full");
      },
    });
    assert.equal(result.record.observedOutcomeClass, "failed");
    assert.equal(result.record.errorBlockingCorrect, false);
    assert.equal(result.record.failureClass, "evaluator");
    assert.ok(existsSync(join(directory, "workspace.db")));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("browser timeout while the model is still active is an evaluator failure", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cordis-active-timeout-"));
  try {
    const result = await runStabilityScenario({
      directory,
      scenario: STABILITY_EVAL_MANIFEST.scenarios[0],
      manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
      evidenceKind: "model-stub",
      driver: {
        generate: (_request, signal) =>
          new Promise((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            }),
          ),
      },
      browserRun: async ({ app }) => {
        await app.request("/api/assistant/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "request",
            operationId: crypto.randomUUID(),
            text: "添加标签",
          }),
        });
        return {
          status: "failed",
          message: "Playwright timeout",
          viewport: { width: 390, height: 844 },
          openedImprovePanel: true,
          recoveryEntryVisible: false,
          screenshot: "",
          pageErrors: [],
        };
      },
    });
    assert.equal(result.record.failureClass, "evaluator");
    const events = readFileSync(result.eventsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(
      events.find((event) => event.type === "before-shutdown").snapshot.run
        .status,
      "planning",
    );
    assert.equal(result.record.evidenceComplete, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("截图取证失败单独记录并保留数据库", async () => {
  const directory = mkdtempSync(join(tmpdir(), "cordis-screenshot-failure-"));
  try {
    const result = await runStabilityScenario({
      directory,
      scenario: STABILITY_EVAL_MANIFEST.scenarios[0],
      manifest: freezeManifest(STABILITY_EVAL_MANIFEST),
      evidenceKind: "model-stub",
      browserRun: async () => ({
        status: "failed",
        viewport: { width: 390, height: 844 },
        openedImprovePanel: true,
        recoveryEntryVisible: false,
        screenshot: "",
        pageErrors: [],
        message: "original browser failure",
        evidenceErrors: ["screenshot disk full"],
        cleanupErrors: ["browser close failed"],
      }),
    });
    assert.equal(result.record.evidenceComplete, false);
    assert.equal(existsSync(join(directory, "workspace.db")), true);
    const events = readFileSync(result.eventsPath, "utf8");
    assert.match(events, /original browser failure/);
    assert.match(events, /screenshot disk full/);
    assert.match(events, /browser close failed/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
