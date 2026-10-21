import {
  archiveWorkspace,
  writeVerifiedJson,
  usageFromCalls,
  firstPlanResult,
  archiveBrowserEvidence,
} from "./archive.js";
import { dependencyFault } from "./environment.js";
import { resolveExperienceBindings } from "./bindings.js";
import type {
  InvestigatedPlan,
  PlanBinding,
} from "../../../src/shared/assistant.js";
import type { WorkspaceCaseEvidence } from "../../../src/server/workspace-acceptance.js";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  cpSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../../src/server/workspace.js";
import { Evolution } from "../../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../../src/server/evolution-domain.js";
import { ExperienceSessionHost } from "../../../src/server/experience-session.js";
import { createApp } from "../../../src/server/app.js";
import type { Driver } from "../../../src/evolution/driver.js";
import { activateStabilityBaseline } from "./baseline.js";
import { redactSensitive } from "../shortened-real-model.js";
import {
  type FrozenManifest,
  type StabilityScenario,
  assertManifestFrozen,
} from "./manifest.js";
import {
  classifyFailure,
  type ScenarioRunRecord,
  failureFromEvidence,
  runIncidents,
  type CallEvidence,
} from "./metrics.js";
import { runStabilityBrowserPath, type BrowserPathResult } from "./browser.js";
import { frozenClarificationReceiptMatches } from "./clarification.js";
import {
  selectResponsibilityTrial,
  observeResponsibility,
  type FrozenResponsibilityExperiment,
  type ResponsibilityObservation,
} from "./responsibility.js";
import type { WorkflowProtocolOwner } from "../../../src/shared/workflow-protocol.js";
import {
  observeOutcome,
  scoreCapabilityAndBlocking,
  type SettledPlanEvidence,
} from "./scoring.js";
import { stabilityDriverFor } from "./driver-fixture.js";
import {
  checkIndependentPlan,
  checkIndependentBlock,
  checkDuePolicy,
  checkIndependentBrowser,
  independentBrowserCases,
  oracleCheck,
  oracleComplete,
  pendingOracle,
  type OracleCheck,
} from "./oracle.js";
import {
  verifyBrowser,
  BrowserAssertionError,
} from "../../../src/server/browser-acceptance.js";

export type StabilityRunOptions = {
  directory: string;
  scenario: StabilityScenario;
  manifest: FrozenManifest;
  evidenceKind: "model-stub" | "real-model";
  driver?: Driver;
  clarificationAnswer?: string;
  browserRun?: typeof runStabilityBrowserPath;
  archive?: typeof archiveWorkspace;
  resumeExistingCandidate?: boolean;
  trialId?: string;
  responsibilityExperiment?: FrozenResponsibilityExperiment;
};

export type StabilityScenarioResult = {
  record: ScenarioRunRecord;
  eventsPath: string;
  preservedDirectory: string;
};

function clarificationFor(scenario: StabilityScenario): string | undefined {
  if (
    scenario.id === "due-auto-expire" &&
    scenario.expectedOutcomeClass === "current-blocker"
  )
    return "坚持完整能力，等待维护者补齐";
  if (scenario.id === "missing-capability-push")
    return "坚持完整外部推送与离线送达";
  return undefined;
}

async function prepareWorkspace(
  scenario: StabilityScenario,
  directory: string,
  owner: WorkflowProtocolOwner = "model",
) {
  const w = await Workspace.open(join(directory, "workspace.db"), {
    workflowProtocolOwner: owner,
  });
  try {
    if (scenario.id === "member-upgrade-tags" || scenario.baseline === "dual") {
      const baseline = await activateStabilityBaseline(w);
      writeVerifiedJson(join(directory, "baseline-evidence.json"), baseline.evidence);
    }
    await w.command({
      type: "create",
      operationId: randomUUID(),
      compositionRevision: w.composition().revision,
      title: "稳定性评估保留任务",
    });
    return w;
  } catch (error) {
    try {
      await w.close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], `基线准备失败：${String(error)}；资源释放失败：${String(cleanup)}`);
    }
    throw error;
  }
}


