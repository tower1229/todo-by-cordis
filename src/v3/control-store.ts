import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  DataFingerprintDiff,
  TestChangeDisclosure,
  VerificationReport,
} from "./plugin-verifier.js";
import type {
  CompositionMember,
  CompositionSnapshot,
  PluginArtifact,
} from "./types.js";

export type CompositionRecordKind = "initial" | "apply" | "rollback";

export interface CompositionRecord extends CompositionSnapshot {
  readonly kind: CompositionRecordKind;
  readonly targetCompositionId?: string | null;
  readonly candidateId?: string | null;
  readonly summary?: string | null;
}

export interface AffectedPluginSummary {
  readonly pluginId: string;
  readonly action: "added" | "upgraded" | "enabled" | "disabled";
  readonly fromVersionId?: string;
  readonly toVersionId: string;
}

export interface DataCompatibilitySummary {
  readonly compatible: boolean;
  readonly summary: string;
  readonly disabledPluginDataChecks: readonly DataFingerprintDiff[];
}

export interface ChangeBrief {
  readonly summary: string;
  readonly affectedPlugins: readonly AffectedPluginSummary[];
  readonly dataCompatibility: DataCompatibilitySummary;
  readonly testChangeDisclosures: readonly TestChangeDisclosure[];
  readonly noBehaviorDiffWarning: boolean;
  readonly warnings: readonly string[];
}

export type CandidateReceiptStatus = "verified" | "applied" | "rejected";

export interface CandidateReceipt {
  readonly candidateId: string;
  readonly baseCompositionId: string;
  readonly candidateComposition: CompositionSnapshot;
  readonly changeBrief: ChangeBrief;
  readonly verificationReport: VerificationReport;
  readonly status: CandidateReceiptStatus;
  readonly createdAt: string;
  readonly appliedAt?: string | null;
}

export interface CompareAndSetResult {
  readonly committed: boolean;
  readonly actualActiveCompositionId: string | null;
}

export class ControlStore {
  private readonly db: DatabaseSync;

