import type { DatabaseSync } from "node:sqlite";
import type { InvestigationState } from "../shared/change-spec.js";
import type { PlanEvidence } from "../shared/assistant.js";
import type { InvestigationDocument } from "../server/planning.js";
import { hash } from "../release/storage.js";

/** Content storage and delivery receipts are separate from provider history. */
export class InvestigationStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS evolution_materials(hash TEXT PRIMARY KEY,body TEXT NOT NULL)",
    );
  }
  capture(state: InvestigationState, docs: InvestigationDocument[]) {
    for (const doc of docs) {
      if (hash(doc.content) !== doc.hash)
        throw new Error("调查资料摘要无效：" + doc.ref);
      this.db
        .prepare("INSERT OR IGNORE INTO evolution_materials VALUES(?,?)")
        .run(doc.hash, JSON.stringify(doc.content));
    }
    const refs = new Set(docs.map((d) => d.ref));
    state.materials = [
      ...state.materials.filter((d) => !refs.has(d.ref)),
      ...docs.map(({ ref, hash }) => ({ ref, hash })),
    ];
  }
  documents(state: InvestigationState, valid: PlanEvidence[]) {
    return state.materials
      .filter((m) => valid.some((v) => v.ref === m.ref && v.hash === m.hash))
      .map((m) => {
        const row = this.db
          .prepare("SELECT body FROM evolution_materials WHERE hash=?")
          .get(m.hash);
        if (!row) throw new Error("调查资料缺失：" + m.ref);
        const content: unknown = JSON.parse(String(row.body));
        if (hash(content) !== m.hash)
          throw new Error("调查资料已损坏：" + m.ref);
        return { ...m, content };
      });
  }
  delivered(
    state: InvestigationState,
    phase: "planning" | "generation",
    call: number,
    docs: PlanEvidence[],
  ) {
    state.deliveries.push({ phase, call, materials: structuredClone(docs) });
  }
}
