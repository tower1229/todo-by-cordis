import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../../src/server/workspace.js";
import { Evolution } from "../../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../../src/server/evolution-domain.js";
import { ExperienceSessionHost } from "../../../src/server/experience-session.js";
import { createApp } from "../../../src/server/app.js";
import type { Driver } from "../../../src/evolution/driver.js";
import { activateDual } from "../../../tests/app/dual-composition-fixture.js";
import { redactSensitive } from "../shortened-real-model.js";
import {
  type FrozenManifest,
  type StabilityScenario,
  assertManifestFrozen,
} from "./manifest.js";
import {
  classifyFailure,
  type ObservedOutcomeClass,
  type ScenarioRunRecord,
} from "./metrics.js";
import {
  experienceBindingsFor,
  runStabilityBrowserPath,
  type BrowserPathResult,
} from "./browser.js";
import {
  scoreCapabilityAndBlocking,
  type SettledPlanEvidence,
} from "./scoring.js";
import { stabilityDriverFor } from "./driver-fixture.js";

export type StabilityRunOptions = {
  directory: string;
  scenario: StabilityScenario;
  manifest: FrozenManifest;
  evidenceKind: "model-stub" | "real-model";
  driver?: Driver;
  clarificationAnswer?: string;
};

export type StabilityScenarioResult = {
  record: ScenarioRunRecord;
  eventsPath: string;
  preservedDirectory: string;
};

function clarificationFor(scenario: StabilityScenario): string | undefined {
  if (scenario.id === "due-auto-expire") return "坚持完整能力，等待维护者补齐";
  if (scenario.id === "missing-capability-push")
    return "坚持完整外部推送与离线送达";
  return undefined;
}

async function prepareWorkspace(scenario: StabilityScenario, directory: string) {
  const w = await Workspace.open(join(directory, "workspace.db"));
  if (scenario.id === "member-upgrade-tags") await activateDual(w);
  await w.command({
    type: "create",
    operationId: randomUUID(),
    compositionRevision: w.composition().revision,
    title: "稳定性评估保留任务",
  });
  return w;
}

function observeOutcome(
  scenario: StabilityScenario,
  browserStatus: string,
  runStatus: string | undefined,
): ObservedOutcomeClass {
  if (
    scenario.expectedOutcomeClass === "current-blocker" &&
    (browserStatus === "blocked-observed" || runStatus === "blocked")
  )
    return "current-blocker";
  if (
    scenario.expectedOutcomeClass === "accurate-block" &&
    (browserStatus === "blocked-observed" || runStatus === "blocked")
  )
    return "accurate-block";
  if (
    browserStatus === "passed" &&
    (runStatus === "succeeded" ||
      (!scenario.requiresApply && runStatus === "awaiting-apply"))
  )
    return "full-path-success";
  return "failed";
}

