import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { Runtime } from "../runtime/runtime.js";
import { catalog, isWorkflowId } from "../runtime/catalog.js";
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

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
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
type RuntimeLike = Pick<Runtime, "invoke" | "close" | "onFailure">;
type Options = {
  launch?: (id: WorkflowId) => Promise<RuntimeLike>;
  checkpoint?: (stage: string) => void;
};

export class Workspace {
  private db: DatabaseSync;
  private runtime?: RuntimeLike;
  private queue: Promise<unknown> = Promise.resolve();
  private status: Composition["status"] = "unavailable";
  private stopped = false;
  private recovering?: Promise<void>;
  private automaticRestartUsed = false;
  private publishing = false;
  private retiring = new Set<Promise<void>>();
  private launch: (id: WorkflowId) => Promise<RuntimeLike>;
  private constructor(
    filename: string,
    private options: Options,
  ) {
    mkdirSync(dirname(filename), { recursive: true });
    this.launch = options.launch ?? ((id) => Runtime.start(id));
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,state TEXT NOT NULL,revision INTEGER NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL,deletedAt TEXT,fields TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS task_order ON tasks(deletedAt,createdAt DESC,id DESC);
      CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,result TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS workspace(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,workflowId TEXT NOT NULL,buildHash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS releases(id INTEGER PRIMARY KEY,workflowId TEXT NOT NULL,createdAt TEXT NOT NULL,pausedMs REAL NOT NULL,preparationMs REAL NOT NULL,buildHash TEXT NOT NULL);`);
    this.db
      .prepare("INSERT OR IGNORE INTO workspace VALUES(1,1,?,?)")
      .run("default", this.buildHash("default"));
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
        readFileSync(
          new URL(`../runtime/plugins/${id}.${extension}`, import.meta.url),
        ),
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
    };
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
        runtime = await this.launch(this.current().workflowId);
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
    return {
      revision: active.revision,
      workflow: catalog[active.workflowId].definition,
      status: this.status,
      buildHash: active.buildHash,
      retainedFields: Object.values(catalog).flatMap(
        (plugin) => plugin.definition.fields,
      ),
      history: this.db
        .prepare(
          "SELECT id,workflowId,createdAt,pausedMs,preparationMs FROM releases ORDER BY id DESC LIMIT 20",
        )
        .all() as any,
    };
  }
  private decode(row: any): Task {
    return { ...row, fields: JSON.parse(row.fields) };
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
    if (row.hash !== hash(input))
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
  command(command: Command): Promise<CommandResult> {
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
              (v) => typeof v !== "string" || v.length > 5000,
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
          .run(command.operationId, hash(command), JSON.stringify(result));
      });
      return result;
    });
  }
  async activate(request: {
    workflowId: WorkflowId;
    operationId: string;
    compositionRevision: number;
  }) {
    if (!isWorkflowId(request.workflowId))
      throw new AppError("INVALID_WORKFLOW", "未知流程");
    const replay = this.replay(request.operationId, request);
    if (replay) return replay;
    if (this.publishing)
      throw new AppError("RELEASE_BUSY", "正在切换流程，请稍候", 409);
    this.publishing = true;
    let candidate: RuntimeLike | undefined;
    const start = performance.now();
    try {
      candidate = await this.launch(request.workflowId);
      const definition = await candidate.invoke<WorkflowDefinition>("describe");
      if (definition.id !== request.workflowId)
        throw new Error("候选身份不一致");
      // Verify both useful behavior and input handling before touching the active pointer.
      const sample: Task = {
        id: "probe",
        title: "验证",
        description: "",
        state: definition.initialState,
        fields: {},
        revision: 1,
        createdAt: "",
        updatedAt: "",
        deletedAt: null,
      };
      const probe = await candidate.invoke<WorkflowDecision>("decide", {
        task: sample,
        action: "complete",
        input: {},
      });
      if (probe.kind === "input-required") {
        const completed = await candidate.invoke<WorkflowDecision>("decide", {
          task: sample,
          action: "complete",
          input: Object.fromEntries(
            probe.fields.map((f) => [f.key, "验证复盘"]),
          ),
        });
        if (
          completed.kind !== "commit" ||
          definition.states[completed.state]?.category !== "done"
        )
          throw new Error("候选完成验证失败");
      } else if (
        probe.kind !== "commit" ||
        definition.states[probe.state]?.category !== "done"
      )
        throw new Error("候选行为验证失败");
      const preparationMs = performance.now() - start;
      return await this.serial(async () => {
        this.revision(request.compositionRevision);
        for (const row of this.db
          .prepare("SELECT DISTINCT state FROM tasks")
          .all())
          if (!definition.states[row.state as string])
            throw new AppError(
              "INCOMPATIBLE_STATE",
              "新流程无法保留当前任务状态",
            );
        const paused = performance.now();
        const revision = this.current().revision + 1;
        const buildHash = this.buildHash(request.workflowId);
        this.options.checkpoint?.("prepared");
        const result = { revision };
        this.transaction(() => {
          this.db
            .prepare(
              "UPDATE workspace SET revision=?,workflowId=?,buildHash=? WHERE id=1",
            )
            .run(revision, request.workflowId, buildHash);
          this.db
            .prepare("INSERT INTO releases VALUES(?,?,?,?,?,?)")
            .run(
              revision,
              request.workflowId,
              new Date().toISOString(),
              0,
              preparationMs,
              buildHash,
            );
          this.db
            .prepare("INSERT INTO operations VALUES(?,?,?)")
            .run(request.operationId, hash(request), JSON.stringify(result));
          this.options.checkpoint?.("transaction");
        });
        this.options.checkpoint?.("switched");
        const old = this.runtime;
        this.runtime = candidate!;
        candidate = undefined;
        this.bind(this.runtime);
        this.status = "ready";
        this.automaticRestartUsed = false;
        this.db
          .prepare("UPDATE releases SET pausedMs=? WHERE id=?")
          .run(performance.now() - paused, revision);
        // Cleanup does not hold the task write queue; obsolete runtimes cannot commit data.
        if (old) {
          old.onFailure = undefined;
          const cleanup = old
            .close()
            .finally(() => this.retiring.delete(cleanup));
          this.retiring.add(cleanup);
        }
        return result;
      });
    } finally {
      if (candidate) await candidate.close();
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
