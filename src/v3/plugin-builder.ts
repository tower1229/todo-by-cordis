import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build as viteBuild, transformWithOxc } from "vite";
import { V3_IMPORTMAP_SPECIFIERS } from "./client-bundle-builder.js";
import {
  computeArtifactVersionId,
  transpileServerTypeScript,
} from "./plugin-loader.js";
import { compilePluginTailwindCss } from "./tailwind-compiler.js";
import type { PluginArtifact } from "./types.js";

export { V3_IMPORTMAP_SPECIFIERS } from "./client-bundle-builder.js";

const EXTERNAL_SET = new Set<string>(V3_IMPORTMAP_SPECIFIERS);
const RELATIVE_IMPORT_RE =
  /(?:from\s+["']\.\.?\/|import\s*\(\s*["']\.\.?\/|import\s+["']\.\.?\/)/;

export async function compileClientTypeScript(
  source: string,
  fileName = "client.tsx",
): Promise<string> {
  const result = await transformWithOxc(source, fileName, {
    lang: fileName.endsWith(".ts") ? "ts" : "tsx",
    jsx: {
      runtime: "automatic",
      importSource: "react",
    },
  });
  return result.code;
}

export async function bundleClientEntryFile(entryPath: string): Promise<string> {
  const source = readFileSync(entryPath, "utf8");
  const transpiled = await compileClientTypeScript(source, entryPath);
  if (!RELATIVE_IMPORT_RE.test(transpiled)) {
    return transpiled;
  }

  const outDir = mkdtempSync(join(tmpdir(), "v3-plugin-client-"));
  try {
    await viteBuild({
      configFile: false,
      logLevel: "silent",
      build: {
        outDir,
        emptyOutDir: true,
        minify: false,
        lib: {
          entry: entryPath,
          formats: ["es"],
          fileName: () => "client.mjs",
        },
        rollupOptions: {
          external: (id) => EXTERNAL_SET.has(id),
        },
      },
    });
    return readFileSync(join(outDir, "client.mjs"), "utf8");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

export interface CompileFullStackPluginInput {
  readonly pluginId: string;
  readonly name: string;
  readonly dependencies?: readonly string[];
  readonly contractTypes?: string;
  readonly serverSource?: string;
  readonly clientSource?: string;
  readonly clientEntryPath?: string;
  readonly extraClientSources?: readonly string[];
  readonly styleCss?: string;
  readonly sourceFiles?: Readonly<Record<string, string>>;
  readonly testFiles?: Readonly<Record<string, string>>;
}

export async function compileFullStackPluginArtifact(
  input: CompileFullStackPluginInput,
): Promise<PluginArtifact> {
  const dependencies = input.dependencies ? [...input.dependencies] : [];
  const contractTypes = input.contractTypes ?? "";

  const serverCode =
    input.serverSource !== undefined
      ? transpileServerTypeScript(input.serverSource)
      : undefined;

  let clientCode: string | undefined;
  if (input.clientEntryPath) {
    clientCode = await bundleClientEntryFile(input.clientEntryPath);
  } else if (input.clientSource !== undefined) {
    clientCode = await compileClientTypeScript(input.clientSource, "client.tsx");
  }

  let styleCss = input.styleCss;
  if (styleCss === undefined) {
    const cssSources: string[] = [];
    if (input.clientSource !== undefined) {
      cssSources.push(input.clientSource);
    }
    if (input.extraClientSources) {
      cssSources.push(...input.extraClientSources);
    }
    if (cssSources.length > 0) {
      const compiled = await compilePluginTailwindCss(cssSources);
      if (compiled.length > 0) {
        styleCss = compiled;
      }
    }
  }

  const versionId = computeArtifactVersionId({
    pluginId: input.pluginId,
    name: input.name,
    dependencies,
    contractTypes,
    serverCode,
    clientCode,
    styleCss,
  });

  const defaultSourceFiles: Record<string, string> = {};
  if (input.serverSource !== undefined) {
    defaultSourceFiles["server.ts"] = input.serverSource;
  }
  if (input.clientSource !== undefined) {
    defaultSourceFiles["client.tsx"] = input.clientSource;
  }

  return {
    pluginId: input.pluginId,
    versionId,
    name: input.name,
    dependencies,
    contractTypes,
    ...(serverCode !== undefined ? { serverCode } : {}),
    ...(clientCode !== undefined ? { clientCode } : {}),
    ...(styleCss !== undefined ? { styleCss } : {}),
    sourceFiles: input.sourceFiles ?? defaultSourceFiles,
    testFiles: input.testFiles ?? {},
  };
}
