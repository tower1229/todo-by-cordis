import { DatabaseSync, constants, type SQLInputValue } from "node:sqlite";
import type { ScopedDb, ScopedStatement } from "./types.js";

// Strict lowercase kebab-case guarantees injective mapping to plg_<id>__
// without '-' vs '_' prefix collisions across distinct pluginIds.
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function pluginTablePrefix(pluginId: string): string {
  if (!PLUGIN_ID_RE.test(pluginId)) {
    throw new Error(
      `Invalid pluginId for ScopedDb (expected lowercase kebab-case): ${JSON.stringify(pluginId)}`,
    );
  }
  return `plg_${pluginId.replace(/-/g, "_")}__`;
}

export function openAppDatabase(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.enableDefensive(true);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  return db;
}

type AuthorizerCallback = Parameters<DatabaseSync["setAuthorizer"]>[0];

const activeAuthorizers = new WeakMap<DatabaseSync, AuthorizerCallback>();
let savepointSeq = 0;

const ALWAYS_DENIED_ACTIONS = new Set<number>([
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_VIEW,
  constants.SQLITE_ATTACH,
  constants.SQLITE_DETACH,
  constants.SQLITE_CREATE_VTABLE,
  constants.SQLITE_DROP_VTABLE,
  // Force transaction control through scopedDb.transaction() so DDL savepoints
  // and cross-plugin foreign key checks can never be bypassed with raw BEGIN/COMMIT.
  constants.SQLITE_TRANSACTION,
  constants.SQLITE_SAVEPOINT,
]);

const DESTRUCTIVE_INTERNAL_FUNCTIONS = new Set<string>([
  "sqlite_drop_column",
  "sqlite_rename_column",
  "sqlite_rename_table",
]);

const ALLOWED_INTROSPECTION_PRAGMAS = new Set<string>([
  "table_info",
  "table_xinfo",
  "index_list",
  "foreign_key_list",
]);

// Direct user writes to sqlite_master/sqlite_schema are already blocked by
// enableDefensive(true); SQLite's own internal DDL needs catalog access here,
// whereas sqlite_sequence must remain inaccessible to plugin SQL.
const SYSTEM_CATALOG_TABLES = new Set<string>([
  "sqlite_master",
  "sqlite_schema",
  "sqlite_temp_master",
  "sqlite_temp_schema",
]);

function isSystemCatalogTable(name: string | null): boolean {
  return (
    typeof name === "string" &&
    SYSTEM_CATALOG_TABLES.has(name.toLowerCase())
  );
}

function isOwnedName(name: string | null, tablePrefix: string): boolean {
  return typeof name === "string" && name.startsWith(tablePrefix);
}

function buildAuthorizer(
  tablePrefix: string,
  touchedDdlTables: Set<string>,
): NonNullable<AuthorizerCallback> {
  return (actionCode, arg1, arg2, arg3) => {
    if (ALWAYS_DENIED_ACTIONS.has(actionCode)) {
      return constants.SQLITE_DENY;
    }

    switch (actionCode) {
      case constants.SQLITE_FUNCTION: {
        if (
          typeof arg2 === "string" &&
          DESTRUCTIVE_INTERNAL_FUNCTIONS.has(arg2.toLowerCase())
        ) {
          return constants.SQLITE_DENY;
        }
        return constants.SQLITE_OK;
      }

      case constants.SQLITE_CREATE_TABLE:
      case constants.SQLITE_CREATE_TEMP_TABLE: {
        if (arg1 === "sqlite_sequence") {
          return constants.SQLITE_OK;
        }
        if (!isOwnedName(arg1, tablePrefix)) {
          return constants.SQLITE_DENY;
        }
        touchedDdlTables.add(arg1!);
        return constants.SQLITE_OK;
      }

      case constants.SQLITE_CREATE_VIEW:
      case constants.SQLITE_CREATE_TEMP_VIEW: {
        return isOwnedName(arg1, tablePrefix)
          ? constants.SQLITE_OK
          : constants.SQLITE_DENY;
      }

      case constants.SQLITE_CREATE_INDEX:
      case constants.SQLITE_CREATE_TEMP_INDEX:
      case constants.SQLITE_DROP_INDEX:
      case constants.SQLITE_DROP_TEMP_INDEX:
      case constants.SQLITE_CREATE_TRIGGER:
      case constants.SQLITE_CREATE_TEMP_TRIGGER:
      case constants.SQLITE_DROP_TRIGGER:
      case constants.SQLITE_DROP_TEMP_TRIGGER: {
        return isOwnedName(arg2, tablePrefix)
          ? constants.SQLITE_OK
          : constants.SQLITE_DENY;
      }

      case constants.SQLITE_ALTER_TABLE: {
        // arg2 is target table name; arg3 is non-null for DROP COLUMN
        if (!isOwnedName(arg2, tablePrefix) || arg3 !== null) {
          return constants.SQLITE_DENY;
        }
        touchedDdlTables.add(arg2!);
        return constants.SQLITE_OK;
      }

      case constants.SQLITE_READ:
      case constants.SQLITE_INSERT:
      case constants.SQLITE_UPDATE:
      case constants.SQLITE_DELETE: {
        if (isSystemCatalogTable(arg1) || isOwnedName(arg1, tablePrefix)) {
          return constants.SQLITE_OK;
        }
        return constants.SQLITE_DENY;
      }

      case constants.SQLITE_PRAGMA: {
        const pragma = typeof arg1 === "string" ? arg1.toLowerCase() : "";
        if (
          ALLOWED_INTROSPECTION_PRAGMAS.has(pragma) &&
          isOwnedName(arg2, tablePrefix)
        ) {
          return constants.SQLITE_OK;
        }
        return constants.SQLITE_DENY;
      }

      default:
        return constants.SQLITE_OK;
    }
  };
}

