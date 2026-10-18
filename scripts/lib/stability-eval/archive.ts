import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  existsSync,
  cpSync,
} from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import type { BrowserEvidence } from "../../../src/shared/browser-cases.js";
import type { DatabaseSync } from "node:sqlite";
import { redactSensitive } from "../shortened-real-model.js";
import { isDeepStrictEqual } from "node:util";

function archiveFiles(root: string, prefix = ""): Record<string, string> {
  return Object.fromEntries(
    readdirSync(join(root, prefix), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => {
        const file = join(prefix, entry.name);
        if (file === "archive-index.json") return [];
        if (entry.isSymbolicLink()) throw new Error("归档不接受符号链接");
        return entry.isDirectory()
          ? Object.entries(archiveFiles(root, file))
          : [
              [
                file,
                createHash("sha256")
                  .update(readFileSync(join(root, file)))
                  .digest("hex"),
              ],
            ];
      }),
  );
}

/** The returned digest is the external anchor; modifying an index cannot re-sign the archive. */
export function sealArchive(root: string): string {
  return writeVerifiedJson(join(root, "archive-index.json"), {
    schema: "stability-archive/1",
    files: archiveFiles(root),
  });
}

export function verifyArchive(root: string, expectedDigest: string): void {
  const index = readFileSync(join(root, "archive-index.json"));
  if (createHash("sha256").update(index).digest("hex") !== expectedDigest)
    throw new Error("归档索引摘要不一致");
  const value = JSON.parse(index.toString()) as {
    schema: string;
    files: Record<string, string>;
  };
  if (
    value.schema !== "stability-archive/1" ||
    !isDeepStrictEqual(value.files, archiveFiles(root))
  )
    throw new Error("归档文件缺失、追加或内容被修改");
}

/** Keep screenshots/diagnostics before the isolated product directory is removed. */
export function archiveBrowserEvidence(
  evidence: BrowserEvidence,
  destination: string,
): BrowserEvidence {
  const root = resolve(".runtime/browser-acceptance");
  const source = resolve(evidence.directory);
  if (!source.startsWith(root + "/") || !existsSync(source))
    throw new Error("浏览器证据目录不属于隔离检查器");
  const remap = (path: string | undefined) => {
    if (!path) return undefined;
    const name = relative(source, path);
    if (name.startsWith("..") || isAbsolute(name))
      throw new Error("截图不属于浏览器证据目录");
    return join(destination, name);
  };
  archiveFiles(source); // Refuse symlinks before copying.
  cpSync(source, destination, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  return {
    ...evidence,
    directory: destination,
    results: evidence.results.map((r) => ({
      ...r,
      ...(r.screenshot ? { screenshot: remap(r.screenshot) } : {}),
    })),
    preparations: evidence.preparations?.map((r) => ({
      ...r,
      ...(r.screenshot ? { screenshot: remap(r.screenshot) } : {}),
    })),
  };
}

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
    const prompt =
      usage!.promptTokens ?? usage!.promptTokenCount ?? usage!.prompt_tokens;
    const completion =
      usage!.completionTokens ??
      usage!.completion_tokens ??
      usage!.candidatesTokenCount ??
      (usage!.totalTokenCount === prompt + (usage!.thoughtsTokenCount ?? 0)
        ? 0
        : undefined);
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
        choices?: {
          message?: { tool_calls?: { function?: { name?: string } }[] };
        }[];
        candidates?: {
          content?: { parts?: { functionCall?: { name?: string } }[] };
        }[];
      };
      request?: { tools?: { name: string }[] };
    };
    if (body.request?.tools?.some((t) => t.name === "submit_candidate"))
      return [];
    return [
      ...(body.response?.choices?.flatMap(
        (c) =>
          c.message?.tool_calls?.filter(
            (t) => t.function?.name === "propose_plan",
          ) ?? [],
      ) ?? []),
      ...(body.response?.candidates?.flatMap(
        (c) =>
          c.content?.parts?.filter(
            (p) => p.functionCall?.name === "propose_plan",
          ) ?? [],
      ) ?? []),
    ];
  });
  if (!proposals.length) return null;
  return proposals.length === 1 && (confirmed || blocked);
}
