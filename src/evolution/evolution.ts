import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Driver, ModelReply, ModelRequest } from "./driver.js";
import type {
  AssistantCommand,
  AssistantPlan,
  AssistantRun,
  AssistantSnapshot,
  AssistantStep,
} from "../shared/assistant.js";
import { AppError } from "../shared/contracts.js";
import { hash } from "../release/storage.js";
export type Target = {
  kind: "plugin" | "command";
  baseVersion: string;
  payload: unknown;
};
export type Planning =
  | { question: string }
  | { plan: Omit<AssistantPlan, "id">; target: Target };
export interface Domain {
  context(): unknown;
  planningInstruction: string;
  planningSchema: Record<string, unknown>;
  parse(value: unknown, context: unknown): Planning;
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
  apply(
    versionId: string,
    target: Target,
    revision: number,
    operationId: string,
    complete: () => void,
    signal: AbortSignal,
  ): Promise<void>;
  command(
    target: Target,
    revision: number,
    operationId: string,
    complete: () => void,
  ): Promise<void>;
}
type RecordRun = {
  run: AssistantRun;
  target?: Target;
  plan?: AssistantPlan;
  history: unknown[];
  calls: number;
  candidates: number;
  elapsed: number;
  versionId?: string;
};
const terminal = (status: string) =>
  ["succeeded", "failed", "cancelled"].includes(status);
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
      CREATE TABLE IF NOT EXISTS evolution_operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,runId TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evolution_calls(id INTEGER PRIMARY KEY,runId TEXT NOT NULL,body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evolution_candidates(id INTEGER PRIMARY KEY,runId TEXT NOT NULL,body TEXT NOT NULL);`);
    for (const row of db.prepare("SELECT body FROM evolution_runs").all()) {
      const record = JSON.parse(String(row.body)) as RecordRun;
      if (["planning", "executing"].includes(record.run.status)) {
        record.run = {
          ...this.base(record),
          status: "failed",
          message: "宿主重启，未完成的运行已中断。请重新提出需求。",
          steps: this.steps(record),
        };
        this.save(record);
      }
    }
  }
  private base(r: RecordRun) {
    return {
      id: r.run.id,
      request: r.run.request,
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
  async observe(): Promise<AssistantSnapshot> {
    const row = this.db
      .prepare("SELECT body FROM evolution_runs ORDER BY rowid DESC LIMIT 1")
      .get();
    return {
      availability: "ready",
      run: row ? (JSON.parse(String(row.body)) as RecordRun).run : null,
    };
  }
  async command(command: AssistantCommand): Promise<AssistantSnapshot> {
    const prior = this.db
      .prepare("SELECT hash,runId FROM evolution_operations WHERE id=?")
      .get(command.operationId);
    if (prior) {
      if (prior.hash !== hash(command))
        throw new AppError(
          "IDEMPOTENCY_MISMATCH",
          "操作标识已用于其他请求",
          409,
        );
      return { availability: "ready", run: this.get(String(prior.runId)).run };
    }
    let record: RecordRun;
    let work: "plan" | "execute" | undefined;
    if (command.type === "request") {
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
          !(latest.status === "awaiting-input" && latest.id === command.runId))
      )
        throw new AppError("EVOLUTION_BUSY", "请先完成或取消当前方案", 409);
      record = {
        run: {
          id: randomUUID(),
          request: command.text,
          updatedAt: new Date().toISOString(),
          status: "planning",
        },
        history: [],
        calls: 0,
        candidates: 0,
        elapsed: 0,
      };
      if (command.runId) {
        const previous = this.get(command.runId);
        if (
          previous.run.status !== "awaiting-input" ||
          latest?.id !== previous.run.id
        )
          throw new AppError("PLAN_STALE", "请重新提出需求", 409);
        record = previous;
        record.run = {
          ...this.base(record),
          request: `${previous.run.request}\n澄清：${command.text}`,
          status: "planning",
        };
      }
      work = "plan";
    } else {
      record = this.get(command.runId);
      if (command.type === "cancel") {
        if (!terminal(record.run.status)) {
          if (this.active?.id === record.run.id)
            this.active.controller.abort(new Error("已取消"));
          record.run = { ...this.base(record), status: "cancelled" };
        }
      } else {
        if (
          !record.plan ||
          command.planId !== record.plan.id ||
          command.compositionRevision !== record.plan.compositionRevision
        )
          throw new AppError("PLAN_STALE", "确认与方案不一致", 409);
        if (record.run.status === "awaiting-confirmation") {
          this.domain.check(record.target!, record.plan.compositionRevision);
          record.run = {
            ...this.base(record),
            status: "executing",
            plan: record.plan,
            steps: [],
          };
          work = "execute";
        } else if (!["executing", "succeeded"].includes(record.run.status))
          throw new AppError("PLAN_STALE", "方案已失效", 409);
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.save(record);
      this.db
        .prepare("INSERT INTO evolution_operations VALUES(?,?,?)")
        .run(command.operationId, hash(command), record.run.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    if (work) this.start(record, work);
    return { availability: "ready", run: record.run };
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
        // A committed success wins over cancellation or a transport failure after commit.
        const persisted = this.get(record.run.id);
        if (!terminal(persisted.run.status)) {
          record.run = {
            ...this.base(record),
            status: "failed",
            message: error instanceof Error ? error.message : "运行失败",
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
      throw new Error("已达到 12 次模型调用上限");
    r.calls++;
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
      reply = await this.driver.generate(request, signal);
    } catch (error) {
      this.db.prepare("UPDATE evolution_calls SET body=? WHERE id=?").run(
        JSON.stringify({
          startedAt,
          request,
          status: "failed",
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

  private async plan(r: RecordRun, signal: AbortSignal) {
    const context = this.domain.context();
    const response = await this.call(
      r,
      {
        instruction: this.domain.planningInstruction,
        schema: this.domain.planningSchema,
        history: [],
        message: JSON.stringify({ request: r.run.request, context }),
      },
      signal,
    );
    const parsed = this.domain.parse(JSON.parse(response.text), context);
    if ("question" in parsed)
      r.run = {
        ...this.base(r),
        status: "awaiting-input",
        question: parsed.question,
      };
    else {
      r.target = parsed.target;
      r.plan = { ...parsed.plan, id: randomUUID() };
      r.run = {
        ...this.base(r),
        status: "awaiting-confirmation",
        plan: r.plan,
      };
    }
    this.save(r);
  }
  private stage(r: RecordRun, label: string) {
    if (this.get(r.run.id).run.status === "cancelled") return;
    const steps = this.steps(r).map((s) =>
      s.status === "running" ? { ...s, status: "succeeded" as const } : s,
    );
    steps.push({ id: randomUUID(), label, status: "running" });
    r.run = { ...this.base(r), status: "executing", plan: r.plan!, steps };
    this.save(r);
  }
  private success(r: RecordRun) {
    r.run = {
      ...this.base(r),
      status: "succeeded",
      versionId: r.versionId,
      summary: r.plan!.outcome,
      steps: this.steps(r).map((s) =>
        s.status === "running" ? { ...s, status: "succeeded" } : s,
      ),
    };
    this.save(r);
  }
  private async execute(r: RecordRun, signal: AbortSignal) {
    const target = r.target!;
    const revision = r.plan!.compositionRevision;
    signal.throwIfAborted();
    this.domain.check(target, revision);
    if (target.kind === "command") {
      this.stage(r, "执行任务操作");
      await this.domain.command(target, revision, r.run.id, () => {
        signal.throwIfAborted();
        this.success(r);
      });
      return;
    }
    const context = this.domain.generation(target);
    this.stage(r, "生成候选");
    let history: unknown[] = [];
    let message: string | undefined = JSON.stringify({ plan: r.plan, target });
    while (r.candidates < this.limits.candidates) {
      if (r.candidates) this.stage(r, "修正候选");
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
      if (!response.calls.length) throw new Error("模型没有提交候选或工具调用");
      const parts: unknown[] = [];
      for (const call of response.calls) {
        signal.throwIfAborted();
        let result: unknown;
        if (call.name === "read_contract")
          result = { contract: context.contract };
        else if (call.name === "read_current_source")
          result = { source: context.source };
        else if (call.name === "submit_candidate") {
          if (r.candidates >= this.limits.candidates)
            throw new Error("已达到 3 个候选上限");
          r.candidates++;
          this.save(r);
          const source = String(call.args.source ?? "");
          try {
            r.versionId = await this.domain.candidate(
              source,
              target,
              signal,
              (label) => this.stage(r, label),
            );
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
                }),
              );
          } catch (error) {
            signal.throwIfAborted();
            result = {
              error: error instanceof Error ? error.message : "候选失败",
            };
            r.versionId = undefined;
            if (r.run.status === "executing")
              r.run.steps = r.run.steps.map((step) =>
                step.status === "running"
                  ? { ...step, status: "failed" }
                  : step,
              );
            this.save(r);
            this.db
              .prepare(
                "INSERT INTO evolution_candidates(runId,body) VALUES(?,?)",
              )
              .run(
                r.run.id,
                JSON.stringify({ source, passed: false, diagnostic: result }),
              );
          }
          if (r.versionId) {
            signal.throwIfAborted();
            this.stage(r, "应用版本");
            await this.domain.apply(
              r.versionId,
              target,
              revision,
              r.run.id,
              () => {
                signal.throwIfAborted();
                this.success(r);
              },
              signal,
            );
            return;
          }
        } else throw new Error("模型请求了未授权工具");
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
    throw new Error("三个候选均未应用，当前版本保持不变");
  }
  async close() {
    this.active?.controller.abort(new Error("宿主停止，运行已中断"));
    await this.active?.promise;
  }
}
