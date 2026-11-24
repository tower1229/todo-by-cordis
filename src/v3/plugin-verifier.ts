import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Browser, type BrowserContext, chromium } from "playwright";
import { ClientCordisRuntime } from "./client/client-runtime.js";
import { SupervisedCordisRuntime } from "./cordis-runtime.js";
import {
  type DataFingerprintDiff,
  type PluginDataFingerprint,
  cloneSqliteDatabaseOnline,
  comparePluginDataFingerprints,
  snapshotPluginDataFingerprint,
} from "./db-snapshot.js";
import { startV3HttpServer } from "./http-gateway.js";
import {
  type PluginTestContext,
  type SingleTestFileResult,
  openTrackedBrowserPage,
  runPluginContractTests,
} from "./plugin-test-runner.js";
import {
  type DagViolation,
  type StaticViolation,
  verifyCompositionDag,
  verifyStaticBoundaries,
} from "./static-verifier.js";
import {
  type TestChangeDisclosure,
  type TestFileDiffEntry,
  computeTestChangeDisclosures,
  diffPluginTestFiles,
} from "./test-diff.js";
import { artifactKey, validateAndSortComposition } from "./topology.js";
import type {
  ActiveClientComposition,
  CompositionSnapshot,
  CompositionTopology,
  PluginArtifact,
} from "./types.js";

export type { DataFingerprintDiff, TestChangeDisclosure, TestFileDiffEntry };

export const NO_BEHAVIOR_DIFF_WARNING = "无行为差分断言，请人工核验预览";

export type CandidateChangeKind = "behavior" | "visual-only" | "refactor-only";

export type FailedGate =
  | "gate1-static-dag"
  | "gate1-hotswap-probe"
  | "gate2-ablation"
  | "gate3-subgraph-contract"
  | "gate3-red-green-diff"
  | "gate3-full-composition-smoke"
  | "gate3-disabled-data-preservation";

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

export interface AblationCheckResult {
  readonly targetPluginId: string;
  readonly kind: "upstream-seam" | "upstream-with-test-changes" | "parallel-sibling";
  readonly ablatedPlugins: readonly string[];
  readonly closurePlugins: readonly string[];
  readonly passed: boolean;
  readonly testResults: ReadonlyArray<{
    readonly file: string;
    readonly passed: boolean;
    readonly error?: string;
  }>;
  readonly error?: string;
}

export interface VerificationReport {
  readonly ok: boolean;
  readonly failedGate?: FailedGate;
  readonly errors: readonly string[];
  readonly staticViolations: readonly StaticViolation[];
  readonly dagViolations: readonly DagViolation[];
  readonly probedPlugins: readonly string[];
  readonly ablationResults: readonly AblationCheckResult[];
  readonly testChangeDisclosures: readonly TestChangeDisclosure[];
  readonly warnings?: readonly string[];
  readonly noBehaviorDiffWarning?: boolean;
  readonly subgraphResults?: readonly SubgraphVerificationResult[];
  readonly fullCompositionSmoke?: FullCompositionSmokeResult;
}

export interface VerifyCandidateInput {
  readonly baseline?: CompositionSnapshot;
  readonly candidate: CompositionSnapshot;
  readonly artifacts: ReadonlyMap<string, PluginArtifact>;
  readonly applyTimeoutMs?: number;
  readonly changeKind?: CandidateChangeKind;
  readonly productionDbPath?: string;
  readonly fullCompositionSmokeTest?: (
    ctx: PluginTestContext,
    meta: { readonly sandboxDbPath: string },
  ) => Promise<void>;
  readonly browser?: Browser;
}

function getChangedEnabledPlugins(
  baseline: CompositionSnapshot | undefined,
  candidate: CompositionSnapshot,
): string[] {
  const baselineById = new Map(
    (baseline?.members ?? []).map((m) => [m.pluginId, m]),
  );
  const changed: string[] = [];
  for (const member of candidate.members) {
    if (!member.enabled) continue;
    const prev = baselineById.get(member.pluginId);
    if (!prev || !prev.enabled || prev.versionId !== member.versionId) {
      changed.push(member.pluginId);
    }
  }
  return changed;
}

function computeTransitiveDependents(
  targetId: string,
  orderedEnabled: readonly { readonly member: { readonly pluginId: string }; readonly artifact: PluginArtifact }[],
): Set<string> {
  const affected = new Set<string>([targetId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of orderedEnabled) {
      if (affected.has(entry.member.pluginId)) continue;
      if (entry.artifact.dependencies.some((dep) => affected.has(dep))) {
        affected.add(entry.member.pluginId);
        changed = true;
      }
    }
  }
  return affected;
}