  constructor(readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plugin_artifacts (
        plugin_id TEXT NOT NULL,
        version_id TEXT NOT NULL,
        artifact_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (plugin_id, version_id)
      );

      CREATE TABLE IF NOT EXISTS compositions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        composition_id TEXT NOT NULL UNIQUE,
        parent_composition_id TEXT,
        members_json TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_composition_id TEXT,
        candidate_id TEXT,
        summary TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS active_pointer (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active_composition_id TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS candidate_receipts (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        candidate_id TEXT NOT NULL UNIQUE,
        base_composition_id TEXT NOT NULL,
        candidate_composition_json TEXT NOT NULL,
        change_brief_json TEXT NOT NULL,
        verification_report_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
    `);
  }

  saveArtifact(artifact: PluginArtifact): void {
    const serialized = JSON.stringify(artifact);
    const existing = this.db
      .prepare(
        "SELECT artifact_json FROM plugin_artifacts WHERE plugin_id = ? AND version_id = ?",
      )
      .get(artifact.pluginId, artifact.versionId) as
      | { artifact_json: string }
      | undefined;

    if (existing) {
      if (existing.artifact_json !== serialized) {
        throw new Error(
          `Immutable artifact conflict for ${artifact.pluginId}@${artifact.versionId}`,
        );
      }
      return;
    }

    this.db
      .prepare(
        `INSERT INTO plugin_artifacts (plugin_id, version_id, artifact_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        artifact.pluginId,
        artifact.versionId,
        serialized,
        new Date().toISOString(),
      );
  }

  getArtifact(pluginId: string, versionId: string): PluginArtifact | undefined {
    const row = this.db
      .prepare(
        "SELECT artifact_json FROM plugin_artifacts WHERE plugin_id = ? AND version_id = ?",
      )
      .get(pluginId, versionId) as { artifact_json: string } | undefined;
    if (!row) return undefined;
    return JSON.parse(row.artifact_json) as PluginArtifact;
  }

  listArtifacts(): PluginArtifact[] {
    const rows = this.db
      .prepare(
        "SELECT artifact_json FROM plugin_artifacts ORDER BY created_at ASC, plugin_id ASC, version_id ASC",
      )
      .all() as Array<{ artifact_json: string }>;
    return rows.map((row) => JSON.parse(row.artifact_json) as PluginArtifact);
  }

  getActiveCompositionId(): string | null {
    const row = this.db
      .prepare("SELECT active_composition_id FROM active_pointer WHERE id = 1")
      .get() as { active_composition_id: string } | undefined;
    return row ? row.active_composition_id : null;
  }

  getActiveComposition(): CompositionRecord | undefined {
    const activeId = this.getActiveCompositionId();
    if (!activeId) return undefined;
    return this.getComposition(activeId);
  }

  getComposition(compositionId: string): CompositionRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT composition_id, parent_composition_id, members_json, kind,
                target_composition_id, candidate_id, summary, created_at
         FROM compositions WHERE composition_id = ?`,
      )
      .get(compositionId) as
      | {
          composition_id: string;
          parent_composition_id: string | null;
          members_json: string;
          kind: CompositionRecordKind;
          target_composition_id: string | null;
          candidate_id: string | null;
          summary: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) return undefined;
    return this.mapCompositionRow(row);
  }

  listCompositions(): CompositionRecord[] {
    const rows = this.db
      .prepare(
        `SELECT composition_id, parent_composition_id, members_json, kind,
                target_composition_id, candidate_id, summary, created_at
         FROM compositions ORDER BY seq DESC`,
      )
      .all() as Array<{
      composition_id: string;
      parent_composition_id: string | null;
      members_json: string;
      kind: CompositionRecordKind;
      target_composition_id: string | null;
      candidate_id: string | null;
      summary: string | null;
      created_at: string;
    }>;

    return rows.map((row) => this.mapCompositionRow(row));
  }

  compareAndSetActiveComposition(
    expectedBaseCompositionId: string | null,
    nextComposition: CompositionRecord,
    options?: { readonly markCandidateApplied?: string },
  ): CompareAndSetResult {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const current = this.getActiveCompositionId();
      if (current !== expectedBaseCompositionId) {
        this.db.exec("ROLLBACK;");
        return {
          committed: false,
          actualActiveCompositionId: current,
        };
      }

      this.db
        .prepare(
          `INSERT INTO compositions (
             composition_id, parent_composition_id, members_json, kind,
             target_composition_id, candidate_id, summary, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          nextComposition.compositionId,
          nextComposition.parentCompositionId,
          JSON.stringify(nextComposition.members),
          nextComposition.kind,
          nextComposition.targetCompositionId ?? null,
          nextComposition.candidateId ?? null,
          nextComposition.summary ?? null,
          nextComposition.createdAt,
        );

      const now = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO active_pointer (id, active_composition_id, updated_at)
           VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             active_composition_id = excluded.active_composition_id,
             updated_at = excluded.updated_at`,
        )
        .run(nextComposition.compositionId, now);

      if (options?.markCandidateApplied) {
        this.db
          .prepare(
            `UPDATE candidate_receipts
             SET status = 'applied', applied_at = ?
             WHERE candidate_id = ?`,
          )
          .run(now, options.markCandidateApplied);
      }

      this.db.exec("COMMIT;");
      return {
        committed: true,
        actualActiveCompositionId: nextComposition.compositionId,
      };
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  saveCandidateReceipt(receipt: CandidateReceipt): void {
    const existing = this.getCandidateReceipt(receipt.candidateId);
    if (existing) {
      throw new Error(
        `Immutable candidate receipt already exists for ${receipt.candidateId}`,
      );
    }

    this.db
      .prepare(
        `INSERT INTO candidate_receipts (
           candidate_id, base_composition_id, candidate_composition_json,
           change_brief_json, verification_report_json, status, created_at, applied_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        receipt.candidateId,
        receipt.baseCompositionId,
        JSON.stringify(receipt.candidateComposition),
        JSON.stringify(receipt.changeBrief),
        JSON.stringify(receipt.verificationReport),
        receipt.status,
        receipt.createdAt,
        receipt.appliedAt ?? null,
      );
  }

  getCandidateReceipt(candidateId: string): CandidateReceipt | undefined {
    const row = this.db
      .prepare(
        `SELECT candidate_id, base_composition_id, candidate_composition_json,
                change_brief_json, verification_report_json, status, created_at, applied_at
         FROM candidate_receipts WHERE candidate_id = ?`,
      )
      .get(candidateId) as
      | {
          candidate_id: string;
          base_composition_id: string;
          candidate_composition_json: string;
          change_brief_json: string;
          verification_report_json: string;
          status: CandidateReceiptStatus;
          created_at: string;
          applied_at: string | null;
        }
      | undefined;

    if (!row) return undefined;
    return this.mapReceiptRow(row);
  }

  listCandidateReceipts(): CandidateReceipt[] {
    const rows = this.db
      .prepare(
        `SELECT candidate_id, base_composition_id, candidate_composition_json,
                change_brief_json, verification_report_json, status, created_at, applied_at
         FROM candidate_receipts ORDER BY seq DESC`,
      )
      .all() as Array<{
      candidate_id: string;
      base_composition_id: string;
      candidate_composition_json: string;
      change_brief_json: string;
      verification_report_json: string;
      status: CandidateReceiptStatus;
      created_at: string;
      applied_at: string | null;
    }>;

    return rows.map((row) => this.mapReceiptRow(row));
  }

  close(): void {
    this.db.close();
  }

  private mapCompositionRow(row: {
    composition_id: string;
    parent_composition_id: string | null;
    members_json: string;
    kind: CompositionRecordKind;
    target_composition_id: string | null;
    candidate_id: string | null;
    summary: string | null;
    created_at: string;
  }): CompositionRecord {
    return {
      compositionId: row.composition_id,
      parentCompositionId: row.parent_composition_id,
      members: JSON.parse(row.members_json) as CompositionMember[],
      kind: row.kind,
      targetCompositionId: row.target_composition_id,
      candidateId: row.candidate_id,
      summary: row.summary,
      createdAt: row.created_at,
    };
  }

  private mapReceiptRow(row: {
    candidate_id: string;
    base_composition_id: string;
    candidate_composition_json: string;
    change_brief_json: string;
    verification_report_json: string;
    status: CandidateReceiptStatus;
    created_at: string;
    applied_at: string | null;
  }): CandidateReceipt {
    return {
      candidateId: row.candidate_id,
      baseCompositionId: row.base_composition_id,
      candidateComposition: JSON.parse(
        row.candidate_composition_json,
      ) as CompositionSnapshot,
      changeBrief: JSON.parse(row.change_brief_json) as ChangeBrief,
      verificationReport: JSON.parse(
        row.verification_report_json,
      ) as VerificationReport,
      status: row.status,
      createdAt: row.created_at,
      appliedAt: row.applied_at,
    };
  }
}
