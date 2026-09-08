import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { stripTypeScriptTypes } from "node:module";
import { Release, type Prepared } from "../release/release.js";
import type { Version, RuntimeLike } from "../release/types.js";
import { hash, operationHash } from "../release/storage.js";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Runtime } from "../runtime/runtime.js";
import { catalog } from "./catalog.js";
import {
  AppError,
  type Command,
  type CommandResult,
  type Composition,
  type Task,
  type TaskList,
  type WorkflowDecision,
  type WorkflowDefinition,
  type WorkflowId,
} from "../shared/contracts.js";

function text(value: unknown, max: number, required = false) {
  if (
    typeof value !== "string" ||
    [...value].length > max ||
    (required && !value.trim())
  )
    throw new AppError(
      "INVALID_INPUT",
      required ? `标题必填，最多 ${max} 字` : `内容最多 ${max} 字`,
    );
  return required ? value.trim() : value;
}
type Options = {
  launch?: (version: Version) => Promise<RuntimeLike>;
  checkpoint?: (stage: string) => void;
};

export class Workspace {
  readonly db: DatabaseSync;
  readonly release: Release;
  private builtins = new Map<string, Version>();
  private runtime?: RuntimeLike;
  private queue: Promise<unknown> = Promise.resolve();
  private status: Composition["status"] = "unavailable";
  private stopped = false;
  private recovering?: Promise<void>;
  private automaticRestartUsed = false;
  private publishing = false;
  private retiring = new Set<Promise<void>>();
  private launch: (version: Version) => Promise<RuntimeLike>;
  private constructor(
    filename: string,
    private options: Options,
  ) {
    mkdirSync(dirname(filename), { recursive: true });
    this.launch = options.launch ?? ((version) => Runtime.start(version));
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,deletedAt TEXT,fields TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_order ON tasks(deletedAt,createdAt DESC,id DESC);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,workflowId TEXT NOT NULL,buildHash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS releases(id INTEGER PRIMARY KEY,workflowId TEXT NOT NULL,createdAt TEXT NOT NULL,pausedMs REAL NOT NULL,preparationMs REAL NOT NULL,buildHash TEXT NOT NULL);`);
    this.db
      .prepare(
        "INSERT OR IGNORE INTO workspace(id,revision,workflowId,buildHash) VALUES(1,1,?,?)",
      )
      .run("default", this.buildHash("default"));
    this.release = new Release(
      this.db,
      join(dirname(filename), "artifacts"),
      this.launch,
    );
    const columns = (table: string) =>
      this.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((r) => String(r.name));
    if (!columns("workspace").includes("versionId"))
      this.db.exec("ALTER TABLE workspace ADD COLUMN versionId TEXT");
    if (!columns("workspace").includes("recovery"))
      this.db.exec("ALTER TABLE workspace ADD COLUMN recovery TEXT");
    if (!columns("releases").includes("versionId"))
      this.db.exec(
        "ALTER TABLE releases ADD COLUMN versionId TEXT; ALTER TABLE releases ADD COLUMN name TEXT",
      );
    for (const [id, workflow] of Object.entries(catalog)) {
      const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
      const source = readFileSync(
        new URL(`./plugins/${id}.${extension}`, import.meta.url),
        "utf8",
      );
      const code = stripTypeScriptTypes(source);
      const version = this.release.record({
        pluginId: id,
        name: workflow.definition.name,
        service: "workflow",
        contractVersion: "workflow/1",
        source,
        code,
        definition: workflow.definition,
        evidence: { passed: true, origin: "builtin" },
      });
      this.builtins.set(id, version);
      this.db
        .prepare(
          "UPDATE workspace SET versionId=?,buildHash=? WHERE workflowId=? AND versionId IS NULL",
        )
        .run(version.id, hash(code), id);
      this.db
        .prepare(
          "UPDATE releases SET versionId=?,name=? WHERE workflowId=? AND versionId IS NULL",
        )
        .run(version.id, version.name, id);
    }
  }
  static async open(filename: string, options: Options = {}) {
    const workspace = new Workspace(filename, options);
    await workspace.restart();
    return workspace;
  }
  private buildHash(id: WorkflowId) {
    const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
    return createHash("sha256")
      .update(
        readFileSync(new URL(`./plugins/${id}.${extension}`, import.meta.url)),
      )
      .digest("hex");
  }
  private serial<T>(callback: () => Promise<T> | T): Promise<T> {
    const result = this.queue.then(callback);
    this.queue = result.catch(() => {});
    return result;
  }
  private current() {
    return this.db
      .prepare("SELECT * FROM workspace WHERE id=1")
      .get() as unknown as {
      revision: number;
      workflowId: WorkflowId;
      buildHash: string;
      versionId: string;
      recovery: string | null;
    };
  }
  private readRecovery(): Composition["recovery"] | undefined {
    const raw = this.current().recovery;
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as Composition["recovery"];
    } catch {
      return undefined;
    }
  }
  private writeRecovery(recovery: Composition["recovery"] | undefined) {
    this.db
      .prepare("UPDATE workspace SET recovery=? WHERE id=1")
      .run(recovery ? JSON.stringify(recovery) : null);
  }
  private bind(runtime: RuntimeLike) {
    runtime.onFailure = () => {
      if (this.stopped || this.runtime !== runtime) return;
      this.status = "unavailable";
      if (!this.automaticRestartUsed) {
        this.automaticRestartUsed = true;
        void this.restart(false);
      }
    };
  }
  restart(manual = true): Promise<void> {
    if (this.recovering) return this.recovering;
    this.status = "recovering";
    this.recovering = this.serial(async () => {
      if (manual) this.automaticRestartUsed = false;
      await this.runtime?.close();
      let runtime: RuntimeLike | undefined;
      try {
        runtime = await this.release.start(
          this.release.get(this.current().versionId),
        );
        await runtime.invoke("describe");
        this.runtime = runtime;
        this.bind(runtime);
        this.status = "ready";
      } catch {
        await runtime?.close();
        this.status = "unavailable";
      }
    }).finally(() => {
      this.recovering = undefined;
    });
    return this.recovering;
  }
  composition(): Composition {
    const active = this.current();
    const recovery = this.readRecovery();
    const published = new Set([
      active.versionId,
      ...[...this.builtins.values()].map((version) => version.id),
      ...this.db
        .prepare("SELECT DISTINCT versionId FROM releases")
        .all()
        .map((row) => String(row.versionId)),
    ]);
    return {
      revision: active.revision,
      workflow: this.release.get(active.versionId)
        .definition as WorkflowDefinition,
      versionId: active.versionId,
      previousVersionId: this.previousVersionId(),
      status: this.status,
      buildHash: active.buildHash,
      ...(recovery ? { recovery } : {}),
      retainedFields: this.release
        .all()
        .filter(
          (v) =>
            published.has(v.id) && (v.evidence as { passed?: boolean }).passed,
        )
        .flatMap(
          (v) => (v.definition as WorkflowDefinition | null)?.fields ?? [],
        ),
      history: this.db
        .prepare(
          "SELECT id,workflowId,versionId,name,createdAt,pausedMs,preparationMs FROM releases ORDER BY id DESC LIMIT 20",
        )
        .all() as unknown as Composition["history"],
    };
  }
  private decode(row: Record<string, unknown>): Task {
    return { ...row, fields: JSON.parse(String(row.fields)) } as Task;
  }
  read(id: string): Task {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=?").get(id);
    if (!row) throw new AppError("NOT_FOUND", "找不到这条任务", 404);
    return this.decode(row);
  }
  query(search = "", category = "open", offset = 0): TaskList {
    const definition = this.composition().workflow;
    const states = Object.entries(definition.states)
      .filter(([, s]) => category === "all" || s.category === category)
      .map(([id]) => id);
    const pattern = `%${search.replace(/[\\%_]/g, "\\$&")}%`;
    const condition = `deletedAt IS NULL AND state IN (${states.map(() => "?").join(",") || "''"}) AND (title LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\')`;
    const args = [...states, pattern, pattern];
    const total = this.db
      .prepare(`SELECT count(*) AS n FROM tasks WHERE ${condition}`)
      .get(...args)!.n as number;
    const tasks = this.db
      .prepare(
        `SELECT * FROM tasks WHERE ${condition} ORDER BY createdAt DESC,id DESC LIMIT 100 OFFSET ?`,
      )
      .all(...args, Math.max(0, offset))
      .map((r) => this.decode(r));
    const counts = { open: 0, done: 0 };
    for (const row of this.db
      .prepare(
        "SELECT state,count(*) AS n FROM tasks WHERE deletedAt IS NULL GROUP BY state",
      )
      .all()) {
      const group = definition.states[row.state as string]?.category;
      if (group) counts[group] += row.n as number;
    }
    return { tasks, total, counts, revision: this.current().revision };
  }
  operation(id: string) {
    const row = this.db
      .prepare("SELECT result FROM operations WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.result as string) : null;
  }
  private replay(id: unknown, input: unknown) {
    if (typeof id !== "string" || !id || id.length > 100)
      throw new AppError("INVALID_OPERATION", "操作标识无效");
    const row = this.db
      .prepare("SELECT hash,result FROM operations WHERE id=?")
      .get(id);
    if (!row) return;
    if (row.hash !== operationHash(input))
      throw new AppError("IDEMPOTENCY_MISMATCH", "请为新的修改重新提交", 409);
    return JSON.parse(row.result as string);
  }
  private revision(revision: number) {
    if (this.current().revision !== revision)
      throw new AppError(
        "COMPOSITION_STALE",
        "流程已变化，请刷新后重试；草稿已保留",
        409,
      );
  }
  private save(task: Task) {
    this.db
      .prepare(
        "INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,description=excluded.description,state=excluded.state,revision=excluded.revision,updatedAt=excluded.updatedAt,deletedAt=excluded.deletedAt,fields=excluded.fields",
      )
      .run(
        task.id,
        task.title,
        task.description,
        task.state,
        task.revision,
        task.createdAt,
        task.updatedAt,
        task.deletedAt,
        JSON.stringify(task.fields),
      );
  }
  private transaction<T>(callback: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  command(command: Command, complete?: () => void): Promise<CommandResult> {
    return this.serial(async () => {
      const replay = this.replay(command.operationId, command);
      if (replay) return replay;
      this.revision(command.compositionRevision);
      const now = new Date().toISOString();
      let task: Task;
      let decision: WorkflowDecision | undefined;
      if (command.type === "create") {
        task = {
          id: randomUUID(),
          title: text(command.title, 200, true),
          description: text(command.description ?? "", 5000),
          state: this.composition().workflow.initialState,
          revision: 1,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
          fields: {},
        };
      } else {
        task = this.read(command.taskId ?? "");
        if (task.revision !== command.expectedRevision)
          throw new AppError(
            "REVISION_CONFLICT",
            "任务已在别处修改，请刷新后重新应用草稿",
            409,
          );
        if (task.deletedAt && command.type !== "restore")
          throw new AppError("TASK_DELETED", "任务已删除", 409);
        if (command.type === "edit") {
          task.title = text(command.title, 200, true);
          task.description = text(command.description ?? "", 5000);
        } else if (command.type === "delete") task.deletedAt = now;
        else if (command.type === "restore") task.deletedAt = null;
        else if (command.type === "action") {
          if (this.status !== "ready" || !this.runtime)
            throw new AppError(
              "RUNTIME_UNAVAILABLE",
              "流程暂时不可用，请重试运行环境",
              503,
            );
          const runtime = this.runtime;
          const definition = this.composition().workflow;
          if (
            !definition.actions.some(
              (a) => a.id === command.actionId && a.from.includes(task.state),
            )
          )
            throw new AppError("INVALID_ACTION", "当前动作不可用");
          const input = command.input ?? {};
          if (
            Object.values(input).some(
              (v) => typeof v !== "string" || [...v].length > 5000,
            )
          )
            throw new AppError("INVALID_INPUT", "表单内容无效");
          decision = await runtime.invoke<WorkflowDecision>("decide", {
            task,
            action: command.actionId,
            input,
          });
          if (runtime !== this.runtime || this.status !== "ready")
            throw new AppError(
              "RUNTIME_CHANGED",
              "运行环境已变化，请重试",
              503,
            );
          if (decision.kind === "reject")
            throw new AppError("ACTION_REJECTED", decision.message);
          if (decision.kind === "input-required") return { decision };
          if (
            decision.kind !== "commit" ||
            !definition.states[decision.state] ||
            !decision.fields ||
            Object.values(decision.fields).some((v) => typeof v !== "string")
          )
            throw new AppError("INVALID_DECISION", "流程返回了无效结果");
          task.state = decision.state;
          task.fields = decision.fields;
        } else throw new AppError("INVALID_COMMAND", "未知操作");
        task.revision++;
        task.updatedAt = now;
      }
      const result = decision ? { task, decision } : { task };
      this.transaction(() => {
        this.save(task);
        this.db
          .prepare("INSERT INTO operations VALUES(?,?,?)")
          .run(
            command.operationId,
            operationHash(command),
            JSON.stringify(result),
          );
        complete?.();
      });
      return result;
    });
  }
  activeVersion() {
    return this.release.get(this.current().versionId);
  }
  previousVersionId() {
    const history = this.db
      .prepare(
        "SELECT versionId FROM releases WHERE versionId != ? ORDER BY id DESC LIMIT 1",
      )
      .get(this.current().versionId);
    return history
      ? String(history.versionId)
      : this.current().workflowId !== "default"
        ? this.builtins.get("default")?.id
        : undefined;
  }
  async activate(
    request: {
      workflowId?: string;
      versionId?: string;
      operationId: string;
      compositionRevision: number;
    },
    complete?: () => void,
    signal?: AbortSignal,
  ) {
    const replay = this.replay(request.operationId, request);
    if (replay) return replay;
    const versionId =
      request.versionId ?? this.builtins.get(request.workflowId ?? "")?.id;
    if (
      request.versionId &&
      !this.db
        .prepare("SELECT id FROM releases WHERE versionId=? LIMIT 1")
        .get(request.versionId) &&
      ![...this.builtins.values()].some((v) => v.id === request.versionId) &&
      !complete
    )
      throw new AppError("UNKNOWN_RELEASE", "只能恢复已发布版本");
    if (!versionId) throw new AppError("INVALID_WORKFLOW", "未知流程");
    const version = this.release.get(versionId);
    if (!(version.evidence as { passed?: boolean })?.passed)
      throw new AppError("UNVERIFIED_VERSION", "候选尚未通过验证");
    const prepared = await this.release.prepare(version, async (runtime) => {
      const definition = await runtime.invoke<WorkflowDefinition>("describe");
      if (definition.id !== version.pluginId) throw new Error("候选身份不一致");
    });
    return this.publish(prepared, request, complete, signal);
  }
  async publish(
    prepared: Prepared,
    request: {
      operationId: string;
      compositionRevision: number;
      versionId?: string;
      workflowId?: string;
    },
    complete?: () => void,
    signal?: AbortSignal,
  ) {
    if (this.publishing) {
      await prepared.runtime.close();
      throw new AppError("RELEASE_BUSY", "正在切换流程，请稍候", 409);
    }
    this.publishing = true;
    const prior = this.current();
    const priorRuntime = this.runtime;
    const result: {
      revision: number;
      compensated?: boolean;
      versionId?: string;
      attemptedVersionId?: string;
      reason?: string;
    } = { revision: request.compositionRevision + 1 };
    try {
      await this.release.activate(
        prepared,
        {
          serial: (work) => this.serial(work),
          check: (version) => {
            this.revision(request.compositionRevision);
            const definition = version.definition as WorkflowDefinition;
            for (const row of this.db
              .prepare("SELECT DISTINCT state FROM tasks")
              .all())
              if (!definition.states[String(row.state)])
                throw new AppError(
                  "INCOMPATIBLE_STATE",
                  "新流程无法保留当前任务状态",
                );
          },
          commit: (version, metrics) => {
            this.options.checkpoint?.("prepared");
            this.transaction(() => {
              this.db
                .prepare(
                  "UPDATE workspace SET revision=?,workflowId=?,buildHash=?,versionId=? WHERE id=1",
                )
                .run(
                  result.revision,
                  version.pluginId,
                  hash(version.code),
                  version.id,
                );
              this.db
                .prepare(
                  "INSERT INTO releases(id,workflowId,createdAt,pausedMs,preparationMs,buildHash,versionId,name) VALUES(?,?,?,?,?,?,?,?)",
                )
                .run(
                  result.revision,
                  version.pluginId,
                  new Date().toISOString(),
                  metrics.pausedMs,
                  metrics.preparationMs,
                  hash(version.code),
                  version.id,
                  version.name,
                );
              this.db
                .prepare("INSERT INTO operations VALUES(?,?,?)")
                .run(
                  request.operationId,
                  operationHash(request),
                  JSON.stringify(result),
                );
              complete?.();
              this.options.checkpoint?.("transaction");
            });
            this.options.checkpoint?.("switched");
          },
          install: (runtime) => {
            const old = this.runtime;
            this.runtime = runtime;
            this.bind(runtime);
            // Writes stay frozen until openWrites after readiness.
            this.status = "recovering";
            this.automaticRestartUsed = false;
            if (old && old !== priorRuntime) {
              old.onFailure = undefined;
              const cleanup = old
                .close()
                .finally(() => this.retiring.delete(cleanup));
              this.retiring.add(cleanup);
            }
          },
          openWrites: () => {
            this.options.checkpoint?.("ready-check");
            this.status = "ready";
            this.writeRecovery(undefined);
            if (priorRuntime && priorRuntime !== this.runtime) {
              priorRuntime.onFailure = undefined;
              const cleanup = priorRuntime
                .close()
                .finally(() => this.retiring.delete(cleanup));
              this.retiring.add(cleanup);
            }
          },
          compensate: async (failed, reason) => {
            const restoredRevision = result.revision + 1;
            const restored = this.release.get(prior.versionId);
            const at = new Date().toISOString();
            const recovery = {
              attemptedVersionId: failed.id,
              restoredVersionId: restored.id,
              reason,
              revision: restoredRevision,
              at,
            };
            this.transaction(() => {
              this.db
                .prepare(
                  "UPDATE workspace SET revision=?,workflowId=?,buildHash=?,versionId=? WHERE id=1",
                )
                .run(
                  restoredRevision,
                  restored.pluginId,
                  hash(restored.code),
                  restored.id,
                );
              this.db
                .prepare(
                  "INSERT INTO releases(id,workflowId,createdAt,pausedMs,preparationMs,buildHash,versionId,name) VALUES(?,?,?,?,?,?,?,?)",
                )
                .run(
                  restoredRevision,
                  restored.pluginId,
                  at,
                  0,
                  0,
                  hash(restored.code),
                  restored.id,
                  `${restored.name}（补偿恢复）`,
                );
              result.revision = restoredRevision;
              result.compensated = true;
              result.versionId = restored.id;
              result.attemptedVersionId = failed.id;
              result.reason = reason;
              this.db
                .prepare("UPDATE operations SET result=? WHERE id=?")
                .run(JSON.stringify(result), request.operationId);
              this.writeRecovery(recovery);
            });
            if (this.runtime && this.runtime !== priorRuntime) {
              this.runtime.onFailure = undefined;
              this.runtime = undefined;
            }
            if (priorRuntime) {
              this.runtime = priorRuntime;
              this.bind(priorRuntime);
              this.status = "ready";
              return;
            }
            try {
              const runtime = await this.release.start(restored);
              await runtime.invoke("describe");
              this.runtime = runtime;
              this.bind(runtime);
              this.status = "ready";
            } catch {
              this.status = "unavailable";
            }
          },
        },
        signal,
      );
      return result;
    } finally {
      this.publishing = false;
    }
  }
  async close() {
    this.stopped = true;
    await this.queue;
    await this.runtime?.close();
    await Promise.all(this.retiring);
    this.db.close();
  }
}
