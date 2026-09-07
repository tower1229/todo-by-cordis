import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Driver, ModelReply, ModelRequest } from "./driver.js";
import type {
  AssistantCommand,
  AssistantEvent,
  AssistantPlan,
  AssistantRun,
  AssistantSnapshot,
  AssistantStep,
  InvestigatedPlan,
  PlanEvidence,
} from "../shared/assistant.js";
import { AppError } from "../shared/contracts.js";
import type { Investigation, InvestigationRead } from "../server/planning.js";
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
  target(plan: InvestigatedPlan): Target;
  check(target: Target, revision: number): void;
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
  ["awaiting-input", "ready", "blocked"].includes(status);
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
          status: "interrupted",
          message:
            "旧计划须重新调查或宿主重启，未完成的运行已中断。请重新提出需求。",
        };
        this.save(record);
      }
    }
  }
  private base(r: RecordRun) {
    return {
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
  private snapshot(run: AssistantRun | null, afterSequence = 0): AssistantSnapshot {
    if (!run) return { availability: "ready", run: null, events: [], eventCursor: 0 };
    const events = this.events(run.id, afterSequence);
    const cursor = events.at(-1)?.sequence ?? afterSequence;
    return { availability: "ready", run, events, eventCursor: cursor };
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
    let work: "plan" | "execute" | undefined;
    if (
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
          latest && ["executing", "awaiting-apply"].includes(latest.status)
            ? "需求已锁定，请先停止当前执行"
            : "请先完成或取消当前方案",
          409,
        );
      record = {
        run: {
          id: randomUUID(),
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
      if (command.runId) {
        const previous = this.get(command.runId);
        if (
          !editable(previous.run.status) ||
          latest?.id !== previous.run.id
        )
          throw new AppError("PLAN_STALE", "请重新提出需求", 409);
        if (
          command.type === "answer" &&
          previous.run.status !== "awaiting-input"
        )
          throw new AppError("REQUEST_LOCKED", "当前不等待回答", 409);
        if (
          (command.type === "revise" || command.type === "answer") &&
          ["executing", "awaiting-apply"].includes(previous.run.status)
        )
          throw new AppError("REQUEST_LOCKED", "需求已锁定，请先停止当前执行", 409);
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
        if (this.active?.id === record.run.id)
          this.active.controller.abort(new Error("已取消"));
        record.run = { ...this.base(record), status: "cancelled" };
      }
    } else if (command.type === "start") {
      record = this.get(command.runId);
      if (record.run.status !== "ready" || !("plan" in record.run))
        throw new AppError("PLAN_STALE", "没有可开始的计划", 409);
      const plan = record.run.plan as InvestigatedPlan;
      if (command.planId !== plan.id)
        throw new AppError("PLAN_STALE", "开始与计划不一致", 409);
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
    } else {
      throw new AppError(
        "PLAN_ONLY",
        "旧确认不能授予执行或应用授权，请使用开始执行",
        409,
      );
    }
    this.db.exec("BEGIN IMMEDIATE");
    let receipt: AssistantSnapshot;
    try {
      this.save(record);
      receipt = this.snapshot(record.run);
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
    if (work) this.start(record, work);
    return receipt;
  }
  private start(record: RecordRun, kind: "plan" | "execute") {
    const controller = new AbortController();
    const started = performance.now();
    const timer = setTimeout(
      () => controller.abort(new Error("已达到 10 分钟执行上限")),
      Math.max(1, this.limits.milliseconds - record.elapsed),
    );
    const promise = Promise.resolve().then(async () => {
      try {
        if (kind === "plan") await this.plan(record, controller.signal);
        else await this.execute(record, controller.signal);
      } catch (error) {
        const persisted = this.get(record.run.id);
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
  private beginStep(r: RecordRun, label: string, attempt: number) {
    if (this.get(r.run.id).run.status === "cancelled") return null;
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
    });
    this.save(r);
    return stepId;
  }
  private endStep(
    r: RecordRun,
    stepId: string | null,
    status: "succeeded" | "failed",
    detail?: string,
  ) {
    if (!stepId) return;
    const step = this.steps(r).find((s) => s.id === stepId);
    if (!step) return;
    r.run = {
      ...this.base(r),
      status: "executing",
      plan: r.plan as InvestigatedPlan,
      steps: this.steps(r).map((s) =>
        s.id === stepId ? { ...s, status } : s,
      ),
    };
    this.emit(r, {
      stepId,
      attempt: step.attempt ?? 1,
      label: step.label,
      status,
      detail,
    });
    this.save(r);
  }
  private async plan(r: RecordRun, signal: AbortSignal) {
    const context = this.domain.context();
    let message: string | undefined = JSON.stringify({
      request: r.run.request,
      revisions: r.run.revisions,
      previousPlans: r.run.plans,
    });
    r.history = [];
    const rejections = new Set<string>();
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
      if (!response.calls.length || response.calls.length > 16)
        throw new Error("模型没有返回有效调查工具调用");
      const parts: unknown[] = [];
      for (const call of response.calls) {
        signal.throwIfAborted();
        if (
          [
            "redirect_request",
            "request_clarification",
            "propose_plan",
          ].includes(call.name)
        ) {
          if (response.calls.length !== 1)
            throw new Error("调查结论须单独提交");
          if (call.name === "redirect_request") {
            r.run = {
              ...this.base(r),
              status: "dismissed",
              message: this.resultText(call.args.message),
            };
          } else if (call.name === "request_clarification") {
            if (!r.run.evidence?.some((e) => e.ref === "inspect_application"))
              throw new Error("澄清前必须调查应用");
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
            const plan = {
              ...parsed.plan,
              id: randomUUID(),
              requestRevision: r.run.requestRevision ?? 1,
            };
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
                  message: parsed.blockers.join("；"),
                  plan,
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
    if (this.get(r.run.id).run.status === "cancelled") return;
    this.domain.check(target, revision);
    const context = this.domain.generation(target);
    let history: unknown[] = [];
    let message: string | undefined = JSON.stringify({
      plan,
      target,
      frozenAcceptance: plan.cases,
      frozenRules: plan.workflowRules,
    });
    while (r.candidates < this.limits.candidates) {
      if (this.get(r.run.id).run.status === "cancelled") return;
      const attempt = r.candidates + 1;
      const generateId = this.beginStep(
        r,
        r.candidates ? "修正候选" : "生成候选",
        attempt,
      );
      let submitted = false;
      while (!submitted) {
        const response = await this.call(
          r,
          {
            instruction: context.instruction,
            history,
            message,
            tools: [
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
                  "Build and independently verify complete TypeScript source",
                parameters: {
                  type: "object",
                  properties: { source: { type: "string" } },
                  required: ["source"],
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
        const parts: unknown[] = [];
        for (const call of response.calls) {
          signal.throwIfAborted();
          if (this.get(r.run.id).run.status === "cancelled") return;
          let result: unknown;
          if (call.name === "read_contract")
            result = { contract: context.contract };
          else if (call.name === "read_current_source")
            result = { source: context.source };
          else if (call.name === "patch_candidate") {
            const path = String(call.args.path ?? "");
            throw new Error(
              path.includes("evolution") || path.startsWith("src/")
                ? "禁止修改受保护路径或超出候选可写范围"
                : "未授权工具：patch_candidate 不在当前执行阶段开放",
            );
          } else if (call.name === "submit_candidate") {
            submitted = true;
            this.endStep(r, generateId, "succeeded");
    if (r.candidates >= this.limits.candidates)
              throw new Error(`已达到 ${this.limits.candidates} 个候选上限`);
            r.candidates++;
            this.save(r);
            const source = String(call.args.source ?? "");
            let buildId: string | null = null;
            let validateId: string | null = null;
            try {
              r.versionId = await this.domain.candidate(
                source,
                target,
                signal,
                (label) => {
                  if (label === "构建候选")
                    buildId = this.beginStep(r, label, attempt);
                  else if (label === "验证行为") {
                    if (buildId) this.endStep(r, buildId, "succeeded");
                    validateId = this.beginStep(r, label, attempt);
                  } else this.beginStep(r, label, attempt);
                },
              );
              if (buildId) this.endStep(r, buildId, "succeeded");
              if (validateId) this.endStep(r, validateId, "succeeded");
              this.save(r);
              this.db
                .prepare(
                  "INSERT INTO evolution_candidates(runId,body) VALUES(?,?)",
                )
                .run(
                  r.run.id,
                  JSON.stringify({
                    source,
                    versionId: r.versionId,
                    passed: true,
                    attempt,
                  }),
                );
            } catch (error) {
              signal.throwIfAborted();
              if (this.get(r.run.id).run.status === "cancelled") return;
              const diagnostic =
                error instanceof Error ? error.message : "候选失败";
              result = { error: diagnostic };
              r.versionId = undefined;
              if (buildId) this.endStep(r, buildId, "failed", diagnostic);
              if (validateId)
                this.endStep(r, validateId, "failed", diagnostic);
              this.db
                .prepare(
                  "INSERT INTO evolution_candidates(runId,body) VALUES(?,?)",
                )
                .run(
                  r.run.id,
                  JSON.stringify({
                    source,
                    passed: false,
                    diagnostic: result,
                    attempt,
                  }),
                );
            }
            if (r.versionId) {
              if (this.get(r.run.id).run.status === "cancelled") return;
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
