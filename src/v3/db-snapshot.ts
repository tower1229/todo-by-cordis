import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, backup } from "node:sqlite";
import { pluginTablePrefix } from "./scoped-db.js";

export interface TableFingerprint {
  readonly tableName: string;
  readonly schemaSql: string;
  readonly rowCount: number;
  readonly contentHash: string;
}

export interface PluginDataFingerprint {
  readonly pluginId: string;
  readonly tablePrefix: string;
  readonly tables: readonly TableFingerprint[];
}

export interface DataFingerprintDiff {
  readonly pluginId: string;
  readonly preserved: boolean;
  readonly violations: readonly string[];
}

/**
 * Safely clones a live SQLite database (including WAL-mode uncheckpointed writes)
 * using SQLite's native online backup API. Never copies the raw .db file directly.
 */
export async function cloneSqliteDatabaseOnline(
  sourceDbPath: string,
  destDbPath: string,
): Promise<void> {
  mkdirSync(dirname(destDbPath), { recursive: true });
  const sourceDb = new DatabaseSync(sourceDbPath);
  sourceDb.exec("PRAGMA busy_timeout = 5000;");
  try {
    await backup(sourceDb, destDbPath);
  } finally {
    sourceDb.close();
  }
}

function canonicalizeRow(row: Record<string, unknown>): string {
  const keys = Object.keys(row).sort();
  const normalized: Record<string, unknown> = {};
  for (const key of keys) {
    const value = row[key];
    if (value instanceof Uint8Array) {
      normalized[key] = { __bytes_b64__: Buffer.from(value).toString("base64") };
    } else if (typeof value === "bigint") {
      normalized[key] = { __bigint__: value.toString() };
    } else {
      normalized[key] = value;
    }
  }
  return JSON.stringify(normalized);
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function snapshotPluginDataFingerprint(
  dbPath: string,
  pluginId: string,
): PluginDataFingerprint {
  const tablePrefix = pluginTablePrefix(pluginId);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA busy_timeout = 5000;");

  try {
    const escapedPrefix = tablePrefix.replace(/[\\%_]/g, "\\$&");
    const tableRows = db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name LIKE ? ESCAPE '\\' ORDER BY name ASC",
      )
      .all(`${escapedPrefix}%`) as Array<{ name: string; sql: string | null }>;

    const tables: TableFingerprint[] = [];
    for (const row of tableRows) {
      const records = db
        .prepare(`SELECT * FROM ${quoteIdent(row.name)}`)
        .all() as Array<Record<string, unknown>>;
      const canonicalRows = records.map(canonicalizeRow).sort();
      const hash = createHash("sha256");
      hash.update(`${row.name}\n${row.sql ?? ""}\n${canonicalRows.length}\n`);
      for (const line of canonicalRows) {
        hash.update(line);
        hash.update("\n");
      }
      tables.push({
        tableName: row.name,
        schemaSql: row.sql ?? "",
        rowCount: canonicalRows.length,
        contentHash: hash.digest("hex"),
      });
    }

    return {
      pluginId,
      tablePrefix,
      tables,
    };
  } finally {
    db.close();
  }
}

export function comparePluginDataFingerprints(
  before: PluginDataFingerprint,
  after: PluginDataFingerprint,
): DataFingerprintDiff {
  const violations: string[] = [];
  const beforeByName = new Map(before.tables.map((t) => [t.tableName, t]));
  const afterByName = new Map(after.tables.map((t) => [t.tableName, t]));

  for (const [tableName, prev] of beforeByName) {
    const next = afterByName.get(tableName);
    if (!next) {
      violations.push(
        `Disabled plugin "${before.pluginId}" table "${tableName}" was dropped or missing after transition`,
      );
      continue;
    }
    if (next.schemaSql !== prev.schemaSql) {
      violations.push(
        `Disabled plugin "${before.pluginId}" table "${tableName}" schema was altered`,
      );
    }
    if (next.rowCount !== prev.rowCount || next.contentHash !== prev.contentHash) {
      violations.push(
        `Disabled plugin "${before.pluginId}" table "${tableName}" data changed (rows: ${prev.rowCount} -> ${next.rowCount})`,
      );
    }
  }

  for (const tableName of afterByName.keys()) {
    if (!beforeByName.has(tableName)) {
      violations.push(
        `Disabled plugin "${before.pluginId}" unexpectedly gained table "${tableName}"`,
      );
    }
  }

  return {
    pluginId: before.pluginId,
    preserved: violations.length === 0,
    violations,
  };
}
