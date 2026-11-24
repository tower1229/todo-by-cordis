import {
  type OrderedPluginEntry,
  buildClosureSnapshot,
  computeDependencyClosure,
  computeTransitiveDependents,
} from "./gate-static-hotswap.js";
import { runPluginContractTests } from "./test-runner.js";
import { type TestChangeDisclosure, diffPluginTestFiles } from "./gate-test-diff.js";
import { artifactKey } from "../contracts/topology.js";
import type { CompositionSnapshot, PluginArtifact } from "../contracts/types.js";

export interface AblationCheckResult {
  readonly targetPluginId: string;
  readonly kind:
    | "upstream-seam"
    | "upstream-with-test-changes"
    | "parallel-sibling";
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

export interface Gate2Outcome {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly ablationResults: readonly AblationCheckResult[];
  readonly testChangeDisclosures: readonly TestChangeDisclosure[];
}

/**
 * Gate 2: Ablation Invariant preventing monolithic degradation.
 * - Case A (upstream seam): when upstream U and downstream D change together
 *   and U's tests are unchanged, ablating D must still pass U's baseline tests 100%.
 * - Case B (upstream rule change): disclose U's test diff and verify U passes
 *   independently without D.
 * - Parallel siblings: verify mutually independent changed plugins without each other.
 */
export async function runGate2Ablation(input: {
  readonly baseline?: CompositionSnapshot;
  readonly candidate: CompositionSnapshot;
  readonly artifacts: ReadonlyMap<string, PluginArtifact>;
  readonly orderedEnabled: readonly OrderedPluginEntry[];
  readonly changedEnabled: readonly string[];
  readonly applyTimeoutMs: number;
}): Promise<Gate2Outcome> {
  const {
    baseline,
    candidate,
    artifacts,
    orderedEnabled,
    changedEnabled,
    applyTimeoutMs,
  } = input;

  const enabledArtifactById = new Map<string, PluginArtifact>(
    orderedEnabled.map((e) => [e.member.pluginId, e.artifact]),
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
    if (!baseMember) continue;
    const candidateArtifact = enabledArtifactById.get(pluginId)!;
    if (baseMember.versionId === candidateArtifact.versionId) continue;

    const dependents = computeTransitiveDependents(pluginId, orderedEnabled);
    dependents.delete(pluginId);
    const changedDependents = [...dependents].filter((d) => changedSet.has(d));
    if (changedDependents.length === 0) continue;

    checkedUpstream.add(pluginId);
    const baseArtifact = artifacts.get(
      artifactKey(baseMember.pluginId, baseMember.versionId),
    );
    const baselineTests = baseArtifact?.testFiles ?? {};
    const candidateTests = candidateArtifact.testFiles ?? {};
    const disclosure = diffPluginTestFiles(
      pluginId,
      baselineTests,
      candidateTests,
    );

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

  return {
    ok: ablationErrors.length === 0,
    errors: ablationErrors,
    ablationResults,
    testChangeDisclosures,
  };
}
