import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { SupervisedCordisRuntime } from "../runtime/server/supervised-runtime.js";
import {
  type DataFingerprintDiff,
  type PluginDataFingerprint,
  cloneSqliteDatabaseOnline,
  comparePluginDataFingerprints,
  snapshotPluginDataFingerprint,
} from "./db-snapshot.js";
import type { AblationCheckResult } from "./gate-ablation.js";
import {
  assertAllEnabledActive,
  buildClosureSnapshot,
  computeDependencyClosure,
  computeTransitiveDependents,
  getChangedEnabledPlugins,
} from "./gate-static-hotswap.js";
import { startHostServer } from "../supervisor/server/gateway.js";
import {
  type PluginTestContext,
  type SingleTestFileResult,
  openTrackedBrowserPage,
  runPluginContractTests,
} from "./test-runner.js";
import { artifactKey, validateAndSortComposition } from "../contracts/topology.js";
import type { CompositionSnapshot, PluginArtifact } from "../contracts/types.js";

export const NO_BEHAVIOR_DIFF_WARNING = "无行为差分断言，请人工核验预览";

export type CandidateChangeKind = "behavior" | "visual-only" | "refactor-only";

export interface SubgraphVerificationResult {
  readonly pluginId: string;
  readonly closurePlugins: readonly string[];
  readonly candidatePassed: boolean;
  readonly candidateTestResults: readonly SingleTestFileResult[];
  readonly redGreenChecked: boolean;
  readonly baselineRedVerified?: boolean;
  readonly noBehaviorDiffWarning?: boolean;
  readonly error?: string;
}

export interface FullCompositionSmokeResult {
  readonly passed: boolean;
  readonly clonedFromProductionDb: boolean;
  readonly activePlugins: readonly string[];
  readonly errorBoundaryCount: number;
  readonly pageErrors: readonly string[];
  readonly consoleErrors: readonly string[];
  readonly disabledPluginDataChecks: readonly DataFingerprintDiff[];
  readonly error?: string;
}

export type Gate3FailedGate =
  | "gate3-subgraph-contract"
  | "gate3-red-green-diff"
  | "gate3-full-composition-smoke"
  | "gate3-disabled-data-preservation";

export interface Gate3Outcome {
  readonly ok: boolean;
  readonly failedGate?: Gate3FailedGate;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly noBehaviorDiffWarning: boolean;
  readonly subgraphResults: readonly SubgraphVerificationResult[];
  readonly fullCompositionSmoke?: FullCompositionSmokeResult;
}

function getDisabledPlugins(
  baseline: CompositionSnapshot | undefined,
  candidate: CompositionSnapshot,
): string[] {
  if (!baseline) return [];
  const candById = new Map(candidate.members.map((m) => [m.pluginId, m]));
  const disabled: string[] = [];
  for (const baseMember of baseline.members) {
    if (!baseMember.enabled) continue;
    const candMember = candById.get(baseMember.pluginId);
    if (!candMember || !candMember.enabled) {
      disabled.push(baseMember.pluginId);
    }
  }
  return disabled.sort();
}

function buildBaselineClosureSnapshot(
  baseline: CompositionSnapshot | undefined,
  closureIds: ReadonlySet<string>,
  excludePluginId: string | null,
  suffix: string,
): CompositionSnapshot {
  const members = (baseline?.members ?? [])
    .filter(
      (m) =>
        m.enabled &&
        closureIds.has(m.pluginId) &&
        m.pluginId !== excludePluginId,
    )
    .map((m) => ({
      pluginId: m.pluginId,
      versionId: m.versionId,
      enabled: true,
    }));
  return {
    compositionId: `${baseline?.compositionId ?? "empty-baseline"}__base_${suffix}`,
    parentCompositionId: baseline?.compositionId ?? null,
    members,
    createdAt: new Date().toISOString(),
  };
}

