import { execFile } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { build as viteBuild, transformWithOxc } from "vite";
import { V3_IMPORTMAP_SPECIFIERS } from "./client-bundle-builder.js";
import {
  computeArtifactVersionId,
  transpileServerTypeScript,
} from "./plugin-loader.js";
import { compilePluginTailwindCss } from "./tailwind-compiler.js";
import type { PluginArtifact } from "./types.js";

const execFileAsync = promisify(execFile);

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

async function bundleSourceFilesEntry(
  pluginId: string,
  sourceFiles: Readonly<Record<string, string>>,
  entryRelPath: string,
  external: readonly string[],
): Promise<string> {
  const tempRoot = mkdtempSync(join(tmpdir(), `v3-bundle-${pluginId}-`));
  try {
    for (const [relPath, content] of Object.entries(sourceFiles)) {
      const target = resolveSafeSubPath(pluginId, tempRoot, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
    }
    const entryPath = resolveSafeSubPath(pluginId, tempRoot, entryRelPath);
    const result = await viteBuild({
      configFile: false,
      logLevel: "silent",
      esbuild: { jsx: "automatic" },
      build: {
        write: false,
        minify: false,
        sourcemap: false,
        lib: {
          entry: entryPath,
          formats: ["es"],
          fileName: () => "entry.mjs",
        },
        rollupOptions: {
          external: (id) =>
            external.includes(id) ||
            id.startsWith("node:") ||
            id === "@host/server-sdk" ||
            id === "@host/client-sdk",
        },
      },
    });
    const outputs = Array.isArray(result) ? result : [result];
    for (const out of outputs) {
      if ("output" in out) {
        const chunk = out.output.find((item) => item.type === "chunk");
        if (chunk && chunk.type === "chunk") {
          return chunk.code;
        }
      }
    }
    throw new Error(`Failed to bundle multi-file entry "${entryRelPath}" for plugin "${pluginId}"`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export async function compileFullStackPluginArtifact(
  input: CompileFullStackPluginInput,
): Promise<PluginArtifact> {
  const dependencies = input.dependencies ? [...input.dependencies] : [];
  const contractTypes = input.contractTypes ?? "";

  const hasExtraSourceFiles =
    input.sourceFiles !== undefined &&
    Object.keys(input.sourceFiles).filter((k) => !k.endsWith(".d.ts")).length > 1;

  let serverCode: string | undefined;
  if (input.serverSource !== undefined) {
    if (
      hasExtraSourceFiles &&
      input.sourceFiles &&
      RELATIVE_IMPORT_RE.test(input.serverSource)
    ) {
      serverCode = await bundleSourceFilesEntry(
        input.pluginId,
        { ...input.sourceFiles, "server.ts": input.serverSource },
        "server.ts",
        ["cordis", "@host/server-sdk"],
      );
    } else {
      serverCode = transpileServerTypeScript(input.serverSource);
    }
  }

  let clientCode: string | undefined;
  if (input.clientEntryPath) {
    clientCode = await bundleClientEntryFile(input.clientEntryPath);
  } else if (input.clientSource !== undefined) {
    if (
      hasExtraSourceFiles &&
      input.sourceFiles &&
      RELATIVE_IMPORT_RE.test(input.clientSource)
    ) {
      clientCode = await bundleSourceFilesEntry(
        input.pluginId,
        { ...input.sourceFiles, "client.tsx": input.clientSource },
        "client.tsx",
        V3_IMPORTMAP_SPECIFIERS,
      );
    } else {
      clientCode = await compileClientTypeScript(input.clientSource, "client.tsx");
    }
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
    if (input.sourceFiles) {
      for (const [k, v] of Object.entries(input.sourceFiles)) {
        if (k !== "client.tsx" && (k.endsWith(".tsx") || k.endsWith(".jsx"))) {
          cssSources.push(v);
        }
      }
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

export interface TypecheckPluginPackageInput {
  readonly pluginId: string;
  readonly contractTypes?: string;
  readonly upstreamContracts?: Readonly<Record<string, string>>;
  readonly sourceFiles: Readonly<Record<string, string>>;
  readonly workspaceRoot?: string;
}

export interface TypecheckPluginPackageResult {
  readonly ok: boolean;
  readonly diagnostics: readonly string[];
}

const SAFE_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

function assertSafePluginId(id: string, label: string): void {
  if (!SAFE_PLUGIN_ID_RE.test(id)) {
    throw new PluginBuildError(id || "unknown", [
      `Invalid ${label} "${id}": must match ${SAFE_PLUGIN_ID_RE}`,
    ]);
  }
}

function resolveSafeSubPath(
  pluginId: string,
  baseDir: string,
  relPath: string,
): string {
  if (!relPath || relPath.includes("\0")) {
    throw new PluginBuildError(pluginId, [
      `Invalid source file path "${relPath}"`,
    ]);
  }
  const normalizedBase = resolve(baseDir);
  const target = resolve(normalizedBase, relPath);
  if (!target.startsWith(`${normalizedBase}${sep}`)) {
    throw new PluginBuildError(pluginId, [
      `Path traversal detected in source file path "${relPath}"`,
    ]);
  }
  return target;
}

export async function typecheckPluginPackage(
  input: TypecheckPluginPackageInput,
): Promise<TypecheckPluginPackageResult> {
  assertSafePluginId(input.pluginId, "pluginId");
  const workspaceRoot = resolve(input.workspaceRoot ?? process.cwd());
  const tscBin = join(workspaceRoot, "node_modules", ".bin", "tsc");
  const tempRoot = mkdtempSync(join(tmpdir(), `v3-typecheck-${input.pluginId}-`));

  try {
    const includePatterns: string[] = [];

    if (input.upstreamContracts) {
      for (const [depId, dts] of Object.entries(input.upstreamContracts)) {
        if (!dts.trim()) continue;
        assertSafePluginId(depId, "dependency pluginId");
        const depFile = resolveSafeSubPath(
          input.pluginId,
          join(tempRoot, "deps"),
          join(depId, "contract.d.ts"),
        );
        mkdirSync(dirname(depFile), { recursive: true });
        writeFileSync(depFile, dts, "utf8");
        includePatterns.push(`deps/${depId}/contract.d.ts`);
      }
    }

    if (input.contractTypes && input.contractTypes.trim()) {
      const contractPath = join(tempRoot, "plugin", "contract.d.ts");
      mkdirSync(dirname(contractPath), { recursive: true });
      writeFileSync(contractPath, input.contractTypes, "utf8");
      includePatterns.push("plugin/contract.d.ts");
    }

    const pluginDir = join(tempRoot, "plugin");
    for (const [relPath, content] of Object.entries(input.sourceFiles)) {
      if (
        !relPath.endsWith(".ts") &&
        !relPath.endsWith(".tsx") &&
        !relPath.endsWith(".d.ts")
      ) {
        continue;
      }
      const target = resolveSafeSubPath(input.pluginId, pluginDir, relPath);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, "utf8");
      includePatterns.push(`plugin/${relPath}`);
    }

    if (includePatterns.length === 0) {
      return { ok: true, diagnostics: [] };
    }

    symlinkSync(
      join(workspaceRoot, "node_modules"),
      join(tempRoot, "node_modules"),
      "dir",
    );

    const tsconfig = {
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        isolatedModules: true,
        types: ["node"],
        paths: {
          "@host/server-sdk": [join(workspaceRoot, "src/v3/server-sdk.ts")],
          "@host/client-sdk": [join(workspaceRoot, "src/v3/client-sdk.ts")],
        },
      },
      include: includePatterns,
    };

    const tsconfigPath = join(tempRoot, "tsconfig.json");
    writeFileSync(tsconfigPath, JSON.stringify(tsconfig, null, 2), "utf8");

    try {
      await execFileAsync(tscBin, ["--noEmit", "-p", tsconfigPath, "--pretty", "false"], {
        cwd: workspaceRoot,
        maxBuffer: 4 * 1024 * 1024,
      });
      return { ok: true, diagnostics: [] };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; message?: string };
      const rawOutput = [err.stdout ?? "", err.stderr ?? ""]
        .filter(Boolean)
        .join("\n")
        .trim();
      const diagnostics = rawOutput
        ? rawOutput
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
        : [err.message ?? "TypeScript typecheck failed"];
      return { ok: false, diagnostics };
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export interface BuildPluginPackageInput extends CompileFullStackPluginInput {
  readonly upstreamContracts?: Readonly<Record<string, string>>;
  readonly workspaceRoot?: string;
}

export class PluginBuildError extends Error {
  readonly pluginId: string;
  readonly diagnostics: readonly string[];

  constructor(pluginId: string, diagnostics: readonly string[]) {
    super(
      `Plugin "${pluginId}" failed TypeScript typecheck:\n${diagnostics.join("\n")}`,
    );
    this.name = "PluginBuildError";
    this.pluginId = pluginId;
    this.diagnostics = diagnostics;
  }
}

export async function buildPluginPackage(
  input: BuildPluginPackageInput,
): Promise<PluginArtifact> {
  const declaredDeps = new Set(input.dependencies ?? []);
  if (input.upstreamContracts) {
    const undeclared = Object.keys(input.upstreamContracts).filter(
      (depId) => !declaredDeps.has(depId),
    );
    if (undeclared.length > 0) {
      throw new PluginBuildError(
        input.pluginId,
        undeclared.map(
          (depId) =>
            `Upstream contract "${depId}" is not declared in plugin "${input.pluginId}" dependencies`,
        ),
      );
    }
  }

  const sourceFiles: Record<string, string> = { ...(input.sourceFiles ?? {}) };
  if (input.serverSource !== undefined && !("server.ts" in sourceFiles)) {
    sourceFiles["server.ts"] = input.serverSource;
  }
  if (input.clientSource !== undefined && !("client.tsx" in sourceFiles)) {
    sourceFiles["client.tsx"] = input.clientSource;
  }

  const check = await typecheckPluginPackage({
    pluginId: input.pluginId,
    contractTypes: input.contractTypes,
    upstreamContracts: input.upstreamContracts,
    sourceFiles,
    workspaceRoot: input.workspaceRoot,
  });

  if (!check.ok) {
    throw new PluginBuildError(input.pluginId, check.diagnostics);
  }

  return compileFullStackPluginArtifact({
    ...input,
    sourceFiles,
  });
}
