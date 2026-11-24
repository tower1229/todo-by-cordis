import type { Browser } from "playwright";
import type { DataFingerprintDiff } from "./db-snapshot.js";
import { type AblationCheckResult, runGate2Ablation } from "./gate-ablation.js";
import { runGate1StaticAndHotSwap } from "./gate-static-hotswap.js";
import {
  type CandidateChangeKind,
  type FullCompositionSmokeResult,
  NO_BEHAVIOR_DIFF_WARNING,
  type SubgraphVerificationResult,
  runGate3SubgraphAndSmoke,
} from "./gate-subgraph-smoke.js";
import type { PluginTestContext } from "./test-runner.js";
import type { DagViolation, StaticViolation } from "./static-verifier.js";
import {
  type TestChangeDisclosure,
  type TestFileDiffEntry,
  computeTestChangeDisclosures,
} from "./gate-test-diff.js";
import type { CompositionSnapshot, PluginArtifact } from "../contracts/types.js";

export type {
  AblationCheckResult,
  CandidateChangeKind,
  DataFingerprintDiff,
  FullCompositionSmokeResult,
  SubgraphVerificationResult,
  TestChangeDisclosure,
  TestFileDiffEntry,
};
export { NO_BEHAVIOR_DIFF_WARNING };

export type FailedGate =
  | "gate1-static-dag"
  | "gate1-hotswap-probe"
  | "gate2-ablation"
  | "gate3-subgraph-contract"
  | "gate3-red-green-diff"
  | "gate3-full-composition-smoke"
  | "gate3-disabled-data-preservation";

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

export async function verifyCandidateGates1And2(
  input: VerifyCandidateInput,
): Promise<VerificationReport> {
  const { baseline, candidate, artifacts } = input;
  const applyTimeoutMs = input.applyTimeoutMs ?? 15_000;

  // Gate 1: Static AST whitelist, DAG acyclicity, and Fiber dispose/remount probe
  const gate1 = await runGate1StaticAndHotSwap({
    baseline,
    candidate,
    artifacts,
    applyTimeoutMs,
  });
  if (!gate1.ok) {
    return {
      ok: false,
      failedGate: gate1.failedGate,
      errors: gate1.errors,
      staticViolations: gate1.staticViolations,
      dagViolations: gate1.dagViolations,
      probedPlugins: gate1.probedPlugins,
      ablationResults: [],
      testChangeDisclosures: [],
    };
  }

  // Gate 2: Ablation Invariant (Cases A/B & parallel siblings)
  const gate2 = await runGate2Ablation({
    baseline,
    candidate,
    artifacts,
    orderedEnabled: gate1.orderedEnabled ?? [],
    changedEnabled: gate1.changedEnabled ?? [],
    applyTimeoutMs,
  });

  if (!gate2.ok) {
    return {
      ok: false,
      failedGate: "gate2-ablation",
      errors: gate2.errors,
      staticViolations: [],
      dagViolations: [],
      probedPlugins: gate1.probedPlugins,
      ablationResults: gate2.ablationResults,
      testChangeDisclosures: gate2.testChangeDisclosures,
    };
  }

  return {
    ok: true,
    errors: [],
    staticViolations: [],
    dagViolations: [],
    probedPlugins: gate1.probedPlugins,
    ablationResults: gate2.ablationResults,
    testChangeDisclosures: gate2.testChangeDisclosures,
  };
}

/**
 * Orchestrate all four deterministic verification gates in sequence:
 * 1. Static AST / DAG / Fiber hot-swap lifecycle probe
 * 2. Ablation Invariant (preventing monolithic degradation)
 * 3. Subgraph closure(P) Red-Green differential + online cloned-DB full smoke
 * 4. Transparent existing-test diff disclosure
 */
export async function verifyCandidate(
  input: VerifyCandidateInput,
): Promise<VerificationReport> {
  const { baseline, candidate, artifacts, applyTimeoutMs } = input;
  const changeKind: CandidateChangeKind = input.changeKind ?? "behavior";

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

  // Gate 3: Subgraph Red-Green + online cloned-DB full composition smoke
  const gate3 = await runGate3SubgraphAndSmoke({
    baseline,
    candidate,
    artifacts,
    ablationResults: g12.ablationResults,
    applyTimeoutMs,
    changeKind,
    productionDbPath: input.productionDbPath,
    fullCompositionSmokeTest: input.fullCompositionSmokeTest,
    browser: input.browser,
  });

  return {
    ...g12,
    ok: gate3.ok,
    ...(gate3.failedGate ? { failedGate: gate3.failedGate } : {}),
    errors: gate3.errors,
    testChangeDisclosures: allTestDisclosures,
    warnings: gate3.warnings,
    noBehaviorDiffWarning: gate3.noBehaviorDiffWarning,
    subgraphResults: gate3.subgraphResults,
    ...(gate3.fullCompositionSmoke
      ? { fullCompositionSmoke: gate3.fullCompositionSmoke }
      : {}),
  };
}
