import { budgetPause } from "./budget-authorization.js";
import { questionsFor, answerText, compileDefaults } from "./interaction.js";
import type { BudgetGrant, ResourceAmounts } from "../shared/evolution-interaction.js";
import { compileSemantics, semanticReuse } from "./requirement-semantics.js";
import { resolveErrorFeedback, feedbackConflicts } from "./error-review.js";
import { planSchemaFor } from "./plan-input.js";
import { assembleCandidate, boundCandidateSchema, candidateDifference, deltaBasis } from "./candidate-delta.js";
import { BudgetScheduler, BudgetExhaustedError, type ModelPhase } from "./budget.js";
import { InvestigationStore } from "./investigation.js";
import { modelInput, modelInputEncoding } from "./model-input.js";
import { changeDefinition, compileSpec } from "./specification.js";
import { recordReview, reviewEvidence } from "./review.js";
import { requirementReviewInput } from "./review-input.js";
import { clarificationRequest, parseClarificationReview, clarificationBlockers, type ClarificationDecision } from "./clarification-review.js";
import { admissionRequest, admissionKey, parseAdmission, admissionQuestionState, questionReviewKey, admissionReviewRequest, adjudicateAdmission, admissionResolved } from "./request-admission.js";
import { admissionChoiceProof, type AdmissionQuestionTarget } from "./source-items.js";
import { technicalPremiseContext, technicalPremiseBasis, technicalPremiseRequest, parseTechnicalPremises, technicalPremisesResolved } from "./technical-premise.js";
import { ModelProtocolError, ModelResourceError, replyProblems } from "./model-protocol.js";
import { stopForError } from "./run-stop.js";
import {
  adjudicateTechnicalReview,
  businessChoices,
  semanticChoiceProof,
  reviewQuestion,
  technicalFacts,
} from "./technical-facts.js";
import { generationMaterialRefs, type InvestigationState } from "../shared/change-spec.js";
import { BrowserEnvironmentError, BrowserDefinitionError } from "../server/browser-acceptance.js";
import {
  candidateEvidenceHash,
  coverage,
  freezeRequirements,
  gateFailure,
  parseReview,
  boundReviewSchema,
} from "../server/requirement-coverage.js";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Driver, ModelReply, ModelRequest } from "./driver.js";
import { ModelTransportError } from "./driver.js";
import { transportFailure } from "./transport-failure.js";
import { HistoricalPreparationBlocked } from "./historical-preparation.js";
import { OperationPreparationError } from "./obligation-derivation.js";
import type {
  CandidateAttempt,
  AssistantCommand,
  AssistantEvent,
  AssistantPlan,
  AssistantRun,
  AssistantSnapshot,
  AssistantStep,
  ExperienceReport,
  InvestigatedPlan,
  PlanBinding,
  PlanEvidence,
  RequirementGate,
  RequirementReview,
} from "../shared/assistant.js";
import { describeBlockers } from "../shared/assistant.js";
import { AppError } from "../shared/contracts.js";
import type {
  Investigation,
  InvestigationRead,
  InvestigationDocument,
} from "../server/planning.js";
import {
  compositionIntentLabel,
  reviewedBaselineDefaults,
} from "../server/planning.js";
import {
  ProtectedCandidateError,
  CandidateValidationError,
} from "../release/business-bundle.js";
import { hash } from "../release/storage.js";
import {
  capabilityGuides,
  type CapabilityGuideRef,
} from "../server/capability-guides.js";
import { ExperienceSessionHost } from "../server/experience-session.js";
import { experienceSessionBanner } from "../shared/assistant.js";
import { experienceRequestTimeoutMs } from "../shared/request-policy.js";
export type Target = {
  kind: "plugin";
  baseVersion: string;
  payload: unknown;
};
export interface Domain {
  context(): Investigation;
  admission?(context: Investigation): {facts: ReturnType<typeof technicalFacts>; missing: string[]};
  planningInstruction: string;
  planningTools: NonNullable<ModelRequest["tools"]>;
  read(
    name: string,
    args: Record<string, unknown>,
    context: Investigation,
    delivered?: PlanEvidence[],
  ): InvestigationRead;
  parse(
    value: unknown,
    context: Investigation,
    seen: PlanEvidence[],
    sources?: RequirementGate["sources"],
    admission?: import("./request-admission.js").RequestAdmission,
  ): {
    plan: Omit<InvestigatedPlan, "id" | "requestRevision">;
    blockers: string[];
    retryable: boolean;
    sourceAdjudication?: {obligationId:string;diagnostic:string}[];
  };
  reproduce?(
    plan: InvestigatedPlan,
    signal: AbortSignal,
  ): Promise<NonNullable<InvestigatedPlan["repairEvidence"]> | undefined>;
  target(plan: InvestigatedPlan): Target;
  check(target: Target, revision: number, plan?: InvestigatedPlan): void;
  isActiveVersion(versionId: string): boolean;
  isReadyVersion(versionId: string): boolean;
  verifyAcceptance?(versionId: string, plan: InvestigatedPlan): void;
  acceptanceEvidence(versionId: string): {
    members?: unknown;
    workspaceChecks: string[];
    browser?: import("../shared/browser-cases.js").BrowserEvidence;
  };
  generation(target: Target): {
    instruction: string;
    contract: string;
    source: string;
    scaffold?: {
      writablePaths: string[];
      memberPluginIds: string[];
      inheritedMembers: {
        pluginId: string;
        versionId?: string;
        enabled: boolean;
        role: string;
      }[];
      workflowTemplate?: string;
      contractInjection: string;
    };
  };
  /** Exact member source/contract/acceptance for generation-time reads. */
  readMember(
    pluginId: string,
    versionId: string,
  ): {
    pluginId: string;
    versionId: string;
    source: string;
    contract: string;
    acceptance: string;
  };
  candidate(
    source: string,
    target: Target,
    signal: AbortSignal,
    stage: (label: string) => void,
  ): Promise<string>;
  experience(
    versionId: string,
    candidateId: string,
    signal: AbortSignal,
  ): Promise<ExperienceReport>;
  apply(
    versionId: string,
    target: Target,
    revision: number,
    operationId: string,
    complete: () => void,
    signal: AbortSignal,
  ): Promise<void>;
}
type RecordRun = {
  run: AssistantRun;
  initialLimits?: ResourceAmounts;
  authorizedLimits?: ResourceAmounts;
  grants?: BudgetGrant[];
  pauseRevision?: number;
  memoReplies?: Record<string, ModelReply>;
  planner?: { message?: string; response?: ModelReply; proposalId?: string; rejections: string[]; ready?: { plan: InvestigatedPlan; parsed: ReturnType<Domain["parse"]> } };
  generator?: { history: unknown[]; message?: string; previousCandidate?: {id: string; source: string}; failures: string[]; response?: ModelReply; pendingCandidate?: { rowId: number; source: string; candidate: CandidateAttempt } };
  target?: Target;
  plan?: AssistantPlan | InvestigatedPlan;
  history: unknown[];
  investigation?: InvestigationState;
  pendingMaterials?: PlanEvidence[];
  calls: number;
  candidates: number;
  elapsed: number;
  versionId?: string;
  eventSequence?: number;
  applyRevision?: number;
  applyOperationId?: string;
};
const terminal = (status: string) =>
  [
    "succeeded",
    "failed",
    "cancelled",
    "dismissed",
    "blocked",
    "interrupted",
  ].includes(status);
const editable = (status: string) =>
  ["awaiting-input", "awaiting-acceptance", "ready", "blocked"].includes(
    status,
  );
