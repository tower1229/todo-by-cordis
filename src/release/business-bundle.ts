import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";

export class ProtectedCandidateError extends Error {}
export class CandidateValidationError extends Error {
  constructor(
    message: string,
    readonly versionId: string,
  ) {
    super(message);
  }
}
export const businessPath = (path: string) =>
  /^business\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\.(ts|json)$/.test(path);

/** All files are data until the trusted compiler and linker accept the graph. */
export function parseBusinessFiles(value: unknown): Record<string, string> {
  if (!Array.isArray(value) || !value.length || value.length > 32)
    throw new Error("候选文件列表无效");
  const files: Record<string, string> = {};
  for (const file of value) {
    if (
      !file ||
      typeof file !== "object" ||
      typeof file.path !== "string" ||
      typeof file.content !== "string"
    )
      throw new Error("候选文件无效");
    if (!businessPath(file.path) || file.path === "business/contract.ts")
      throw new ProtectedCandidateError(`受保护路径或路径绕过：${file.path}`);
    if (Object.hasOwn(files, file.path)) throw new Error("候选路径重复");
    files[file.path] = file.content;
  }
  if (JSON.stringify(files).length > 200_000) throw new Error("候选过大");
  for (const path of [
    "business/entry.ts",
    "business/view.ts",
    "business/config.json",
    "business/compatibility.json",
  ])
    if (!Object.hasOwn(files, path))
      throw new Error(`缺少完整候选文件：${path}`);
  const compatibility = JSON.parse(files["business/compatibility.json"]);
  if (JSON.stringify(compatibility) !== '{"preserveUnknownFields":true}')
    throw new ProtectedCandidateError(
      "兼容映射必须保留所有已有字段；其他迁移需要维护者升级",
    );
  const config: unknown = JSON.parse(files["business/config.json"]);
  if (!config || typeof config !== "object" || Array.isArray(config))
    throw new Error("业务配置必须是对象");
  if (
    Object.keys(config).some((key) =>
      [
        "scripts",
        "dependencies",
        "policy",
        "budget",
        "verification",
        "entry",
        "database",
        "env",
      ].includes(key),
    )
  )
    throw new ProtectedCandidateError(
      "业务配置不能替换构建入口、依赖、预算或保护策略",
    );
  return files;
}

export function checkBusinessImports(files: Record<string, string>) {
  const checkImport = (path: string, specifier: string) => {
    const resolved = posix
      .join(posix.dirname(path), specifier)
      .replace(/\.js$/, ".ts");
    if (
      !specifier.startsWith("./") ||
      !specifier.endsWith(".js") ||
      !Object.hasOwn(files, resolved)
    )
      throw new ProtectedCandidateError(
        `未授权类型或运行依赖：${path} → ${specifier}`,
      );
  };
  for (const [path, source] of Object.entries(files)) {
    if (!path.endsWith(".ts")) continue;
    if (/\/\/\/\s*<reference|\b(enum|any)\b/.test(source))
      throw new ProtectedCandidateError(`未授权编译指令或类型：${path}`);
    for (const match of source.matchAll(
      /(?:from\s*|import\s*)["']([^"']+)["']/g,
    )) {
      checkImport(path, match[1]);
    }
    // Strip types before checking runtime dependencies; the runtime linker checks again.
    const code = stripTypeScriptTypes(source);
    const remaining = code.replace(
      /(?:import\s+(?:[\w$*,{}\s]+\s+from\s+)?|export\s+(?:\*|\{[^}]*\})\s+from\s+)["']([^"']+)["']\s*;?/g,
      (_match, specifier: string) => {
        checkImport(path, specifier);
        return "";
      },
    );
    if (
      /\b(import|require|eval|Function|process|global|globalThis|fetch|WebSocket)\b/.test(
        remaining,
      )
    )
      throw new ProtectedCandidateError(`未授权运行能力：${path}`);
  }
}
