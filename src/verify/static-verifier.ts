import { builtinModules } from "node:module";
import { posix } from "node:path";
import { parse } from "@babel/parser";
import { IMPORTMAP_SPECIFIERS } from "../runtime/client/bundle-builder.js";
import { validateAndSortComposition } from "../contracts/topology.js";
import type { CompositionSnapshot, PluginArtifact } from "../contracts/types.js";

const NODE_BUILTINS = new Set<string>(
  builtinModules.flatMap((m) => (m.startsWith("node:") ? [m, m.slice(5)] : [m, `node:${m}`])),
);

const SERVER_ALLOWED_SPECIFIERS = new Set<string>([
  "cordis",
  "@host/server-sdk",
]);

const CLIENT_ALLOWED_SPECIFIERS = new Set<string>(IMPORTMAP_SPECIFIERS);

export interface StaticViolation {
  readonly pluginId: string;
  readonly file: string;
  readonly specifier: string;
  readonly reason: string;
  readonly line?: number;
}

export interface DagViolation {
  readonly message: string;
}

function isScriptFile(relPath: string): boolean {
  if (relPath.endsWith(".d.ts")) return false;
  return (
    relPath.endsWith(".ts") ||
    relPath.endsWith(".tsx") ||
    relPath.endsWith(".js") ||
    relPath.endsWith(".mjs") ||
    relPath.endsWith(".jsx")
  );
}

function isClientFile(relPath: string): boolean {
  const normalized = relPath.replace(/\\/g, "/");
  return (
    normalized === "client.tsx" ||
    normalized === "client.ts" ||
    normalized === "__compiled__/client.mjs" ||
    normalized.endsWith(".tsx") ||
    normalized.endsWith(".jsx") ||
    normalized.startsWith("client/") ||
    normalized.startsWith("components/")
  );
}

function isSafeIntraPackageRelative(fileRelPath: string, specifier: string): boolean {
  if (!specifier.startsWith("./") && !specifier.startsWith("../")) {
    return false;
  }
  const fileDir = posix.dirname(fileRelPath.replace(/\\/g, "/"));
  const resolved = posix.normalize(posix.join(fileDir, specifier));
  if (resolved === ".." || resolved.startsWith("../") || posix.isAbsolute(resolved)) {
    return false;
  }
  return true;
}

function validateSpecifier(
  pluginId: string,
  file: string,
  specifier: string,
  line?: number,
): StaticViolation | null {
  if (specifier.startsWith("node:") || NODE_BUILTINS.has(specifier)) {
    return {
      pluginId,
      file,
      specifier,
      reason: `Forbidden Node.js builtin import "${specifier}"`,
      line,
    };
  }

  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    if (!isSafeIntraPackageRelative(file, specifier)) {
      return {
        pluginId,
        file,
        specifier,
        reason: `Relative import "${specifier}" escapes plugin package boundary`,
        line,
      };
    }
    return null;
  }

  const allowed = isClientFile(file)
    ? CLIENT_ALLOWED_SPECIFIERS
    : SERVER_ALLOWED_SPECIFIERS;

  if (!allowed.has(specifier)) {
    return {
      pluginId,
      file,
      specifier,
      reason: `Import "${specifier}" is not in the ${isClientFile(file) ? "client" : "server"} whitelist`,
      line,
    };
  }

  return null;
}

function walkAst(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walkAst(item, visit);
    }
    return;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.type === "string") {
    visit(record);
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "loc" || key === "start" || key === "end" || key === "extra") {
      continue;
    }
    if (value && typeof value === "object") {
      walkAst(value, visit);
    }
  }
}

function getLine(node: Record<string, unknown>): number | undefined {
  const loc = node.loc as { start?: { line?: number } } | undefined;
  return loc?.start?.line;
}