export async function runStabilityScenario(
  options: StabilityRunOptions,
): Promise<StabilityScenarioResult> {
  const started = Date.now();
  let fault: ReturnType<typeof dependencyFault> | undefined;
  try {
    fault =
      options.scenario.id === "temporarily-unavailable-dependency"
        ? dependencyFault(options.directory)
        : undefined;
    return await runScenarioInEnvironment(options, fault);
  } catch (error) {
    const record: ScenarioRunRecord = {
      trialId: options.trialId,
      ...(options.scenario.oracle
        ? {
            oracle: pendingOracle(options.scenario, {
              manifestHash: options.manifest.contentHash,
              trialId: options.trialId ?? "unregistered",
            }),
          }
        : {}),
      scenarioId: options.scenario.id,
      evidenceKind: options.evidenceKind,
      evidenceComplete: false,
      expectedOutcomeClass: options.scenario.expectedOutcomeClass,
      observedOutcomeClass: "failed",
      capabilitySelectionCorrect: null,
      errorBlockingCorrect: null,
      firstPlanPassed: null,
      firstCandidatePassed: null,
      fullPathSucceeded: false,
      repairedInOriginalBudget: false,
      durationMs: Date.now() - started,
      usage: null,
      failureClass: "evaluator",
    };
    const eventsPath = join(options.directory, "events.jsonl");
    writeFileSync(
      eventsPath,
      JSON.stringify(
        redactSensitive({
          type: "setup-or-finalization-error",
          message: String(error),
          record,
        }),
      ) + "\n",
      { flag: "a", mode: 0o600 },
    );
    if (!existsSync(join(options.directory, "record.json")))
      writeVerifiedJson(join(options.directory, "record.json"), record);
    // A completed record may exist if only finalization failed; preserve it and add failure evidence.
    writeVerifiedJson(join(options.directory, "incomplete-run.json"), {
      record,
      message: String(error),
    });
    return { record, eventsPath, preservedDirectory: options.directory };
  } finally {
    fault?.restore();
  }
}

