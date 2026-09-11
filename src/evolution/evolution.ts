import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Driver, ModelReply, ModelRequest } from "./driver.js";
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
  PlanEvidence,
} from "../shared/assistant.js";
import { describeBlockers } from "../shared/assistant.js";
import { AppError } from "../shared/contracts.js";
import type { Investigation, InvestigationRead } from "../server/planning.js";
import { compositionIntentLabel } from "../server/planning.js";
import {
  ProtectedCandidateError,
  CandidateValidationError,
} from "../release/business-bundle.js";
import { hash } from "../release/storage.js";
export type Target = {
  kind: "plugin";
  baseVersion: string;
  payload: unknown;
};
export interface Domain {
  context(): Investigation;
  planningInstruction: string;
  planningTools: NonNullable<ModelRequest["tools"]>;
  read(
    name: string,
    args: Record<string, unknown>,
    context: Investigation,
  ): InvestigationRead;
  parse(
    value: unknown,
    context: Investigation,
    seen: PlanEvidence[],
  ): {
    plan: Omit<InvestigatedPlan, "id" | "requestRevision">;
    blockers: string[];
    retryable: boolean;
  };
  reproduce?(
    plan: InvestigatedPlan,
    signal: AbortSignal,
  ): Promise<NonNullable<InvestigatedPlan["repairEvidence"]> | undefined>;
  target(plan: InvestigatedPlan): Target;
  check(target: Target, revision: number): void;
  isActiveVersion(versionId: string): boolean;
  isReadyVersion(versionId: string): boolean;
  acceptanceEvidence(versionId: string): {
    members?: unknown;
    workspaceChecks: string[];
  };
  generation(target: Target): {
    instruction: string;
    contract: string;
    source: string;
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
  target?: Target;
  plan?: AssistantPlan | InvestigatedPlan;
  history: unknown[];
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
  private active?: {
    id: string;
    controller: AbortController;
    promise: Promise<void>;
  };
  constructor(
    private db: DatabaseSync,
    private driver: Driver,
    private domain: Domain,
    private limits = { calls: 12, candidates: 3, milliseconds: 600_000 },
  ) {
    db.exec(`CREATE TABLE IF NOT EXISTS evolution_runs(id TEXT PRIMARY KEY,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evolution_operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,runId TEXT NOT NULL,receipt TEXT);
      CREATE TABLE IF NOT EXISTS evolution_acceptance_revisions(id TEXT PRIMARY KEY,runId TEXT NOT NULL,body TEXT NOT NULL);
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
        callsUsed: r.calls,
        callsRemaining: Math.max(0, this.limits.calls - r.calls),
        candidatesRemaining: Math.max(0, this.limits.candidates - r.candidates),
        millisecondsRemaining: Math.max(
          0,
          this.limits.milliseconds - r.elapsed,
        ),
      },
      updatedAt: new Date().toISOString(),
    };
  }
  private steps(r: RecordRun): AssistantStep[] {
    return "steps" in r.run ? r.run.steps : [];
  }
  private alive(id: string) {
    return this.get(id).run.status === "executing";
  }
  private save(r: RecordRun) {
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
    const sequence = (r.eventSequence ?? 0) + 1;
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
  async observe(runId?: string, afterSequence = 0): Promise<AssistantSnapshot> {
    if (runId) return this.snapshot(this.get(runId).run, afterSequence);
    const row = this.db
      .prepare("SELECT body FROM evolution_runs ORDER BY rowid DESC LIMIT 1")
      .get();
    const run = row ? (JSON.parse(String(row.body)) as RecordRun).run : null;
    return this.snapshot(run, afterSequence);
  }
  async command(command: AssistantCommand): Promise<AssistantSnapshot> {
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
    let record: RecordRun;
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
              createdAt: new Date().toISOString(),
            },
          ],
          evidence: [],
          status: "planning",
        };
      }
      work = "plan";
    } else if (command.type === "cancel") {
      record = this.get(command.runId);
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
      this.domain.check(this.domain.target(plan), plan.compositionRevision);
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
      this.domain.check(target, plan.compositionRevision);
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
        candidate.versionId !== (record.versionId ?? record.run.versionId)
      )
        throw new AppError(
          "CANDIDATE_MISMATCH",
          "候选已过期或不匹配，请重新规划",
          409,
        );
      const report = await this.domain.experience(
        candidate.versionId,
        candidate.id,
        AbortSignal.timeout(15_000),
      );
      record.run = {
        ...record.run,
        experience: report,
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
      this.domain.check(target, command.compositionRevision);
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
          hash(command),
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
      () => controller.abort(new Error("已达到 10 分钟执行上限")),
      Math.max(1, this.limits.milliseconds - record.elapsed),
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
            : {
                ...this.base(record),
                status: "failed",
                message,
                steps: this.steps(persisted).map((s) =>
                  s.status === "running" ? { ...s, status: "failed" } : s,
                ),
              };
          this.save(record);
        }
      } finally {
        clearTimeout(timer);
        const current = this.get(record.run.id);
        current.elapsed += performance.now() - started;
        current.run = { ...current.run, ...this.base(current) };
        this.save(current);
        if (this.active?.id === record.run.id) this.active = undefined;
      }
    });
    this.active = { id: record.run.id, controller, promise };
  }
  private async call(
    r: RecordRun,
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelReply> {
    signal.throwIfAborted();
    if (r.calls >= this.limits.calls)
      throw new Error(`已达到 ${this.limits.calls} 次模型调用上限`);
    r.calls++;
    r.run = { ...r.run, ...this.base(r) };
    this.save(r);
    const startedAt = new Date().toISOString();
    const entry = this.db
      .prepare("INSERT INTO evolution_calls(runId,body) VALUES(?,?)")
      .run(
        r.run.id,
        JSON.stringify({ startedAt, request, status: "calling", usage: null }),
      );
    let reply: ModelReply;
    try {
      let abort!: () => void;
      const cancelled = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new Error("调查已停止"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      try {
        reply = await Promise.race([
          this.driver.generate(request, signal),
          cancelled,
        ]);
      } finally {
        signal.removeEventListener("abort", abort);
      }
    } catch (error) {
      this.db.prepare("UPDATE evolution_calls SET body=? WHERE id=?").run(
        JSON.stringify({
          startedAt,
          request,
          status: "failed",
          endedAt: new Date().toISOString(),
          error: error instanceof Error ? error.message : "Model call failed",
          usage: null,
        }),
        entry.lastInsertRowid,
      );
      throw error;
    }
    this.db.prepare("UPDATE evolution_calls SET body=? WHERE id=?").run(
      JSON.stringify({
        startedAt,
        request,
        status: "returned",
        endedAt: new Date().toISOString(),
        response: reply.raw,
        usage: reply.usage,
      }),
      entry.lastInsertRowid,
    );
    signal.throwIfAborted();
    r.history = reply.history;
    this.save(r);
    return reply;
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
    let message: string | undefined = JSON.stringify({
      intent: r.run.intent,
      budget: this.base(r).budget,
      parent: r.run.parent,
      parentRunId: r.run.parentRunId,
      baseVersion: context.versionId,
      request: r.run.request,
      revisions: r.run.revisions,
      previousPlans: r.run.plans,
    });
    r.history = [];
    const rejections = new Set<string>();
    const conclusions = [
      "redirect_request",
      "request_clarification",
      "propose_plan",
    ] as const;
    const conclusionAlone =
      "redirect_request、request_clarification、propose_plan 必须单独一轮提交且该轮只能有这一个调用。请先批量完成只读调查，再单独提交结论。";
    const retryProtocol = (
      response: ModelReply,
      error: string,
      instruction: string,
    ) => {
      if (r.calls >= this.limits.calls)
        throw new Error(`已达到 ${this.limits.calls} 次模型调用上限`);
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
      this.save(r);
    };
    investigation: while (true) {
      const response = await this.call(
        r,
        {
          instruction: this.domain.planningInstruction,
          history: r.history,
          message,
          tools: this.domain.planningTools,
        },
        signal,
      );
      message = undefined;
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
          } else if (call.name === "request_clarification") {
            if (
              !r.run.evidence?.some((e) => e.ref === "inspect_application")
            ) {
              retryProtocol(
                response,
                "澄清前必须调查应用",
                "请先调用 inspect_application，再在单独一轮中 request_clarification。",
              );
              continue investigation;
            }
            r.run = {
              ...this.base(r),
              status: "awaiting-input",
              question: this.resultText(call.args.question),
            };
          } else {
            const parsed = this.domain.parse(
              call.args,
              context,
              r.run.evidence ?? [],
            );
            if (r.calls >= this.limits.calls)
              parsed.blockers.push(
                "调查已耗尽模型调用预算，需要新的运行重新规划",
              );
            const plan: InvestigatedPlan = {
              ...parsed.plan,
              intent: r.run.intent === "repair" ? "repair" : parsed.plan.intent,
              id: randomUUID(),
              requestRevision: r.run.requestRevision ?? 1,
            };
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
              r.calls < this.limits.calls &&
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
              this.save(r);
              continue investigation;
            }
            r.run = parsed.blockers.length
              ? {
                  ...base,
                  status: "blocked",
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
          this.save(r);
          return;
        }
        const result = this.domain.read(call.name, call.args, context);
        if ("ref" in result)
          r.run.evidence = [
            ...(r.run.evidence ?? []).filter((e) => e.ref !== result.ref),
            { ref: result.ref, hash: result.hash },
          ];
        parts.push({
          functionResponse: {
            ...(call.id ? { id: call.id } : {}),
            name: call.name,
            response: { result },
          },
        });
      }
      r.history = [...r.history, { role: "user", parts }];
      this.save(r);
    }
  }
  private async execute(r: RecordRun, signal: AbortSignal) {
    const target = r.target!;
    const plan = r.plan as InvestigatedPlan;
    const revision = plan.compositionRevision;
    signal.throwIfAborted();
    if (!this.alive(r.run.id)) return;
    this.domain.check(target, revision);
    const context = this.domain.generation(target);
    let history: unknown[] = [];
    let message: string | undefined = JSON.stringify({
      plan,
      target,
      frozenAcceptance: plan.cases,
      frozenRules: plan.workflowRules,
    });
    const failures = new Set<string>();
    while (r.candidates < this.limits.candidates) {
      if (!this.alive(r.run.id)) return;
      const attempt = r.candidates + 1;
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
        const response = await this.call(
          r,
          {
            instruction: context.instruction,
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
                name: "read_contract",
                description: "Read the public contract",
                parameters: { type: "object", properties: {} },
              },
              {
                name: "read_current_source",
                description: "Read the exact base source",
                parameters: { type: "object", properties: {} },
              },
              {
                name: "submit_candidate",
                description:
                  "Build and independently verify complete TypeScript source; optional members overlays auxiliary plugins declared in the frozen plan",
                parameters: {
                  type: "object",
                  properties: {
                    source: {
                      type: "string",
                      description: "Legacy single file; prefer files",
                    },
                    files: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          path: { type: "string" },
                          content: { type: "string" },
                        },
                        required: ["path", "content"],
                      },
                    },
                    members: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          pluginId: { type: "string" },
                          source: { type: "string" },
                        },
                        required: ["pluginId", "source"],
                      },
                      description:
                        "Auxiliary member sources matching plan.memberAdditions or plan.memberUpgrades",
                    },
                  },
                },
              },
            ],
          },
          signal,
        );
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
              ...describeBlockers([reason]),
            };
            this.save(r);
            return;
          } else if (call.name === "read_contract") {
            if (Object.keys(call.args).length)
              throw new Error("读取契约参数无效");
            this.toolEvent(r, "read_contract", "started", attempt);
            result = { contract: context.contract };
            this.toolEvent(r, "read_contract", "succeeded", attempt);
          } else if (call.name === "read_current_source") {
            if (Object.keys(call.args).length)
              throw new Error("读取源码参数无效");
            this.toolEvent(r, "read_current_source", "started", attempt);
            result = { source: context.source };
            this.toolEvent(r, "read_current_source", "succeeded", attempt);
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
            submitted = true;
            this.toolEvent(r, "submit_candidate", "started", attempt);
            this.endStep(
              r,
              generateId,
              "succeeded",
              undefined,
              "submit_candidate",
            );
            if (r.candidates >= this.limits.candidates)
              throw new Error(`已达到 ${this.limits.candidates} 个候选上限`);
            r.candidates++;
            this.save(r);
            const source =
              call.args.members !== undefined
                ? JSON.stringify({
                    ...(call.args.files !== undefined
                      ? { files: call.args.files }
                      : { source: String(call.args.source ?? "") }),
                    members: call.args.members,
                  })
                : call.args.files !== undefined
                  ? JSON.stringify({ files: call.args.files })
                  : String(call.args.source ?? "");
            const candidate: CandidateAttempt = {
              id: hash({
                source,
                planId: plan.id,
                baseVersion: target.baseVersion,
              }),
              planId: plan.id,
              baseVersion: target.baseVersion,
              attempt,
              passed: false,
              sourceHash: hash(source),
            };
            const entry = this.db
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
            try {
              if (
                Object.keys(call.args).some(
                  (key) => !["source", "files", "members"].includes(key),
                ) ||
                (call.args.source !== undefined &&
                  call.args.files !== undefined)
              )
                throw new ProtectedCandidateError(
                  "候选不得提交验证报告或控制参数",
                );
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
              this.toolEvent(r, "submit_candidate", "succeeded", attempt);
              this.save(r);
              candidate.passed = true;
              candidate.versionId = r.versionId;
              const acceptance = this.domain.acceptanceEvidence(r.versionId!);
              candidate.evidenceHash = hash({
                candidateId: candidate.id,
                versionId: r.versionId,
                cases: plan.cases,
                rules: plan.workflowRules,
                members: acceptance.members,
                workspaceChecks: acceptance.workspaceChecks,
              });
              saveAttempt();
            } catch (error) {
              if (!this.alive(r.run.id)) {
                r.versionId = undefined;
                return;
              }
              signal.throwIfAborted();
              const diagnostic =
                error instanceof Error ? error.message : "候选失败";
              result = { error: diagnostic };
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
              candidate.diagnostic = diagnostic;
              if (error instanceof CandidateValidationError)
                candidate.versionId = error.versionId;
              saveAttempt();
              const failure = hash({
                diagnostic: diagnostic.replace(
                  /candidate-[a-f0-9-]+/g,
                  "candidate",
                ),
                source,
              });
              if (error instanceof ProtectedCandidateError) {
                r.run = {
                  ...this.base(r),
                  status: "blocked",
                  plan,
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
        this.save(r);
      }
    }
    throw new Error(
      `${this.limits.candidates} 个候选均未通过验证，当前版本保持不变`,
    );
  }
  async close() {
    this.active?.controller.abort(new Error("宿主停止，运行已中断"));
    await this.active?.promise;
  }
}