export function verifyStaticBoundaries(artifact: PluginArtifact): StaticViolation[] {
  const violations: StaticViolation[] = [];
  const files: Record<string, string> = { ...artifact.sourceFiles };

  if (artifact.serverCode) {
    files["__compiled__/server.mjs"] = artifact.serverCode;
  }
  if (artifact.clientCode) {
    files["__compiled__/client.mjs"] = artifact.clientCode;
  }

  for (const [relPath, code] of Object.entries(files)) {
    if (!isScriptFile(relPath)) continue;

    let ast: unknown;
    try {
      ast = parse(code, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
      });
    } catch (error) {
      violations.push({
        pluginId: artifact.pluginId,
        file: relPath,
        specifier: "",
        reason: `Failed to parse AST: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    walkAst(ast, (node) => {
      const line = getLine(node);

      if (
        node.type === "ImportDeclaration" ||
        node.type === "ExportNamedDeclaration" ||
        node.type === "ExportAllDeclaration"
      ) {
        const source = node.source as { value?: unknown } | null | undefined;
        if (source && typeof source.value === "string") {
          const violation = validateSpecifier(
            artifact.pluginId,
            relPath,
            source.value,
            line,
          );
          if (violation) violations.push(violation);
        }
        return;
      }

      if (node.type === "CallExpression") {
        const callee = node.callee as Record<string, unknown> | undefined;
        const args = Array.isArray(node.arguments) ? node.arguments : [];

        if (callee?.type === "Import") {
          const firstArg = args[0] as Record<string, unknown> | undefined;
          if (firstArg?.type === "StringLiteral" && typeof firstArg.value === "string") {
            const violation = validateSpecifier(
              artifact.pluginId,
              relPath,
              firstArg.value,
              line,
            );
            if (violation) {
              violations.push({
                ...violation,
                reason: `Forbidden dynamic import: ${violation.reason}`,
              });
            }
          } else {
            violations.push({
              pluginId: artifact.pluginId,
              file: relPath,
              specifier: "<dynamic>",
              reason: "Non-literal dynamic import() is forbidden in plugin code",
              line,
            });
          }
          return;
        }

        if (callee?.type === "Identifier" && callee.name === "require") {
          const firstArg = args[0] as Record<string, unknown> | undefined;
          const spec =
            firstArg?.type === "StringLiteral" && typeof firstArg.value === "string"
              ? firstArg.value
              : "<dynamic>";
          violations.push({
            pluginId: artifact.pluginId,
            file: relPath,
            specifier: spec,
            reason: `CommonJS require("${spec}") is forbidden in plugin code`,
            line,
          });
          return;
        }

        if (
          callee?.type === "Identifier" &&
          (callee.name === "eval" || callee.name === "Function")
        ) {
          violations.push({
            pluginId: artifact.pluginId,
            file: relPath,
            specifier: callee.name,
            reason: `Dynamic code execution via ${callee.name}() is forbidden in plugin code`,
            line,
          });
          return;
        }

        if (callee?.type === "MemberExpression") {
          const prop = callee.property as Record<string, unknown> | undefined;
          const propName =
            !callee.computed && prop?.type === "Identifier"
              ? prop.name
              : prop?.type === "StringLiteral"
                ? prop.value
                : undefined;
          if (propName === "getBuiltinModule") {
            violations.push({
              pluginId: artifact.pluginId,
              file: relPath,
              specifier: "process.getBuiltinModule",
              reason: "process.getBuiltinModule() is forbidden in plugin code",
              line,
            });
          }
        }
      }

      if (node.type === "NewExpression") {
        const callee = node.callee as Record<string, unknown> | undefined;
        if (callee?.type === "Identifier" && callee.name === "Function") {
          violations.push({
            pluginId: artifact.pluginId,
            file: relPath,
            specifier: "new Function",
            reason: "Dynamic code execution via new Function() is forbidden in plugin code",
            line,
          });
        }
      }
    });
  }

  return violations;
}

export function verifyCompositionDag(
  composition: CompositionSnapshot,
  artifacts: ReadonlyMap<string, PluginArtifact>,
): DagViolation[] {
  try {
    validateAndSortComposition(composition.members, artifacts);
    return [];
  } catch (error) {
    return [
      {
        message: error instanceof Error ? error.message : String(error),
      },
    ];
  }
}