function withAuthorizer<T>(
  db: DatabaseSync,
  authorizer: AuthorizerCallback,
  fn: () => T,
): T {
  const prev = activeAuthorizers.get(db) ?? null;
  db.setAuthorizer(authorizer);
  activeAuthorizers.set(db, authorizer);
  try {
    return fn();
  } finally {
    db.setAuthorizer(prev);
    activeAuthorizers.set(db, prev);
  }
}

function withSavepoint<T>(db: DatabaseSync, prefix: string, fn: () => T): T {
  const sp = `${prefix}_${++savepointSeq}`;
  withAuthorizer(db, null, () => {
    db.exec(`SAVEPOINT ${sp}`);
  });
  try {
    const result = fn();
    withAuthorizer(db, null, () => {
      db.exec(`RELEASE SAVEPOINT ${sp}`);
    });
    return result;
  } catch (error) {
    withAuthorizer(db, null, () => {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
        db.exec(`RELEASE SAVEPOINT ${sp}`);
      } catch {
        // Ignore rollback cleanup errors if connection state already aborted
      }
    });
    throw error;
  }
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function assertNoCrossPluginForeignKeys(
  db: DatabaseSync,
  tablePrefix: string,
  tables: ReadonlySet<string>,
): void {
  if (tables.size === 0) return;
  withAuthorizer(db, null, () => {
    for (const table of tables) {
      const fks = db
        .prepare(`PRAGMA foreign_key_list(${quoteIdentifier(table)})`)
        .all() as Array<{ table?: string }>;
      for (const fk of fks) {
        if (typeof fk.table === "string" && !fk.table.startsWith(tablePrefix)) {
          throw new Error(
            `Cross-plugin physical foreign key is not authorized: table "${table}" references "${fk.table}" (expected prefix "${tablePrefix}")`,
          );
        }
      }
    }
  });
}

export function createScopedDb(db: DatabaseSync, pluginId: string): ScopedDb {
  const tablePrefix = pluginTablePrefix(pluginId);

  const runWithDdlGuard = <T>(run: () => T): T => {
    const touchedDdlTables = new Set<string>();
    const authorizer = buildAuthorizer(tablePrefix, touchedDdlTables);
    return withSavepoint(db, "sp_scoped", () => {
      const result = withAuthorizer(db, authorizer, run);
      assertNoCrossPluginForeignKeys(db, tablePrefix, touchedDdlTables);
      return result;
    });
  };

  return {
    pluginId,
    tablePrefix,

    exec(sql: string): void {
      runWithDdlGuard(() => {
        db.exec(sql);
      });
    },

    prepare(sql: string): ScopedStatement {
      const touchedDdlTables = new Set<string>();
      const authorizer = buildAuthorizer(tablePrefix, touchedDdlTables);
      const stmt = withAuthorizer(db, authorizer, () => db.prepare(sql));

      const wrapExec = <R>(invoke: () => R): R => {
        if (touchedDdlTables.size > 0) {
          return runWithDdlGuard(invoke);
        }
        return withAuthorizer(db, authorizer, invoke);
      };

      return {
        run(...params: unknown[]) {
          return wrapExec(() =>
            stmt.run(...(params as SQLInputValue[])),
          );
        },
        get<T = Record<string, unknown>>(...params: unknown[]): T | undefined {
          return wrapExec(() => {
            const row = stmt.get(...(params as SQLInputValue[])) as
              | Record<string, unknown>
              | undefined;
            return (row ? { ...row } : undefined) as T | undefined;
          });
        },
        all<T = Record<string, unknown>>(...params: unknown[]): T[] {
          return wrapExec(() => {
            const rows = stmt.all(
              ...(params as SQLInputValue[]),
            ) as Array<Record<string, unknown>>;
            return rows.map((row) => ({ ...row })) as T[];
          });
        },
      };
    },

    transaction<T>(fn: () => T): T {
      return withSavepoint(db, "sp_tx", fn);
    },
  };
}