function assertAllEnabledActive(
  topology: CompositionTopology,
  expectedEnabledIds: ReadonlySet<string>,
  phase: string,
): string[] {
  const errors: string[] = [];
  const byId = new Map(topology.plugins.map((p) => [p.pluginId, p]));

  for (const pluginId of expectedEnabledIds) {
    const entry = byId.get(pluginId);
    if (!entry) {
      errors.push(`[${phase}] Enabled plugin "${pluginId}" missing from runtime topology`);
      continue;
    }
    if (entry.state !== "ACTIVE") {
      errors.push(
        `[${phase}] Plugin "${pluginId}" is in state "${entry.state}" (expected "ACTIVE")`,
      );
    }
  }

  for (const entry of topology.plugins) {
    if (entry.state === "PENDING" || entry.state === "FAILED") {
      errors.push(
        `[${phase}] Plugin "${entry.pluginId}" entered forbidden state "${entry.state}"`,
      );
    }
  }

  return errors;
}

function computeDependencyClosure(
  targetId: string,
  enabledArtifactById: ReadonlyMap<string, PluginArtifact>,
): Set<string> {
  const closure = new Set<string>();
  const visit = (id: string) => {
    if (closure.has(id)) return;
    closure.add(id);
    const art = enabledArtifactById.get(id);
    if (!art) return;
    for (const dep of art.dependencies) {
      visit(dep);
    }
  };
  visit(targetId);
  return closure;
}

function buildClosureSnapshot(
  candidate: CompositionSnapshot,
  closureIds: ReadonlySet<string>,
  suffix: string,
): CompositionSnapshot {
  return {
    compositionId: `${candidate.compositionId}-ablation-${suffix}`,
    parentCompositionId: candidate.compositionId,
    createdAt: new Date().toISOString(),
    members: candidate.members
      .filter((m) => closureIds.has(m.pluginId))
      .map((m) => ({ ...m, enabled: true })),
  };
}

function failReport(
  failedGate: FailedGate,
  errors: readonly string[],
  partial?: {
    staticViolations?: readonly StaticViolation[];
    dagViolations?: readonly DagViolation[];
    probedPlugins?: readonly string[];
    ablationResults?: readonly AblationCheckResult[];
    testChangeDisclosures?: readonly TestChangeDisclosure[];
  },
): VerificationReport {
  return {
    ok: false,
    failedGate,
    errors,
    staticViolations: partial?.staticViolations ?? [],
    dagViolations: partial?.dagViolations ?? [],
    probedPlugins: partial?.probedPlugins ?? [],
    ablationResults: partial?.ablationResults ?? [],
    testChangeDisclosures: partial?.testChangeDisclosures ?? [],
  };
}

