import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveProjectRoot } from "../build/project-root.js";
import { ClientCordisRuntime } from "../runtime/client/client-runtime.js";
import { SupervisedCordisRuntime } from "../runtime/server/supervised-runtime.js";
import {
  type DagViolation,
  type StaticViolation,
  verifyCompositionDag,
  verifyStaticBoundaries,
} from "./static-verifier.js";
import { validateAndSortComposition } from "../contracts/topology.js";
import type {
  ActiveClientComposition,
  CompositionSnapshot,
  CompositionTopology,
  PluginArtifact,
} from "../contracts/types.js";

export interface OrderedPluginEntry {
  readonly member: { readonly pluginId: string; readonly versionId: string };
  readonly artifact: PluginArtifact;
}

export function getChangedEnabledPlugins(
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

export function computeTransitiveDependents(
  targetId: string,
  orderedEnabled: readonly OrderedPluginEntry[],
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

export function assertAllEnabledActive(
  topology: CompositionTopology,
  expectedEnabledIds: ReadonlySet<string>,
  phase: string,
): string[] {
  const errors: string[] = [];
  const byId = new Map(topology.plugins.map((p) => [p.pluginId, p]));

  for (const pluginId of expectedEnabledIds) {
    const entry = byId.get(pluginId);
    if (!entry) {
      errors.push(
        `[${phase}] Enabled plugin "${pluginId}" missing from runtime topology`,
      );
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

export function computeDependencyClosure(
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

export function buildClosureSnapshot(
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

async function runClientHotSwapProbe(
  orderedEnabled: readonly OrderedPluginEntry[],
  changedEnabled: readonly string[],
  compositionId: string,
): Promise<string[]> {
  const clientPlugins = orderedEnabled.filter(
    (e) => e.artifact.clientCode !== undefined,
  );
  if (clientPlugins.length === 0) return [];

  const tempDir = mkdtempSync(join(tmpdir(), "verifier-client-probe-"));
  symlinkSync(
    join(resolveProjectRoot(), "node_modules"),
    join(tempDir, "node_modules"),
    "dir",
  );
  const clientSdkUrl = new URL(
    import.meta.url.endsWith(".ts")
      ? "../contracts/client-sdk.ts"
      : "../contracts/client-sdk.js",
    import.meta.url,
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
          (d) =>
            `[client-dispose:${pluginId}] ${d.pluginId} (${d.kind}): ${d.message}`,
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
          (d) =>
            `[client-remount:${pluginId}] ${d.pluginId} (${d.kind}): ${d.message}`,
        );
      }
    }

    return [];
  } finally {
    await clientRuntime.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export interface Gate1Outcome {
  readonly ok: boolean;
  readonly failedGate?: "gate1-static-dag" | "gate1-hotswap-probe";
  readonly errors: readonly string[];
  readonly staticViolations: readonly StaticViolation[];
  readonly dagViolations: readonly DagViolation[];
  readonly probedPlugins: readonly string[];
  readonly orderedEnabled?: readonly OrderedPluginEntry[];
  readonly changedEnabled?: readonly string[];
}

/**
 * Gate 1: AST import whitelist, DAG acyclicity, and sandbox Fiber hot-swap
 * lifecycle probe (mount -> dispose -> verify zero residual routes/timers -> remount).
 */
export async function runGate1StaticAndHotSwap(input: {
  readonly baseline?: CompositionSnapshot;
  readonly candidate: CompositionSnapshot;
  readonly artifacts: ReadonlyMap<string, PluginArtifact>;
  readonly applyTimeoutMs: number;
}): Promise<Gate1Outcome> {
  const { baseline, candidate, artifacts, applyTimeoutMs } = input;

  const dagViolations = verifyCompositionDag(candidate, artifacts);
  if (dagViolations.length > 0) {
    return {
      ok: false,
      failedGate: "gate1-static-dag",
      errors: dagViolations.map((v) => v.message),
      staticViolations: [],
      dagViolations,
      probedPlugins: [],
    };
  }

  const plan = validateAndSortComposition(candidate.members, artifacts);
  const staticViolations: StaticViolation[] = [];
  for (const { artifact } of plan.orderedEnabled) {
    staticViolations.push(...verifyStaticBoundaries(artifact));
  }

  if (staticViolations.length > 0) {
    return {
      ok: false,
      failedGate: "gate1-static-dag",
      errors: staticViolations.map(
        (v) =>
          `[${v.pluginId}] ${v.file}${v.line ? `:${v.line}` : ""}: ${v.reason}`,
      ),
      staticViolations,
      dagViolations: [],
      probedPlugins: [],
    };
  }

  const changedEnabled = getChangedEnabledPlugins(baseline, candidate);
  const probedPlugins: string[] = [];
  const tempDir = mkdtempSync(join(tmpdir(), "verifier-gate1-"));
  const runtime = new SupervisedCordisRuntime({
    dbPath: join(tempDir, "sandbox.db"),
    workDir: tempDir,
    applyTimeoutMs,
  });

  try {
    for (const artifact of artifacts.values()) {
      runtime.registerArtifact(artifact);
    }

    const enabledIds = new Set(
      plan.orderedEnabled.map((e) => e.member.pluginId),
    );

    try {
      await runtime.applyComposition(candidate);
    } catch (error) {
      return {
        ok: false,
        failedGate: "gate1-hotswap-probe",
        errors: [
          `Initial mount of candidate composition failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
        staticViolations: [],
        dagViolations: [],
        probedPlugins,
      };
    }

    const initialTopology = await runtime.introspect();
    const initialErrors = assertAllEnabledActive(
      initialTopology,
      enabledIds,
      "initial-mount",
    );
    if (initialErrors.length > 0) {
      return {
        ok: false,
        failedGate: "gate1-hotswap-probe",
        errors: initialErrors,
        staticViolations: [],
        dagViolations: [],
        probedPlugins,
      };
    }

    for (const pluginId of changedEnabled) {
      const toDisable = computeTransitiveDependents(
        pluginId,
        plan.orderedEnabled,
      );
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
        return {
          ok: false,
          failedGate: "gate1-hotswap-probe",
          errors: [
            `Dispose of plugin "${pluginId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
          staticViolations: [],
          dagViolations: [],
          probedPlugins,
        };
      }

      const disposedTopology = await runtime.introspect();
      const residualRoutes = disposedTopology.routes.filter((r) =>
        toDisable.has(r.pluginId),
      );
      if (residualRoutes.length > 0) {
        return {
          ok: false,
          failedGate: "gate1-hotswap-probe",
          errors: [
            `Plugin "${pluginId}" left ${residualRoutes.length} residual route(s) after dispose: ${residualRoutes.map((r) => `${r.method} ${r.path}`).join(", ")}`,
          ],
          staticViolations: [],
          dagViolations: [],
          probedPlugins,
        };
      }

      const residualTimers = disposedTopology.plugins.filter(
        (p) => toDisable.has(p.pluginId) && p.activeTimers > 0,
      );
      if (residualTimers.length > 0) {
        return {
          ok: false,
          failedGate: "gate1-hotswap-probe",
          errors: [
            `Plugin "${pluginId}" left active timer(s) after dispose: ${residualTimers.map((p) => `${p.pluginId}(${p.activeTimers})`).join(", ")}`,
          ],
          staticViolations: [],
          dagViolations: [],
          probedPlugins,
        };
      }

      const remountSnapshot: CompositionSnapshot = {
        ...candidate,
        compositionId: `${candidate.compositionId}-remount-${pluginId}`,
      };

      try {
        await runtime.applyComposition(remountSnapshot);
      } catch (error) {
        return {
          ok: false,
          failedGate: "gate1-hotswap-probe",
          errors: [
            `Remount of plugin "${pluginId}" failed: ${error instanceof Error ? error.message : String(error)}`,
          ],
          staticViolations: [],
          dagViolations: [],
          probedPlugins,
        };
      }

      const remountTopology = await runtime.introspect();
      const remountErrors = assertAllEnabledActive(
        remountTopology,
        enabledIds,
        `remount:${pluginId}`,
      );
      if (remountErrors.length > 0) {
        return {
          ok: false,
          failedGate: "gate1-hotswap-probe",
          errors: remountErrors,
          staticViolations: [],
          dagViolations: [],
          probedPlugins,
        };
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
    return {
      ok: false,
      failedGate: "gate1-hotswap-probe",
      errors: clientProbeErrors,
      staticViolations: [],
      dagViolations: [],
      probedPlugins,
    };
  }

  return {
    ok: true,
    errors: [],
    staticViolations: [],
    dagViolations: [],
    probedPlugins,
    orderedEnabled: plan.orderedEnabled,
    changedEnabled,
  };
}