export async function runStabilityScenario(
  options: StabilityRunOptions,
): Promise<StabilityScenarioResult> {
  assertManifestFrozen(options.manifest);

  const eventsPath = join(options.directory, "events.jsonl");
  writeFileSync(eventsPath, "", { flag: "wx", mode: 0o600 });
  const recordEvent = (event: Record<string, unknown>) => {
    writeFileSync(
      eventsPath,
      `${JSON.stringify(redactSensitive({ at: new Date().toISOString(), ...event }))}\n`,
      { flag: "a", mode: 0o600 },
    );
  };

  const started = Date.now();
  const driver =
    options.driver ??
    (options.evidenceKind === "model-stub"
      ? stabilityDriverFor(options.scenario.id)
      : undefined);
  if (!driver) throw new Error("真实模型运行必须显式传入已授权 Driver");

  recordEvent({
    type: "header",
    schema: "cordis.stability-eval-run/1",
    evidenceKind: options.evidenceKind,
    scenarioId: options.scenario.id,
    request: options.scenario.request,
    expectedOutcomeClass: options.scenario.expectedOutcomeClass,
    productCommit: options.manifest.productCommit,
    sourceCommit: options.manifest.productCommit,
    contentHash: options.manifest.contentHash,
    budget: options.manifest.budget,
    retry: options.manifest.retry,
    model:
      options.evidenceKind === "model-stub"
        ? options.manifest.model.stubKind
        : options.manifest.model.realModelId,
  });

  let w = await prepareWorkspace(options.scenario, options.directory);
  const sessions = new ExperienceSessionHost(w);
  const evolution = new Evolution(
    w.db,
    driver,
    new EvolutionDomain(w),
    sessions,
    options.manifest.budget,
  );
  const app = createApp(w, evolution, sessions);
  const formalBefore = {
    compositionRevision: w.composition().revision,
    versionId: w.composition().versionId,
    taskTotal: w.query().total,
  };
  recordEvent({ type: "formal-fingerprint-before", fingerprint: formalBefore });

  let browserResult: BrowserPathResult | undefined;
  let runStatus: string | undefined;
  let firstCandidatePassed: boolean | null = null;
  let repairedInOriginalBudget = false;
  let failureMessage: string | undefined;
  let usage: ScenarioRunRecord["usage"] = null;
  let blockReason: string | undefined;
  let settledMessage: string | undefined;
  let planEvidence: SettledPlanEvidence | null = null;

  try {
    browserResult = await runStabilityBrowserPath({
      app,
      directory: options.directory,
      scenario: options.scenario,
      clarificationAnswer:
        options.clarificationAnswer ?? clarificationFor(options.scenario),
      bindings: experienceBindingsFor(options.scenario.id),
    });
    const snapshot = await evolution.observe();
    runStatus = snapshot.run?.status;
    blockReason =
      snapshot.run && "blockReason" in snapshot.run
        ? String(snapshot.run.blockReason ?? "")
        : undefined;
    settledMessage =
      snapshot.run && "message" in snapshot.run
        ? String(snapshot.run.message ?? "")
        : undefined;
    if (snapshot.run && "plan" in snapshot.run && snapshot.run.plan) {
      planEvidence = {
        summary: snapshot.run.plan.summary,
        unresolved: snapshot.run.plan.unresolved,
        capabilityChanges: snapshot.run.plan.capabilityChanges?.map((c) => ({
          capability: c.capability,
          provider: c.provider,
          change: c.change,
        })),
      };
    } else {
      // After apply, observe().run.plan is cleared; recover from persisted RecordRun.plan.
      const row = w.db
        .prepare("SELECT body FROM evolution_runs ORDER BY rowid DESC LIMIT 1")
        .get() as { body: string } | undefined;
      if (row) {
        const stored = JSON.parse(row.body) as {
          plan?: {
            summary?: string;
            unresolved?: string[];
            capabilityChanges?: {
              capability: string;
              provider: string;
              change: string;
            }[];
          };
        };
        if (stored.plan) {
          planEvidence = {
            summary: stored.plan.summary,
            unresolved: stored.plan.unresolved,
            capabilityChanges: stored.plan.capabilityChanges?.map((c) => ({
              capability: c.capability,
              provider: c.provider,
              change: c.change,
            })),
          };
        }
      }
    }
    recordEvent({
      type: "settled",
      run: snapshot.run
        ? {
            id: snapshot.run.id,
            status: snapshot.run.status,
            message: settledMessage,
            blockReason,
            budget: "budget" in snapshot.run ? snapshot.run.budget : undefined,
            plan: planEvidence
              ? {
                  ...planEvidence,
                  id:
                    "plan" in snapshot.run && snapshot.run.plan
                      ? snapshot.run.plan.id
                      : undefined,
                }
              : null,
          }
        : null,
      candidates: (snapshot.candidates ?? []).map((c) => ({
        id: c.id,
        passed: c.passed,
        diagnostic: c.diagnostic,
        evidenceHash: c.evidenceHash,
        versionId: c.versionId,
      })),
      browser: browserResult,
    });

    const candidates = snapshot.candidates ?? [];
    if (candidates.length) {
      firstCandidatePassed = candidates[0]?.passed ?? null;
      repairedInOriginalBudget =
        candidates.length > 1 &&
        candidates.some((c) => c.passed) &&
        firstCandidatePassed === false;
    }

    const calls = w.db
      .prepare("SELECT body FROM evolution_calls")
      .all() as { body: string }[];
    recordEvent({
      type: "calls",
      count: calls.length,
      samples: calls
        .slice(0, 20)
        .map((row) => redactSensitive(JSON.parse(row.body))),
    });

    let promptTokens = 0;
    let completionTokens = 0;
    let sawUsage = false;
    for (const row of calls) {
      const body = JSON.parse(row.body) as {
        usage?: {
          promptTokens?: number;
          completionTokens?: number;
          promptTokenCount?: number;
          candidatesTokenCount?: number;
        };
      };
      if (!body.usage) continue;
      sawUsage = true;
      promptTokens +=
        body.usage.promptTokens ?? body.usage.promptTokenCount ?? 0;
      completionTokens +=
        body.usage.completionTokens ?? body.usage.candidatesTokenCount ?? 0;
    }
    if (sawUsage) usage = { promptTokens, completionTokens };

    recordEvent({
      type: "formal-fingerprint-after",
      fingerprint: {
        compositionRevision: w.composition().revision,
        versionId: w.composition().versionId,
        taskTotal: w.query().total,
      },
      note: "只读补充证据；不得用 API 成功替代浏览器用户路径。",
    });
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
    recordEvent({
      type: "failure",
      message: failureMessage,
      preservedDirectory: options.directory,
    });
    browserResult = browserResult ?? {
      status: "failed",
      viewport: { width: 390, height: 844 },
      openedImprovePanel: false,
      recoveryEntryVisible: false,
      screenshot: join(
        options.directory,
        `browser-${options.scenario.id}.png`,
      ),
      pageErrors: [],
      message: failureMessage,
    };
  } finally {
    await evolution.close();
    await sessions.close();
    await w.close();
    rmSync(join(options.directory, "workspace.db"), { force: true });
    rmSync(join(options.directory, "artifacts"), {
      recursive: true,
      force: true,
    });
  }

  const observed = observeOutcome(
    options.scenario,
    browserResult!.status,
    runStatus ?? browserResult!.observedRunStatus,
  );

  const reachedReadyOnFirstPlan = Boolean(browserResult!.confirmedPlan);
  const blockedWithoutReady =
    browserResult!.status === "blocked-observed" &&
    !browserResult!.confirmedPlan;

  const scored = scoreCapabilityAndBlocking({
    scenario: options.scenario,
    observedOutcomeClass: observed,
    blockReason,
    message: [
      failureMessage,
      browserResult!.message,
      settledMessage,
      ...(planEvidence?.unresolved ?? []),
    ]
      .filter(Boolean)
      .join(" "),
    plan: planEvidence,
    reachedReadyOnFirstPlan,
    blockedWithoutReady,
  });

  const matchesExpectation = observed === options.scenario.expectedOutcomeClass;
  const failureClass =
    matchesExpectation && observed !== "failed"
      ? null
      : classifyFailure({
          message: failureMessage ?? browserResult!.message,
          transportFailed: /fetch failed|ECONNRESET|UNAVAILABLE/i.test(
            failureMessage ?? "",
          ),
          documentationGap: /定时|调度基础|检查器|资料/.test(
            failureMessage ?? "",
          ),
        });

  const record: ScenarioRunRecord = {
    scenarioId: options.scenario.id,
    evidenceKind: options.evidenceKind,
    expectedOutcomeClass: options.scenario.expectedOutcomeClass,
    observedOutcomeClass: observed,
    capabilitySelectionCorrect: scored.capabilitySelectionCorrect,
    errorBlockingCorrect: scored.errorBlockingCorrect,
    firstPlanPassed: scored.firstPlanPassed,
    firstCandidatePassed,
    fullPathSucceeded:
      observed === "full-path-success" &&
      Boolean(
        browserResult!.experienced || !options.scenario.requiresExperience,
      ) &&
      Boolean(browserResult!.applied || !options.scenario.requiresApply) &&
      browserResult!.recoveryEntryVisible &&
      Boolean(
        !options.scenario.requiresExperience ||
          browserResult!.experienceActions?.completedAndReopened ||
          browserResult!.experienceActions?.tagSet ||
          browserResult!.experienceActions?.counterValue,
      ),
    repairedInOriginalBudget,
    durationMs: Date.now() - started,
    usage,
    failureClass,
  };
  recordEvent({ type: "metrics-record", record });
  writeFileSync(
    join(options.directory, "record.json"),
    JSON.stringify(redactSensitive(record), null, 2) + "\n",
    { mode: 0o600 },
  );
  return {
    record,
    eventsPath,
    preservedDirectory: options.directory,
  };
}

