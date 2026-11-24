import { randomUUID } from "node:crypto";
import type { EvolutionToolDefinition } from "./model/types.js";
import type { CompositionRelease } from "../release/composition-release.js";
import type {
  EvolutionRunRecord,
  StagedPluginPackage,
  StagedWorkspaceState,
} from "../release/control-store.js";
import { computeWorkspaceHash } from "./context-builder.js";
import { PluginBuildError, buildPluginPackage } from "../build/plugin-builder.js";
import type {
  VerificationReport,
  VerifyCandidateInput,
} from "../verify/index.js";
import { artifactKey } from "../contracts/topology.js";
import type {
  CompositionMember,
  CompositionSnapshot,
  PluginArtifact,
} from "../contracts/types.js";

export const EVOLUTION_TOOLS: readonly EvolutionToolDefinition[] = [
  {
    name: "inspect_plugin",
    description:
      "Read the source files and test files of a specific plugin from the staged workspace or active composition.",
    parameters: {
      type: "object",
      properties: {
        pluginId: { type: "string", description: "Target plugin ID" },
      },
      required: ["pluginId"],
    },
  },
  {
    name: "clarify_request",
    description:
      "Pause and ask the user a clarification question ONLY when there is a major business goal ambiguity or destructive data intent.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Concise clarification question" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "Optional suggested choices",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "stage_plugin_changes",
    description:
      "Stage new or updated plugin package files and/or toggle plugin enabled states in the candidate sandbox workspace.",
    parameters: {
      type: "object",
      properties: {
        upserts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pluginId: { type: "string" },
              name: { type: "string" },
              dependencies: { type: "array", items: { type: "string" } },
              contractTypes: { type: "string" },
              sourceFiles: { type: "object" },
              testFiles: { type: "object" },
            },
            required: ["pluginId", "name", "dependencies", "sourceFiles"],
          },
        },
        toggles: {
          type: "array",
          items: {
            type: "object",
            properties: {
              pluginId: { type: "string" },
              enabled: { type: "boolean" },
            },
            required: ["pluginId", "enabled"],
          },
        },
      },
    },
  },
  {
    name: "verify_candidate",
    description:
      "Build staged plugins and run all four verification gates (static/DAG/hot-swap, ablation, subgraph red-green & cloned-DB smoke, test diff disclosure).",
    parameters: {
      type: "object",
      properties: {
        pureVisualOrRefactor: {
          type: "boolean",
          description:
            "Set true only if the change is purely visual or internal refactor with no behavioral diff.",
        },
      },
    },
  },
  {
    name: "present_preview",
    description:
      "Mount an isolated preview session and present the Change Brief to the user. Only allowed when the latest verify_candidate passed and workspace hash has not drifted.",
    parameters: {
      type: "object",
      properties: {
        summary: { type: "string", description: "Short summary of the change" },
        highlights: {
          type: "array",
          items: { type: "string" },
          description: "Optional bullet highlights for the Change Brief",
        },
      },
      required: ["summary"],
    },
  },
];

export const ALLOWED_TOOL_NAMES = new Set<string>(
  EVOLUTION_TOOLS.map((t) => t.name),
);

export function executeInspectPlugin(
  release: CompositionRelease,
  run: EvolutionRunRecord,
  pluginId: string,
): Record<string, unknown> {
  if (!pluginId) {
    return { ok: false, error: "pluginId is required" };
  }
  const staged = run.stagedWorkspace.upserts[pluginId];
  if (staged) {
    return {
      ok: true,
      source: "staged",
      pluginId: staged.pluginId,
      name: staged.name,
      dependencies: staged.dependencies,
      contractTypes: staged.contractTypes,
      sourceFiles: staged.sourceFiles,
      testFiles: staged.testFiles,
    };
  }

  const baseComp = release.controlStore.getComposition(run.baseCompositionId);
  const member = baseComp?.members.find((m) => m.pluginId === pluginId);
  if (!member) {
    return { ok: false, error: `Plugin "${pluginId}" not found` };
  }
  const artifact = release.controlStore.getArtifact(
    member.pluginId,
    member.versionId,
  );
  if (!artifact) {
    return {
      ok: false,
      error: `Artifact for ${member.pluginId}@${member.versionId} not found`,
    };
  }
  return {
    ok: true,
    source: "active",
    pluginId: artifact.pluginId,
    versionId: artifact.versionId,
    name: artifact.name,
    enabled: member.enabled,
    dependencies: artifact.dependencies,
    contractTypes: artifact.contractTypes,
    sourceFiles: artifact.sourceFiles,
    testFiles: artifact.testFiles,
  };
}