export class Evolution {
  private sessions?: ExperienceSessionHost;
  private materials: InvestigationStore;
  private runLimits(r: RecordRun) { return r.authorizedLimits ?? this.limits; }
  private scheduler(r: RecordRun) { return new BudgetScheduler(this.runLimits(r)); }
  private limits = { calls: 12, candidates: 3, milliseconds: 600_000 };
  private active?: {
    id: string;
    started: number;
    controller: AbortController;
    promise: Promise<void>;
  };
  constructor(
    private db: DatabaseSync,
    private driver: Driver,
    private domain: Domain,
    /** ExperienceSessionHost, or legacy budget limits as the 4th argument. */
    sessionsOrBudget?:
      | ExperienceSessionHost
      | { calls: number; candidates: number; milliseconds: number },
    budgetLimits?: { calls: number; candidates: number; milliseconds: number },
  ) {
    this.materials = new InvestigationStore(db);
    if (sessionsOrBudget instanceof ExperienceSessionHost) {
      this.sessions = sessionsOrBudget;
      if (budgetLimits) this.limits = budgetLimits;
    } else if (sessionsOrBudget) this.limits = sessionsOrBudget;
    db.exec(`CREATE TABLE IF NOT EXISTS evolution_runs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evolution_operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,runId TEXT NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS evolution_acceptance_revisions(id TEXT PRIMARY KEY,runId TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evolution_requirement_freezes(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evolution_calls(id INTEGER PRIMARY KEY,runId TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evolution_candidates(id INTEGER PRIMARY KEY,runId TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evolution_events(id INTEGER PRIMARY KEY,runId TEXT NOT NULL,sequence INTEGER NOT NULL,body TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS evolution_events_run_seq ON evolution_events(runId, sequence);`);
    if (
      !db
        .prepare("PRAGMA table_info(evolution_operations)")
        .all()
        .some((column) => column.name === "receipt")
    )
      db.exec("ALTER TABLE evolution_operations ADD COLUMN receipt TEXT");
    for (const row of db.prepare("SELECT body FROM evolution_runs").all()) {
      const record = JSON.parse(String(row.body)) as RecordRun;
      if (
        (record.run.status === "ready" ||
          record.run.status === "awaiting-apply" ||
          record.run.status === "awaiting-acceptance" ||
          (record.run.status === "applying" &&
            !this.domain.isActiveVersion(
              record.versionId ?? record.run.versionId ?? "",
            ))) &&
        !("plan" in record.run && record.run.plan.requirementGate && record.run.plan.changeSpec?.version === "change/3")
      ) {
        record.run = {
          ...this.base(record),
          historicalPlan: "plan" in record.run ? record.run.plan : undefined,
          status: "interrupted",
          message: "旧待执行或待应用计划缺少需求及浏览器门禁证据，请重新规划",
        };
        this.save(record);
      } else if (
        ["planning", "executing", "awaiting-confirmation"].includes(
          record.run.status,
        )
      ) {
        record.run = {
          ...this.base(record),
          ...(["awaiting-confirmation"].includes(record.run.status) &&
          "plan" in record.run
            ? { historicalPlan: record.run.plan }
            : {}),
          status: "interrupted",
          message:
            "旧计划须重新调查或宿主重启，未完成的运行已中断。请重新提出需求。",
        };
        this.save(record);
      } else if (record.run.status === "applying") {
        const versionId = record.versionId ?? record.run.versionId;
        const ready = !!versionId && this.domain.isReadyVersion(versionId);
        const committed = !!versionId && this.domain.isActiveVersion(versionId);
        const plan =
          "plan" in record.run
            ? (record.run as Extract<AssistantRun, { status: "applying" }>).plan
            : record.plan;
        record.run = ready
          ? {
              ...this.base(record),
              status: "succeeded",
              summary: "候选已正式应用",
              steps: this.steps(record),
            }
          : committed
            ? {
                ...this.base(record),
                status: "interrupted",
                message:
                  "发布已提交但运行未就绪。请在工作区重试运行环境；不会自动重放模型。",
              }
            : {
                ...this.base(record),
                status: "awaiting-apply",
                plan: plan as InvestigatedPlan,
                steps: this.steps(record),
                summary: `${plan && "outcome" in plan ? plan.outcome : "候选"}（应用中断，按发布事实尚未就绪或已补偿，可重新确认）`,
              };
        this.save(record);
      }
    }
  }
  private base(r: RecordRun) {
    return {
      historicalPlan: r.run.historicalPlan,
      diagnostics: [
        ...new Set([
          ...(r.run.diagnostics ?? []),
          ...("message" in r.run ? [r.run.message] : []),
        ]),
      ],
      reviewLedger: r.run.reviewLedger,
      clarificationReviews: r.run.clarificationReviews,
      requestAdmissions: r.run.requestAdmissions,
      protocolFailures: r.run.protocolFailures,
      resourceFailures: r.run.resourceFailures,
      intent: r.run.intent,
      acceptanceRevisions: r.run.acceptanceRevisions ?? [],
      parentRunId: r.run.parentRunId,
      baseVersion: r.run.baseVersion,
      capabilityId: r.run.capabilityId,
      parent: r.run.parent,
      id: r.run.id,
      request: r.run.request,
      requestRevision: r.run.requestRevision ?? 1,
      revisions: r.run.revisions ?? [],
      plans: r.run.plans ?? [],
      evidence: r.run.evidence ?? [],
      ...(r.versionId || r.run.versionId
        ? { versionId: r.versionId ?? r.run.versionId }
        : {}),
      budget: {
        efficiencyTarget: r.initialLimits?.calls ?? this.limits.calls,
        authorized: this.runLimits(r),
        grants: r.grants ?? [],
        callsUsed: r.calls,
        callsRemaining: Math.max(0, this.runLimits(r).calls - r.calls),
        candidatesRemaining: Math.max(0, this.runLimits(r).candidates - r.candidates),
        millisecondsRemaining: Math.max(
          0,
          this.runLimits(r).milliseconds - r.elapsed - (this.active?.id === r.run.id ? performance.now() - this.active.started : 0),
        ),
      },
      updatedAt: new Date().toISOString(),
    };
  }
  private checkPlan(
    r: RecordRun,
    target: Target,
    revision: number,
    plan: InvestigatedPlan,
  ) {
    try {
      if (
        r.run.requestRevision !== undefined &&
        plan.requestRevision !== r.run.requestRevision
      )
        throw new AppError("PLAN_STALE", "需求修订已变化，请重新规划", 409);
      const row = this.db
        .prepare("SELECT body FROM evolution_requirement_freezes WHERE id=?")
        .get(plan.id);
      const trusted = row
        ? (JSON.parse(String(row.body)) as RequirementGate)
        : undefined;
      if (plan.changeSpec?.runId !== r.run.id) throw new AppError("PLAN_STALE", "统一规格不属于当前运行", 409);
      if (hash(plan.questionAdjudications ?? []) !== hash(r.run.clarificationReviews ?? [])) throw new AppError("PLAN_STALE","冻结的澄清裁决已变化，请重新规划",409);
      if (this.domain.admission) {
        const context = this.domain.context();
        const reject = (code: string, message: string, detail: Record<string, unknown>) => {
          this.emit(r, {
            stepId: randomUUID(), attempt: r.candidates, label: "方案预检未通过",
            status: "failed", tool: "host:plan-preflight",
            detail: JSON.stringify({ planId: plan.id, runtimeStatus: context.runtimeStatus, ...detail }),
          });
          this.save(r);
          throw new AppError(code, message, code === "UNAVAILABLE" ? 503 : 409);
        };
        // Recovery withdraws live registrations. They are not a new frozen baseline;
        // retry only after readiness, then recheck every identity and acceptance gate.
        if (context.runtimeStatus !== "ready")
          reject("UNAVAILABLE", context.runtimeStatus === "recovering"
            ? "宿主正在恢复，暂时无法检查方案，请稍后重试"
            : "宿主运行环境不可用，请恢复宿主后重试", { reason: "runtime-not-ready" });
        const inputs = this.domain.admission(context);
        const receipt = plan.requestAdmission;
        const sources = trusted?.sources ?? [];
        const state = receipt ? admissionQuestionState(receipt, sources, inputs.facts, r.run.clarificationReviews ?? []) : undefined;
        const checks = {
          environmentAvailable: inputs.missing.length === 0,
          receiptPresent: !!receipt,
          receiptResolved: !!receipt && admissionResolved(receipt),
          factsAndSourcesBound: receipt?.key === admissionKey(context.versionId, sources, inputs.facts),
          receiptUnblocked: !!receipt && receipt.blockers.length === 0,
          questionsResolved: !!state && !state.pending.length && !state.questions.length && !state.blockers.length,
          receiptRecorded: !!receipt && !!r.run.requestAdmissions?.some(a => hash(a) === hash(receipt)),
        };
        if (Object.values(checks).some(passed => !passed)) {
          const previousFacts = new Map((receipt?.factsSnapshot ?? []).map(fact => [fact.id, fact]));
          const currentFacts = new Map(inputs.facts.map(fact => [fact.id, fact]));
          reject("PLAN_STALE", "需求预检事实或来源已变化，请重新规划", {
            reason: "admission-invalid", checks, missing: inputs.missing,
            baseVersion: { frozen: receipt?.baseVersion, current: context.versionId },
            sourcesHash: { frozen: hash(receipt?.sources), current: hash(sources) },
            changedFacts: [...new Set([...previousFacts.keys(), ...currentFacts.keys()])]
              .filter(id => hash(previousFacts.get(id)) !== hash(currentFacts.get(id)))
              .map(id => ({ id, frozenHash: hash(previousFacts.get(id)), currentHash: hash(currentFacts.get(id)) })),
          });
        }
      }
      const failure = gateFailure(plan, trusted, hash(r.run.revisions), r.run.reviewLedger);
      if (failure) throw new AppError("PLAN_STALE", failure, 409);
      this.domain.check(target, revision, plan);
    } catch (error) {
      if (error instanceof AppError && error.code === "PLAN_STALE") {
        r.run = { ...r.run, staleReason: error.message };
        this.save(r);
      }
      throw error;
    }
  }
  private steps(r: RecordRun): AssistantStep[] {
    return "steps" in r.run ? r.run.steps : [];
  }
  private alive(id: string) {
    return this.get(id).run.status === "executing";
  }
  private save(r: RecordRun) {
    if (r.run.status === "awaiting-input" && r.initialLimits && !r.run.questions) {
      const questions = r.run.clarificationReviews?.filter(v => r.run.status === "awaiting-input" && (r.run.question === v.question || r.run.question.split("\n").includes(v.question))).map(v => v.question) ?? [];
      r.run.questions = questionsFor(r.run.id, r.run.requestRevision ?? 1, [...new Set(questions)], r.run.clarificationReviews ?? []);
      r.run.questionRevision = r.run.requestRevision ?? 1;
    }
    this.db
      .prepare(
        "INSERT INTO evolution_runs VALUES(?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
      )
      .run(r.run.id, JSON.stringify(r));
  }
  private get(id: string) {
    const row = this.db
      .prepare("SELECT body FROM evolution_runs WHERE id=?")
      .get(id);
    if (!row) throw new AppError("RUN_NOT_FOUND", "找不到这次运行", 404);
    return JSON.parse(String(row.body)) as RecordRun;
  }
  private events(runId: string, afterSequence = 0): AssistantEvent[] {
    return this.db
      .prepare(
        "SELECT body FROM evolution_events WHERE runId=? AND sequence>? ORDER BY sequence",
      )
      .all(runId, afterSequence)
      .map((row) => JSON.parse(String(row.body)) as AssistantEvent);
  }
  private emit(
    r: RecordRun,
    event: Omit<AssistantEvent, "sequence" | "at"> & { at?: string },
  ) {
    // A restored/rejected run record may lag behind its durable diagnostic events.
    const latest = this.db.prepare("SELECT MAX(sequence) AS sequence FROM evolution_events WHERE runId=?").get(r.run.id);
    const sequence = Math.max(r.eventSequence ?? 0, Number(latest?.sequence ?? 0)) + 1;
    r.eventSequence = sequence;
    const body: AssistantEvent = {
      ...event,
      sequence,
      at: event.at ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        "INSERT INTO evolution_events(runId,sequence,body) VALUES(?,?,?)",
      )
      .run(r.run.id, sequence, JSON.stringify(body));
    return body;
  }
  private normalizeRun(run: AssistantRun | null): AssistantRun | null {
    if (!run || run.status !== "blocked") return run;
    if (run.userMessage && run.blockReason) return run;
    const described = describeBlockers(
      run.message ? run.message.split("；") : [],
    );
    return {
      ...run,
      message: run.message || described.message,
      userMessage: run.userMessage ?? described.userMessage,
      blockReason: run.blockReason ?? described.blockReason,
    };
  }
  private snapshot(
    run: AssistantRun | null,
    afterSequence = 0,
  ): AssistantSnapshot {
    run = this.normalizeRun(run);
    if (!run)
      return { availability: "ready", run: null, events: [], eventCursor: 0 };
    if (run.status === "awaiting-apply" && run.experienceSession) {
      const session = this.sessions?.observe({
        sessionId: run.experienceSession.id,
        runId: run.id,
      });
      run = {
        ...run,
        experienceSession:
          session && session.status !== "none"
            ? session
            : {
                ...run.experienceSession,
                status: "ended",
                note: "体验会话已结束，请重新打开体验。",
              },
      };
    }
    const events = this.events(run.id, afterSequence);
    const cursor = events.at(-1)?.sequence ?? afterSequence;
    const candidates = this.db
      .prepare(
        "SELECT body FROM evolution_candidates WHERE runId=? ORDER BY id",
      )
      .all(run.id)
      .map((row) => {
        const stored = JSON.parse(String(row.body)) as CandidateAttempt;
        return {
          id: stored.id,
          planId: stored.planId,
          baseVersion: stored.baseVersion,
          attempt: stored.attempt,
          passed: stored.passed,
          sourceHash: stored.sourceHash,
          ...(stored.requirementSeal
            ? { requirementSeal: stored.requirementSeal }
            : {}),
          ...(stored.browser ? { browser: stored.browser } : {}),
          ...(stored.delta ? { delta: stored.delta } : {}),
          ...(stored.diagnostic ? { diagnostic: stored.diagnostic } : {}),
          ...(stored.evidenceHash ? { evidenceHash: stored.evidenceHash } : {}),
          ...(stored.versionId ? { versionId: stored.versionId } : {}),
        };
      });
    return {
      availability: "ready",
      run,
      events,
      eventCursor: cursor,
      candidates,
    };
  }
  /** A settled status is public only after its phase has charged time and released ownership. */
  private async publishedRecord(runId?: string): Promise<RecordRun | null> {
    let record: RecordRun | null;
    if (runId) record = this.get(runId);
    else {
      const row = this.db.prepare("SELECT body FROM evolution_runs ORDER BY rowid DESC LIMIT 1").get();
      record = row ? JSON.parse(String(row.body)) as RecordRun : null;
    }
    const phase = this.active;
    if (
      record && phase?.id === record.run.id &&
      !["planning", "executing", "applying"].includes(record.run.status)
    ) {
      await phase.promise;
      record = this.get(record.run.id);
    }
    return record;
  }
  async observe(runId?: string, afterSequence = 0): Promise<AssistantSnapshot> {
    return this.snapshot((await this.publishedRecord(runId))?.run ?? null, afterSequence);
  }
  private priorCommand(command: AssistantCommand): AssistantSnapshot | undefined {
    const prior = this.db
      .prepare("SELECT hash,runId,receipt FROM evolution_operations WHERE id=?")
      .get(command.operationId);
    if (prior) {
      if (prior.hash !== hash(command))
        throw new AppError(
          "IDEMPOTENCY_MISMATCH",
          "操作标识已用于其他请求",
          409,
        );
      return prior.receipt
        ? (JSON.parse(String(prior.receipt)) as AssistantSnapshot)
        : this.snapshot(this.get(String(prior.runId)).run);
    }
  }
  async command(command: AssistantCommand): Promise<AssistantSnapshot> {
    const commandHash = hash(command);
    const prior = this.priorCommand(command);
    if (prior) return prior;
    // Cancellation must remain immediate while all other transitions wait for a published phase.
    if (command.type !== "cancel" && this.active) {
      await this.publishedRecord("runId" in command ? command.runId : undefined);
      // Another caller may have committed this operation while publication was awaited.
      const settled = this.priorCommand(command);
      if (settled) return settled;
    }
    let record: RecordRun;
    let boundAnswers: Omit<import("../shared/evolution-interaction.js").AnsweredQuestion,"sourceRevision">[] | undefined;
    let work: "plan" | "execute" | "apply" | undefined;
    let applyOp: string | undefined;
    let refreshApplyReceipt = false;
    if (
      command.type === "continue" ||
      command.type === "request" ||
      command.type === "answer" ||
      command.type === "revise"
    ) {
      const latestRow = this.db
        .prepare("SELECT body FROM evolution_runs ORDER BY rowid DESC LIMIT 1")
        .get();
      const latest = latestRow
        ? (JSON.parse(String(latestRow.body)) as RecordRun).run
        : null;
      if (
        this.active ||
        (latest &&
          !terminal(latest.status) &&
          !(editable(latest.status) && latest.id === command.runId))
      )
        throw new AppError(
          command.type === "revise" || command.type === "answer"
            ? "REQUEST_LOCKED"
            : "EVOLUTION_BUSY",
          latest &&
          ["executing", "awaiting-apply", "applying"].includes(latest.status)
            ? "需求已锁定，请先停止当前执行"
            : "请先完成或取消当前方案",
          409,
        );
      record = {
        run: {
          id: randomUUID(),
          intent: "intent" in command ? command.intent : undefined,
          request: command.text,
          updatedAt: new Date().toISOString(),
          status: "planning",
          requestRevision: 1,
          revisions: [
            {
              revision: 1,
              type: "request",
              text: command.text,
              createdAt: new Date().toISOString(),
            },
          ],
          plans: [],
          evidence: [],
        },
        initialLimits: {...this.limits},
        authorizedLimits: {...this.limits},
        grants: [],
        history: [],
        calls: 0,
        candidates: 0,
        elapsed: 0,
        eventSequence: 0,
      };
      if (command.type === "continue") {
        const previous = this.get(command.runId);
        if (!terminal(previous.run.status))
          throw new AppError(
            "REQUEST_LOCKED",
            "请先停止当前运行，再重新规划",
            409,
          );
        const context = this.domain.context();
        if (
          command.baseVersion !== context.versionId ||
          (previous.run.status === "succeeded" &&
            previous.run.versionId !== context.versionId) ||
          (previous.run.capabilityId &&
            previous.run.capabilityId !== context.pluginId)
        )
          throw new AppError(
            "PLAN_STALE",
            "已发布版本或能力已变化，请基于当前版本重新提出需求",
            409,
          );
        record.run = {
          ...record.run,
          parentRunId: previous.run.id,
          baseVersion: context.versionId,
          capabilityId: context.pluginId,
          parent: {
            status: previous.run.status,
            ...("message" in previous.run
              ? { message: previous.run.message }
              : previous.run.diagnostics?.length
                ? { message: previous.run.diagnostics.join("；") }
                : {}),
            budget: previous.run.budget,
          },
        };
      } else if (command.runId) {
        const previous = this.get(command.runId);
        if (!editable(previous.run.status) || latest?.id !== previous.run.id)
          throw new AppError("PLAN_STALE", "请重新提出需求", 409);
        if (
          command.type === "answer" &&
          previous.run.status !== "awaiting-input"
        )
          throw new AppError("REQUEST_LOCKED", "当前不等待回答", 409);
        if (
          previous.candidates > 0 ||
          (previous.run.status === "blocked" && previous.target)
        )
          throw new AppError(
            "REQUEST_LOCKED",
            "执行后调整需求须通过 continue 重新规划和开始",
            409,
          );
        record = previous;
        if (command.type === "answer" && previous.run.status === "awaiting-input" && previous.run.questions?.length) {
          if (command.questionRevision !== previous.run.questionRevision || !command.answers) throw new AppError("QUESTION_STALE", "请回答当前问题，旧回答不能覆盖新问题", 409);
          const publishedQuestions = previous.run.questions;
          const submittedAnswers = command.answers;
          answerText(publishedQuestions,submittedAnswers);
          boundAnswers = publishedQuestions.map(q=>({questionId:q.id,question:q.title,answer:answerText([q],[submittedAnswers.find(a=>a.questionId===q.id)!])}));
          command = {...command, text: boundAnswers.map(a=>a.answer).join("\n\n")};
        }
        record.planner = undefined;
        record.memoReplies = undefined;
        const revision = (previous.run.requestRevision ?? 1) + 1;
        record.history = [];
        record.run = {
          ...this.base(record),
          request:
            command.type === "revise" ? command.text : previous.run.request,
          requestRevision: revision,
          revisions: [
            ...(previous.run.revisions ?? []),
            {
              revision,
              type: command.type === "revise" ? "revise" : "answer",
              text: command.text,
              ...(boundAnswers ? {answers:boundAnswers} : {}),
              createdAt: new Date().toISOString(),
            },
          ],
          evidence: previous.run.evidence,
          status: "planning",
        };
      }
      work = "plan";
    } else if (command.type === "resume-budget") {
      record = this.get(command.runId);
      const run = record.run;
      if (run.status !== "awaiting-budget" || run.pause.revision !== command.pauseRevision || !record.initialLimits) throw new AppError("BUDGET_PAUSE_STALE", "追加请求已过期，请刷新当前进度", 409);
      const context = this.domain.context();
      if (context.versionId !== run.baseVersion || context.pluginId !== run.capabilityId) throw new AppError("PLAN_STALE", "基础版本已变化，请结束本次改进后重新规划", 409);
      if (run.pause.resume === "execute") this.checkPlan(record, record.target!, (record.plan as InvestigatedPlan).compositionRevision, record.plan as InvestigatedPlan);
      const limits = this.runLimits(record);
      for (const resource of ["calls", "candidates", "milliseconds"] as const) {
        const value = command.amounts[resource];
        if (!Number.isSafeInteger(value) || value < run.pause.minimum[resource] || !Number.isSafeInteger(limits[resource] + value)) throw new AppError("BUDGET_GRANT_TOO_SMALL", "追加资源不足以恢复当前阶段", 400);
      }
      record.authorizedLimits = {calls: limits.calls + command.amounts.calls, candidates: limits.candidates + command.amounts.candidates, milliseconds: limits.milliseconds + command.amounts.milliseconds};
      (record.grants ??= []).push({operationId: command.operationId, pauseRevision: command.pauseRevision, amounts: command.amounts, at: new Date().toISOString()});
      work = run.pause.resume;
      record.run = work === "plan" ? {...this.base(record),status:"planning"} : {...this.base(record),status:"executing",plan:record.plan as InvestigatedPlan,steps:this.steps(record)};
    } else if (command.type === "cancel") {
      record = this.get(command.runId);
      this.sessions?.endForRun(record.run.id);
      if (!terminal(record.run.status) || record.run.status === "blocked") {
        const wasApplying = record.run.status === "applying";
        if (this.active?.id === record.run.id)
          this.active.controller.abort(new Error("已取消"));
        if (wasApplying) {
          refreshApplyReceipt = true;
          const versionId = record.versionId ?? record.run.versionId;
          if (versionId && this.domain.isReadyVersion(versionId)) {
            record.run = {
              ...this.base(record),
              status: "succeeded",
              summary: "候选已正式应用（按发布事实恢复）",
              steps: this.steps(record),
              versionId,
            };
          } else if (versionId && this.domain.isActiveVersion(versionId)) {
            // Committed but writes not open yet — keep applying; reconcile on readiness.
            refreshApplyReceipt = false;
          } else {
            record.run = { ...this.base(record), status: "cancelled" };
          }
        } else {
          record.run = { ...this.base(record), status: "cancelled" };
        }
      }
    } else if (command.type === "confirm-acceptance") {
      record = this.get(command.runId);
      if (
        record.run.status !== "awaiting-acceptance" ||
        record.run.plan.id !== command.planId ||
        record.run.acceptanceRevision.id !== command.revisionId
      )
        throw new AppError(
          "ACCEPTANCE_STALE",
          "验收修订已变化或需求已锁定，请重新比较规则",
          409,
        );
      const plan = record.run.plan;
      this.checkPlan(
        record,
        this.domain.target(plan),
        plan.compositionRevision,
        plan,
      );
      const revision = {
        ...record.run.acceptanceRevision,
        confirmedAt: new Date().toISOString(),
      };
      record.run = {
        ...this.base(record),
        status: "ready",
        plan: { ...plan, acceptanceRevision: revision },
        acceptanceRevisions: [
          ...(record.run.acceptanceRevisions ?? []),
          revision,
        ],
      };
    } else if (command.type === "start") {
      record = this.get(command.runId);
      if (record.run.status !== "ready" || !("plan" in record.run))
        throw new AppError("PLAN_STALE", "没有可开始的计划", 409);
      const plan = record.run.plan as InvestigatedPlan;
      if (command.planId !== plan.id)
        throw new AppError("PLAN_STALE", "开始与计划不一致", 409);
      if (
        plan.acceptanceChanges?.length &&
        (!plan.acceptanceRevision?.confirmedAt ||
          plan.acceptanceRevision.planId !== plan.id ||
          hash(plan.acceptanceRevision.changes) !==
            hash(plan.acceptanceChanges))
      )
        throw new AppError(
          "ACCEPTANCE_STALE",
          "请先确认本计划的业务验收修订",
          409,
        );
      const target = this.domain.target(plan);
      this.checkPlan(record, target, plan.compositionRevision, plan);
      record.target = target;
      record.plan = structuredClone(plan);
      record.versionId = undefined;
      record.history = [];
      record.run = {
        ...this.base(record),
        status: "executing",
        plan: structuredClone(plan),
        steps: [],
      };
      delete record.run.versionId;
      work = "execute";
    } else if (command.type === "experience") {
      record = this.get(command.runId);
      if (record.run.status !== "awaiting-apply" || !("plan" in record.run))
        throw new AppError("PLAN_STALE", "没有可体验的候选", 409);
      const candidate = this.candidateOf(record.run.id, command.candidateId);
      if (
        !candidate.passed ||
        !candidate.versionId ||
        !candidate.evidenceHash ||
        candidate.versionId !== (record.versionId ?? record.run.versionId)
      )
        throw new AppError(
          "CANDIDATE_MISMATCH",
          "候选已过期或不匹配，请重新规划",
          409,
        );
      if (!this.sessions)
        throw new AppError("UNAVAILABLE", "候选体验会话未配置", 503);
      const plan = record.run.plan as InvestigatedPlan;
      const target = record.target ?? this.domain.target(plan);
      this.checkPlan(record, target, plan.compositionRevision, plan);
      this.domain.verifyAcceptance?.(candidate.versionId, plan);
      const snapshot = await this.sessions.start({
        runId: record.run.id,
        candidateId: candidate.id,
        versionId: candidate.versionId,
        evidenceHash: candidate.evidenceHash,
        compositionRevision: plan.compositionRevision,
        signal: AbortSignal.timeout(experienceRequestTimeoutMs),
      });
      record.run = {
        ...record.run,
        experienceSession: {
          id: snapshot.id,
          status: "active",
          banner: experienceSessionBanner,
          runId: snapshot.runId,
          candidateId: snapshot.candidateId,
          taskId: snapshot.taskId,
          note: snapshot.note,
        },
        updatedAt: new Date().toISOString(),
      };
    } else if (command.type === "apply") {
      record = this.get(command.runId);
      if (record.run.status !== "awaiting-apply" || !("plan" in record.run))
        throw new AppError("PLAN_STALE", "没有可应用的候选", 409);
      const plan = record.run.plan as InvestigatedPlan;
      const candidate = this.candidateOf(record.run.id, command.candidateId);
      if (
        !candidate.passed ||
        !candidate.evidenceHash ||
        candidate.evidenceHash !== command.evidenceHash ||
        !candidate.versionId ||
        candidate.versionId !== (record.versionId ?? record.run.versionId)
      )
        throw new AppError(
          "CANDIDATE_MISMATCH",
          "候选或证据摘要不匹配或已过期，请重新规划",
          409,
        );
      const target = record.target ?? this.domain.target(plan);
      this.checkPlan(record, target, command.compositionRevision, plan);
      if (
        candidate.evidenceHash !==
        candidateEvidenceHash(
          candidate,
          plan,
          this.domain.acceptanceEvidence(candidate.versionId),
        )
      )
        throw new AppError("CANDIDATE_MISMATCH", "候选最终证据摘要已变化", 409);
      if (candidate.requirementSeal !== plan.requirementGate?.seal)
        throw new AppError("CANDIDATE_MISMATCH", "候选需求摘要已变化", 409);
      this.domain.verifyAcceptance?.(candidate.versionId, plan);
      this.sessions?.endForRun(record.run.id);
      record.target = target;
      record.versionId = candidate.versionId;
      record.applyRevision = command.compositionRevision;
      record.applyOperationId = command.operationId;
      record.run = {
        ...this.base(record),
        status: "applying",
        plan: structuredClone(plan),
        steps: this.steps(record),
        summary: "正在应用已验证候选…",
        versionId: candidate.versionId,
      };
      applyOp = command.operationId;
      work = "apply";
    } else {
      throw new AppError("INVALID_INPUT", "AI 请求格式无效");
    }
    if (record.initialLimits) record.run = {...record.run,...this.base(record)};
    this.db.exec("BEGIN IMMEDIATE");
    let receipt: AssistantSnapshot;
    try {
      this.save(record);
      if (
        command.type === "confirm-acceptance" &&
        record.run.status === "ready"
      ) {
        const revision = record.run.plan.acceptanceRevision!;
        this.db
          .prepare("INSERT INTO evolution_acceptance_revisions VALUES(?,?,?)")
          .run(revision.id, record.run.id, JSON.stringify(revision));
      }
      receipt = this.snapshot(this.get(record.run.id).run);
      this.db
        .prepare(
          "INSERT INTO evolution_operations(id,hash,runId,receipt) VALUES(?,?,?,?)",
        )
        .run(
          command.operationId,
          commandHash,
          record.run.id,
          JSON.stringify(receipt),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (work) this.start(record, work, applyOp);
    if (refreshApplyReceipt && record.applyOperationId)
      this.updateReceipt(record.applyOperationId, this.snapshot(record.run));
    return receipt;
  }
  private updateReceipt(operationId: string, snapshot: AssistantSnapshot) {
    this.db
      .prepare("UPDATE evolution_operations SET receipt=? WHERE id=?")
      .run(JSON.stringify(snapshot), operationId);
  }
  private finishApply(
    record: RecordRun,
    versionId: string,
    summary: string,
    applyOperationId?: string,
  ) {
    record.run = {
      ...this.base(record),
      status: "succeeded",
      summary,
      steps: this.steps(record),
      versionId,
    };
    this.save(record);
    if (applyOperationId)
      this.updateReceipt(applyOperationId, this.snapshot(record.run));
  }
  private candidateOf(runId: string, candidateId: string): CandidateAttempt {
    const row = this.db
      .prepare(
        "SELECT body FROM evolution_candidates WHERE runId=? ORDER BY id",
      )
      .all(runId)
      .map((item) => JSON.parse(String(item.body)) as CandidateAttempt)
      .find((item) => item.id === candidateId);
    if (!row)
      throw new AppError(
        "CANDIDATE_MISMATCH",
        "候选已过期或不匹配，请重新规划",
        409,
      );
    return row;
  }
  private start(
    record: RecordRun,
    kind: "plan" | "execute" | "apply",
    applyOperationId?: string,
  ) {
    const controller = new AbortController();
    const started = performance.now();
    const timer = setTimeout(
      () => controller.abort(new DOMException(`已达到 ${this.runLimits(record).milliseconds / 60_000} 分钟活动时间上限`, "TimeoutError")),
      Math.max(1, this.runLimits(record).milliseconds - record.elapsed),
    );
    const promise = Promise.resolve().then(async () => {
      try {
        if (kind === "plan") await this.plan(record, controller.signal);
        else if (kind === "execute")
          await this.execute(record, controller.signal);
        else {
          const current = this.get(record.run.id);
          if (current.run.status !== "applying") {
            const versionId = current.versionId ?? current.run.versionId;
            if (
              versionId &&
              this.domain.isReadyVersion(versionId) &&
              current.run.status !== "succeeded"
            )
              this.finishApply(
                current,
                versionId,
                "候选已正式应用（按发布事实恢复）",
                applyOperationId ?? current.applyOperationId,
              );
            return;
          }
          const plan =
            "plan" in current.run
              ? current.run.plan
              : (current.plan as InvestigatedPlan);
          const target = current.target ?? this.domain.target(plan);
          const versionId = current.versionId ?? current.run.versionId;
          const revision = current.applyRevision;
          if (!versionId || !applyOperationId || revision === undefined)
            throw new Error("缺少应用所需的候选、修订或操作标识");
          await this.domain.apply(
            versionId,
            target,
            revision,
            applyOperationId,
            () => undefined,
            controller.signal,
          );
          const after = this.get(record.run.id);
          if (!this.domain.isReadyVersion(versionId)) {
            if (after.run.status !== "applying") return;
            throw new Error("应用提交后运行未就绪");
          }
          this.finishApply(
            after,
            versionId,
            after.run.status === "applying"
              ? "候选已正式应用"
              : "候选已正式应用（按发布事实恢复）",
            applyOperationId,
          );
        }
      } catch (error) {
        const persisted = this.get(record.run.id);
        if (kind === "apply") {
          const versionId = persisted.versionId ?? persisted.run.versionId;
          const opId = applyOperationId ?? persisted.applyOperationId;
          if (versionId && this.domain.isReadyVersion(versionId)) {
            if (persisted.run.status !== "succeeded")
              this.finishApply(
                persisted,
                versionId,
                "候选已正式应用（按发布事实恢复）",
                opId,
              );
            return;
          }
          if (persisted.run.status === "applying") {
            const plan =
              "plan" in persisted.run
                ? persisted.run.plan
                : (persisted.plan as InvestigatedPlan);
            record.run = {
              ...this.base(persisted),
              status: "awaiting-apply",
              plan: plan as InvestigatedPlan,
              steps: this.steps(persisted),
              summary: `${plan && "outcome" in plan ? plan.outcome : "候选"}（候选已验证，尚未正式就绪；可按版本与回执重新确认应用）`,
              versionId,
            };
            this.save(record);
            if (opId) this.updateReceipt(opId, this.snapshot(record.run));
            return;
          }
        }
        if (!terminal(persisted.run.status)) {
          const message = error instanceof Error ? error.message : "运行失败";
          const interrupted = message.includes("宿主停止");
          record.run = interrupted
            ? {
                ...this.base(record),
                status: "interrupted",
                message:
                  "旧计划须重新调查或宿主重启，未完成的运行已中断。请重新提出需求。",
              }
            : error instanceof ModelTransportError && error.httpStatus === 400 ? {
                ...this.base(record),status:"blocked",...describeBlockers(["维护者模型契约被供应商拒绝（HTTP 400），停止业务规划并保留传输证据：" + message]),
              } : error instanceof BudgetExhaustedError && error.resource !== "candidates" || error instanceof ModelProtocolError ? {
                ...this.base(record), status: "blocked", ...describeBlockers([message]),
              } : {
                ...this.base(record),
                status: "failed",
                message,
                steps: this.steps(persisted).map((s) =>
                  s.status === "running" ? { ...s, status: "failed" } : s,
                ),
              };
          const timeBudget = controller.signal.aborted && controller.signal.reason instanceof DOMException && controller.signal.reason.name === "TimeoutError";
          if (kind !== "apply" && record.initialLimits && (error instanceof BudgetExhaustedError || timeBudget)) {
            const pause = budgetPause({revision: (record.pauseRevision ?? 0) + 1, resume: kind, phase: error instanceof BudgetExhaustedError ? error.phase ?? kind : kind, resource: error instanceof BudgetExhaustedError ? error.resource : "milliseconds", limits: this.runLimits(record), calls: record.calls, candidates: record.candidates, elapsed: record.elapsed + performance.now() - started, message});
            record.pauseRevision = pause.revision;
            record.run = {...this.base(record), status:"awaiting-budget", pause, ...(record.plan ? {plan:record.plan as InvestigatedPlan}:{}), steps:this.steps(record)};
          }
          this.save(record);
          const lastCall = this.db.prepare("SELECT body FROM evolution_calls WHERE runId=? ORDER BY id DESC LIMIT 1").get(record.run.id);
          const phase = (error instanceof ModelProtocolError || error instanceof ModelTransportError || error instanceof ModelResourceError) && lastCall ?
            (JSON.parse(String(lastCall.body)) as {phase:string}).phase : kind === "execute" ? "execution" : kind === "apply" ? "apply" : "planning";
          const stop = stopForError(error, phase, record.calls, controller.signal);
          if (stop) {
            record.run.stop = stop;
            this.save(record);
          }
        }
      } finally {
        clearTimeout(timer);
        const current = this.get(record.run.id);
        current.elapsed += performance.now() - started;
        if (this.active?.id === record.run.id) this.active = undefined;
        current.run = { ...current.run, ...this.base(current) };
        this.save(current);
        if (this.active?.id === record.run.id) this.active = undefined;
      }
    });
    this.active = { id: record.run.id, started, controller, promise };
  }
  private async call(
    r: RecordRun,
    request: ModelRequest,
    signal: AbortSignal,
    phase: ModelPhase = "planning",
    validate?: (reply: ModelReply) => unknown,
  ): Promise<ModelReply> {
    request={...request,phase};
    const memoKey = phase === "review" || phase === "admission" ? hash(request) : undefined;
    if (memoKey && r.memoReplies?.[memoKey]) return structuredClone(r.memoReplies[memoKey]);
    const original = request;
    for (let attempt = 0; ; attempt++) {
      const reply = await this.callOnce(r, request, signal, phase);
      if(reply.transport?.finishReason==="length") {
        (r.run.resourceFailures??=[]).push({phase,call:r.calls,kind:"output-budget",requestHash:hash(original),responseHash:hash(reply.raw),finishReason:"length",usage:reply.usage});
        this.save(r);
        throw new ModelResourceError("模型输出预算耗尽，保留原始响应与用量并停止；不以相同参数重试：length");
      }
      const problems = replyProblems(original, reply);
      if (!problems.length && validate) {
        try { validate(reply); }
        catch (error) {problems.push(error instanceof Error ? error.message : "宿主来源绑定校验未通过");}
      }
      if (!problems.length) {
        if (memoKey) { (r.memoReplies ??= {})[memoKey] = structuredClone(reply); this.save(r); }
        return reply;
      }
      (r.run.protocolFailures ??= []).push({phase,call:r.calls,requestHash:hash(original),responseHash:hash(reply.raw),problems});
      this.save(r);
      if (attempt || r.run.protocolFailures.length > 2)
        throw new ModelProtocolError("模型协议未收敛，保留原始响应与用量：" + problems.join("；"));
      // A single budgeted protocol correction at this seam, never a new run or transport retry.
      let input: Record<string,unknown>;
      try { input = JSON.parse(original.message ?? "{}"); }
      catch { input = {originalMessage:original.message}; }
      request = {...original, message:JSON.stringify({...input,protocolCorrection:{problems,rejected:{text:reply.text,calls:reply.calls},attempt:attempt+1,budget:this.base(r).budget}})};
    }
  }
  private remainingTime(r: RecordRun) {
    return this.base(r).budget!.millisecondsRemaining;
  }
  private async callOnce(
    r: RecordRun,
    request: ModelRequest,
    signal: AbortSignal,
    phase: ModelPhase = "planning",
  ): Promise<ModelReply> {
    signal.throwIfAborted();
    const remaining = this.remainingTime(r);
    this.scheduler(r).admit(r.calls, phase, remaining);
    const modelMilliseconds = this.scheduler(r).modelWindow(phase, remaining);
    request = { ...request, resourceWindow: { remainingMilliseconds: remaining, reservedMilliseconds: Math.max(0, remaining - modelMilliseconds), modelMilliseconds } };
    if (r.calls >= this.runLimits(r).calls)
      throw new BudgetExhaustedError(`已达到 ${this.runLimits(r).calls} 次模型调用上限`);
    r.calls++;
    if (phase !== "review" && phase !== "admission" && r.investigation && r.pendingMaterials?.length) {
      this.materials.delivered(r.investigation, phase, r.calls, r.pendingMaterials);
      r.pendingMaterials = [];
    }
    r.run = { ...r.run, ...this.base(r) };
    this.save(r);
    const startedAt = new Date().toISOString();
    const entry = this.db
      .prepare("INSERT INTO evolution_calls(runId,body) VALUES(?,?)")
      .run(
        r.run.id,
        JSON.stringify({ startedAt, request, phase, status: "calling", usage: null }),
      );
    let reply: ModelReply;
    let transport: ModelReply["transport"];
    const transportStarted = performance.now();
    const phaseController = new AbortController();
    const phaseTimer = remaining > modelMilliseconds ? setTimeout(() => phaseController.abort(new BudgetExhaustedError("本阶段已用完模型时间窗口，保留后续候选与验收时间并停止", "milliseconds", phase)), modelMilliseconds) : undefined;
    const callSignal = AbortSignal.any([signal, phaseController.signal]);
    try {
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(callSignal.reason ?? new Error("调查已停止"));
        callSignal.addEventListener("abort", abort, { once: true });
        if (callSignal.aborted) abort();
      });
      try {
        reply = await Promise.race([
          this.driver.generate(request, callSignal, (progress) => { transport = progress; }),
          cancelled,
        ]);
      } finally {
        callSignal.removeEventListener("abort", abort);
      }
    } catch (error) {
      this.db.prepare("UPDATE evolution_calls SET body=? WHERE id=?").run(
        JSON.stringify({
          startedAt,
          request,
          phase,
          status: "failed",
          endedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "Model call failed",
          usage: null,
          ...(error instanceof ModelTransportError ? {transport:error.transport,httpStatus:error.httpStatus} : transport ? {
            transport: {...transport, failure: transportFailure(error, "", performance.now() - transportStarted, callSignal)},
          } : {}),
        }),
        entry.lastInsertRowid,
      );
      throw !signal.aborted && phaseController.signal.aborted ? phaseController.signal.reason : error;
    } finally {
      clearTimeout(phaseTimer);
    }
    this.db.prepare("UPDATE evolution_calls SET body=? WHERE id=?").run(
      JSON.stringify({
        startedAt,
        request,
        phase,
        status: "returned",
        endedAt: new Date().toISOString(),
        response: reply.raw,
        usage: reply.usage,
        transport: reply.transport,
      }),
      entry.lastInsertRowid,
    );
    signal.throwIfAborted();
    r.history = reply.history;
    this.save(r);
    return reply;
  }

