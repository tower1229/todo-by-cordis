import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  createScopedDb,
  openAppDatabase,
  pluginTablePrefix,
} from "../../src/runtime/server/scoped-db.js";

describe("ScopedDb engine-level isolation", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function setupDb() {
    const dir = mkdtempSync(join(tmpdir(), "host-scoped-db-"));
    dirs.push(dir);
    const dbPath = join(dir, "app.db");
    const db = openAppDatabase(dbPath);
    return { db, dbPath };
  }

  it("normalizes pluginId to plg_<id>__ and permits own-table DDL, DML, index, ADD COLUMN, and transactions", () => {
    const { db } = setupDb();
    try {
      assert.equal(pluginTablePrefix("todo-core"), "plg_todo_core__");
      const todoDb = createScopedDb(db, "todo-core");
      assert.equal(todoDb.pluginId, "todo-core");
      assert.equal(todoDb.tablePrefix, "plg_todo_core__");

      todoDb.exec(`
        CREATE TABLE IF NOT EXISTS plg_todo_core__tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_todo_title ON plg_todo_core__tasks(title);
      `);

      todoDb.exec(
        "ALTER TABLE plg_todo_core__tasks ADD COLUMN state TEXT NOT NULL DEFAULT 'open'",
      );

      const inserted = todoDb.transaction(() => {
        const stmt = todoDb.prepare(
          "INSERT INTO plg_todo_core__tasks (id, title, state) VALUES (?, ?, ?)",
        );
        stmt.run("t1", "Write V3 runtime", "open");
        stmt.run("t2", "Ship ScopedDb", "done");
        return todoDb
          .prepare("SELECT id, title, state FROM plg_todo_core__tasks ORDER BY id")
          .all<{ id: string; title: string; state: string }>();
      });

      assert.deepEqual(inserted, [
        { id: "t1", title: "Write V3 runtime", state: "open" },
        { id: "t2", title: "Ship ScopedDb", state: "done" },
      ]);

      todoDb
        .prepare("UPDATE plg_todo_core__tasks SET state = ? WHERE id = ?")
        .run("done", "t1");
      const updated = todoDb
        .prepare("SELECT state FROM plg_todo_core__tasks WHERE id = ?")
        .get<{ state: string }>("t1");
      assert.equal(updated?.state, "done");

      todoDb.prepare("DELETE FROM plg_todo_core__tasks WHERE id = ?").run("t2");
      const remaining = todoDb
        .prepare("SELECT id FROM plg_todo_core__tasks")
        .all<{ id: string }>();
      assert.deepEqual(remaining, [{ id: "t1" }]);
    } finally {
      db.close();
    }
  });

  it("denies cross-plugin table reads, writes, creates, and unprefixed table access at SQLite authorizer level", () => {
    const { db } = setupDb();
    try {
      const todoDb = createScopedDb(db, "todo-core");
      const tagsDb = createScopedDb(db, "tags");

      todoDb.exec(
        "CREATE TABLE plg_todo_core__tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
      );
      todoDb
        .prepare("INSERT INTO plg_todo_core__tasks (id, title) VALUES (?, ?)")
        .run("t1", "Secret task");

      // Cross-plugin SELECT
      assert.throws(() => {
        tagsDb.prepare("SELECT * FROM plg_todo_core__tasks").all();
      }, /not authorized|prohibited/i);

      // Cross-plugin INSERT / UPDATE / DELETE
      assert.throws(() => {
        tagsDb
          .prepare("INSERT INTO plg_todo_core__tasks (id, title) VALUES (?, ?)")
          .run("t2", "Injected");
      }, /not authorized/i);
      assert.throws(() => {
        tagsDb
          .prepare("UPDATE plg_todo_core__tasks SET title = ? WHERE id = ?")
          .run("Tampered", "t1");
      }, /not authorized/i);
      assert.throws(() => {
        tagsDb.prepare("DELETE FROM plg_todo_core__tasks").run();
      }, /not authorized/i);

      // Creating unprefixed or other plugin's table
      assert.throws(() => {
        tagsDb.exec("CREATE TABLE tasks (id TEXT PRIMARY KEY)");
      }, /not authorized/i);
      assert.throws(() => {
        tagsDb.exec("CREATE TABLE plg_todo_core__evil (id TEXT PRIMARY KEY)");
      }, /not authorized/i);

      // Cross-plugin index or alter
      assert.throws(() => {
        tagsDb.exec(
          "CREATE INDEX idx_evil ON plg_todo_core__tasks(title)",
        );
      }, /not authorized/i);
      assert.throws(() => {
        tagsDb.exec("ALTER TABLE plg_todo_core__tasks ADD COLUMN hack TEXT");
      }, /not authorized/i);

      // Original data intact
      const rows = todoDb
        .prepare("SELECT id, title FROM plg_todo_core__tasks")
        .all<{ id: string; title: string }>();
      assert.deepEqual(rows, [{ id: "t1", title: "Secret task" }]);
    } finally {
      db.close();
    }
  });

  it("denies DROP TABLE, DROP VIEW, ATTACH, DETACH, virtual tables, and destructive ALTER TABLE statements even on own tables", () => {
    const { db } = setupDb();
    try {
      const todoDb = createScopedDb(db, "todo-core");
      todoDb.exec(`
        CREATE TABLE plg_todo_core__tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          notes TEXT
        )
      `);
      todoDb
        .prepare("INSERT INTO plg_todo_core__tasks (id, title, notes) VALUES (?, ?, ?)")
        .run("t1", "Keep me", "important");

      assert.throws(() => {
        todoDb.exec("DROP TABLE plg_todo_core__tasks");
      }, /not authorized/i);

      assert.throws(() => {
        todoDb.exec("ALTER TABLE plg_todo_core__tasks DROP COLUMN notes");
      }, /not authorized/i);

      assert.throws(() => {
        todoDb.exec("ALTER TABLE plg_todo_core__tasks RENAME COLUMN notes TO memo");
      }, /not authorized/i);

      assert.throws(() => {
        todoDb.exec("ALTER TABLE plg_todo_core__tasks RENAME TO plg_todo_core__tasks_v2");
      }, /not authorized/i);

      assert.throws(() => {
        todoDb.exec("ATTACH DATABASE ':memory:' AS extra");
      }, /not authorized/i);

      assert.throws(() => {
        todoDb.exec("DETACH DATABASE main");
      }, /not authorized/i);

      assert.throws(() => {
        todoDb.exec(
          "CREATE VIRTUAL TABLE plg_todo_core__fts USING fts5(title)",
        );
      }, /not authorized/i);

      // Verify table & data survived all destructive attempts
      const row = todoDb
        .prepare("SELECT id, title, notes FROM plg_todo_core__tasks WHERE id = ?")
        .get<{ id: string; title: string; notes: string }>("t1");
      assert.deepEqual(row, { id: "t1", title: "Keep me", notes: "important" });
    } finally {
      db.close();
    }
  });

  it("denies cross-plugin physical foreign keys while allowing intra-plugin foreign keys and weak-ID references", () => {
    const { db } = setupDb();
    try {
      const todoDb = createScopedDb(db, "todo-core");
      const tagsDb = createScopedDb(db, "tags");

      todoDb.exec(
        "CREATE TABLE plg_todo_core__tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
      );

      // Cross-plugin physical FK must be rejected and rolled back cleanly
      assert.throws(() => {
        tagsDb.exec(`
          CREATE TABLE plg_tags__links (
            id TEXT PRIMARY KEY,
            task_id TEXT NOT NULL REFERENCES plg_todo_core__tasks(id)
          )
        `);
      }, /foreign key|not authorized/i);

      // Table should not exist after rejected DDL
      const exists = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plg_tags__links'",
        )
        .get();
      assert.equal(exists, undefined);

      // Weak-ID reference without physical FK succeeds
      tagsDb.exec(`
        CREATE TABLE plg_tags__items (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL,
          tag TEXT NOT NULL
        )
      `);
      tagsDb
        .prepare("INSERT INTO plg_tags__items (id, task_id, tag) VALUES (?, ?, ?)")
        .run("tg1", "t1", "urgent");

      // Cross-plugin FK via prepare().run() must also be denied
      assert.throws(
        () =>
          tagsDb
            .prepare(
              `CREATE TABLE plg_tags__evil_fk (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL REFERENCES plg_todo_core__tasks(id)
              )`,
            )
            .run(),
        /Cross-plugin physical foreign key/,
      );

      // Intra-plugin FK between own tables is allowed
      tagsDb.exec(`
        CREATE TABLE plg_tags__meta (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL REFERENCES plg_tags__items(id)
        )
      `);
      assert.equal(
        tagsDb
          .prepare("SELECT tag FROM plg_tags__items WHERE task_id = ?")
          .get<{ tag: string }>("t1")?.tag,
        "urgent",
      );
    } finally {
      db.close();
    }
  });

  it("rolls back transaction cleanly when callback throws", () => {
    const { db } = setupDb();
    try {
      const todoDb = createScopedDb(db, "todo-core");
      todoDb.exec(
        "CREATE TABLE plg_todo_core__tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
      );

      assert.throws(() => {
        todoDb.transaction(() => {
          todoDb
            .prepare("INSERT INTO plg_todo_core__tasks (id, title) VALUES (?, ?)")
            .run("t1", "Should rollback");
          throw new Error("boom");
        });
      }, /boom/);

      const rows = todoDb
        .prepare("SELECT id FROM plg_todo_core__tasks")
        .all();
      assert.deepEqual(rows, []);
    } finally {
      db.close();
    }
  });

  it("blocks raw BEGIN/COMMIT FK bypass, sqlite_sequence tampering, and underscore pluginId prefix collisions", () => {
    const { db } = setupDb();
    try {
      // Underscore pluginId rejected to prevent collision with kebab-case 'todo-core'
      assert.throws(() => createScopedDb(db, "todo_core"), /Invalid pluginId/);

      const todoDb = createScopedDb(db, "todo-core");
      const evilDb = createScopedDb(db, "evil");

      todoDb.exec(`
        CREATE TABLE plg_todo_core__tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          title TEXT NOT NULL
        )
      `);
      todoDb
        .prepare("INSERT INTO plg_todo_core__tasks (title) VALUES (?)")
        .run("first");

      // Multi-statement BEGIN; CREATE TABLE ... REFERENCES ...; COMMIT must be denied
      assert.throws(() => {
        evilDb.exec(`
          BEGIN;
          CREATE TABLE plg_evil__fk (
            id TEXT PRIMARY KEY,
            task_id INTEGER REFERENCES plg_todo_core__tasks(id)
          );
          COMMIT;
        `);
      }, /not authorized|foreign key/i);

      // sqlite_sequence cannot be read or tampered with by another plugin
      assert.throws(() => {
        evilDb.exec("DELETE FROM sqlite_sequence");
      }, /not authorized|prohibited/i);
      assert.throws(() => {
        evilDb.prepare("SELECT * FROM sqlite_sequence").all();
      }, /not authorized|prohibited/i);
    } finally {
      db.close();
    }
  });
});