async function runClientHotSwapProbe(
  orderedEnabled: readonly {
    readonly member: { readonly pluginId: string; readonly versionId: string };
    readonly artifact: PluginArtifact;
  }[],
  changedEnabled: readonly string[],
  compositionId: string,
): Promise<string[]> {
  const clientPlugins = orderedEnabled.filter(
    (e) => e.artifact.clientCode !== undefined,
  );
  if (clientPlugins.length === 0) return [];

  const tempDir = mkdtempSync(join(tmpdir(), "v3-verifier-client-"));
  symlinkSync(
    join(process.cwd(), "node_modules"),
    join(tempDir, "node_modules"),
    "dir",
  );
  const clientSdkUrl = pathToFileURL(
    join(process.cwd(), "src/v3/client-sdk.ts"),
  ).href;

  const entryPaths = new Map<string, string>();
  const pluginsDir = join(tempDir, "plugins");
  mkdirSync(pluginsDir, { recursive: true });

  for (const { artifact } of clientPlugins) {
    const entryUrl = `/plugins/${artifact.pluginId}/${artifact.versionId}/client.mjs`;
    const filePath = join(
      pluginsDir,
      `${artifact.pluginId}-${artifact.versionId}.mjs`,
    );
    const rewritten = artifact.clientCode!.replace(
      /(["'])@host\/client-sdk\1/g,
      JSON.stringify(clientSdkUrl),
    );
    writeFileSync(filePath, rewritten, "utf8");
    entryPaths.set(entryUrl, filePath);
  }

  const clientRuntime = new ClientCordisRuntime({
    diagnosticsUrl: "",
    moduleImporter: async (url) => {
      const filePath = entryPaths.get(url);
      if (!filePath) {
        throw new Error(`Client probe module not found: ${url}`);
      }
      return (await import(pathToFileURL(filePath).href)) as Record<
        string,
        unknown
      >;
    },
  });

  const toClientSnapshot = (
    id: string,
    exclude: ReadonlySet<string>,
  ): ActiveClientComposition => ({
    compositionId: id,
    plugins: clientPlugins
      .filter((e) => !exclude.has(e.member.pluginId))
      .map((e) => ({
        pluginId: e.member.pluginId,
        versionId: e.member.versionId,
        dependencies: e.artifact.dependencies,
        clientEntryUrl: `/plugins/${e.member.pluginId}/${e.member.versionId}/client.mjs`,
        ...(e.artifact.styleCss ? { styleCss: e.artifact.styleCss } : {}),
      })),
  });

  try {
    await clientRuntime.reconcile(toClientSnapshot(compositionId, new Set()));
    const initialDiags = clientRuntime.getDiagnostics();
    if (initialDiags.length > 0) {
      return initialDiags.map((d) => {
        const hint = /without inject/i.test(d.message)
          ? " (available client Context services: ctx.router, ctx.slots)"
          : "";
        return `[client-initial-mount] ${d.pluginId} (${d.kind}): ${d.message}${hint}`;
      });
    }

    const clientIdSet = new Set(clientPlugins.map((e) => e.member.pluginId));
    for (const pluginId of changedEnabled) {
      if (!clientIdSet.has(pluginId)) continue;
      const toDisable = computeTransitiveDependents(pluginId, orderedEnabled);

      clientRuntime.clearDiagnostics();
      await clientRuntime.reconcile(
        toClientSnapshot(`${compositionId}-client-dispose-${pluginId}`, toDisable),
      );
      const disposeDiags = clientRuntime.getDiagnostics();
      if (disposeDiags.length > 0) {
        return disposeDiags.map(
          (d) => `[client-dispose:${pluginId}] ${d.pluginId} (${d.kind}): ${d.message}`,
        );
      }

      const residualClientRoutes = clientRuntime
        .getRoutes()
        .filter((r) => toDisable.has(r.pluginId));
      if (residualClientRoutes.length > 0) {
        return [
          `[client-dispose:${pluginId}] Left ${residualClientRoutes.length} residual client route(s): ${residualClientRoutes.map((r) => r.path).join(", ")}`,
        ];
      }

      clientRuntime.clearDiagnostics();
      await clientRuntime.reconcile(
        toClientSnapshot(`${compositionId}-client-remount-${pluginId}`, new Set()),
      );
      const remountDiags = clientRuntime.getDiagnostics();
      if (remountDiags.length > 0) {
        return remountDiags.map(
          (d) => `[client-remount:${pluginId}] ${d.pluginId} (${d.kind}): ${d.message}`,
        );
      }
    }

    return [];
  } finally {
    await clientRuntime.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function verifyCandidateGates1And2(
  input: VerifyCandidateInput,
): Promise<VerificationReport> {
  const { baseline, candidate, artifacts } = input;
  const applyTimeoutMs = input.applyTimeoutMs ?? 15_000;

  // --- Gate 1a: DAG & Static Boundaries ---
  const dagViolations = verifyCompositionDag(candidate, artifacts);
  if (dagViolations.length > 0) {
    return failReport(
      "gate1-static-dag",
      dagViolations.map((v) => v.message),
      { dagViolations },
    );
  }

  const plan = validateAndSortComposition(candidate.members, artifacts);
  const staticViolations: StaticViolation[] = [];
  for (const { artifact } of plan.orderedEnabled) {
    staticViolations.push(...verifyStaticBoundaries(artifact));
  }

  if (staticViolations.length > 0) {
    return failReport(
      "gate1-static-dag",
      staticViolations.map(
        (v) => `[${v.pluginId}] ${v.file}${v.line ? `:${v.line}` : ""}: ${v.reason}`,
      ),
      { staticViolations },
    );
  }

  // --- Gate 1b: Sandbox Hot-Swap Lifecycle Probe (dispose -> remount) ---
  const changedEnabled = getChangedEnabledPlugins(baseline, candidate);
  const probedPlugins: string[] = [];
  const tempDir = mkdtempSync(join(tmpdir(), "v3-verifier-gate1-"));
  const runtime = new SupervisedCordisRuntime({
    dbPath: join(tempDir, "sandbox.db"),
    workDir: tempDir,
    applyTimeoutMs,
  });

  try {
    for (const artifact of artifacts.values()) {
      runtime.registerArtifact(artifact);
    }

    const enabledIds = new Set(plan.orderedEnabled.map((e) => e.member.pluginId));

    try {
      await runtime.applyComposition(candidate);
    } catch (error) {
      return failReport(
        "gate1-hotswap-probe",
        [
          `Initial mount of candidate composition failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
        { probedPlugins },
      );
    }

    const initialTopology = await runtime.introspect();
    const initialErrors = assertAllEnabledActive(
      initialTopology,
      enabledIds,
      "initial-mount",
    );
    if (initialErrors.length > 0) {
      return failReport("gate1-hotswap-probe", initialErrors, { probedPlugins });
    }

    for (const pluginId of changedEnabled) {
      const toDisable = computeTransitiveDependents(pluginId, plan.orderedEnabled);
      const disabledSnapshot: CompositionSnapshot = {
        compositionId: `${candidate.compositionId}-dispose-${pluginId}`,
        parentCompositionId: candidate.compositionId,
        createdAt: new Date().toISOString(),
        members: candidate.members.map((m) =>
          toDisable.has(m.pluginId) ? { ...m, enabled: false } : m,
        ),
      };

      try {
        await runtime.applyComposition(disabledSnapshot);
      } catch (error) {
        return failReport(
          "gate1-hotswap-probe",
          [
            `Dispose of plugin "${pluginId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
          { probedPlugins },
        );
      }

      const disposedTopology = await runtime.introspect();
      const residualRoutes = disposedTopology.routes.filter((r) =>
        toDisable.has(r.pluginId),
      );
      if (residualRoutes.length > 0) {
        return failReport(
          "gate1-hotswap-probe",
          [
            `Plugin "${pluginId}" left ${residualRoutes.length} residual route(s) after dispose: ${residualRoutes.map((r) => `${r.method} ${r.path}`).join(", ")}`,
          ],
          { probedPlugins },
        );
      }

      const residualTimers = disposedTopology.plugins.filter(
        (p) => toDisable.has(p.pluginId) && p.activeTimers > 0,
      );
      if (residualTimers.length > 0) {
        return failReport(
          "gate1-hotswap-probe",
          [
            `Plugin "${pluginId}" left active timer(s) after dispose: ${residualTimers.map((p) => `${p.pluginId}(${p.activeTimers})`).join(", ")}`,
          ],
          { probedPlugins },
        );
      }

      const remountSnapshot: CompositionSnapshot = {
        ...candidate,
        compositionId: `${candidate.compositionId}-remount-${pluginId}`,
      };

      try {
        await runtime.applyComposition(remountSnapshot);
      } catch (error) {
        return failReport(
          "gate1-hotswap-probe",
          [
            `Remount of plugin "${pluginId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
          { probedPlugins },
        );
      }

      const remountTopology = await runtime.introspect();
      const remountErrors = assertAllEnabledActive(
        remountTopology,
        enabledIds,
        `remount:${pluginId}`,
      );
      if (remountErrors.length > 0) {
        return failReport("gate1-hotswap-probe", remountErrors, { probedPlugins });
      }

      probedPlugins.push(pluginId);
    }
  } finally {
    await runtime.close();
    rmSync(tempDir, { recursive: true, force: true });
  }

  const clientProbeErrors = await runClientHotSwapProbe(
    plan.orderedEnabled,
    changedEnabled,
    candidate.compositionId,
  );
  if (clientProbeErrors.length > 0) {
    return failReport("gate1-hotswap-probe", clientProbeErrors, {
      probedPlugins,
    });
  }

  // --- Gate 2: Ablation Invariant ---
  const enabledArtifactById = new Map<string, PluginArtifact>(
    plan.orderedEnabled.map((e) => [e.member.pluginId, e.artifact]),
  );
  const baselineMemberById = new Map(
    (baseline?.members ?? []).map((m) => [m.pluginId, m]),
  );
  const changedSet = new Set(changedEnabled);

  const ablationResults: AblationCheckResult[] = [];
  const testChangeDisclosures: TestChangeDisclosure[] = [];
  const ablationErrors: string[] = [];
  const checkedUpstream = new Set<string>();

  // 1. Upstream U modified + downstream D (depending on U) added or modified
  for (const pluginId of changedEnabled) {
    const baseMember = baselineMemberById.get(pluginId);
    if (!baseMember) continue; // newly added plugin, not an existing upstream
    const candidateArtifact = enabledArtifactById.get(pluginId)!;
    if (baseMember.versionId === candidateArtifact.versionId) continue;

    const dependents = computeTransitiveDependents(pluginId, plan.orderedEnabled);
    dependents.delete(pluginId);
    const changedDependents = [...dependents].filter((d) => changedSet.has(d));
    if (changedDependents.length === 0) continue;

    checkedUpstream.add(pluginId);
    const baseArtifact = artifacts.get(
      artifactKey(baseMember.pluginId, baseMember.versionId),
    );
    const baselineTests = baseArtifact?.testFiles ?? {};
    const candidateTests = candidateArtifact.testFiles ?? {};
    const disclosure = diffPluginTestFiles(pluginId, baselineTests, candidateTests);

    const closureIds = computeDependencyClosure(pluginId, enabledArtifactById);
    const closureSnapshot = buildClosureSnapshot(
      candidate,
      closureIds,
      `upstream-${pluginId}`,
    );

    const kind = disclosure ? "upstream-with-test-changes" : "upstream-seam";
    if (disclosure) {
      testChangeDisclosures.push(disclosure);
    }

    const testsToRun: Record<string, string> = {};
    if (disclosure) {
      for (const id of closureIds) {
        const art = enabledArtifactById.get(id);
        if (!art) continue;
        for (const [file, code] of Object.entries(art.testFiles)) {
          testsToRun[id === pluginId ? file : `${id}/${file}`] = code;
        }
      }
    } else {
      Object.assign(testsToRun, baselineTests);
    }

    const runResult = await runPluginContractTests({
      composition: closureSnapshot,
      artifacts,
      testFiles: testsToRun,
      applyTimeoutMs,
    });

    ablationResults.push({
      targetPluginId: pluginId,
      kind,
      ablatedPlugins: changedDependents,
      closurePlugins: [...closureIds],
      passed: runResult.ok,
      testResults: runResult.results,
      ...(runResult.error ? { error: runResult.error } : {}),
    });

    if (!runResult.ok) {
      ablationErrors.push(
        `Ablation failed for upstream plugin "${pluginId}" (without ${changedDependents.join(", ")}): ${runResult.error ?? "contract tests failed"}`,
      );
    }
  }

  // 2. Parallel sibling plugins (mutually independent changed plugins)
  const closureByChanged = new Map<string, Set<string>>();
  for (const pluginId of changedEnabled) {
    closureByChanged.set(
      pluginId,
      computeDependencyClosure(pluginId, enabledArtifactById),
    );
  }

  const parallelSiblings = new Set<string>();
  for (let i = 0; i < changedEnabled.length; i++) {
    for (let j = i + 1; j < changedEnabled.length; j++) {
      const a = changedEnabled[i];
      const b = changedEnabled[j];
      const aDependsOnB = closureByChanged.get(a)!.has(b);
      const bDependsOnA = closureByChanged.get(b)!.has(a);
      if (!aDependsOnB && !bDependsOnA) {
        parallelSiblings.add(a);
        parallelSiblings.add(b);
      }
    }
  }

  for (const pluginId of parallelSiblings) {
    if (checkedUpstream.has(pluginId)) continue;
    const closureIds = closureByChanged.get(pluginId)!;
    const ablatedSiblings = [...parallelSiblings].filter(
      (other) => other !== pluginId && !closureIds.has(other),
    );
    const closureSnapshot = buildClosureSnapshot(
      candidate,
      closureIds,
      `sibling-${pluginId}`,
    );
    const artifact = enabledArtifactById.get(pluginId)!;
    const runResult = await runPluginContractTests({
      composition: closureSnapshot,
      artifacts,
      testFiles: artifact.testFiles,
      applyTimeoutMs,
    });

    ablationResults.push({
      targetPluginId: pluginId,
      kind: "parallel-sibling",
      ablatedPlugins: ablatedSiblings,
      closurePlugins: [...closureIds],
      passed: runResult.ok,
      testResults: runResult.results,
      ...(runResult.error ? { error: runResult.error } : {}),
    });

    if (!runResult.ok) {
      ablationErrors.push(
        `Parallel sibling isolation failed for "${pluginId}" (without ${ablatedSiblings.join(", ")}): ${runResult.error ?? "contract tests failed"}`,
      );
    }
  }

  if (ablationErrors.length > 0) {
    return {
      ok: false,
      failedGate: "gate2-ablation",
      errors: ablationErrors,
      staticViolations: [],
      dagViolations: [],
      probedPlugins,
      ablationResults,
      testChangeDisclosures,
    };
  }

  return {
    ok: true,
    errors: [],
    staticViolations: [],
    dagViolations: [],
    probedPlugins,
    ablationResults,
    testChangeDisclosures,
  };
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
  input: VerifyCandidateInput,
  disabledPlugins: readonly string[],
  sharedBrowser: Browser,
): Promise<{
  readonly result: FullCompositionSmokeResult;
  readonly failedGate?: "gate3-full-composition-smoke" | "gate3-disabled-data-preservation";
  readonly errors: readonly string[];
}> {
  const tempDir = mkdtempSync(join(tmpdir(), "v3-gate3-full-smoke-"));
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
    let httpServer: Awaited<ReturnType<typeof startV3HttpServer>> | null = null;
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
      const activeErrors = assertAllEnabledActive(
        topology,
        expectedEnabledIds,
        "full-composition-smoke",
      );
      errors.push(...activeErrors);
      activePlugins = topology.plugins
        .filter((p) => p.state === "ACTIVE")
        .map((p) => p.pluginId)
        .sort();

      httpServer = await startV3HttpServer(runtime, { port: 0 });

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
          '[data-plugin-error-boundary], [data-v3-error-boundary="true"], [data-error-boundary="true"]',
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

    // Verify disabled plugins' own-namespace tables suffered zero data loss
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

export async function verifyCandidate(
  input: VerifyCandidateInput,
): Promise<VerificationReport> {
  const { baseline, candidate, artifacts, applyTimeoutMs } = input;
  const changeKind: CandidateChangeKind = input.changeKind ?? "behavior";
  const isNonBehavioral =
    changeKind === "visual-only" || changeKind === "refactor-only";

  // Gate 4: Deterministic test diff disclosure for all existing plugins
  const allTestDisclosures = computeTestChangeDisclosures(
    baseline,
    candidate,
    artifacts,
  );

  // Gates 1 & 2
  const g12 = await verifyCandidateGates1And2(input);
  if (!g12.ok) {
    return {
      ...g12,
      testChangeDisclosures:
        allTestDisclosures.length > 0
          ? allTestDisclosures
          : g12.testChangeDisclosures,
      warnings: [],
      noBehaviorDiffWarning: false,
      subgraphResults: [],
    };
  }

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
    // --- Gate 3 Layer 1: Minimum dependency subgraph closure(P) + Red-Green differential ---
    const subgraphResults: SubgraphVerificationResult[] = [];
    const warnings: string[] = [];
    let noBehaviorDiffWarning = false;

    // Gate 2 Case A (upstream-seam): an existing upstream plugin whose tests were untouched
    // and passed ablation without its changed downstream plugin(s) only opened a generic seam;
    // the new behavior is proven via Red-Green differential on the downstream plugin(s).
    const upstreamSeamExemptIds = new Set<string>();
    for (const ablation of g12.ablationResults) {
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
          ...g12,
          ok: false,
          failedGate: "gate3-subgraph-contract",
          errors: [errMsg],
          testChangeDisclosures: allTestDisclosures,
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

      // Changed or newly added/enabled plugin: enforce Red-Green differential
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
          ...g12,
          ok: false,
          failedGate: "gate3-red-green-diff",
          errors: [errMsg],
          testChangeDisclosures: allTestDisclosures,
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
          ...g12,
          ok: false,
          failedGate: "gate3-red-green-diff",
          errors: [errMsg],
          testChangeDisclosures: allTestDisclosures,
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

    // --- Gate 3 Layer 2: Online Cloned DB + Full-Composition Smoke + Disabled-Plugin Data Preservation ---
    const disabledPlugins = getDisabledPlugins(baseline, candidate);
    const sharedBrowser = await getSharedBrowser();
    const smokeOutcome = await runFullCompositionSmoke(
      input,
      disabledPlugins,
      sharedBrowser,
    );

    if (!smokeOutcome.result.passed) {
      return {
        ...g12,
        ok: false,
        failedGate: smokeOutcome.failedGate ?? "gate3-full-composition-smoke",
        errors: smokeOutcome.errors,
        testChangeDisclosures: allTestDisclosures,
        warnings,
        noBehaviorDiffWarning,
        subgraphResults,
        fullCompositionSmoke: smokeOutcome.result,
      };
    }

    return {
      ...g12,
      ok: true,
      errors: [],
      testChangeDisclosures: allTestDisclosures,
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