async function runScenarioInEnvironment(
  options: StabilityRunOptions,
  fault?: ReturnType<typeof dependencyFault>,
): Promise<StabilityScenarioResult> {
  assertManifestFrozen(options.manifest);
  const responsibility = options.responsibilityExperiment
    ? selectResponsibilityTrial(
        options.responsibilityExperiment,
        options.trialId,
        options.scenario.id,
        options.manifest,
      )
    : undefined;
  if (responsibility && options.resumeExistingCandidate)
    throw new Error("职责实验禁止续跑旧候选或重置预注册运行");
  if (
    options.manifest.evaluation &&
    options.clarificationAnswer &&
    options.clarificationAnswer !== options.scenario.clarification?.answer
  )
    throw new Error("当前评测不得替换冻结的澄清答案");

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
  const oracle = options.scenario.oracle
    ? pendingOracle(options.scenario, {
        manifestHash: options.manifest.contentHash,
        trialId: options.trialId ?? "unregistered",
      })
    : undefined;
  const recordOracle = (checks: OracleCheck[]) => {
    if (!oracle) return;
    for (const check of checks) {
      oracle.checks = oracle.checks.map((c) => (c.id === check.id ? check : c));
      recordEvent({
        type: "independent-oracle",
        check,
        definitionHash: oracle.definitionHash,
      });
    }
    const failed = checks.filter((check) => check.status === "failed");
    if (failed.length)
      throw new Error(
        `独立需求断言失败：${failed.map((check) => check.id).join("、")}`,
      );
  };
  const driver =
    options.driver ??
    (options.evidenceKind === "model-stub"
      ? stabilityDriverFor(
          options.scenario.id,
          options.scenario.oracle ? options.scenario : undefined,
        )
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
    ...(responsibility ? { responsibility } : {}),
    model:
      options.evidenceKind === "model-stub"
        ? options.manifest.model.stubKind
        : options.manifest.model.realModelId,
  });

  if (fault) recordEvent({ type: "environment-fault", ...fault.evidence });
  const w = options.resumeExistingCandidate
    ? await Workspace.open(join(options.directory, "workspace.db"))
    : await prepareWorkspace(
        options.scenario,
        options.directory,
        responsibility?.owner,
      );
  const sessions = new ExperienceSessionHost(w);
  const planningReplies: unknown[] = [];
  const observedDriver: Driver = {
    async generate(request, signal, onTransport) {
      const reply = await driver.generate(request, signal, onTransport);
      if (!request.tools?.some((tool) => tool.name === "submit_candidate")) {
        const observation = {
          request: { tools: request.tools },
          response: {
            candidates: [
              {
                content: {
                  parts: reply.calls.map((call) => ({ functionCall: call })),
                },
              },
            ],
          },
        };
        planningReplies.push(observation);
        recordEvent({ type: "planning-reply", calls: reply.calls });
      }
      return reply;
    },
  };
  const domain = new EvolutionDomain(w);
  const initialContext = options.scenario.oracle ? domain.context() : undefined;
  if (fault) {
    const environment = domain.context().environment;
    recordEvent({ type: "host-environment", environment });
    if (!environment.missing.includes("@types/node")) {
      await w.close();
      throw new Error("Evaluator dependency fault was not visible to the Host");
    }
  }
  const evolution = new Evolution(
    w.db,
    observedDriver,
    domain,
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
  let processingFailure: string | undefined;
  let usage: ScenarioRunRecord["usage"] = null;
  let callEvidence: CallEvidence[] = [];
  let resources: ScenarioRunRecord["resources"];
  let blockReason: string | undefined;
  let settledMessage: string | undefined;
  let planEvidence: SettledPlanEvidence | null = null;
  let plannedProtocol: PlanBinding["workflowProtocol"];
  let responsibilityObservation: ResponsibilityObservation | undefined;
  let responsibilityMismatch = false;

  let archiveComplete = false;
  let firstPlanPassed: boolean | null = null;
  try {
    browserResult = await (options.browserRun ?? runStabilityBrowserPath)({
      app,
      resumeExistingCandidate: options.resumeExistingCandidate,
      budgetMs: options.manifest.budget.milliseconds,
      directory: options.directory,
      scenario: options.scenario,
      clarificationAnswer:
        options.clarificationAnswer ??
        options.scenario.clarification?.answer ??
        (options.manifest.evaluation
          ? undefined
          : clarificationFor(options.scenario)),
      validatePlan: async () => {
        if (!oracle && !responsibility) return;
        const snapshot = await evolution.observe();
        if (!snapshot.run || !("plan" in snapshot.run) || !snapshot.run.plan)
          throw new Error("独立判定缺少待执行计划");
        plannedProtocol = snapshot.run.plan.binding?.workflowProtocol;
        if (
          responsibility &&
          (plannedProtocol?.owner !== responsibility.owner ||
            plannedProtocol?.implementationHash !== responsibility.kernelHash)
        ) {
          responsibilityMismatch = true;
          throw new Error("职责实验计划偏离冻结分组或执行内核");
        }
        if (!oracle) return;
        const baseline = JSON.parse(
          initialContext!.files["active-acceptance"].content,
        ) as {
          rules?: InvestigatedPlan["workflowRules"];
          requirements?: InvestigatedPlan["requirements"];
        };
        recordOracle(
          checkIndependentPlan(options.scenario, snapshot.run.plan, {
            workflowRules: baseline.rules,
            requirements: baseline.requirements,
          }),
        );
      },
      resolveBindings: async () => {
        const snapshot = await evolution.observe();
        const plan =
          snapshot.run && "plan" in snapshot.run
            ? snapshot.run.plan
            : undefined;
        const session = sessions.observe();
        if (!plan || session.status !== "active")
          throw new Error("Evaluator binding: missing confirmed plan/session");
        const sessionSnapshot = sessions.readSnapshot(session.id);
        if (options.scenario.id === "tags-add") {
          sessions
            .workspaceFor(session.id)
            .seedAcceptanceTask(
              sessionSnapshot.task.id,
              sessionSnapshot.task.state,
              { ...sessionSnapshot.task.fields, retained: "原值" },
              sessionSnapshot.task.revision,
            );
        }
        const composition = sessionSnapshot.composition;
        const evidence = w.release.get(composition.versionId).evidence as {
          passed?: boolean;
          workspaceCases?: WorkspaceCaseEvidence[];
        };
        const bindings = resolveExperienceBindings({
          scenarioId:
            options.scenario.id === "clarification-reflection"
              ? "rule-revision-reflection"
              : options.scenario.id,
          plan: plan as InvestigatedPlan,
          composition,
          evidence,
          schedules: sessions
            .workspaceFor(session.id)
            .extensionRegistry()
            .schedules(),
        });
        if (options.scenario.oracle?.kind === "due" && bindings.due)
          bindings.due.expiredExpected = options.scenario.oracle.expiredValue;
        if (oracle) {
          const cases = independentBrowserCases(
            options.scenario,
            composition,
            bindings,
          );
          const candidate = w.release.get(composition.versionId);
          let actual;
          try {
            const evidence = await verifyBrowser(
              w,
              candidate,
              w.release.get(plan.changeSpec!.baseVersion),
              cases,
              [],
              oracle.definitionHash,
              AbortSignal.timeout(120000),
            );
            writeVerifiedJson(
              join(options.directory, "independent-browser.json"),
              archiveBrowserEvidence(
                evidence,
                join(options.directory, "independent-browser-evidence"),
              ),
            );
            actual = checkIndependentBrowser(cases, evidence);
          } catch (error) {
            if (error instanceof BrowserAssertionError) {
              writeVerifiedJson(
                join(options.directory, "independent-browser.json"),
                archiveBrowserEvidence(
                  error.evidence,
                  join(options.directory, "independent-browser-evidence"),
                ),
              );
              actual = checkIndependentBrowser(cases, error.evidence);
            } else throw error;
          }
          recordOracle([actual]);
        }
        return bindings;
      },
      restartHost: () => w.restart(),
    });
  } catch (error) {
    failureMessage = error instanceof Error ? error.message : String(error);
    recordEvent({ type: "browser-error", message: failureMessage });
  }
  // Preserve the observed outcome before shutdown changes a live run to interrupted.
  const beforeShutdown = await evolution.observe();
  recordEvent({ type: "before-shutdown", snapshot: beforeShutdown });
  // Stop in-flight work before archiving; cancellation itself is retained in the DB.
  await evolution
    .close()
    .catch((error) =>
      recordEvent({ type: "shutdown-error", message: String(error) }),
    );
  try {
    const snapshot = beforeShutdown;
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
      plannedProtocol = snapshot.run.plan.binding?.workflowProtocol;
      planEvidence = {
        memberCases: snapshot.run.plan.memberCases,
        workflowRules: snapshot.run.plan.workflowRules,
        summary: snapshot.run.plan.summary,
        unresolved: snapshot.run.plan.unresolved,
        requiredCapabilities: snapshot.run.plan.requiredCapabilities,
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
          plan?: SettledPlanEvidence & { binding?: PlanBinding };
        };
        if (stored.plan) {
          plannedProtocol = stored.plan.binding?.workflowProtocol;
          planEvidence = {
            memberCases: stored.plan.memberCases,
            workflowRules: stored.plan.workflowRules,
            summary: stored.plan.summary,
            unresolved: stored.plan.unresolved,
            requiredCapabilities: stored.plan.requiredCapabilities,
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
    if (responsibility) {
      responsibilityObservation = observeResponsibility(
        responsibility,
        plannedProtocol,
        candidates,
        (id) => w.release.get(id),
      );
      writeVerifiedJson(
        join(options.directory, "responsibility-evidence.json"),
        responsibilityObservation,
      );
      recordEvent({
        type: "responsibility-evidence",
        observation: responsibilityObservation,
      });
      if (!responsibilityObservation.consistent) {
        responsibilityMismatch = true;
        failureMessage =
          "职责实验身份不一致：" +
          responsibilityObservation.issues.map((i) => i.detail).join("；");
        if (browserResult) browserResult.status = "failed";
      }
    }
    if (options.manifest.evaluation)
      for (const candidate of candidates) {
        if (candidate.browser)
          writeVerifiedJson(
            join(options.directory, `candidate-browser-${candidate.id}.json`),
            archiveBrowserEvidence(
              candidate.browser,
              join(options.directory, `candidate-browser-${candidate.id}`),
            ),
          );
      }
    if (candidates.length) {
      firstCandidatePassed = candidates[0]?.passed ?? null;
      repairedInOriginalBudget =
        candidates.length > 1 &&
        candidates.some((c) => c.passed) &&
        firstCandidatePassed === false;
    }

    const calls = w.db.prepare("SELECT body FROM evolution_calls").all() as {
      body: string;
    }[];
    recordEvent({
      type: "calls",
      count: calls.length,
      samples: calls.map((row) => redactSensitive(JSON.parse(row.body))),
    });

    const callBodies = calls.map((row) => JSON.parse(row.body));
    callEvidence = callBodies;
    const storedRow = w.db
      .prepare("SELECT body FROM evolution_runs ORDER BY rowid DESC LIMIT 1")
      .get() as { body: string } | undefined;
    if (storedRow) {
      const stored = JSON.parse(storedRow.body) as {
        calls: number;
        candidates: number;
        elapsed: number;
      };
      resources = {
        calls: stored.calls,
        recordedCalls: callBodies.length,
        candidates: stored.candidates,
        activeMilliseconds: stored.elapsed,
      };
    }
    usage = usageFromCalls(callBodies);
    firstPlanPassed = firstPlanResult(
      options.resumeExistingCandidate
        ? readFileSync(join(options.directory, "prior-events.jsonl"), "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line))
            .filter((event) => event.type === "planning-reply")
            .map((event) => ({
              response: {
                candidates: [
                  {
                    content: {
                      parts: event.calls.map((call: unknown) => ({
                        functionCall: call,
                      })),
                    },
                  },
                ],
              },
            }))
        : planningReplies,
      Boolean(browserResult?.confirmedPlan || options.resumeExistingCandidate),
      browserResult?.status === "blocked-observed",
    );

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
    processingFailure = error instanceof Error ? error.message : String(error);
    failureMessage ??= processingFailure;
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
      screenshot: join(options.directory, `browser-${options.scenario.id}.png`),
      pageErrors: [],
      message: failureMessage,
    };
    browserResult.status = "failed";
  } finally {
    try {
      const evidenceHash = (options.archive ?? archiveWorkspace)(
        w.db,
        options.directory,
      );
      recordEvent({ type: "archive-verified", evidenceHash });
      archiveComplete =
        Boolean(browserResult) && !browserResult?.evidenceErrors?.length;
      if (browserResult?.evidenceErrors?.length)
        recordEvent({
          type: "browser-evidence-errors",
          errors: browserResult.evidenceErrors,
        });
      if (browserResult?.cleanupErrors?.length)
        recordEvent({
          type: "browser-cleanup-errors",
          errors: browserResult.cleanupErrors,
        });
    } catch (error) {
      archiveComplete = false;
      failureMessage ??= `Archive verification: ${String(error)}`;
      recordEvent({
        type: "archive-error",
        message: String(error),
        preservedDirectory: options.directory,
      });
    }
    for (const close of [() => sessions.close(), () => w.close()]) {
      try {
        await close();
      } catch (error) {
        archiveComplete = false;
        recordEvent({ type: "cleanup-error", message: String(error) });
      }
    }
  }
  browserResult ??= {
    status: "failed",
    viewport: { width: 390, height: 844 },
    openedImprovePanel: false,
    recoveryEntryVisible: false,
    screenshot: "",
    pageErrors: [],
    message: failureMessage,
  };
  failureMessage ??= browserResult.message;
  if (processingFailure) archiveComplete = false;
  if (!archiveComplete) browserResult.status = "failed";

  if (oracle) {
    if (options.scenario.oracle?.kind === "block") {
      const check = checkIndependentBlock(
        options.scenario,
        { ...beforeShutdown.run!, status: runStatus ?? "unknown", blockReason },
        initialContext!,
      );
      oracle.checks = oracle.checks.map((c) => (c.id === check.id ? check : c));
    } else {
      for (const [id, value] of [
        ["path:experience", !!browserResult.experienced],
        ["path:apply", !!browserResult.applied],
      ] as const)
        oracle.checks = oracle.checks.map((c) =>
          c.id === id ? oracleCheck(id, true, value) : c,
        );
      if (
        options.scenario.oracle?.kind === "due" &&
        options.scenario.oracle.lifecyclePolicy
      ) {
        const check = checkDuePolicy(browserResult.duePolicyChecks ?? []);
        oracle.checks = oracle.checks.map((c) =>
          c.id === check.id ? check : c,
        );
      }
      if (options.scenario.clarification)
        oracle.checks = oracle.checks.map((c) =>
          c.id === "path:clarification"
            ? oracleCheck(
                c.id,
                true,
                frozenClarificationReceiptMatches(
                  options.scenario,
                  beforeShutdown.run,
                  browserResult.answeredClarification,
                ),
              )
            : c,
        );
    }
    writeVerifiedJson(
      join(options.directory, "independent-oracle.json"),
      oracle,
    );
  }
  const observed = !archiveComplete
    ? "failed"
    : observeOutcome(
          options.scenario,
          browserResult!.status,
          runStatus ?? browserResult!.observedRunStatus,
          oracle ? oracleComplete(options.scenario, oracle) : undefined,
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

  if (oracle && options.scenario.oracle?.kind === "block") {
    scored.errorBlockingCorrect = oracleComplete(options.scenario, oracle);
    scored.capabilitySelectionCorrect = scored.errorBlockingCorrect;
  }
  const matchesExpectation =
    observed === options.scenario.expectedOutcomeClass &&
    (!oracle || oracleComplete(options.scenario, oracle));
  const evaluatorStoppedLiveRun =
    browserResult.status === "failed" &&
    ["planning", "executing"].includes(beforeShutdown.run?.status ?? "");
  const failure = processingFailure
    ? {
        classification: "evaluator" as const,
        phase: "evidence",
        code: "evidence-processing-failed",
        evidence: ["events.jsonl", "before-shutdown"],
      }
    : responsibilityMismatch
      ? {
          classification: responsibilityObservation?.issues.some(
            (i) => i.classification === "host-defect",
          )
            ? ("host-defect" as const)
            : ("evaluator" as const),
          phase: "experiment",
          code: "responsibility-identity",
          evidence: ["responsibility-evidence.json", "before-shutdown"],
        }
      : options.manifest.evaluation && !matchesExpectation
        ? evaluatorStoppedLiveRun
          ? {
              classification: "evaluator" as const,
              phase: "browser",
              code: "evaluation-stopped-live-run",
              evidence: ["before-shutdown", "browser-result"],
            }
          : failureFromEvidence({
              calls: callEvidence,
              run: beforeShutdown.run ?? undefined,
              protocolFailures: beforeShutdown.run?.protocolFailures,
              resourceFailures: beforeShutdown.run?.resourceFailures,
              oracle,
              archiveComplete,
            })
        : undefined;
  const failureClass =
    failure?.classification ??
    (evaluatorStoppedLiveRun
      ? "evaluator"
      : matchesExpectation
        ? null
        : classifyFailure({
            message: [failureMessage, settledMessage, browserResult!.message]
              .filter(Boolean)
              .join(" "),
            transportFailed: /fetch failed|ECONNRESET|UNAVAILABLE/i.test(
              failureMessage ?? "",
            ),
            documentationGap: /定时|调度基础|检查器|资料/.test(
              failureMessage ?? "",
            ),
          }));

  const record: ScenarioRunRecord = {
    trialId: options.trialId,
    ...(responsibilityObservation
      ? { responsibility: responsibilityObservation }
      : {}),
    candidatePassed: (beforeShutdown.candidates ?? []).some((c) => c.passed),
    ...(oracle ? { oracle } : {}),
    ...(failure ? { failure } : {}),
    ...(beforeShutdown.run
      ? {
          terminal: {
            status: beforeShutdown.run.status,
            ...(beforeShutdown.run.stop
              ? { stop: beforeShutdown.run.stop }
              : {}),
          },
        }
      : {}),
    incidents: runIncidents(
      callEvidence,
      beforeShutdown.run?.protocolFailures,
      beforeShutdown.run?.resourceFailures,
    ),
    ...(resources ? { resources } : {}),
    scenarioId: options.scenario.id,
    evidenceKind: options.evidenceKind,
    evidenceComplete: archiveComplete,
    expectedOutcomeClass: options.scenario.expectedOutcomeClass,
    observedOutcomeClass: options.resumeExistingCandidate ? "failed" : observed,
    recoveredBrowserSucceeded: options.resumeExistingCandidate
      ? observed === "full-path-success"
      : undefined,
    capabilitySelectionCorrect: scored.capabilitySelectionCorrect,
    errorBlockingCorrect: scored.errorBlockingCorrect,
    firstPlanPassed,
    firstCandidatePassed,
    fullPathSucceeded:
      !options.resumeExistingCandidate &&
      (!oracle || oracleComplete(options.scenario, oracle)) &&
      observed === "full-path-success" &&
      Boolean(
        browserResult!.experienced || !options.scenario.requiresExperience,
      ) &&
      Boolean(browserResult!.applied || !options.scenario.requiresApply) &&
      browserResult!.recoveryEntryVisible &&
      (options.scenario.id !== "due-auto-expire" ||
        options.scenario.expectedOutcomeClass !== "full-path-success" ||
        browserResult!.formalDueLifecyclePassed === true) &&
      (options.scenario.id === "due-auto-expire" &&
      options.scenario.expectedOutcomeClass === "full-path-success"
        ? Boolean(
            browserResult!.experienceActions?.dueEditedAndCleared &&
              browserResult!.experienceActions?.dueFiredInExperience,
          )
        : Boolean(
            !options.scenario.requiresExperience ||
              browserResult!.experienceActions?.completedAndReopened ||
              browserResult!.experienceActions?.tagSet ||
              browserResult!.experienceActions?.counterValue,
          )),
    repairedInOriginalBudget,
    durationMs: Date.now() - started,
    durationScope: options.resumeExistingCandidate
      ? "recovery-only"
      : undefined,
    usage,
    failureClass: options.resumeExistingCandidate ? "evaluator" : failureClass,
  };
  recordEvent({ type: "metrics-record", record });
  writeVerifiedJson(join(options.directory, "record.json"), record);
  // Both evidence and metrics must be verified before deleting the synthetic source.
  if (archiveComplete) {
    try {
      rmSync(join(options.directory, "workspace.db"), { force: true });
      rmSync(join(options.directory, "artifacts"), {
        recursive: true,
        force: true,
      });
      rmSync(join(options.directory, "environment"), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      recordEvent({ type: "cleanup-error", message: String(error) });
    }
  }
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
  continuationRoot?: string;
  responsibilityExperiment?: FrozenResponsibilityExperiment;
  browserRun?: StabilityRunOptions["browserRun"];
}): Promise<{
  runs: StabilityScenarioResult[];
  records: ScenarioRunRecord[];
}> {
  assertManifestFrozen(input.manifest);
  const experiment = input.responsibilityExperiment;
  if (experiment) {
    if (input.scenarioFilter || input.continuationRoot)
      throw new Error("配对实验禁止筛选场景、外层续跑或复用候选");
    selectResponsibilityTrial(
      experiment,
      experiment.trials[0]?.trialId,
      experiment.trials[0]?.scenarioId,
      input.manifest,
    );
  }
  if (input.manifest.evaluation && input.continuationRoot)
    throw new Error("当前评测不接受外层续跑或复用历史模型运行");
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
  if (experiment) {
    writeVerifiedJson(
      join(input.root, "responsibility.frozen.json"),
      experiment,
    );
    for (const trial of experiment.trials) {
      const scenario = input.manifest.scenarios.find(
        (s) => s.id === trial.scenarioId,
      )!;
      const directory = join(
        input.root,
        "runs",
        `${trial.trialId}-${randomUUID().slice(0, 8)}`,
      );
      mkdirSync(directory, { recursive: true });
      runs.push(
        await runStabilityScenario({
          directory,
          scenario,
          manifest: input.manifest,
          evidenceKind: input.evidenceKind,
          trialId: trial.trialId,
          responsibilityExperiment: experiment,
          browserRun: input.browserRun,
          driver: input.driverFactory?.(scenario.id),
        }),
      );
    }
    return { runs, records: runs.map((r) => r.record) };
  }
  let priorDirectory: string | undefined;
  if (input.continuationRoot) {
    const identity = JSON.parse(
      readFileSync(join(input.continuationRoot, "identity.json"), "utf8"),
    );
    const previousRuns = readdirSync(join(input.continuationRoot, "runs"));
    if (
      identity.productCommit !== input.manifest.productCommit ||
      previousRuns.length !== 1 ||
      !previousRuns[0]!.startsWith("tags-add-r1-")
    )
      throw new Error(
        "Continuation requires exactly one historical tags trial",
      );
    priorDirectory = join(input.continuationRoot, "runs", previousRuns[0]!);
    if (existsSync(join(priorDirectory, "record.json")))
      throw new Error("Completed trials cannot be retried");
    writeVerifiedJson(join(input.root, "continuation.json"), {
      source: input.continuationRoot,
      originalFailure: JSON.parse(
        readFileSync(
          join(input.continuationRoot, "runner-failure.json"),
          "utf8",
        ),
      ),
      policy:
        "No additional model calls for recovered tags trial; original evaluator failure remains in metrics",
    });
  }
  for (const scenario of input.manifest.scenarios) {
    if (input.scenarioFilter && !input.scenarioFilter.includes(scenario.id))
      continue;
    for (let i = 0; i < input.manifest.runs.independentRunsPerScenario; i++) {
      const directory = join(
        input.root,
        "runs",
        `${scenario.id}-r${i + 1}-${randomUUID().slice(0, 8)}`,
      );
      mkdirSync(directory, { recursive: true });
      const resume = scenario.id === "tags-add" && priorDirectory !== undefined;
      if (resume) {
        for (const entry of readdirSync(priorDirectory!)) {
          if (entry === "events.jsonl")
            cpSync(
              join(priorDirectory!, entry),
              join(directory, "prior-events.jsonl"),
            );
          else
            cpSync(join(priorDirectory!, entry), join(directory, entry), {
              recursive: true,
            });
        }
        const { DatabaseSync } = await import("node:sqlite");
        const db = new DatabaseSync(join(directory, "workspace.db"));
        try {
          const row = db
            .prepare(
              "SELECT body FROM evolution_runs ORDER BY rowid DESC LIMIT 1",
            )
            .get() as { body: string };
          if (JSON.parse(row.body).run?.status !== "awaiting-apply")
            throw new Error(
              "Continuation requires an existing verified candidate awaiting apply",
            );
          writeVerifiedJson(join(directory, "recovery-source.json"), {
            source: priorDirectory,
            run: JSON.parse(row.body),
            callsBefore: db
              .prepare("SELECT COUNT(*) AS count FROM evolution_calls")
              .get(),
          });
        } finally {
          db.close();
        }
      }
      const result = await runStabilityScenario({
        trialId: `${scenario.id}-r${i + 1}`,
        directory,
        scenario,
        manifest: input.manifest,
        evidenceKind: input.evidenceKind,
        resumeExistingCandidate: resume,
        driver: resume
          ? {
              async generate() {
                throw new Error("Recovery forbids additional model calls");
              },
            }
          : input.driverFactory?.(scenario.id),
        browserRun: input.browserRun,
      });
      runs.push(result);
      if (resume && !result.record.recoveredBrowserSucceeded)
        throw new Error(
          "Recovered browser failed; no remaining scenarios started",
        );
    }
  }
  return { runs, records: runs.map((r) => r.record) };
}