  private budgetInstruction(r: RecordRun, instruction: string) {
    return `${instruction}\n宿主预算（本轮开始前，callsRemaining 包含本轮）：${JSON.stringify(this.base(r).budget)}。规划与生成共享此预算；宿主已为候选生成和失败修正保留执行调用，不得为节省调用省略复核、降低要求或重置上限。已知且独立的补充读取应在同一回复中合批请求，避免逐项往返。`;
  }

  private resultText(value: unknown) {
    if (typeof value !== "string" || !value.trim() || value.length > 5000)
      throw new Error("调查结论文本无效");
    return value.trim();
  }
  private beginStep(
    r: RecordRun,
    label: string,
    attempt: number,
    tool?: string,
  ) {
    if (!this.alive(r.run.id)) return null;
    const stepId = randomUUID();
    const steps = [
      ...this.steps(r),
      { id: stepId, label, status: "running" as const, attempt },
    ];
    r.run = {
      ...this.base(r),
      status: "executing",
      plan: r.plan as InvestigatedPlan,
      steps,
    };
    this.emit(r, {
      stepId,
      attempt,
      label,
      status: "started",
      ...(tool ? { tool } : {}),
    });
    this.save(r);
    return stepId;
  }
  private endStep(
    r: RecordRun,
    stepId: string | null,
    status: "succeeded" | "failed",
    detail?: string,
    tool?: string,
  ) {
    if (!stepId || !this.alive(r.run.id)) return;
    const step = this.steps(r).find((s) => s.id === stepId);
    if (!step) return;
    r.run = {
      ...this.base(r),
      status: "executing",
      plan: r.plan as InvestigatedPlan,
      steps: this.steps(r).map((s) => (s.id === stepId ? { ...s, status } : s)),
    };
    this.emit(r, {
      stepId,
      attempt: step.attempt ?? 1,
      label: step.label,
      status,
      ...(tool ? { tool } : {}),
      detail,
    });
    this.save(r);
  }
  private toolEvent(
    r: RecordRun,
    tool: string,
    status: "started" | "succeeded" | "failed",
    attempt: number,
    detail?: string,
  ) {
    if (!this.alive(r.run.id)) return;
    this.emit(r, {
      stepId: `tool:${tool}:${attempt}:${status}`,
      attempt,
      label: tool,
      status,
      tool,
      detail,
    });
    this.save(r);
  }
  private async auditQuestions(r: RecordRun, questions: string[], sources: RequirementGate["sources"], facts: ReturnType<typeof technicalFacts>, signal: AbortSignal, targets?: ReturnType<typeof semanticChoiceProof>[], admissionTargets?: AdmissionQuestionTarget[]) {
    const cached = questions.map((question,index) => r.run.clarificationReviews?.find(a => a.key === questionReviewKey(question,sources,facts) && hash(a.choice) === hash(targets?.[index].proof) && hash(a.admissionChoice) === hash(admissionTargets?.[index] ? admissionChoiceProof(admissionTargets[index]) : undefined)));
    if (r.planner?.response && cached.every(Boolean)) return cached.map(a => ({question:a!.question,decision:a!.decision,choice:a!.choice,admissionChoice:a!.admissionChoice}));
    this.scheduler(r).requireClarification(r.calls, false, this.remainingTime(r), true);
    if (questions.some((question,index) => r.run.clarificationReviews?.some(a => a.key === questionReviewKey(question,sources,facts) && hash(a.choice)===hash(targets?.[index].proof) && hash(a.admissionChoice)===hash(admissionTargets?.[index] ? admissionChoiceProof(admissionTargets[index]) : undefined))))
      throw new ModelProtocolError("相同澄清已审查且没有新证据，保留原预算并停止");
    const history = r.history;
    try {
      const request = clarificationRequest(questions,sources,facts,targets,admissionTargets);
      const context = this.domain.context();
      if (context.versionId !== r.run.baseVersion) throw new AppError("PLAN_STALE", "基础版本已变化，请重新规划", 409);
      request.message = JSON.stringify({...JSON.parse(request.message!),baselineDefaults:reviewedBaselineDefaults(context)});
      const parse = (text:string) => parseClarificationReview(text,questions,sources,facts,admissionTargets,targets);
      const reply = await this.call(r,request,signal,"review",reply => parse(reply.text));
      signal.throwIfAborted();
      const decisions = parse(reply.text).map((d,index)=>({...d,...(targets?.[index]?{choice:targets[index].proof}:{})}));
      for (const {question,decision,choice,admissionChoice} of decisions)
        (r.run.clarificationReviews ??= []).push({key:questionReviewKey(question,sources,facts),question,call:r.calls,decision,...(choice?{choice}:{}),...(admissionChoice?{admissionChoice}:{})});
      r.history = history;
      this.save(r);
      return decisions;
    } finally { r.history = history; }
  }
  private async auditQuestion(r: RecordRun, question: string, sources: RequirementGate["sources"], facts: ReturnType<typeof technicalFacts>, signal: AbortSignal) {
    return (await this.auditQuestions(r,[question],sources,facts,signal))[0].decision;
  }
  private async auditTechnicalPremises(r: RecordRun, review: RequirementReview, plan: InvestigatedPlan, sources: RequirementGate["sources"], signal: AbortSignal) {
    const facts = technicalFacts(plan), context = technicalPremiseContext(plan, sources);
    const basis = technicalPremiseBasis(review, facts, context);
    if (!basis.claims.length) return review;
    const cached = r.run.reviewLedger?.attempts.map(attempt => attempt.review.technicalPremiseAudit)
      .find(audit => audit?.key === basis.key && technicalPremisesResolved(audit,review,facts,context));
    if (cached) return {...review,technicalPremiseAudit:cached};
    const history = r.history;
    try {
      const request = technicalPremiseRequest(review,facts,context);
      const parse = (text:string) => parseTechnicalPremises(text,review,facts,context);
      const reply = await this.call(r,request,signal,"review",reply=>parse(reply.text));
      signal.throwIfAborted();
      return {...review,technicalPremiseAudit:parse(reply.text)};
    } finally { r.history = history; }
  }
  private answeredQuestions(r:RecordRun) {
    return (r.run.revisions ?? []).flatMap(revision => (revision.answers ?? []).map(answer => ({...answer,sourceRevision:`${r.run.id}:${revision.revision}`})));
  }
  private async plan(r: RecordRun, signal: AbortSignal) {
    const context = this.domain.context();
    if (
      r.run.baseVersion &&
      (r.run.baseVersion !== context.versionId ||
        r.run.capabilityId !== context.pluginId)
    )
      throw new Error("基础版本已变化，请重新规划");
    r.run.baseVersion = context.versionId;
    r.run.capabilityId = context.pluginId;
    r.investigation ??= {version: 2, baseVersion: context.versionId, materials: [], deliveries: []};
    const initial = this.domain.read("inspect_application", {}, context, []);
    if (!("ref" in initial)) throw new Error("应用调查失败");
    const baseline = [{ref: initial.ref, hash: initial.hash, content: initial.content}, ...(initial.documents ?? []),
      ...Object.entries(context.guideHashes)
        // New auxiliary actions need their protocol before they are registered/ready.
        // Delivering the guide does not change the capability's runtime status.
        .filter(([ref])=>context.capabilities.some(c=>(c.ready || c.interfaceId === "command.register") && c.installed && c.enabled && c.authorized && ref === `guide/${c.interfaceId}`))
        .map(([ref,digest])=>{
        const content = capabilityGuides[ref];
        if (content === undefined || hash(content) !== digest) throw new AppError("PLAN_STALE","能力指南与调查目录不一致",409);
        return {ref,hash:digest,content};
      })];
    const valid = [...Object.entries(context.files).map(([ref, file]) => ({ref, hash: file.hash})),
      ...baseline.map(({ref, hash}) => ({ref, hash})),
      ...Object.entries(context.guideHashes).map(([ref, hash]) => ({ref, hash}))];
    const reused = this.materials.documents(r.investigation, valid);
    this.materials.capture(r.investigation, baseline);
    const documents = [...reused.filter(d => !baseline.some(b => b.ref === d.ref)), ...baseline];
    r.run.evidence = documents.map(({ref, hash}) => ({ref, hash}));
    r.pendingMaterials = r.run.evidence;
    this.save(r);
    const inheritedSources = (JSON.parse(context.files["active-acceptance"].content) as {requirementGate?: RequirementGate}).requirementGate?.sources ?? [];
    const sourceCatalog = [...inheritedSources, ...(r.run.revisions ?? []).map(v => ({id: `${r.run.id}:${v.revision}`, text: v.text}))];
    const admissionContext = this.domain.admission?.(context);
    if (admissionContext) {
      if (admissionContext.missing.length) {
        r.run = {...this.base(r),status:"blocked",stop:{kind:"environment",phase:"admission",code:"missing-dependency-or-checker",evidence:["inspect_application.environment"]},...describeBlockers(admissionContext.missing.map(s=>"规划预检缺少依赖或检查器："+s))};
        this.save(r); return;
      }
      const key = admissionKey(context.versionId,sourceCatalog,admissionContext.facts);
      let admitted = r.run.requestAdmissions?.find(a=>a.key === key && admissionResolved(a));
      if (!admitted) {
        const history = r.history;
        try {
          const prior = semanticReuse((r.run.requestAdmissions??[]).filter(admissionResolved),sourceCatalog);
          const intake = admissionRequest(sourceCatalog,admissionContext.facts,prior);
          intake.instruction += "\nansweredQuestions 是宿主的问题对应记录，question 不是用户声明，answer 才是对应来源的用户回答。";
          intake.message = JSON.stringify({...JSON.parse(intake.message ?? "{}"),answeredQuestions:this.answeredQuestions(r),baselineDefaults:reviewedBaselineDefaults(context)});
          const response = await this.call(r,intake,signal,"admission",reply=>parseAdmission(reply.text,context.versionId,sourceCatalog,admissionContext.facts));
          try { admitted = parseAdmission(response.text,context.versionId,sourceCatalog,admissionContext.facts); }
          catch (error) {throw new ModelProtocolError("需求预检未通过：" + (error instanceof Error ? error.message : "无效来源解释"));}
          if (admitted.claims.length) {
            const proposed = admitted;
            const review = await this.call(r, admissionReviewRequest(proposed,sourceCatalog,prior), signal, "review", reply => adjudicateAdmission(reply.text, proposed, sourceCatalog));
            admitted = adjudicateAdmission(review.text, proposed, sourceCatalog);
          }
          (r.run.requestAdmissions ??= []).push(admitted);
        } finally {r.history=history;}
        this.save(r);
      }
      if (admitted.blockers.length) {
        const capability = admitted.capabilityChecks.some(check => check.outcome === "unsupported" &&
          admitted!.semanticReview?.decisions.some(decision => decision.claimId === check.claimId &&
            decision.layer === "capability" && decision.verdict === "entailed"));
        r.run={...this.base(r),status:"blocked",stop:{kind:capability?"capability":"semantic",phase:"admission",code:capability?"unsupported-host-effect":admitted.semanticReview?.decisions.some(d=>d.verdict==="uncertain")?"source-undecided":"unsupported-initial-presentation",evidence:["run.requestAdmissions"]},...describeBlockers(admitted.blockers)};
        this.save(r);return;
      }
      if (admitted.questions.length) {
        const pending=admissionQuestionState(admitted,sourceCatalog,admissionContext.facts,r.run.clarificationReviews??[]).pendingTargets;
        if(pending.length) await this.auditQuestions(r,pending.map((target)=>target.question),sourceCatalog,admissionContext.facts,signal,undefined,pending);
        const state=admissionQuestionState(admitted,sourceCatalog,admissionContext.facts,r.run.clarificationReviews??[]);
        if(state.pending.length)throw new ModelProtocolError("需求预检澄清缺少完整裁决");
        if(state.blockers.length){const capability = r.run.clarificationReviews?.some(a=>a.decision.effects?.checks.some(c=>c.verdict==="required"&&c.outcome==="unsupported"));r.run={...this.base(r),status:"blocked",stop:{kind:capability?"capability":"semantic",phase:"admission",code:capability?"unsupported-host-effect":"clarification-boundary",evidence:["run.clarificationReviews"]},...describeBlockers(state.blockers)};this.save(r);return;}
        if(state.questions.length){
        this.scheduler(r).requireClarification(r.calls, true, this.remainingTime(r));
        r.run={...this.base(r),status:"awaiting-input",stop:{kind:"clarification",phase:"admission",code:"business-answer-required",evidence:["run.question","run.clarificationReviews"]},question:state.questions.join("\n")};
        this.save(r);return;
        }
      }
    }
    let message: string | undefined = JSON.stringify({
      materials: {documents}, reviewLedger: r.run.reviewLedger,
      intent: r.run.intent,
      budget: this.base(r).budget,
      parent: r.run.parent,
      parentRunId: r.run.parentRunId,
      baseVersion: context.versionId,
      requestSourceIds: (r.run.revisions ?? []).map(v => `${r.run.id}:${v.revision}`),
      priorPlanIdentities: r.run.plans?.map(p=>({id:p.id,definitionHash:hash(p.changeSpec?.definition)})),
      admission: r.run.requestAdmissions?.at(-1) ? {
        receiptHash:hash(r.run.requestAdmissions.at(-1)),
        initialStates:r.run.requestAdmissions.at(-1)!.initialStates,
        presentations:r.run.requestAdmissions.at(-1)!.presentations,
        semanticReview:r.run.requestAdmissions.at(-1)!.semanticReview,
      }:undefined,
      sources: sourceCatalog,
      answeredQuestions:this.answeredQuestions(r),
      questionAdjudications:r.run.clarificationReviews,
    });
    if (!r.planner) { r.history = []; r.planner = {message, rejections:[]}; this.save(r); }
    message = r.planner.message;
    const rejections = new Set<string>(r.planner.rejections);
    const conclusions = [
      "redirect_request",
      "request_clarification",
      "propose_plan",
      "report_blocker",
    ] as const;
    const conclusionAlone =
      "redirect_request、request_clarification、propose_plan 必须单独一轮提交且该轮只能有这一个调用。请先批量完成只读调查，再单独提交结论。";
    const retryProtocol = (
      response: ModelReply,
      error: string,
      instruction: string,
    ) => {
      if (r.calls >= this.runLimits(r).calls)
        throw new BudgetExhaustedError(`已达到 ${this.runLimits(r).calls} 次模型调用上限`);
      if (!response.calls.length) {
        message = JSON.stringify({
          error,
          instruction,
          budget: this.base(r).budget,
        });
      } else {
        r.history = [
          ...r.history,
          {
            role: "user",
            parts: response.calls.map((call) => ({
              functionResponse: {
                ...(call.id ? { id: call.id } : {}),
                name: call.name,
                response: {
                  result: {
                    accepted: false,
                    error,
                    instruction,
                    budget: this.base(r).budget,
                  },
                },
              },
            })),
          },
        ];
      }
      r.run = { ...this.base(r), status: "planning" };
      r.planner = {message, rejections:[...rejections]};
      r.memoReplies = undefined;
      this.save(r);
    };
    investigation: while (true) {
      const conclusionOnly = this.scheduler(r).conclusionOnly(r.calls,this.remainingTime(r));
      r.planner.rejections = [...rejections];
      r.planner.message = message;
      this.save(r);
      const response = r.planner.response ?? await this.call(
        r,
        {
          instruction: this.budgetInstruction(
            r,
            this.domain.planningInstruction,
          ),
          history: r.history,
          message,
          tools: conclusionOnly
            ? this.domain.planningTools.filter(t => (conclusions as readonly string[]).includes(t.name))
                .map((t) =>
                  t.name === "propose_plan"
                    ? { ...t, parameters: planSchemaFor(context) }
                    : t,
                )
            : this.domain.planningTools.map((t) =>
                t.name === "propose_plan"
                  ? { ...t, parameters: planSchemaFor(context) }
                  : t,
              ),
        },
        signal,
      );
      r.planner.response = response;
      this.save(r);
      message = undefined;
      if (conclusionOnly && response.calls.some(c => !(conclusions as readonly string[]).includes(c.name)))
        throw new BudgetExhaustedError("规划预算已到结论边界，不能继续读取；候选及复核预留不变");
      if (!response.calls.length || response.calls.length > 16) {
        retryProtocol(
          response,
          "模型没有返回有效调查工具调用",
          `请返回 1 到 16 个工具调用。${conclusionAlone}`,
        );
        continue investigation;
      }
      if (
        response.calls.some((call) =>
          (conclusions as readonly string[]).includes(call.name),
        ) &&
        response.calls.length !== 1
      ) {
        retryProtocol(response, "调查结论须单独提交", conclusionAlone);
        continue investigation;
      }
      const parts: unknown[] = [];
      for (const call of response.calls) {
        signal.throwIfAborted();
        if ((conclusions as readonly string[]).includes(call.name)) {
          if (call.name === "redirect_request") {
            r.run = {
              ...this.base(r),
              status: "dismissed",
              message: this.resultText(call.args.message),
            };
          } else if (call.name === "report_blocker") {
            r.run = {...this.base(r), status: "blocked",stop:{kind:"model-blocker",phase:"planning",code:"model-reported-blocker",evidence:[`model-call:${r.calls}`]}, ...describeBlockers([this.resultText(call.args.reason)])};
          } else if (call.name === "request_clarification") {
            if (!r.run.evidence?.some((e) => e.ref === "inspect_application")) {
              retryProtocol(
                response,
                "澄清前必须调查应用",
                "请先调用 inspect_application，再在单独一轮中 request_clarification。",
              );
              continue investigation;
            }
            const question = this.resultText(call.args.question);
            const decision = await this.auditQuestion(r,question,sourceCatalog,admissionContext?.facts??technicalFacts({workflowRules:[],binding:undefined}),signal);
            if (clarificationBlockers(decision).length) {
              r.run = {...this.base(r), status: "blocked", stop:{kind:decision.effects?.checks.some(c=>c.verdict==="required"&&c.outcome==="unsupported")?"capability":"semantic",phase:"planning",code:"clarification-boundary",evidence:["run.clarificationReviews"]}, ...describeBlockers(clarificationBlockers(decision))};
            } else if (decision.kind !== "business-ambiguity") {
              retryProtocol(response, "宿主已裁决该问题无需用户澄清：" + JSON.stringify(decision), "保持原始要求，在同一预算内纠正规格或报告阻断，不以替代要求发起用户确认。");
              continue investigation;
            } else {
              this.scheduler(r).requireClarification(r.calls, !!admissionContext, this.remainingTime(r));
              r.run = {...this.base(r),status:"awaiting-input",stop:{kind:"clarification",phase:"planning",code:"business-answer-required",evidence:["run.question","run.clarificationReviews"]},question};
            }
          } else {
            let parsed: ReturnType<Domain["parse"]>;
            try {
              parsed = this.domain.parse(
                call.args,
                context,
                r.run.evidence ?? [],
                sourceCatalog,
                r.run.requestAdmissions?.at(-1),
              );
            } catch (error) {
              const diagnostic =
                error instanceof Error ? error.message : "计划结构无效";
              const rejection = hash({ diagnostic: error instanceof OperationPreparationError ? error.rejectionReason : diagnostic, evidence: r.run.evidence });
              if (error instanceof HistoricalPreparationBlocked || rejections.has(rejection) || r.calls >= this.runLimits(r).calls) {
                r.run = {
                  ...this.base(r),
                  status: "blocked",
                  stop: {kind:"planning-gate",phase:"planning",code:"plan-compilation",evidence:[`model-call:${r.calls}`,"run.evidence"]},
                  ...describeBlockers([diagnostic]),
                };
                this.save(r);
                return;
              }
              rejections.add(rejection);
              retryProtocol(
                response,
                diagnostic,
                "计划结构未通过，不允许执行。请检查工具契约中的必填字段与非空列表，在原预算内修正；相同错误且无新证据将结束调查。不得降低目标、修改验收或绕过保护。",
              );
              continue investigation;
            }
            if (r.calls >= this.runLimits(r).calls)
              parsed.blockers.push(
                "调查已耗尽模型调用预算，需要新的运行重新规划",
              );
            let plan: InvestigatedPlan = {
              ...parsed.plan,
              intent: r.run.intent === "repair" ? "repair" : parsed.plan.intent,
              id: r.planner.proposalId ??= randomUUID(),
              requestRevision: r.run.requestRevision ?? 1,
              ...(admissionContext ? {requestAdmission: r.run.requestAdmissions?.at(-1)} : {}),
              questionAdjudications:structuredClone(r.run.clarificationReviews??[]),
            };
            const sources = (r.run.revisions ?? []).map((v) => ({
              id: `${r.run.id}:${v.revision}`,
              text: v.text,
            }));
            const inherited = JSON.parse(
              context.files["active-acceptance"].content,
            ) as {
              requirementGate?: RequirementGate;
              requirements?: InvestigatedPlan["requirements"];
              browserCases?: InvestigatedPlan["browserCases"];
            };
            if (inherited.requirementGate) {
              sources.unshift(...inherited.requirementGate.sources);
              for (const old of inherited.requirements ?? []) {
                const replacement = plan.requirements?.find(
                  (item) => item.id === old.id,
                );
                if (!replacement) (plan.requirements ??= []).push(old);
                else if (hash(replacement) !== hash(old)) {
                  if (
                    typeof call.args.acceptanceReason !== "string" ||
                    !call.args.acceptanceReason.trim()
                  )
                    parsed.blockers.push(
                      `既有需求 ${old.id} 改变，须说明验收修订原因`,
                    );
                  else
                    (plan.acceptanceChanges ??= []).push({
                      rule: `需求 ${old.id}`,
                      before: JSON.stringify(old),
                      after: JSON.stringify(replacement),
                      reason: call.args.acceptanceReason,
                    });
                }
              }
              for (const old of inherited.browserCases ?? []) {
                const replacement = plan.browserCases?.find(
                  (item) => item.id === old.id,
                );
                if (!replacement) (plan.browserCases ??= []).push(old);
                else if (hash(replacement) !== hash(old)) {
                  if (
                    typeof call.args.acceptanceReason !== "string" ||
                    !call.args.acceptanceReason.trim()
                  )
                    parsed.blockers.push(
                      `既有浏览器案例 ${old.id} 改变，须说明验收修订原因`,
                    );
                  else
                    (plan.acceptanceChanges ??= []).push({
                      rule: `浏览器案例 ${old.id}`,
                      before: JSON.stringify(old),
                      after: JSON.stringify(replacement),
                      reason: call.args.acceptanceReason,
                    });
                }
              }
            }
            plan.requirements = plan.requirements?.map(requirement => ({...requirement,
              id: requirement.sourceRevision.startsWith(r.run.id + ":") && !(inherited.requirements ?? []).some(old => old.id === requirement.id) && !(r.run.plans ?? []).some(p => p.requirements?.some(old => old.id === requirement.id && old.sourceRevision === requirement.sourceRevision))
                ? "requirement-" + hash({source: requirement.sourceRevision, key: requirement.id}).slice(0, 24) : requirement.id,
            }));
            plan.answeredQuestions = this.answeredQuestions(r);
            const inferred = (r.run.clarificationReviews ?? []).filter(a => a.decision.sourceRevision === `${r.run.id}:${r.run.requestRevision ?? 1}`).flatMap(a => a.decision.default ? compileDefaults([a.decision.default]) : []);
            plan.defaults = [...new Map([...(plan.defaults ?? []),...inferred].map(d => [d.id,d])).values()];
            plan.semanticState = compileSemantics(plan,sources);
            plan.changeSpec = compileSpec(plan, r.run.id, context.files["active-source"].hash, JSON.parse(context.files["active-contract"].content));
            const supported = Object.keys(context.checkerVersions);
            const covered = coverage(plan, sources, supported);
            const feedbackAdjudication = !parsed.blockers.length && plan.requirements?.some(r=>r.obligations?.some(o=>o.kind==="feedback"&&o.resolution==="pending"));
            plan.requirementCoverage = covered;
            if (!plan.requirements?.length)
              parsed.blockers.push("缺少需求清单及验收映射");
            parsed.blockers.push(
              ...covered.flatMap((item) =>
                item.reasons.map(
                  (reason) => `需求 ${item.requirementId}：${reason}`,
                ),
              ),
            );
            if (r.planner.ready) { plan = r.planner.ready.plan; parsed = r.planner.ready.parsed; }
            else if (!parsed.blockers.length || parsed.sourceAdjudication?.length || feedbackAdjudication) {
              const plannerHistory = r.history;
              let reviewReturned = false;
              try {
                const review = await this.call(
                  r,
                  {
                    instruction:
                      "独立需求复核：只返回契约 JSON，禁止工具。按完整 sources 检查遗漏、额外业务限制、冲突及不可验证项，核对 requirements 中可执行 obligations 的初始状态、动作后状态及历史准备是否对应原文。hostInvariants/hostRules 是宿主规则，按其作用域和 technicalTarget 核对，不是用户来源；不能将宿主规则归因用户。业务问题给出来源、reviewTargets 中精确 subject 与 aspect、required/forbidden/undetermined 立场。技术主张只用 technical:{target,expected} 引用 technicalTargets 的精确属性目标；fact/property/目标/立场由宿主绑定和裁决。semanticState 分开记录名称、必填、初始内容、动作后值和保留；businessChoices 只含已确认未决的选择，新发现的必填或动作可见性未决通过 unresolvedChoices 引用 targetId 和原文；初始呈现用 fieldDecisions 的命题证据。fieldReviewTargets/errorReviewTargets 的 sources.source 与决策 source 均为该目标内局部一基编号；按 sourceRevision 在顶层 sources 查原文，禁止使用全局位置代替局部编号。reviewLedger 的 issueRef/issueRefs 引用其 issues 表，历史是证据数据；全部未消解问题须在 resolutions 引用 issueId、来源及连续原文解释如何修正，相反业务立场须澄清。reviewedIds 逐项列出，无问题才 issues=[]；空 issues 不能替代逐项来源解释。此复核不构成自然语言完整性的数学证明。",
                    history: [],
                    schema: boundReviewSchema(plan, sources, r.run.reviewLedger),
                    message: JSON.stringify({encoding:modelInputEncoding,...modelInput(requirementReviewInput(plan, sources, r.run.reviewLedger))}),
                  },
                  signal,
                  "review",
                  reply=>parseReview(reply.text,plan,sources),
                );
                if (review.calls.length)
                  throw new Error("独立复核禁止工具调用");
                const reviewed = await this.auditTechnicalPremises(r,parseReview(review.text,plan,sources),plan,sources,signal);
                reviewReturned = true;
                let result = adjudicateTechnicalReview(reviewed,technicalFacts(plan),technicalPremiseContext(plan,sources));
                resolveErrorFeedback(plan,result);
                let choiceDecisions:{question:string;decision:ClarificationDecision;choice?:{id:string;hash:string}}[]=[];
                if(result.unresolvedChoices?.length && !result.technicalDecisions?.some(d=>!["satisfied","not-requested"].includes(d.outcome))) {
                  const choices=businessChoices(plan,result).filter(c=>result.unresolvedChoices!.some(choice=>choice.targetId===c.id));
                  choiceDecisions=await this.auditQuestions(r,choices.map(c=>c.question),sources,technicalFacts(plan),signal,choices.map(c=>semanticChoiceProof(plan,c.id)));
                  plan.questionAdjudications=structuredClone(r.run.clarificationReviews??[]);
                  result=adjudicateTechnicalReview({...parseReview(review.text,plan,sources),...(reviewed.technicalPremiseAudit?{technicalPremiseAudit:reviewed.technicalPremiseAudit}:{})},technicalFacts(plan),technicalPremiseContext(plan,sources));
                  resolveErrorFeedback(plan,result);
                }
                // Replace only coverage diagnostics after the deterministic source projection.
                const oldCoverageDiagnostics=covered.flatMap(c=>c.reasons.map(reason=>`需求 ${c.requirementId}：${reason}`));
                parsed.blockers=parsed.blockers.filter(b=>!oldCoverageDiagnostics.includes(b));
                plan.requirementCoverage=coverage(plan,sources,supported);
                parsed.blockers.push(...plan.requirementCoverage.flatMap(c=>c.reasons.map(reason=>`需求 ${c.requirementId}：${reason}`)));
                if(feedbackConflicts(plan).some(c=>plan.requirements?.some(r=>r.obligations?.some(o=>o.id===c.obligationId&&o.kind==="feedback"&&o.resolution==="required"))) || result.errorDecisions?.some(d=>d.feedback==="undetermined")) parsed.retryable=false;
                plan.defaultReviews = structuredClone(result.defaultReviews ?? []);
                const undecidedDefaults = (result.defaultReviews ?? []).filter(d => d.verdict === "requires-choice");
                if (undecidedDefaults.length) {
                  const source = sources.at(-1)!;
                  const questions = undecidedDefaults.map(d => {
                    const chosen = plan.defaults!.find(value => value.id === d.id)!;
                    return `关于“${chosen.scope}”，你希望如何处理？拟采用的行为：${chosen.behavior}`;
                  });
                  for (const [index, question] of questions.entries()) (r.run.clarificationReviews ??= []).push({key:questionReviewKey(question,sources,technicalFacts(plan)),question,call:r.calls,decision:{kind:"business-ambiguity",sourceRevision:source.id,sourceQuote:source.text,detail:undecidedDefaults[index].detail}});
                  r.run = {...this.base(r),status:"awaiting-input",question:questions.join("\n"),questions:questionsFor(r.run.id,r.run.requestRevision??1,questions,r.run.clarificationReviews??[]),questionRevision:r.run.requestRevision??1};
                  this.save(r);
                  return;
                }
                parsed.blockers.push(...(result.defaultReviews ?? []).filter(d => d.verdict === "conflict").map(d => "默认处理与明确要求冲突：" + d.detail));
                plan.designDecisions = structuredClone(result.designDecisions ?? []);
                const semantics=compileSemantics(plan,sources,result);
                for(const entry of semantics.entries.filter(e=>e.status==="conflicting")){
                  const evidence=entry.evidence[0];
                  if(evidence)result.issues.push({kind:"conflict",...evidence,target:{subject:evidence.sourceRevision,aspect:"meaning"},stance:"undetermined",detail:"宿主需求语义命题冲突："+entry.target.subject+"/"+entry.target.aspect});
                }
                const ledger = (r.run.reviewLedger ??= {
                  version: 2,
                  findings: [],
                  attempts: [],
                });
                const recorded = recordReview(
                  ledger,
                  result,
                  plan.requestRevision,
                  hash({
                    requirements: plan.requirements,
                    browserCases: plan.browserCases,
                    cases: plan.cases,
                    memberCases: plan.memberCases,
                    extensions: plan.extensions,
                    workflowRules: plan.workflowRules,
                  }),
                  issue=>reviewEvidence(plan,sources,issue),
                );
                parsed.blockers.push(...recorded.blockers);
                if (recorded.halt) parsed.retryable = false;
                const technicalBlock = result.technicalDecisions?.some(
                  (d) => !["satisfied","not-requested"].includes(d.outcome),
                );
                if (technicalBlock) parsed.retryable = false;
                const question = technicalBlock ? undefined : reviewQuestion(result, plan);
                if (parsed.sourceAdjudication?.length && parsed.sourceAdjudication.every(a=>result.fieldDecisions?.some(d=>d.obligationId===a.obligationId && d.initial.kind === "unspecified"))) {
                  r.run.diagnostics=[...(r.run.diagnostics ?? []),...parsed.sourceAdjudication.map(a=>a.diagnostic)];
                  parsed.blockers=parsed.blockers.filter(b=>!parsed.sourceAdjudication!.some(a=>a.diagnostic===b));
                  parsed.retryable=!recorded.halt && !technicalBlock;
                  parsed.blockers.push("调查来源复核确认这些初始期望未被用户要求，属于规划规格错误；保持基线保护并纠正规格，不新增用户决定");
                }
                if (question && !technicalBlock) {
                  const choice=businessChoices(plan,result).find(c=>c.question===question);
                  const decision=choiceDecisions.find(d=>d.choice?.id===choice?.id)?.decision ?? await this.auditQuestion(r,question,sources,technicalFacts(plan),signal);
                  if(decision.kind === "business-ambiguity" && !clarificationBlockers(decision).length) {
                    this.scheduler(r).requireClarification(r.calls, !!admissionContext, this.remainingTime(r));
                    r.run={...this.base(r),status:"awaiting-input",stop:{kind:"clarification",phase:"review",code:"business-answer-required",evidence:["run.question","run.clarificationReviews"]},question};this.save(r);return;
                  }
                  if(clarificationBlockers(decision).length) {parsed.retryable=false;parsed.blockers.push(...clarificationBlockers(decision));}
                  parsed.blockers.push("复核问题已由统一澄清审查裁决，保留原意见并纠正规格或停止："+JSON.stringify(decision));
                }
                plan.questionAdjudications=structuredClone(r.run.clarificationReviews ?? []);
                plan.semanticState=compileSemantics(plan,sources,result);
                plan.changeSpec=compileSpec(plan,r.run.id,context.files["active-source"].hash,JSON.parse(context.files["active-contract"].content));
                plan.requirementGate = freezeRequirements(
                  plan,
                  sources,
                  hash(r.run.revisions),
                  result,
                  supported,
                  ledger,
                );
                parsed.blockers.push(
                  ...result.issues.map(
                    (issue) => `需求独立复核 ${issue.kind}：${issue.detail}`,
                  ),
                );
                if (!parsed.blockers.length)
                  this.db
                    .prepare(
                      "INSERT INTO evolution_requirement_freezes VALUES(?,?)",
                    )
                    .run(plan.id, JSON.stringify(plan.requirementGate));
              } catch (error) {
                signal.throwIfAborted();
                if (error instanceof BudgetExhaustedError || error instanceof ModelTransportError || error instanceof ModelResourceError || error instanceof ModelProtocolError) throw error;
                if (!reviewReturned || error instanceof ModelProtocolError) parsed.retryable = false;
                parsed.blockers.push(
                  `需求独立复核未通过：${error instanceof Error ? error.message : "无效返回"}`,
                );
              } finally {
                r.history = plannerHistory;
              }
            }
            r.planner.ready = {plan,parsed};
            this.save(r);
            if (!parsed.blockers.length) this.scheduler(r).requireReady(r.calls, this.remainingTime(r));
            if (!parsed.blockers.length && plan.intent === "repair") {
              parsed.retryable = false;
              if (plan.acceptanceChanges?.length)
                parsed.blockers.push(
                  "修复不能替换已有业务规则；要求变化须另行修订和规划",
                );
              else if (!this.domain.reproduce)
                parsed.blockers.push("缺少可靠故障检查器，无法复现");
              else {
                try {
                  plan.repairEvidence = await this.domain.reproduce(
                    plan,
                    signal,
                  );
                  signal.throwIfAborted();
                  if (!plan.repairEvidence)
                    parsed.blockers.push(
                      "unreproduced：旧版未出现相同断言失败，无法复现，不生成修复候选",
                    );
                } catch (error) {
                  signal.throwIfAborted();
                  parsed.blockers.push(
                    `故障检查未可靠完成，不能证明修复：${error instanceof Error ? error.message : "检查失败"}`,
                  );
                }
              }
            }
            const base = {
              ...this.base(r),
              plans: [...(r.run.plans ?? []), plan],
            };
            const rejection = hash({
              blockers: parsed.blockers,
              evidence: r.run.evidence,
            });
            if (
              parsed.blockers.length &&
              parsed.retryable &&
              !rejections.has(rejection)
            ) {
              rejections.add(rejection);
              r.run = { ...base, status: "planning" };
              r.history = [
                ...r.history,
                {
                  role: "user",
                  parts: [
                    {
                      functionResponse: {
                        ...(call.id ? { id: call.id } : {}),
                        name: call.name,
                        response: {
                          result: {
                            accepted: false,
                            blockers: parsed.blockers,
                            budget: base.budget,
                            instruction:
                              "计划尚未通过，不允许执行。请在剩余预算内补读资料、纠正计划或如实保留阻塞；不要降低原目标、修改验收或绕过保护。相同诊断且没有新增证据会结束调查。",
                          },
                        },
                      },
                    },
                  ],
                },
              ];
              r.planner = {rejections:[...rejections]};
              r.memoReplies = undefined;
              this.save(r);
              continue investigation;
            }
            r.run = parsed.blockers.length
              ? {
                  ...base,
                  status: "blocked",
                  stop: {kind:"planning-gate",phase:"planning",code:"plan-gate",evidence:["run.plans","run.reviewLedger"]},
                  ...describeBlockers(parsed.blockers),
                  plan,
                }
              : plan.acceptanceChanges?.length
                ? {
                    ...base,
                    status: "awaiting-acceptance",
                    plan,
                    acceptanceRevision: {
                      id: hash({
                        planId: plan.id,
                        baseVersion: plan.baseVersion,
                        changes: plan.acceptanceChanges,
                      }),
                      planId: plan.id,
                      baseVersion: plan.baseVersion!,
                      changes: plan.acceptanceChanges,
                    },
                  }
                : { ...base, status: "ready", plan };
          }
          r.planner = undefined;
          r.memoReplies = undefined;
          this.save(r);
          return;
        }
        const result = this.domain.read(
          call.name,
          call.args,
          context,
          r.run.evidence ?? [],
        );
        if ("ref" in result) {
          const delivered = [result, ...(result.documents ?? [])];
          const stored = delivered.filter(d => d.ref !== "read_guides" && !("reused" in d && d.reused));
          this.materials.capture(r.investigation!, stored);
          r.pendingMaterials = [...(r.pendingMaterials ?? []), ...stored.map(({ref, hash}) => ({ref, hash}))];
          const deliveredRefs = new Set(
            delivered.map((document) => document.ref),
          );
          r.run.evidence = [
            ...(r.run.evidence ?? []).filter((e) => !deliveredRefs.has(e.ref)),
            ...delivered.map(({ ref, hash }) => ({ ref, hash })),
          ];
        }
        parts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response: { result },
          },
        });
      }
      r.history = [...r.history, { role: "user", parts }];
      r.planner = {rejections:[...rejections]};
      r.memoReplies = undefined;
      this.save(r);
    }
  }
  private async execute(r: RecordRun, signal: AbortSignal) {
    const target = r.target!;
    const plan = r.plan as InvestigatedPlan;
    const revision = plan.compositionRevision;
    signal.throwIfAborted();
    if (!this.alive(r.run.id)) return;
    this.checkPlan(r, target, revision, plan);
    const context = this.domain.generation(target);
    const baseMembers: Record<string, string> = {};
    const reused = new Map(
      this.materials.documents(r.investigation!, plan.binding?.materials ?? [])
        .map((doc) => [doc.ref, doc]),
    );
    const documents: InvestigationDocument[] = [];
    const deliver = (ref: string, content: unknown) => {
      const digest = hash(content);
      const bound = plan.binding?.materials.find((item) => item.ref === ref);
      if (bound && bound.hash !== digest)
        throw new AppError("PLAN_STALE", `执行资料已变化：${ref}`, 409);
      const stored = reused.get(ref);
      if (stored && stored.hash !== digest)
        throw new AppError("PLAN_STALE", `复用资料已变化：${ref}`, 409);
      documents.push({
        ref,
        hash: digest,
        content: stored?.content ?? content,
      });
    };
    deliver(generationMaterialRefs.source, context.source);
    deliver(generationMaterialRefs.contract, context.contract);
    if (context.scaffold)
      deliver(
        generationMaterialRefs.scaffold,
        JSON.parse(JSON.stringify(context.scaffold)) as unknown,
      );
    for (const ref of Object.keys(plan.binding?.guideCatalog ?? {})) {
      const item = { ref };
      if (!Object.hasOwn(capabilityGuides, ref))
        throw new AppError("PLAN_STALE", `指南不存在：${ref}`, 409);
      if (
        plan.binding?.guideCatalog[item.ref] !==
        hash(capabilityGuides[item.ref])
      )
        throw new AppError("PLAN_STALE", `指南已变化：${item.ref}`, 409);
      deliver(item.ref, capabilityGuides[item.ref]);
    }
    for (const { ref } of plan.binding?.materials.filter((m) =>
      m.ref.startsWith("member-source/"),
    ) ?? []) {
      const identity = ref.slice("member-source/".length);
      const split = identity.lastIndexOf("@");
      if (split < 1)
        throw new AppError("PLAN_STALE", "成员精确资料身份无效", 409);
      const pluginId = identity.slice(0, split),
        versionId = identity.slice(split + 1);
      const member = this.domain.readMember(pluginId, versionId);
      if (plan.memberUpgrades?.some((m) => m.pluginId === pluginId))
        baseMembers[pluginId] = member.source;
      deliver(ref, member.source);
      deliver(
        `member-contract/${member.pluginId}@${member.versionId}`,
        member.contract,
      );
      deliver(
        `member-acceptance/${member.pluginId}@${member.versionId}`,
        member.acceptance,
      );
    }
    for (const upgrade of plan.memberUpgrades ?? [])
      if (!Object.hasOwn(baseMembers, upgrade.pluginId))
        throw new AppError("PLAN_STALE", "升级成员缺少精确资料绑定", 409);
    // Retain the frozen read-only host context as well as generation artifacts.
    // The store verifies content hashes; checkPlan already checked live bindings.
    for (const doc of reused.values())
      if (!documents.some((item) => item.ref === doc.ref))
        deliver(doc.ref, doc.content);
    this.materials.capture(r.investigation!, documents);
    const executionDocuments = documents.filter(d =>
      d.ref === generationMaterialRefs.source || d.ref === generationMaterialRefs.contract || d.ref === generationMaterialRefs.scaffold ||
      Object.hasOwn(capabilityGuides, d.ref) || d.ref.startsWith("member-") || d.ref.startsWith("business/"));
    r.pendingMaterials = executionDocuments.map(({ref, hash}) => ({ref, hash}));
    let history: unknown[] = [];
    let message: string | undefined = JSON.stringify(modelInput({
      kind: "candidate-task/1",
      encoding: modelInputEncoding,
      authority: { specificationHash: hash(plan.changeSpec), requirementSeal: plan.requirementGate?.seal, definitionHash: hash(plan.changeSpec?.definition) },
      plan: changeDefinition(plan),
      target: {kind: target.kind, baseVersion: target.baseVersion},
      technicalFacts: technicalFacts(plan),
      delta: {...deltaBasis(context.source), members: Object.entries(baseMembers).map(([pluginId, source]) => ({pluginId, hash: hash(source)}))},
      budget: this.base(r).budget,
      materials: {
        baseVersion: target.baseVersion,
        compositionRevision: revision,
        documents: executionDocuments,
        catalog: documents.map(({ref,hash})=>({ref,hash})),
        guideCatalog: plan.binding?.guideCatalog,
      },
    }));
    let previousCandidate: {id: string; source: string} | undefined;
    r.generator ??= {history, message, failures:[]};
    history = r.generator.history;
    message = r.generator.message;
    previousCandidate = r.generator.previousCandidate;
    const failures = new Set<string>(r.generator.failures);
    this.save(r);
    while (r.candidates < this.runLimits(r).candidates || r.generator.pendingCandidate) {
      if (!this.alive(r.run.id)) return;
      this.domain.check(target, revision, plan);
      const attempt = r.generator.pendingCandidate?.candidate.attempt ?? r.candidates + 1;
      const intentNote = plan.compositionIntent
        ? `（${compositionIntentLabel(plan.compositionIntent)}）`
        : "";
      const generateId = this.beginStep(
        r,
        `${r.candidates ? "修正候选" : "生成候选"}${intentNote}`,
        attempt,
        "submit_candidate",
      );
      if (!generateId) return;
      let submitted = false;
      while (!submitted) {
        if (!this.alive(r.run.id)) return;
        const response = r.generator.response ?? await this.call(
          r,
          {
            instruction: this.budgetInstruction(r, context.instruction),
            history,
            message,
            tools: [
              {
                name: "report_blocker",
                description:
                  "Stop when frozen scope or protected controls must change; preserve all attempts",
                parameters: {
                  type: "object",
                  properties: { reason: { type: "string" } },
                  required: ["reason"],
                },
              },
              {
                name: "submit_candidate",
                description: "Submit only changed authorized files/members against the exact delta basis; host inherits unchanged artifacts and independently verifies the full candidate",
                parameters: boundCandidateSchema(plan),
              },
            ],
          },
          signal,
          "generation",
        );
        r.generator.response = response;
        this.save(r);
        history = response.history;
        message = undefined;
        if (!response.calls.length)
          throw new Error("模型没有提交候选或工具调用");
        if (
          response.calls.filter((c) => c.name === "submit_candidate").length > 1
        )
          throw new Error("每次模型回复只能封存一个候选");
        const parts: unknown[] = [];
        for (const call of response.calls) {
          signal.throwIfAborted();
          if (!this.alive(r.run.id)) return;
          let result: unknown;
          if (call.name === "report_blocker") {
            const reason = this.resultText(call.args.reason);
            this.toolEvent(r, "report_blocker", "failed", attempt, reason);
            r.run = {
              ...this.base(r),
              status: "blocked",
              plan,
              stop: {kind:"model-blocker",phase:"generation",code:"model-reported-blocker",evidence:[`model-call:${r.calls}`]},
              ...describeBlockers([reason]),
            };
            this.save(r);
            return;
          } else if (call.name === "patch_candidate") {
            this.toolEvent(r, "patch_candidate", "started", attempt);
            this.toolEvent(
              r,
              "patch_candidate",
              "failed",
              attempt,
              "未授权工具：patch_candidate 不在当前执行阶段开放",
            );
            throw new Error("未授权工具：patch_candidate 不在当前执行阶段开放");
          } else if (call.name === "submit_candidate") {
            this.domain.check(target, revision, plan);
            submitted = true;
            this.toolEvent(r, "submit_candidate", "started", attempt);
            this.endStep(
              r,
              generateId,
              "succeeded",
              undefined,
              "submit_candidate",
            );
            if (!r.generator.pendingCandidate) {
              if (r.candidates >= this.runLimits(r).candidates) throw new BudgetExhaustedError("候选机会不足", "candidates");
              r.candidates++;
            }
            this.save(r);
            // Charge even malformed submissions and retain their exact transport.
            let source = JSON.stringify(call.args);
            const candidate: CandidateAttempt = r.generator.pendingCandidate?.candidate ?? {
              requirementSeal: plan.requirementGate?.seal,
              id: hash({
                source,
                planId: plan.id,
                baseVersion: target.baseVersion,
                attempt,
              }),
              planId: plan.id,
              baseVersion: target.baseVersion,
              attempt,
              passed: false,
              sourceHash: hash(source),
            };
            const entry = r.generator.pendingCandidate ? {lastInsertRowid:r.generator.pendingCandidate.rowId} : this.db
              .prepare(
                "INSERT INTO evolution_candidates(runId,body) VALUES(?,?)",
              )
              .run(r.run.id, JSON.stringify({ ...candidate, source }));
            const saveAttempt = () =>
              this.db
                .prepare("UPDATE evolution_candidates SET body=? WHERE id=?")
                .run(
                  JSON.stringify({ ...candidate, source }),
                  entry.lastInsertRowid,
                );
            let buildId: string | null = null;
            let validateId: string | null = null;
            let browserId: string | null = null;
            try {
              this.checkPlan(r, target, plan.compositionRevision, plan);
              source = r.generator.pendingCandidate?.source ?? assembleCandidate(call.args, plan, context.source, previousCandidate, baseMembers);
              candidate.delta ??= candidateDifference(plan, context.source, source, previousCandidate, baseMembers);
              candidate.sourceHash = hash(source);
              candidate.id = hash({source, planId: plan.id, baseVersion: target.baseVersion, attempt});
              previousCandidate = {id: candidate.id, source};
              saveAttempt();
              r.generator.pendingCandidate = {rowId:Number(entry.lastInsertRowid),source,candidate};
              this.save(r);
              r.versionId = await this.domain.candidate(
                source,
                target,
                signal,
                (label) => {
                  if (!this.alive(r.run.id)) return;
                  if (label === "构建候选")
                    buildId = this.beginStep(
                      r,
                      label,
                      attempt,
                      "build_candidate",
                    );
                  else if (label === "验证行为") {
                    if (buildId)
                      this.endStep(
                        r,
                        buildId,
                        "succeeded",
                        undefined,
                        "build_candidate",
                      );
                    validateId = this.beginStep(
                      r,
                      label,
                      attempt,
                      "validate_candidate",
                    );
                  } else if (label === "浏览器验收") {
                    if (validateId)
                      this.endStep(
                        r,
                        validateId,
                        "succeeded",
                        undefined,
                        "validate_candidate",
                      );
                    browserId = this.beginStep(r, label, attempt, "browser/1");
                  } else this.beginStep(r, label, attempt);
                },
              );
              if (!this.alive(r.run.id)) {
                r.versionId = undefined;
                return;
              }
              if (buildId)
                this.endStep(
                  r,
                  buildId,
                  "succeeded",
                  undefined,
                  "build_candidate",
                );
              if (validateId)
                this.endStep(
                  r,
                  validateId,
                  "succeeded",
                  undefined,
                  "validate_candidate",
                );
              if (browserId)
                this.endStep(r, browserId, "succeeded", undefined, "browser/1");
              this.toolEvent(r, "submit_candidate", "succeeded", attempt);
              this.save(r);
              this.domain.verifyAcceptance?.(r.versionId!, plan);
              candidate.requirementSeal = plan.requirementGate?.seal;
              candidate.passed = true;
              candidate.versionId = r.versionId;
              const acceptance = this.domain.acceptanceEvidence(r.versionId!);
              candidate.browser = acceptance.browser;
              candidate.evidenceHash = candidateEvidenceHash(
                candidate,
                plan,
                acceptance,
              );
              saveAttempt();
            } catch (error) {
              if (error instanceof BudgetExhaustedError || (signal.aborted && signal.reason instanceof DOMException && signal.reason.name === "TimeoutError")) {
                candidate.diagnostic = error instanceof Error ? error.message : "验证时间不足";
                saveAttempt();
                throw error;
              }
              r.generator.pendingCandidate = undefined;
              if (!this.alive(r.run.id) || signal.aborted) {
                // Preserve the receipt even when cancellation already changed
                // the run state; the candidate remains ineligible for apply.
                candidate.diagnostic =
                  error instanceof Error ? error.message : "候选已停止";
                if (
                  error instanceof CandidateValidationError ||
                  (error instanceof BrowserEnvironmentError && error.versionId)
                ) {
                  candidate.versionId = error.versionId;
                  candidate.browser = this.domain.acceptanceEvidence(
                    error.versionId!,
                  ).browser;
                }
                saveAttempt();
                r.versionId = undefined;
                if (!this.alive(r.run.id)) return;
                signal.throwIfAborted();
              }
              signal.throwIfAborted();
              const diagnostic =
                error instanceof Error ? error.message : "候选失败";
              result = { error: diagnostic, delta: previousCandidate ? {...deltaBasis(previousCandidate.source)} : undefined };
              r.versionId = undefined;
              if (buildId)
                this.endStep(
                  r,
                  buildId,
                  "failed",
                  diagnostic,
                  "build_candidate",
                );
              if (validateId)
                this.endStep(
                  r,
                  validateId,
                  "failed",
                  diagnostic,
                  "validate_candidate",
                );
              this.toolEvent(
                r,
                "submit_candidate",
                "failed",
                attempt,
                diagnostic,
              );
              if (browserId)
                this.endStep(r, browserId, "failed", diagnostic, "browser/1");
              candidate.diagnostic = diagnostic;
              if (
                error instanceof CandidateValidationError ||
                (error instanceof BrowserEnvironmentError && error.versionId)
              ) {
                candidate.versionId = error.versionId;
                candidate.browser = this.domain.acceptanceEvidence(
                  error.versionId!,
                ).browser;
                result = { error: diagnostic, browser: candidate.browser, delta: previousCandidate ? {...deltaBasis(previousCandidate.source)} : undefined };
              }
              saveAttempt();
              const failure = hash({
                diagnostic: diagnostic.replace(
                  /candidate-[a-f0-9-]+/g,
                  "candidate",
                ),
                source,
              });
              if (
                error instanceof ProtectedCandidateError ||
                error instanceof BrowserEnvironmentError ||
                (error instanceof AppError && error.code === "PLAN_STALE")
              ) {
                r.run = {
                  ...this.base(r),
                  status: "blocked",
                  plan,
                  stop: {kind:error instanceof BrowserDefinitionError?"planning-gate":error instanceof BrowserEnvironmentError?"environment":error instanceof ProtectedCandidateError?"protection":"planning-gate",phase:"execution",code:error instanceof BrowserDefinitionError?"browser-definition":error instanceof BrowserEnvironmentError?"browser-environment":error instanceof ProtectedCandidateError?"protected-candidate":"plan-stale",evidence:[`candidate:${candidate.id}`]},
                  ...describeBlockers([diagnostic]),
                };
                this.save(r);
                return;
              }
              if (failures.has(failure))
                throw new Error(
                  `相同候选失败且没有新证据，停止修正：${diagnostic}`,
                );
              failures.add(failure);
            }
            if (r.versionId) {
              if (!this.alive(r.run.id)) {
                r.versionId = undefined;
                return;
              }
              r.run = {
                ...this.base(r),
                status: "awaiting-apply",
                plan,
                steps: this.steps(r),
                summary: `${plan.outcome}（候选已验证，尚未应用）`,
                versionId: r.versionId,
              };
              this.save(r);
              return;
            }
          } else throw new Error(`模型请求了未授权工具：${call.name}`);
          parts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response: { result },
          },
        });
        }
        history = [...history, { role: "user", parts }];
        r.history = history;
        r.generator = {history,message,previousCandidate,failures:[...failures]};
        this.save(r);
      }
    }
    throw new BudgetExhaustedError(
      `${this.runLimits(r).candidates} 个候选均未通过验证，当前版本保持不变`,
      "candidates",
    );
  }
  async close() {
    this.active?.controller.abort(new Error("宿主停止，运行已中断"));
    await this.active?.promise;
    await this.sessions?.close();
  }
}
