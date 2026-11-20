import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisedCordisRuntime } from "./cordis-runtime.js";
import { runPluginContractTests } from "./plugin-test-runner.js";
import {
  type DagViolation,
  type StaticViolation,
  verifyCompositionDag,
  verifyStaticBoundaries,
} from "./static-verifier.js";
import { artifactKey, validateAndSortComposition } from "./topology.js";
import type {
  CompositionSnapshot,
  CompositionTopology,
  PluginArtifact,
} from "./types.js";

export type FailedGate =
  | "gate1-static-dag"
  | "gate1-hotswap-probe"
  | "gate2-ablation";

export interface TestChangeDisclosure {
  readonly pluginId: string;
  readonly modifiedFiles: readonly string[];
  readonly addedFiles: readonly string[];
  readonly removedFiles: readonly string[];
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
}

export interface VerifyCandidateInput {
  readonly baseline?: CompositionSnapshot;
  readonly candidate: CompositionSnapshot;
  readonly artifacts: ReadonlyMap<string, PluginArtifact>;
  readonly applyTimeoutMs?: number;
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

function diffTestFiles(
  pluginId: string,
  baselineTests: Readonly<Record<string, string>>,
  candidateTests: Readonly<Record<string, string>>,
): TestChangeDisclosure | null {
  const modifiedFiles: string[] = [];
  const addedFiles: string[] = [];
  const removedFiles: string[] = [];

  for (const [file, content] of Object.entries(baselineTests)) {
    if (!(file in candidateTests)) {
      removedFiles.push(file);
    } else if (candidateTests[file] !== content) {
      modifiedFiles.push(file);
    }
  }
  for (const file of Object.keys(candidateTests)) {
    if (!(file in baselineTests)) {
      addedFiles.push(file);
    }
  }

  if (
    modifiedFiles.length === 0 &&
    addedFiles.length === 0 &&
    removedFiles.length === 0
  ) {
    return null;
  }

  return {
    pluginId,
    modifiedFiles: modifiedFiles.sort(),
    addedFiles: addedFiles.sort(),
    removedFiles: removedFiles.sort(),
  };
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
    const disclosure = diffTestFiles(pluginId, baselineTests, candidateTests);

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
