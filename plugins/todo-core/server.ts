import { Service, type Context } from "cordis";
import type { ScopedDb } from "@host/server-sdk";
import type {
  CreateTaskInput,
  TaskItem,
  TaskState,
  TodoService,
  UpdateTaskPatch,
} from "./contract.d.ts";

interface TaskRow {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly state: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function toTaskItem(row: TaskRow): TaskItem {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    state: row.state === "done" ? "done" : "open",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function httpError(status: number, message: string): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

export default class TodoCoreService extends Service implements TodoService {
  private readonly db: ScopedDb;

  constructor(ctx: Context) {
    super(ctx, "todo");
    this.db = ctx.db;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plg_todo_core__tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        notes TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'open',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    ctx.http.route("GET", "/tasks", (req) => {
      const state = req.query.state;
      if (state !== undefined && state !== "open" && state !== "done") {
        return { status: 400, body: { error: `Invalid state filter: ${state}` } };
      }
      return { tasks: this.list(state ? { state } : undefined) };
    });

    ctx.http.route("POST", "/tasks", (req) => {
      const body = (req.body ?? {}) as { title?: unknown; notes?: unknown };
      if (typeof body.title !== "string" || body.title.trim().length === 0) {
        return { status: 400, body: { error: "Task title is required" } };
      }
      const task = this.create({
        title: body.title,
        notes: typeof body.notes === "string" ? body.notes : undefined,
      });
      return { status: 201, body: { task } };
    });

    ctx.http.route("GET", "/tasks/:id", (req) => {
      const task = this.get(req.params.id);
      if (!task) {
        return { status: 404, body: { error: "Task not found" } };
      }
      return { task };
    });

    ctx.http.route("PATCH", "/tasks/:id", (req) => {
      const body = (req.body ?? {}) as { title?: unknown; notes?: unknown };
      const patch: { title?: string; notes?: string } = {};
      if (body.title !== undefined) {
        if (typeof body.title !== "string" || body.title.trim().length === 0) {
          return { status: 400, body: { error: "Task title must be non-empty" } };
        }
        patch.title = body.title;
      }
      if (body.notes !== undefined) {
        if (typeof body.notes !== "string") {
          return { status: 400, body: { error: "Task notes must be a string" } };
        }
        patch.notes = body.notes;
      }
      const updated = this.update(req.params.id, patch);
      if (!updated) {
        return { status: 404, body: { error: "Task not found" } };
      }
      return { task: updated };
    });

    ctx.http.route("DELETE", "/tasks/:id", (req) => {
      const deleted = this.delete(req.params.id);
      if (!deleted) {
        return { status: 404, body: { error: "Task not found" } };
      }
      return { deleted: true, id: req.params.id };
    });

    ctx.http.route("POST", "/tasks/:id/transition", async (req) => {
      const body = (req.body ?? {}) as {
        nextState?: unknown;
        meta?: Record<string, unknown>;
      };
      if (body.nextState !== "open" && body.nextState !== "done") {
        return {
          status: 400,
          body: { error: "nextState must be 'open' or 'done'" },
        };
      }
      const updated = await this.transition(
        req.params.id,
        body.nextState,
        body.meta,
      );
      return { task: updated };
    });
  }

  list(filter?: { readonly state?: TaskState }): TaskItem[] {
    if (filter?.state) {
      const rows = this.db
        .prepare(
          "SELECT id, title, notes, state, created_at, updated_at FROM plg_todo_core__tasks WHERE state = ? ORDER BY created_at ASC, id ASC",
        )
        .all<TaskRow>(filter.state);
      return rows.map(toTaskItem);
    }
    const rows = this.db
      .prepare(
        "SELECT id, title, notes, state, created_at, updated_at FROM plg_todo_core__tasks ORDER BY created_at ASC, id ASC",
      )
      .all<TaskRow>();
    return rows.map(toTaskItem);
  }

  get(id: string): TaskItem | null {
    const row = this.db
      .prepare(
        "SELECT id, title, notes, state, created_at, updated_at FROM plg_todo_core__tasks WHERE id = ?",
      )
      .get<TaskRow>(id);
    return row ? toTaskItem(row) : null;
  }

  create(input: string | CreateTaskInput): TaskItem {
    const rawTitle = typeof input === "string" ? input : input.title;
    const title = rawTitle.trim();
    if (!title) {
      throw httpError(400, "Task title is required");
    }
    const notes = typeof input === "string" ? "" : (input.notes ?? "");
    const now = new Date().toISOString();
    const id = globalThis.crypto.randomUUID();

    this.db
      .prepare(
        "INSERT INTO plg_todo_core__tasks (id, title, notes, state, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, ?)",
      )
      .run(id, title, notes, now, now);

    const created = this.get(id)!;
    this.ctx.emit("todo:changed", created);
    return created;
  }

  update(id: string, patch: UpdateTaskPatch): TaskItem | null {
    const existing = this.get(id);
    if (!existing) return null;

    const nextTitle =
      patch.title !== undefined ? patch.title.trim() : existing.title;
    if (!nextTitle) {
      throw httpError(400, "Task title must be non-empty");
    }
    const nextNotes = patch.notes !== undefined ? patch.notes : existing.notes;
    const now = new Date().toISOString();

    this.db
      .prepare(
        "UPDATE plg_todo_core__tasks SET title = ?, notes = ?, updated_at = ? WHERE id = ?",
      )
      .run(nextTitle, nextNotes, now, id);

    const updated = this.get(id)!;
    this.ctx.emit("todo:changed", updated);
    return updated;
  }

  delete(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM plg_todo_core__tasks WHERE id = ?")
      .run(id);
    return Number(result.changes) > 0;
  }

  async transition(
    id: string,
    nextState: TaskState,
    meta?: Record<string, unknown>,
  ): Promise<TaskItem> {
    const existing = this.get(id);
    if (!existing) {
      throw httpError(404, "Task not found");
    }

    const hooks = this.ctx.events._hooks["todo:before-transition"] ?? [];
    for (const hook of [...hooks]) {
      const verdict = await hook.callback({
        task: existing,
        nextState,
        meta,
      });
      if (verdict === false) {
        throw httpError(422, "Task transition blocked");
      }
      if (typeof verdict === "string" && verdict.length > 0) {
        throw httpError(422, verdict);
      }
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        "UPDATE plg_todo_core__tasks SET state = ?, updated_at = ? WHERE id = ?",
      )
      .run(nextState, now, id);

    const updated = this.get(id)!;
    this.ctx.emit("todo:changed", updated);
    return updated;
  }
}