export function executeStagePluginChanges(
  release: CompositionRelease,
  run: EvolutionRunRecord,
  args: Record<string, unknown>,
): {
  nextWorkspace: StagedWorkspaceState;
  response: Record<string, unknown>;
} {
  const nextUpserts: Record<string, StagedPluginPackage> = {
    ...run.stagedWorkspace.upserts,
  };
  const nextToggles: Record<string, boolean> = {
    ...run.stagedWorkspace.toggles,
  };

  const baselineArtifacts = new Map<string, PluginArtifact>();
  const baseline = release.controlStore.getComposition(run.baseCompositionId);
  if (baseline) {
    for (const member of baseline.members) {
      const artifact = release.controlStore.getArtifact(
        member.pluginId,
        member.versionId,
      );
      if (artifact) {
        baselineArtifacts.set(member.pluginId, artifact);
      }
    }
  }

  const stagedIds: string[] = [];
  if (Array.isArray(args.upserts)) {
    for (const raw of args.upserts) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const pluginId =
        typeof item.pluginId === "string" ? item.pluginId.trim() : "";
      if (!pluginId) continue;

      const existing = nextUpserts[pluginId];
      const baseArtifact = existing ? undefined : baselineArtifacts.get(pluginId);

      const name =
        typeof item.name === "string" && item.name.trim()
          ? item.name.trim()
          : existing?.name ?? baseArtifact?.name ?? pluginId;
      const dependencies = Array.isArray(item.dependencies)
        ? item.dependencies.filter((d): d is string => typeof d === "string")
        : existing?.dependencies ?? baseArtifact?.dependencies ?? [];
      const contractTypes =
        typeof item.contractTypes === "string"
          ? item.contractTypes
          : existing?.contractTypes ?? baseArtifact?.contractTypes ?? "";

      const sourceFiles: Record<string, string> = {
        ...(existing?.sourceFiles ?? baseArtifact?.sourceFiles ?? {}),
      };
      if (item.sourceFiles && typeof item.sourceFiles === "object") {
        for (const [k, v] of Object.entries(
          item.sourceFiles as Record<string, unknown>,
        )) {
          if (typeof v === "string") sourceFiles[k] = v;
        }
      }
      const testFiles: Record<string, string> = {
        ...(existing?.testFiles ?? baseArtifact?.testFiles ?? {}),
      };
      if (item.testFiles && typeof item.testFiles === "object") {
        for (const [k, v] of Object.entries(
          item.testFiles as Record<string, unknown>,
        )) {
          if (typeof v === "string") testFiles[k] = v;
        }
      }
      nextUpserts[pluginId] = {
        pluginId,
        name,
        dependencies,
        contractTypes,
        sourceFiles,
        testFiles,
      };
      stagedIds.push(pluginId);
    }
  }

  const toggledIds: string[] = [];
  if (Array.isArray(args.toggles)) {
    for (const raw of args.toggles) {
      if (!raw || typeof raw !== "object") continue;
      const item = raw as Record<string, unknown>;
      const pluginId =
        typeof item.pluginId === "string" ? item.pluginId.trim() : "";
      if (!pluginId || typeof item.enabled !== "boolean") continue;
      nextToggles[pluginId] = item.enabled;
      toggledIds.push(`${pluginId}=${item.enabled}`);
    }
  }

  if (stagedIds.length === 0 && toggledIds.length === 0) {
    return {
      nextWorkspace: run.stagedWorkspace,
      response: {
        ok: false,
        error:
          "stage_plugin_changes requires at least one valid entry in top-level `upserts` or `toggles` (do not wrap parameters inside an extra `arguments` object).",
        stagedPlugins: [],
        toggledPlugins: [],
      },
    };
  }

  const workspaceHash = computeWorkspaceHash(nextUpserts, nextToggles);
  const nextWorkspace: StagedWorkspaceState = {
    ...run.stagedWorkspace,
    upserts: nextUpserts,
    toggles: nextToggles,
    workspaceHash,
  };

  return {
    nextWorkspace,
    response: {
      ok: true,
      workspaceHash,
      stagedPlugins: stagedIds,
      toggledPlugins: toggledIds,
    },
  };
}