export async function runFrozenBaselineSuite(input: {
  root: string;
  manifest: FrozenManifest;
  evidenceKind: "model-stub" | "real-model";
  driverFactory?: (scenarioId: string) => Driver;
  scenarioFilter?: string[];
  harnessCommit?: string;
}): Promise<{
  runs: StabilityScenarioResult[];
  records: ScenarioRunRecord[];
}> {
  assertManifestFrozen(input.manifest);
  mkdirSync(input.root, { recursive: true });
  writeFileSync(
    join(input.root, "manifest.frozen.json"),
    JSON.stringify(
      {
        ...input.manifest,
        harnessCommit: input.harnessCommit,
      },
      null,
      2,
    ) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  const runs: StabilityScenarioResult[] = [];
  for (const scenario of input.manifest.scenarios) {
    if (input.scenarioFilter && !input.scenarioFilter.includes(scenario.id))
      continue;
    for (
      let i = 0;
      i < input.manifest.runs.independentRunsPerScenario;
      i++
    ) {
      const directory = join(
        input.root,
        "runs",
        `${scenario.id}-r${i + 1}-${randomUUID().slice(0, 8)}`,
      );
      mkdirSync(directory, { recursive: true });
      const result = await runStabilityScenario({
        directory,
        scenario,
        manifest: input.manifest,
        evidenceKind: input.evidenceKind,
        driver: input.driverFactory?.(scenario.id),
      });
      rmSync(join(directory, "artifacts"), { recursive: true, force: true });
      rmSync(join(directory, "workspace.db"), { force: true });
      runs.push(result);
    }
  }
  return { runs, records: runs.map((r) => r.record) };
}
