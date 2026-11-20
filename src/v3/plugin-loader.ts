import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { join, relative } from "node:path";
import type { PluginArtifact, PluginManifest } from "./types.js";

function computeVersionId(input: {
  pluginId: string;
  name: string;
  dependencies: readonly string[];
  contractTypes: string;
  serverCode?: string;
  clientCode?: string;
  styleCss?: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify(input))
    .digest("hex")
    .slice(0, 16);
}

function collectFiles(rootDir: string, subDir = ""): Record<string, string> {
  const dir = subDir ? join(rootDir, subDir) : rootDir;
  if (!existsSync(dir)) return {};
  const result: Record<string, string> = {};
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      Object.assign(result, collectFiles(rootDir, join(subDir, entry)));
    } else if (st.isFile()) {
      const rel = relative(rootDir, full).replace(/\\/g, "/");
      result[rel] = readFileSync(full, "utf8");
    }
  }
  return result;
}

export function transpileServerTypeScript(source: string): string {
  return stripTypeScriptTypes(source, { mode: "strip" });
}

export function compileServerPluginArtifact(input: {
  readonly pluginId: string;
  readonly name: string;
  readonly dependencies?: readonly string[];
  readonly contractTypes?: string;
  readonly serverSource?: string;
  readonly sourceFiles?: Readonly<Record<string, string>>;
  readonly testFiles?: Readonly<Record<string, string>>;
}): PluginArtifact {
  const dependencies = input.dependencies ? [...input.dependencies] : [];
  const contractTypes = input.contractTypes ?? "";
  const serverCode =
    input.serverSource !== undefined
      ? transpileServerTypeScript(input.serverSource)
      : undefined;

  const versionId = computeVersionId({
    pluginId: input.pluginId,
    name: input.name,
    dependencies,
    contractTypes,
    serverCode,
  });

  return {
    pluginId: input.pluginId,
    versionId,
    name: input.name,
    dependencies,
    contractTypes,
    serverCode,
    sourceFiles:
      input.sourceFiles ??
      (input.serverSource !== undefined
        ? { "server.ts": input.serverSource }
        : {}),
    testFiles: input.testFiles ?? {},
  };
}

export function loadServerPluginPackage(packageDir: string): PluginArtifact {
  const manifestPath = join(packageDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Plugin manifest.json not found in ${packageDir}`);
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as PluginManifest;

  if (
    !manifest ||
    typeof manifest.pluginId !== "string" ||
    typeof manifest.name !== "string" ||
    !Array.isArray(manifest.dependencies)
  ) {
    throw new Error(`Invalid manifest.json in ${packageDir}`);
  }

  const contractPath = join(packageDir, "contract.d.ts");
  const contractTypes = existsSync(contractPath)
    ? readFileSync(contractPath, "utf8")
    : "";

  const serverTsPath = join(packageDir, "server.ts");
  const serverSource = existsSync(serverTsPath)
    ? readFileSync(serverTsPath, "utf8")
    : undefined;

  const allFiles = collectFiles(packageDir);
  const sourceFiles: Record<string, string> = {};
  const testFiles: Record<string, string> = {};
  for (const [relPath, content] of Object.entries(allFiles)) {
    if (relPath.startsWith("tests/")) {
      testFiles[relPath] = content;
    } else {
      sourceFiles[relPath] = content;
    }
  }

  return compileServerPluginArtifact({
    pluginId: manifest.pluginId,
    name: manifest.name,
    dependencies: manifest.dependencies,
    contractTypes,
    serverSource,
    sourceFiles,
    testFiles,
  });
}