export async function executeVerifyCandidate(input: {
  readonly release: CompositionRelease;
  readonly run: EvolutionRunRecord;
  readonly pureVisualOrRefactor: boolean;
  readonly workspaceRoot?: string;
  readonly verifyFn: (input: VerifyCandidateInput) => Promise<VerificationReport>;
}): Promise<{
  nextWorkspace: StagedWorkspaceState;
  response: Record<string, unknown>;
  summaryMessage: string;
}> {
  const { release, run, pureVisualOrRefactor, workspaceRoot, verifyFn } = input;
  const baseline = release.controlStore.getComposition(run.baseCompositionId);
  if (!baseline) {
    return {
      nextWorkspace: run.stagedWorkspace,
      response: {
        ok: false,
        error: `Baseline composition ${run.baseCompositionId} not found`,
      },
      summaryMessage: "验证失败：找不到基线组合",
    };
  }

  const artifactsMap = new Map<string, PluginArtifact>();
  for (const a of release.controlStore.listArtifacts()) {
    artifactsMap.set(artifactKey(a.pluginId, a.versionId), a);
  }

  const contractByPluginId = new Map<string, string>();
  for (const m of baseline.members) {
    const a = artifactsMap.get(artifactKey(m.pluginId, m.versionId));
    if (a) contractByPluginId.set(m.pluginId, a.contractTypes);
  }
  for (const [pluginId, pkg] of Object.entries(run.stagedWorkspace.upserts)) {
    contractByPluginId.set(pluginId, pkg.contractTypes);
  }

  const builtArtifacts: PluginArtifact[] = [];
  for (const pkg of Object.values(run.stagedWorkspace.upserts)) {
    const upstreamContracts: Record<string, string> = {};
    for (const depId of pkg.dependencies) {
      const ct = contractByPluginId.get(depId);
      if (ct !== undefined) {
        upstreamContracts[depId] = ct;
      }
    }

    try {
      const artifact = await buildPluginPackage({
        pluginId: pkg.pluginId,
        name: pkg.name,
        dependencies: pkg.dependencies,
        contractTypes: pkg.contractTypes,
        ...(pkg.sourceFiles["server.ts"] !== undefined
          ? { serverSource: pkg.sourceFiles["server.ts"] }
          : {}),
        ...(pkg.sourceFiles["client.tsx"] !== undefined
          ? { clientSource: pkg.sourceFiles["client.tsx"] }
          : {}),
        sourceFiles: pkg.sourceFiles,
        testFiles: pkg.testFiles,
        upstreamContracts,
        ...(workspaceRoot ? { workspaceRoot } : {}),
      });
      builtArtifacts.push(artifact);
      artifactsMap.set(artifactKey(artifact.pluginId, artifact.versionId), artifact);
    } catch (error) {
      if (error instanceof PluginBuildError) {
        return {
          nextWorkspace: run.stagedWorkspace,
          response: {
            ok: false,
            stage: "build",
            pluginId: error.pluginId,
            diagnostics: error.diagnostics,
          },
          summaryMessage: `插件 ${error.pluginId} 构建/类型检查失败（${error.diagnostics.length} 条诊断）`,
        };
      }
      const message = error instanceof Error ? error.message : String(error);
      return {
        nextWorkspace: run.stagedWorkspace,
        response: {
          ok: false,
          stage: "build",
          pluginId: pkg.pluginId,
          error: message,
        },
        summaryMessage: `插件 ${pkg.pluginId} 构建失败：${message}`,
      };
    }
  }

  const memberMap = new Map<string, CompositionMember>();
  for (const m of baseline.members) {
    memberMap.set(m.pluginId, { ...m });
  }
  for (const artifact of builtArtifacts) {
    const prev = memberMap.get(artifact.pluginId);
    memberMap.set(artifact.pluginId, {
      pluginId: artifact.pluginId,
      versionId: artifact.versionId,
      enabled: prev ? prev.enabled : true,
    });
  }
  for (const [pluginId, enabled] of Object.entries(run.stagedWorkspace.toggles)) {
    const prev = memberMap.get(pluginId);
    if (prev) {
      memberMap.set(pluginId, { ...prev, enabled });
    }
  }

  const candidateComposition: CompositionSnapshot = {
    compositionId: `cand-comp-${randomUUID().slice(0, 8)}`,
    parentCompositionId: baseline.compositionId,
    members: [...memberMap.values()],
    createdAt: new Date().toISOString(),
  };

  const report = await verifyFn({
    baseline,
    candidate: candidateComposition,
    artifacts: artifactsMap,
    productionDbPath: release.businessDbPath,
    changeKind: pureVisualOrRefactor ? "visual-only" : "behavior",
  });

  if (!report.ok) {
    return {
      nextWorkspace: {
        ...run.stagedWorkspace,
        lastVerificationReport: report,
      },
      response: {
        ok: false,
        failedGate: report.failedGate,
        errors: report.errors,
        staticViolations: report.staticViolations,
        dagViolations: report.dagViolations,
        ablationResults: report.ablationResults,
        subgraphResults: report.subgraphResults,
        fullCompositionSmoke: report.fullCompositionSmoke,
      },
      summaryMessage: `验证未通过 (${report.failedGate ?? "unknown"})：${report.errors[0] ?? "详见诊断"}`,
    };
  }

  const nextWorkspace: StagedWorkspaceState = {
    ...run.stagedWorkspace,
    lastVerifiedHash: run.stagedWorkspace.workspaceHash,
    lastVerificationReport: report,
    lastBuiltArtifacts: builtArtifacts,
    lastCandidateComposition: candidateComposition,
  };

  return {
    nextWorkspace,
    response: {
      ok: true,
      workspaceHash: run.stagedWorkspace.workspaceHash,
      probedPlugins: report.probedPlugins,
      noBehaviorDiffWarning: Boolean(report.noBehaviorDiffWarning),
      testChangeDisclosures: report.testChangeDisclosures,
    },
    summaryMessage: "四道验证门禁全部通过，可调用 present_preview 挂载隔离预览",
  };
}
