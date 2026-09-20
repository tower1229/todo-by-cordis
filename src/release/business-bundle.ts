import { parse } from "@babel/parser";
import { stripTypeScriptTypes } from "node:module";
import { posix } from "node:path";
import { hash } from "./storage.js";
import type { BusinessBundle } from "./types.js";

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

/** Single-file auxiliary plugin → trusted business artifact shape (no tsc). */
export function memberArtifactFiles(source: string): Record<string, string> {
  return {
    "business/entry.ts": source,
    "business/view.ts": 'export default { title: "extension", fields: [] };',
    "business/config.json": "{}",
    "business/compatibility.json": '{"preserveUnknownFields":true}',
  };
}

/**
 * Import-gated strip build for auxiliary members (new record + legacy load).
 * Same checkBusinessImports gate as main candidates; emits VM modules without forking tsc.
 */
export function synthesizeMemberBundle(source: string): BusinessBundle {
  if (!source?.trim()) throw new ProtectedCandidateError("辅助成员源码为空");
  const files = memberArtifactFiles(source);
  checkBusinessImports(files);
  const outputs: Record<string, string> = {};
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".ts")) continue;
    outputs[path.replace(/\.ts$/, ".js")] = stripTypeScriptTypes(content);
  }
  if (!outputs["business/entry.js"])
    throw new ProtectedCandidateError("辅助成员可信构建缺少入口产物");
  return {
    files,
    outputs,
    lockHash: hash(files),
    builder: "member-strip/1",
  };
}

/** Evolution-generated members require restricted load (bundle / no native import). */
export function isGeneratedMember(evidence: unknown): boolean {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence))
    return false;
  const row = evidence as { generated?: unknown; origin?: unknown };
  if (row.generated === true) return true;
  return typeof row.origin === "string" && row.origin.startsWith("evolution-");
}

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
  let typeError: Error | undefined;
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
  const forbidden = new Set([
    "import",
    "require",
    "eval",
    "Function",
    "process",
    "global",
    "globalThis",
    "fetch",
    "WebSocket",
  ]);
  for (const [path, source] of Object.entries(files)) {
    if (!path.endsWith(".ts")) continue;
    const syntax = parse(source, {
      sourceType: "module",
      plugins: ["typescript"],
      createImportExpressions: true,
    });
    if (
      syntax.comments?.some(
        (c) => c.type === "CommentLine" && /^\/\s*<reference/.test(c.value),
      )
    )
      throw new ProtectedCandidateError(`未授权编译指令：${path}`);
    let hasEnum = false;
    walkSyntax(syntax.program, (node) => {
      if (
        [
          "ImportDeclaration",
          "ExportNamedDeclaration",
          "ExportAllDeclaration",
        ].includes(node.type)
      ) {
        const target = node.source;
        if (
          target &&
          typeof target === "object" &&
          "value" in target &&
          typeof target.value === "string"
        )
          checkImport(path, target.value);
      }
      if (
        [
          "ImportExpression",
          "Import",
          "TSImportType",
          "TSImportEqualsDeclaration",
        ].includes(node.type)
      )
        throw new ProtectedCandidateError(`未授权运行能力：${path}`);
      if (node.type === "TSAnyKeyword" || node.type === "TSEnumDeclaration") {
        hasEnum ||= node.type === "TSEnumDeclaration";
        typeError ??= new Error(
          `不支持的类型 any/enum，请在冻结范围内修正：${path}`,
        );
      }
    });
    // Types and prose are not executable identifiers. Enums remain forbidden;
    // inspect their original tree so they cannot mask a protected capability.
    const runtime = hasEnum
      ? syntax
      : parse(stripTypeScriptTypes(source), {
          sourceType: "module",
          createImportExpressions: true,
        });
    walkSyntax(runtime.program, (node, parent, key) => {
      if (
        node.type === "Identifier" &&
        typeof node.name === "string" &&
        forbidden.has(node.name) &&
        !isStaticName(parent, key)
      )
        throw new ProtectedCandidateError(`未授权运行能力：${path}`);
    });
  }
  if (typeError) throw typeError;
}

type SyntaxNode = { type: string; [key: string]: unknown };
function isStaticName(parent: SyntaxNode | undefined, key: string | undefined) {
  if (!parent) return false;
  if (
    [
      "ObjectProperty",
      "ObjectMethod",
      "ClassProperty",
      "ClassMethod",
      "MemberExpression",
      "OptionalMemberExpression",
    ].includes(parent.type)
  )
    return (
      (key === "key" || key === "property") &&
      !parent.computed &&
      !parent.shorthand
    );
  return (
    (parent.type === "ImportSpecifier" && key === "imported") ||
    (parent.type === "ExportSpecifier" && key === "exported")
  );
}
function walkSyntax(
  value: unknown,
  visit: (node: SyntaxNode, parent?: SyntaxNode, key?: string) => void,
  parent?: SyntaxNode,
  key?: string,
) {
  if (Array.isArray(value)) {
    for (const child of value) walkSyntax(child, visit, parent, key);
  } else if (value && typeof value === "object") {
    const node = value as Record<string, unknown>;
    const syntax =
      typeof node.type === "string" ? (node as SyntaxNode) : parent;
    if (typeof node.type === "string") visit(node as SyntaxNode, parent, key);
    for (const [childKey, child] of Object.entries(node))
      if (
        ![
          "loc",
          "start",
          "end",
          "extra",
          "comments",
          "leadingComments",
          "trailingComments",
          "innerComments",
        ].includes(childKey) &&
        // Re-export specifiers name external bindings; the source is still gated.
        !(
          node.type === "ExportNamedDeclaration" &&
          node.source &&
          childKey === "specifiers"
        )
      )
        walkSyntax(child, visit, syntax, childKey);
  }
}
