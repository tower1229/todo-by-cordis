import type { CompositionMember, PluginArtifact } from "./types.js";

export interface ResolvedCompositionPlan {
  readonly orderedEnabled: readonly {
    readonly member: CompositionMember;
    readonly artifact: PluginArtifact;
  }[];
  readonly allMembers: readonly {
    readonly member: CompositionMember;
    readonly artifact: PluginArtifact;
  }[];
}

export function artifactKey(pluginId: string, versionId: string): string {
  return `${pluginId}@${versionId}`;
}

export function validateAndSortComposition(
  members: readonly CompositionMember[],
  artifacts: ReadonlyMap<string, PluginArtifact>,
): ResolvedCompositionPlan {
  const seenIds = new Set<string>();
  const resolvedAll: Array<{
    member: CompositionMember;
    artifact: PluginArtifact;
  }> = [];
  const enabledById = new Map<
    string,
    { member: CompositionMember; artifact: PluginArtifact }
  >();

  for (const member of members) {
    if (seenIds.has(member.pluginId)) {
      throw new Error(`Duplicate pluginId in composition: "${member.pluginId}"`);
    }
    seenIds.add(member.pluginId);
    const artifact = artifacts.get(artifactKey(member.pluginId, member.versionId));
    if (!artifact) {
      throw new Error(
        `Missing plugin artifact for "${member.pluginId}@${member.versionId}"`,
      );
    }
    const entry = { member, artifact };
    resolvedAll.push(entry);
    if (member.enabled) {
      enabledById.set(member.pluginId, entry);
    }
  }

  for (const { member, artifact } of enabledById.values()) {
    for (const dep of artifact.dependencies) {
      if (!enabledById.has(dep)) {
        throw new Error(
          `Enabled plugin "${member.pluginId}" requires enabled dependency "${dep}"`,
        );
      }
    }
  }

  // Topological sort (Kahn / DFS with cycle detection) preserving deterministic order
  const state = new Map<string, "visiting" | "visited">();
  const orderedEnabled: Array<{
    member: CompositionMember;
    artifact: PluginArtifact;
  }> = [];

  const visit = (pluginId: string, stack: string[]) => {
    const current = state.get(pluginId);
    if (current === "visited") return;
    if (current === "visiting") {
      const cycleStart = stack.indexOf(pluginId);
      const cycle = [...stack.slice(cycleStart), pluginId].join(" -> ");
      throw new Error(`Cyclic plugin dependency detected: ${cycle}`);
    }
    state.set(pluginId, "visiting");
    const entry = enabledById.get(pluginId)!;
    for (const dep of entry.artifact.dependencies) {
      visit(dep, [...stack, pluginId]);
    }
    state.set(pluginId, "visited");
    orderedEnabled.push(entry);
  };

  for (const pluginId of enabledById.keys()) {
    visit(pluginId, []);
  }

  return {
    orderedEnabled,
    allMembers: resolvedAll,
  };
}

export interface MountedEntryMeta {
  readonly pluginId: string;
  readonly versionId: string;
  readonly dependencies: readonly string[];
}

export interface HotSwapPlan {
  readonly toDispose: readonly string[];
  readonly toMount: readonly {
    readonly pluginId: string;
    readonly versionId: string;
  }[];
}

export function computeHotSwapPlan(
  currentMountedOrdered: readonly MountedEntryMeta[],
  targetOrderedEnabled: readonly MountedEntryMeta[],
): HotSwapPlan {
  const currentById = new Map(currentMountedOrdered.map((e) => [e.pluginId, e]));
  const targetById = new Map(targetOrderedEnabled.map((e) => [e.pluginId, e]));

  // Direct changes: removed, disabled, or version/dependency changed
  const invalidated = new Set<string>();
  for (const cur of currentMountedOrdered) {
    const next = targetById.get(cur.pluginId);
    if (
      !next ||
      next.versionId !== cur.versionId ||
      next.dependencies.join(",") !== cur.dependencies.join(",")
    ) {
      invalidated.add(cur.pluginId);
    }
  }

  // Propagate invalidation downstream so any dependent of an invalidated plugin
  // is cleanly disposed before its upstream and remounted after its upstream.
  let changed = true;
  while (changed) {
    changed = false;
    for (const cur of currentMountedOrdered) {
      if (invalidated.has(cur.pluginId)) continue;
      if (cur.dependencies.some((dep) => invalidated.has(dep))) {
        invalidated.add(cur.pluginId);
        changed = true;
      }
    }
  }

  // Dispose in reverse topological order (downstream before upstream)
  const toDispose = [...currentMountedOrdered]
    .reverse()
    .filter((entry) => invalidated.has(entry.pluginId))
    .map((entry) => entry.pluginId);

  // Mount in forward topological order (upstream before downstream)
  const toMount = targetOrderedEnabled
    .filter(
      (entry) =>
        !currentById.has(entry.pluginId) || invalidated.has(entry.pluginId),
    )
    .map((entry) => ({
      pluginId: entry.pluginId,
      versionId: entry.versionId,
    }));

  return { toDispose, toMount };
}