function selectDifferentialTestFiles(
  isNewOrReenabled: boolean,
  baselineTests: Readonly<Record<string, string>>,
  candidateTests: Readonly<Record<string, string>>,
): Record<string, string> {
  if (isNewOrReenabled) {
    return { ...candidateTests };
  }
  const diffFiles: Record<string, string> = {};
  for (const [file, content] of Object.entries(candidateTests)) {
    if (!(file in baselineTests) || baselineTests[file] !== content) {
      diffFiles[file] = content;
    }
  }
  return diffFiles;
}

async function runFullCompositionSmoke(
  input: {
    readonly candidate: CompositionSnapshot;
    readonly artifacts: ReadonlyMap<string, PluginArtifact>;
    readonly applyTimeoutMs?: number;
    readonly productionDbPath?: string;
    readonly fullCompositionSmokeTest?: (
      ctx: PluginTestContext,
      meta: { readonly sandboxDbPath: string },
    ) => Promise<void>;
  },
  disabledPlugins: readonly string[],
  sharedBrowser: Browser,
): Promise<{
  readonly result: FullCompositionSmokeResult;
  readonly failedGate?:
    | "gate3-full-composition-smoke"
    | "gate3-disabled-data-preservation";
  readonly errors: readonly string[];
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "verifier-gate3-smoke-"));
  const sandboxDbPath = join(tempDir, "sandbox.db");
  const clonedFromProductionDb = Boolean(input.productionDbPath);
  const errors: string[] = [];

  try {
    if (input.productionDbPath) {
      await cloneSqliteDatabaseOnline(input.productionDbPath, sandboxDbPath);
    }

    const beforeFingerprints = new Map<string, PluginDataFingerprint>();
    if (existsSync(sandboxDbPath)) {
      for (const pluginId of disabledPlugins) {
        beforeFingerprints.set(
          pluginId,
          snapshotPluginDataFingerprint(sandboxDbPath, pluginId),
        );
      }
    }

    const runtime = new SupervisedCordisRuntime({
      dbPath: sandboxDbPath,
      workDir: tempDir,
      applyTimeoutMs: input.applyTimeoutMs ?? 15_000,
    });
    let httpServer: Awaited<ReturnType<typeof startHostServer>> | null = null;
    const openContexts: BrowserContext[] = [];

    let activePlugins: string[] = [];
    let errorBoundaryCount = 0;
    const pageErrors: string[] = [];
    const consoleErrors: string[] = [];

    try {
      for (const artifact of input.artifacts.values()) {
        runtime.registerArtifact(artifact);
      }
      await runtime.applyComposition(input.candidate);

      const topology = await runtime.introspect();
      const expectedEnabledIds = new Set(
        input.candidate.members.filter((m) => m.enabled).map((m) => m.pluginId),
      );
      errors.push(
        ...assertAllEnabledActive(
          topology,
          expectedEnabledIds,
          "full-composition-smoke",
        ),
      );
      activePlugins = topology.plugins
        .filter((p) => p.state === "ACTIVE")
        .map((p) => p.pluginId)
        .sort();

      httpServer = await startHostServer(runtime, { port: 0 });

      const initialSession = await openTrackedBrowserPage(
        sharedBrowser,
        httpServer,
        "/",
        openContexts,
      );
      await initialSession.page.waitForTimeout(100);
      pageErrors.push(...initialSession.pageErrors);
      consoleErrors.push(...initialSession.consoleErrors);

      const diagnostics = httpServer.getClientDiagnostics();
      const boundaryDiags = diagnostics.filter(
        (d) =>
          d.kind === "render-error" ||
          d.kind === "load-error" ||
          d.kind === "reconcile-error",
      );
      const domBoundaryCount = await initialSession.page
        .locator(
          '[data-plugin-error-boundary], [data-host-error-boundary="true"], [data-error-boundary="true"]',
        )
        .count();
      errorBoundaryCount = Math.max(boundaryDiags.length, domBoundaryCount);

      if (errorBoundaryCount > 0) {
        errors.push(
          `Full-composition smoke triggered ${errorBoundaryCount} ErrorBoundary instance(s)`,
        );
      }
      if (pageErrors.length > 0) {
        errors.push(
          `Full-composition smoke encountered uncaught page error(s): ${pageErrors.join("; ")}`,
        );
      }
      if (consoleErrors.length > 0) {
        errors.push(
          `Full-composition smoke encountered console error(s): ${consoleErrors.join("; ")}`,
        );
      }

      if (input.fullCompositionSmokeTest && errors.length === 0) {
        const smokeCtx: PluginTestContext = {
          request: (req) => runtime.handleHttpRequest(req),
          introspect: () => runtime.introspect(),
          openBrowserPage: (path = "/") =>
            openTrackedBrowserPage(sharedBrowser, httpServer!, path, openContexts),
        };
        try {
          await input.fullCompositionSmokeTest(smokeCtx, { sandboxDbPath });
        } catch (err) {
          errors.push(
            `Full-composition smoke test failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } finally {
      for (const ctx of openContexts) {
        await ctx.close().catch(() => {});
      }
      if (httpServer) {
        await httpServer.close().catch(() => {});
      }
      await runtime.close();
    }

    const disabledPluginDataChecks: DataFingerprintDiff[] = [];
    const dataErrors: string[] = [];
    if (existsSync(sandboxDbPath)) {
      for (const pluginId of disabledPlugins) {
        const before = beforeFingerprints.get(pluginId);
        if (!before) continue;
        const after = snapshotPluginDataFingerprint(sandboxDbPath, pluginId);
        const diff = comparePluginDataFingerprints(before, after);
        disabledPluginDataChecks.push(diff);
        if (!diff.preserved) {
          dataErrors.push(...diff.violations);
        }
      }
    }

    if (dataErrors.length > 0) {
      return {
        result: {
          passed: false,
          clonedFromProductionDb,
          activePlugins,
          errorBoundaryCount,
          pageErrors,
          consoleErrors,
          disabledPluginDataChecks,
          error: dataErrors.join("; "),
        },
        failedGate: "gate3-disabled-data-preservation",
        errors: dataErrors,
      };
    }

    if (errors.length > 0) {
      return {
        result: {
          passed: false,
          clonedFromProductionDb,
          activePlugins,
          errorBoundaryCount,
          pageErrors,
          consoleErrors,
          disabledPluginDataChecks,
          error: errors.join("; "),
        },
        failedGate: "gate3-full-composition-smoke",
        errors,
      };
    }

    return {
      result: {
        passed: true,
        clonedFromProductionDb,
        activePlugins,
        errorBoundaryCount,
        pageErrors,
        consoleErrors,
        disabledPluginDataChecks,
      },
      errors: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      result: {
        passed: false,
        clonedFromProductionDb,
        activePlugins: [],
        errorBoundaryCount: 0,
        pageErrors: [],
        consoleErrors: [],
        disabledPluginDataChecks: [],
        error: msg,
      },
      failedGate: "gate3-full-composition-smoke",
      errors: [msg],
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/**
 * Gate 3: Two-layer executable verification.
 * - Layer 1: Minimum dependency subgraph closure(P) contract tests + Red-Green differential.
 * - Layer 2: SQLite online backup clone + full-composition smoke + disabled data preservation.
 */
export async function runGate3SubgraphAndSmoke(input: {
  readonly baseline?: CompositionSnapshot;
  readonly candidate: CompositionSnapshot;
  readonly artifacts: ReadonlyMap<string, PluginArtifact>;
  readonly ablationResults: readonly AblationCheckResult[];
  readonly applyTimeoutMs?: number;
  readonly changeKind: CandidateChangeKind;
  readonly productionDbPath?: string;
  readonly fullCompositionSmokeTest?: (
    ctx: PluginTestContext,
    meta: { readonly sandboxDbPath: string },
  ) => Promise<void>;
  readonly browser?: Browser;
}): Promise<Gate3Outcome> {
  const { baseline, candidate, artifacts, applyTimeoutMs, changeKind } = input;
  const isNonBehavioral =
    changeKind === "visual-only" || changeKind === "refactor-only";

  const plan = validateAndSortComposition(candidate.members, artifacts);
  const enabledArtifactById = new Map<string, PluginArtifact>(
    plan.orderedEnabled.map((e) => [e.member.pluginId, e.artifact]),
  );
  const baselineMemberById = new Map(
    (baseline?.members ?? []).map((m) => [m.pluginId, m]),
  );

  const changedEnabled = getChangedEnabledPlugins(baseline, candidate);
  const changedSet = new Set(changedEnabled);
  const affectedEnabledSet = new Set<string>();
  for (const id of changedEnabled) {
    for (const dep of computeTransitiveDependents(id, plan.orderedEnabled)) {
      affectedEnabledSet.add(dep);
    }
  }
  const affectedEnabled = plan.orderedEnabled
    .map((e) => e.member.pluginId)
    .filter((id) => affectedEnabledSet.has(id));

  let ownedBrowser: Browser | null = null;
  const getSharedBrowser = async (): Promise<Browser> => {
    if (input.browser) return input.browser;
    if (!ownedBrowser) {
      ownedBrowser = await chromium.launch();
    }
    return ownedBrowser;
  };

  try {
    const subgraphResults: SubgraphVerificationResult[] = [];
    const warnings: string[] = [];
    let noBehaviorDiffWarning = false;

    const upstreamSeamExemptIds = new Set<string>();
    for (const ablation of input.ablationResults) {
      if (
        ablation.kind === "upstream-seam" &&
        ablation.passed &&
        ablation.ablatedPlugins.some((depId) => changedSet.has(depId))
      ) {
        upstreamSeamExemptIds.add(ablation.targetPluginId);
      }
    }

    for (const pluginId of affectedEnabled) {
      const closureIds = computeDependencyClosure(pluginId, enabledArtifactById);
      const closureSnapshot = buildClosureSnapshot(
        candidate,
        closureIds,
        `subgraph-${pluginId}`,
      );
      const candArtifact = enabledArtifactById.get(pluginId)!;
      const browser = await getSharedBrowser();

      const candRun = await runPluginContractTests({
        composition: closureSnapshot,
        artifacts,
        testFiles: candArtifact.testFiles,
        applyTimeoutMs,
        browser,
      });

      if (!candRun.ok) {
        const errMsg = `Subgraph contract tests failed for "${pluginId}" in closure [${[...closureIds].join(", ")}]: ${candRun.error ?? "failed"}`;
        subgraphResults.push({
          pluginId,
          closurePlugins: [...closureIds],
          candidatePassed: false,
          candidateTestResults: candRun.results,
          redGreenChecked: false,
          error: errMsg,
        });
        return {
          ok: false,
          failedGate: "gate3-subgraph-contract",
          errors: [errMsg],
          warnings,
          noBehaviorDiffWarning,
          subgraphResults,
        };
      }

      if (!changedSet.has(pluginId) || upstreamSeamExemptIds.has(pluginId)) {
        subgraphResults.push({
          pluginId,
          closurePlugins: [...closureIds],
          candidatePassed: true,
          candidateTestResults: candRun.results,
          redGreenChecked: false,
        });
        continue;
      }

      const baseMember = baselineMemberById.get(pluginId);
      const isNewOrReenabled = !baseMember || !baseMember.enabled;
      const baseArtifact =
        baseMember && !isNewOrReenabled
          ? artifacts.get(artifactKey(baseMember.pluginId, baseMember.versionId))
          : undefined;
      const diffTests = selectDifferentialTestFiles(
        isNewOrReenabled,
        baseArtifact?.testFiles ?? {},
        candArtifact.testFiles,
      );

      if (Object.keys(diffTests).length === 0) {
        if (isNonBehavioral) {
          noBehaviorDiffWarning = true;
          if (!warnings.includes(NO_BEHAVIOR_DIFF_WARNING)) {
            warnings.push(NO_BEHAVIOR_DIFF_WARNING);
          }
          subgraphResults.push({
            pluginId,
            closurePlugins: [...closureIds],
            candidatePassed: true,
            candidateTestResults: candRun.results,
            redGreenChecked: true,
            baselineRedVerified: false,
            noBehaviorDiffWarning: true,
          });
          continue;
        }
        const errMsg = `Red-Green differential check failed for "${pluginId}": no new or modified test file provided to distinguish behavior change`;
        subgraphResults.push({
          pluginId,
          closurePlugins: [...closureIds],
          candidatePassed: true,
          candidateTestResults: candRun.results,
          redGreenChecked: true,
          baselineRedVerified: false,
          error: errMsg,
        });
        return {
          ok: false,
          failedGate: "gate3-red-green-diff",
          errors: [errMsg],
          warnings,
          noBehaviorDiffWarning,
          subgraphResults,
        };
      }

      const baseClosureSnapshot = buildBaselineClosureSnapshot(
        baseline,
        closureIds,
        isNewOrReenabled ? pluginId : null,
        pluginId,
      );
      const baseRun = await runPluginContractTests({
        composition: baseClosureSnapshot,
        artifacts,
        testFiles: diffTests,
        applyTimeoutMs,
        browser,
      });

      if (baseRun.ok) {
        if (isNonBehavioral) {
          noBehaviorDiffWarning = true;
          if (!warnings.includes(NO_BEHAVIOR_DIFF_WARNING)) {
            warnings.push(NO_BEHAVIOR_DIFF_WARNING);
          }
          subgraphResults.push({
            pluginId,
            closurePlugins: [...closureIds],
            candidatePassed: true,
            candidateTestResults: candRun.results,
            redGreenChecked: true,
            baselineRedVerified: false,
            noBehaviorDiffWarning: true,
          });
          continue;
        }
        const errMsg = `Red-Green differential check failed for "${pluginId}": new/modified tests passed on baseline closure (possible empty or tautological assertions)`;
        subgraphResults.push({
          pluginId,
          closurePlugins: [...closureIds],
          candidatePassed: true,
          candidateTestResults: candRun.results,
          redGreenChecked: true,
          baselineRedVerified: false,
          error: errMsg,
        });
        return {
          ok: false,
          failedGate: "gate3-red-green-diff",
          errors: [errMsg],
          warnings,
          noBehaviorDiffWarning,
          subgraphResults,
        };
      }

      subgraphResults.push({
        pluginId,
        closurePlugins: [...closureIds],
        candidatePassed: true,
        candidateTestResults: candRun.results,
        redGreenChecked: true,
        baselineRedVerified: true,
      });
    }

    const disabledPlugins = getDisabledPlugins(baseline, candidate);
    const sharedBrowser = await getSharedBrowser();
    const smokeOutcome = await runFullCompositionSmoke(
      input,
      disabledPlugins,
      sharedBrowser,
    );

    if (!smokeOutcome.result.passed) {
      return {
        ok: false,
        failedGate: smokeOutcome.failedGate ?? "gate3-full-composition-smoke",
        errors: smokeOutcome.errors,
        warnings,
        noBehaviorDiffWarning,
        subgraphResults,
        fullCompositionSmoke: smokeOutcome.result,
      };
    }

    return {
      ok: true,
      errors: [],
      warnings,
      noBehaviorDiffWarning,
      subgraphResults,
      fullCompositionSmoke: smokeOutcome.result,
    };
  } finally {
    const toClose = ownedBrowser as Browser | null;
    if (toClose) {
      await toClose.close().catch(() => {});
    }
  }
}
