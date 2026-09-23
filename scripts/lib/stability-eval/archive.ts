import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { redactSensitive } from "../shortened-real-model.js";

export function reserveArchive(root: string): void {
  mkdirSync(dirname(root), { recursive: true });
  mkdirSync(root, { mode: 0o700 }); // EEXIST is intentional; never reuse an archive.
}

export function writeVerifiedJson(path: string, value: unknown): string {
  const text = JSON.stringify(redactSensitive(value), null, 2) + "\n";
  writeFileSync(path, text, { flag: "wx", mode: 0o600 });
  const archived = readFileSync(path, "utf8");
  JSON.parse(archived);
  if (archived !== text)
    throw new Error(`Archive verification failed: ${path}`);
  return createHash("sha256").update(archived).digest("hex");
}

/** The DB contains only this run's synthetic workspace, never a user's workspace. */
export function archiveWorkspace(db: DatabaseSync, directory: string): string {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all();
  const database = Object.fromEntries(
    tables.map(({ name }) => {
      const table = String(name);
      return [
        table,
        db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}"`).all(),
      ];
    }),
  );
  const artifacts: Record<string, string> = {};
  const walk = (path: string, prefix = "") => {
    if (!existsSync(path)) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink())
        throw new Error("Archive refuses symlink artifact");
      const relative = join(prefix, entry.name);
      if (entry.isDirectory()) walk(join(path, entry.name), relative);
      else artifacts[relative] = readFileSync(join(path, entry.name), "utf8");
    }
  };
  walk(join(directory, "artifacts"));
  return writeVerifiedJson(join(directory, "workspace-evidence.json"), {
    database,
    artifacts,
  });
}

export function usageFromCalls(
  calls: { usage?: Record<string, number> | null }[],
) {
  if (!calls.length || calls.some((call) => !call.usage)) return null;
  let promptTokens = 0;
  let completionTokens = 0;
  for (const { usage } of calls) {
    const prompt = usage!.promptTokens ?? usage!.promptTokenCount;
    const completion = usage!.completionTokens ?? usage!.candidatesTokenCount;
    if (prompt === undefined || completion === undefined) return null;
    promptTokens += prompt;
    completionTokens += completion + (usage!.thoughtsTokenCount ?? 0);
  }
  return { promptTokens, completionTokens };
}

/** Count actual model proposals, including proposals the host rejected. */
export function firstPlanResult(
  calls: unknown[],
  confirmed: boolean,
  blocked: boolean,
): boolean | null {
  const proposals = calls.flatMap((call) => {
    const body = call as {
      response?: {
        candidates?: {
          content?: { parts?: { functionCall?: { name?: string } }[] };
        }[];
      };
      request?: { tools?: { name: string }[] };
    };
    if (body.request?.tools?.some((t) => t.name === "submit_candidate"))
      return [];
    return (
      body.response?.candidates?.flatMap(
        (c) =>
          c.content?.parts?.filter(
            (p) => p.functionCall?.name === "propose_plan",
          ) ?? [],
      ) ?? []
    );
  });
  if (!proposals.length) return null;
  return proposals.length === 1 && (confirmed || blocked);
}
