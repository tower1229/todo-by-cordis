import type { DatabaseSync } from "node:sqlite";
import type { InvestigationState } from "../shared/change-spec.js";
import type { PlanEvidence } from "../shared/assistant.js";
import type { InvestigationDocument } from "../server/planning.js";
import { hash } from "../release/storage.js";
import { AppError } from "../shared/contracts.js";

export function materialIdentity(document: PlanEvidence): PlanEvidence {
  return {ref:document.ref,hash:document.hash,...(document.source ? {source:{...document.source}} : {})};
}

/** Content storage and delivery receipts are separate from provider history. */
export class InvestigationStore {
  constructor(private db: DatabaseSync) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS evolution_materials(hash TEXT PRIMARY KEY,body TEXT NOT NULL)",
    );
  }
  private content(identity: PlanEvidence): unknown {
    const row = this.db.prepare("SELECT body FROM evolution_materials WHERE hash=?").get(identity.hash);
    if (!row) throw new Error("调查资料缺失：" + identity.ref);
    let content: unknown;
    try { content = JSON.parse(String(row.body)); }
    catch { throw new Error("调查资料已损坏：" + identity.ref); }
    if (hash(content) !== identity.hash) throw new Error("调查资料已损坏：" + identity.ref);
    return content;
  }
  capture(
    state: InvestigationState,
    docs: InvestigationDocument[],
    sources: Record<string, {hash:string;content:unknown}> = {},
  ) {
    const put = (doc: InvestigationDocument) => {
      if (hash(doc.content) !== doc.hash) throw new Error("调查资料摘要无效：" + doc.ref);
      this.db.prepare("INSERT OR IGNORE INTO evolution_materials VALUES(?,?)").run(doc.hash,JSON.stringify(doc.content));
      this.content(doc);
    };
    for (const doc of docs) {
      if (doc.source) {
        if (doc.source.ref === doc.ref) throw new AppError("PLAN_STALE","调查视图来源身份无效",409);
        const source = sources[doc.source.ref];
        if (source) {
          if (source.hash !== doc.source.hash) throw new AppError("PLAN_STALE","调查视图来源已变化",409);
          put({ref:doc.source.ref,...source});
        } else this.content(doc.source);
      }
      put(doc);
    }
    const refs = new Set(docs.map((d) => d.ref));
    state.materials = [
      ...state.materials.filter((d) => !refs.has(d.ref)),
      ...docs.map(materialIdentity),
    ];
  }
  documents(state: InvestigationState, valid: PlanEvidence[]) {
    return state.materials
      .filter((m) => {
        const matches = valid.some(v=>hash(materialIdentity(v))===hash(materialIdentity(m)));
        if ((m.source || m.ref.startsWith("model-view/") || valid.some(v=>v.ref===m.ref&&v.source)) && !matches)
          throw new AppError("PLAN_STALE","调查视图或来源已变化，请重新规划",409);
        return matches;
      })
      .map((m) => {
        if (m.source) this.content(m.source);
        return { ...materialIdentity(m), content:this.content(m) };
      });
  }
  delivered(
    state: InvestigationState,
    phase: "planning" | "generation",
    call: number,
    docs: PlanEvidence[],
  ) {
    state.deliveries.push({ phase, call, materials: docs.map(materialIdentity) });
  }
}
