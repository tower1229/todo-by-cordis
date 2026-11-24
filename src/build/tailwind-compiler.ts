import { parse as parseBabel } from "@babel/parser";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { compile } from "tailwindcss";
import { resolveProjectRoot } from "./project-root.js";

const require = createRequire(import.meta.url);

export const HOST_LAYER_ORDER_DECLARATION =
  "@layer theme, base, components, utilities, utilities-sm, utilities-md, utilities-lg, utilities-xl, utilities-2xl;";

function loadSharedThemeCss(): string {
  const srcPath = join(
    resolveProjectRoot(),
    "src",
    "runtime",
    "client",
    "theme.css",
  );
  return readFileSync(srcPath, "utf8");
}

const RESPONSIVE_MEDIA_LAYER_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/^@media\s*\(\s*width\s*>=\s*40rem\s*\)\s*\{/, "utilities-sm"],
  [/^@media\s*\(\s*width\s*>=\s*48rem\s*\)\s*\{/, "utilities-md"],
  [/^@media\s*\(\s*width\s*>=\s*64rem\s*\)\s*\{/, "utilities-lg"],
  [/^@media\s*\(\s*width\s*>=\s*80rem\s*\)\s*\{/, "utilities-xl"],
  [/^@media\s*\(\s*width\s*>=\s*96rem\s*\)\s*\{/, "utilities-2xl"],
  [/^@media\s*\(\s*min-width\s*:\s*40rem\s*\)\s*\{/, "utilities-sm"],
  [/^@media\s*\(\s*min-width\s*:\s*48rem\s*\)\s*\{/, "utilities-md"],
  [/^@media\s*\(\s*min-width\s*:\s*64rem\s*\)\s*\{/, "utilities-lg"],
  [/^@media\s*\(\s*min-width\s*:\s*80rem\s*\)\s*\{/, "utilities-xl"],
  [/^@media\s*\(\s*min-width\s*:\s*96rem\s*\)\s*\{/, "utilities-2xl"],
];

function findMatchingBraceEnd(css: string, openBraceIdx: number): number {
  let depth = 0;
  let i = openBraceIdx;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < css.length && css[i] !== quote) {
        if (css[i] === "\\") i += 1;
        i += 1;
      }
    } else if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      if (end === -1) return css.length;
      i = end + 1;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
    i += 1;
  }
  return css.length;
}

/**
 * Promote direct top-level responsive breakpoint `@media` blocks inside `@layer utilities`
 * into dedicated higher cascade layers (`utilities-sm`..`utilities-2xl`) so dynamically
 * mounted plugin `<style>` tags can never override earlier host or sibling responsive
 * utilities (e.g., `hidden` vs `sm:inline`), while preserving nested variant media queries
 * such as `@media (hover: hover) { @media (width >= 48rem) { ... } }` intact.
 */
export function promoteResponsiveUtilityLayers(css: string): string {
  const promotedBlocks: string[] = [];
  let result = "";
  let i = 0;

  while (i < css.length) {
    if (css.startsWith("@layer utilities", i)) {
      const openBrace = css.indexOf("{", i);
      const semicolon = css.indexOf(";", i);
      if (openBrace !== -1 && (semicolon === -1 || openBrace < semicolon)) {
        const layerEnd = findMatchingBraceEnd(css, openBrace);
        result += css.slice(i, openBrace + 1);

        // Scan only direct children (depth === 0 inside `@layer utilities { ... }`)
        let innerIdx = openBrace + 1;
        const innerLimit = layerEnd - 1;
        let depth = 0;
        while (innerIdx < innerLimit) {
          const ch = css[innerIdx];
          if (ch === '"' || ch === "'") {
            const quote = ch;
            let end = innerIdx + 1;
            while (end < innerLimit && css[end] !== quote) {
              if (css[end] === "\\") end += 1;
              end += 1;
            }
            end = Math.min(end + 1, innerLimit);
            result += css.slice(innerIdx, end);
            innerIdx = end;
            continue;
          }
          if (ch === "/" && css[innerIdx + 1] === "*") {
            const end = css.indexOf("*/", innerIdx + 2);
            const next = end === -1 ? innerLimit : Math.min(end + 2, innerLimit);
            result += css.slice(innerIdx, next);
            innerIdx = next;
            continue;
          }

          if (depth === 0 && ch === "@" && css.startsWith("@media", innerIdx)) {
            const slice = css.slice(innerIdx, innerIdx + 64);
            let matchedLayer: string | null = null;
            for (const [pattern, layerName] of RESPONSIVE_MEDIA_LAYER_MAP) {
              if (pattern.test(slice)) {
                matchedLayer = layerName;
                break;
              }
            }
            if (matchedLayer) {
              const mediaOpen = css.indexOf("{", innerIdx);
              if (mediaOpen !== -1 && mediaOpen < innerLimit) {
                const mediaEnd = findMatchingBraceEnd(css, mediaOpen);
                const mediaBlock = css.slice(innerIdx, mediaEnd);
                promotedBlocks.push(`@layer ${matchedLayer} {\n${mediaBlock}\n}`);
                innerIdx = mediaEnd;
                continue;
              }
            }
          }

          if (ch === "{") depth += 1;
          else if (ch === "}") depth = Math.max(0, depth - 1);

          result += ch;
          innerIdx += 1;
        }

        result += "}";
        i = layerEnd;
        continue;
      }
    }

    result += css[i];
    i += 1;
  }

  const header = result.includes(HOST_LAYER_ORDER_DECLARATION)
    ? ""
    : `${HOST_LAYER_ORDER_DECLARATION}\n`;
  if (promotedBlocks.length === 0) {
    return `${header}${result}`;
  }
  return `${header}${result}\n${promotedBlocks.join("\n")}\n`;
}

type TailwindCompiler = Awaited<ReturnType<typeof compile>>;
let cachedCompilerPromise: Promise<TailwindCompiler> | null = null;

function getCompiler(): Promise<TailwindCompiler> {
  if (!cachedCompilerPromise) {
    const entryCss = `
${HOST_LAYER_ORDER_DECLARATION}
@import "tailwindcss/theme.css" layer(theme);
@import "tailwindcss/utilities.css" layer(utilities);
${loadSharedThemeCss()}
`;
    cachedCompilerPromise = compile(entryCss, {
      loadStylesheet: async (id, base) => {
        const resolved = require.resolve(id);
        return {
          path: resolved,
          base: base ?? process.cwd(),
          content: readFileSync(resolved, "utf8"),
        };
      },
    });
  }
  return cachedCompilerPromise;
}

function cleanCandidateToken(raw: string): string {
  return raw.replace(/^[,;({]+/, "").replace(/[,;)}]+$/, "");
}

function addTokensFromText(text: string, candidates: Set<string>): void {
  for (const piece of text.split(/\s+/)) {
    const token = cleanCandidateToken(piece);
    if (token.length > 0 && token.length <= 160) {
      candidates.add(token);
    }
  }
}

function collectAstStringCandidates(
  node: unknown,
  candidates: Set<string>,
): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      collectAstStringCandidates(item, candidates);
    }
    return;
  }

  const record = node as Record<string, unknown>;
  const type = record.type;

  if (type === "StringLiteral" && typeof record.value === "string") {
    addTokensFromText(record.value, candidates);
    return;
  }

  if (type === "TemplateElement") {
    const value = record.value as { raw?: string; cooked?: string } | undefined;
    const text = value?.cooked ?? value?.raw;
    if (typeof text === "string") {
      addTokensFromText(text, candidates);
    }
    return;
  }

  for (const key of Object.keys(record)) {
    if (
      key === "loc" ||
      key === "start" ||
      key === "end" ||
      key === "extra" ||
      key === "leadingComments" ||
      key === "trailingComments" ||
      key === "innerComments"
    ) {
      continue;
    }
    collectAstStringCandidates(record[key], candidates);
  }
}

const FALLBACK_QUOTED_RE = /"([^"\\]|\\.)*"|'([^'\\]|\\.)*'/g;

export function extractTailwindCandidates(sources: readonly string[]): string[] {
  const candidates = new Set<string>();

  for (const source of sources) {
    if (!source) continue;

    try {
      const ast = parseBabel(source, {
        sourceType: "module",
        plugins: ["typescript", "jsx"],
        errorRecovery: true,
      });
      collectAstStringCandidates(ast.program, candidates);
    } catch {
      // Fallback for non-JS/TS fragments
      for (const match of source.matchAll(FALLBACK_QUOTED_RE)) {
        addTokensFromText(match[0].slice(1, -1), candidates);
      }
      addTokensFromText(source, candidates);
    }
  }

  return [...candidates];
}

export async function compilePluginTailwindCss(
  sources: readonly string[],
): Promise<string> {
  const candidates = extractTailwindCandidates(sources);
  if (candidates.length === 0) return "";

  const compiler = await getCompiler();
  const built = compiler.build(candidates).trim();
  if (!built) return "";

  const withoutComments = built
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(HOST_LAYER_ORDER_DECLARATION, "")
    .trim();
  if (!withoutComments) return "";
  return promoteResponsiveUtilityLayers(built).trim();
}
