import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { SupervisedCordisRuntime } from "./cordis-runtime.js";
import type {
  AppResponse,
  CompositionSnapshot,
  CompositionTopology,
  HttpDispatchInput,
  PluginArtifact,
} from "./types.js";

export interface PluginTestContext {
  request(input: HttpDispatchInput): Promise<AppResponse>;
  introspect(): Promise<CompositionTopology>;
}

export interface SingleTestFileResult {
  readonly file: string;
  readonly passed: boolean;
  readonly error?: string;
}

export interface PluginTestRunResult {
  readonly ok: boolean;
  readonly results: readonly SingleTestFileResult[];
  readonly error?: string;
}

export interface RunPluginContractTestsInput {
  readonly composition: CompositionSnapshot;
  readonly artifacts: ReadonlyMap<string, PluginArtifact>;
  readonly testFiles: Readonly<Record<string, string>>;
  readonly applyTimeoutMs?: number;
}

export async function runPluginContractTests(
  input: RunPluginContractTestsInput,
): Promise<PluginTestRunResult> {
  const tempDir = mkdtempSync(join(tmpdir(), "v3-plugin-tests-"));
  const runtime = new SupervisedCordisRuntime({
    dbPath: join(tempDir, "sandbox.db"),
    workDir: tempDir,
    applyTimeoutMs: input.applyTimeoutMs ?? 15_000,
  });

  try {
    for (const artifact of input.artifacts.values()) {
      runtime.registerArtifact(artifact);
    }

    await runtime.applyComposition(input.composition);

    const topology = await runtime.introspect();
    const enabledIds = new Set(
      input.composition.members.filter((m) => m.enabled).map((m) => m.pluginId),
    );
    const byId = new Map(topology.plugins.map((p) => [p.pluginId, p]));
    for (const pluginId of enabledIds) {
      const entry = byId.get(pluginId);
      if (!entry || entry.state !== "ACTIVE") {
        return {
          ok: false,
          results: [],
          error: `Plugin "${pluginId}" is not ACTIVE in isolated closure (state=${entry?.state ?? "missing"})`,
        };
      }
    }

    const ctx: PluginTestContext = {
      request: (req) => runtime.handleHttpRequest(req),
      introspect: () => runtime.introspect(),
    };

    const results: SingleTestFileResult[] = [];
    const sortedFiles = Object.entries(input.testFiles)
      .filter(
        ([relPath]) =>
          relPath.endsWith(".ts") ||
          relPath.endsWith(".mjs") ||
          relPath.endsWith(".js"),
      )
      .sort(([a], [b]) => a.localeCompare(b));

    for (const [relPath, code] of sortedFiles) {
      try {
        const jsCode = relPath.endsWith(".ts")
          ? stripTypeScriptTypes(code, { mode: "strip" })
          : code;
        const outPath = join(
          tempDir,
          "tests",
          relPath.replace(/\.ts$/, ".mjs"),
        );
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, jsCode, "utf8");

        const mod = (await import(pathToFileURL(outPath).href)) as {
          default?: (ctx: PluginTestContext) => Promise<void> | void;
          runTests?: (ctx: PluginTestContext) => Promise<void> | void;
          verify?: (ctx: PluginTestContext) => Promise<void> | void;
        };

        const fn = mod.default ?? mod.runTests ?? mod.verify;
        if (typeof fn !== "function") {
          throw new Error(
            `Test file "${relPath}" must export a default, runTests, or verify function`,
          );
        }
        await fn(ctx);
        results.push({ file: relPath, passed: true });
      } catch (error) {
        results.push({
          file: relPath,
          passed: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const allPassed = results.every((r) => r.passed);
    return {
      ok: allPassed,
      results,
      ...(allPassed
        ? {}
        : {
            error: results
              .filter((r) => !r.passed)
              .map((r) => `${r.file}: ${r.error}`)
              .join("; "),
          }),
    };
  } catch (error) {
    return {
      ok: false,
      results: [],
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}
