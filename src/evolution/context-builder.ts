import { createHash } from "node:crypto";
import type { StagedPluginPackage } from "../release/control-store.js";
import { HOST_SDK_CONTRACTS } from "../contracts/host-sdk-reference.js";
import { artifactKey } from "../contracts/topology.js";
import type { CompositionTopology, PluginArtifact } from "../contracts/types.js";

export { HOST_SDK_CONTRACTS };

export const SYSTEM_PROMPT = [
  "You are the self-iteration agent for a Cordis full-stack plugin application.",
  "You are given the live composition topology, installed plugins, their contract.d.ts declarations, registered slots/events, and the user's request.",
  "Available tools (strictly 5): inspect_plugin, clarify_request, stage_plugin_changes, verify_candidate, present_preview.",
  "Rules:",
  "- When the user's intent is clear, proceed directly to inspect/stage/verify without asking for pre-execution confirmation.",
  "- Use clarify_request ONLY for major business goal ambiguity or destructive data intent.",
  "- `stage_plugin_changes` incrementally merges fields/files into any already-staged or baseline plugin package for the same `pluginId`. Stage changes in small batches (per plugin or per file) to avoid oversized JSON payloads, and always pass top-level `upserts` or `toggles`.",
  "- After stage_plugin_changes succeeds, immediately call verify_candidate and get ok=true before calling present_preview; do not blindly rewrite unchanged files.",
  "- If verify_candidate fails, read the real build/test diagnostics, fix the staged plugin code, and re-verify.",
  "- You cannot modify host budget, verification gates, or execution policy.",
  "- Follow the exact Host SDK `.d.ts` declarations provided in `hostSdkContracts` of the initial context (e.g. `ctx.router.registerPage`, `ctx.slots.register`, `ctx.http.route`, `ctx.db`, `ctx.schedule`). Never ship speculative runtime probing or `DIAG_*` constants in plugin code.",
  "Plugin contract tests (tests/*.spec.ts):",
  "- Export `default async function (ctx: PluginTestContext)` and drive assertions via HTTP `ctx.request({ method, path, body })` (and optionally `ctx.openBrowserPage` / `ctx.introspect`).",
  "- Mirror existing plugin tests in the active composition: assert status codes and response bodies; do NOT use Cordis `ctx.inject` / `ctx.get` / direct service property access inside tests.",
  "- Cross-plugin behavior must be verified through public HTTP APIs and UI, never by probing another plugin's internal service object.",
  "- Keep tests short and deterministic; do not add diagnostic-only endpoints solely to debug inject/get.",
].join("\n");

export function computeWorkspaceHash(
  upserts: Readonly<Record<string, StagedPluginPackage>>,
  toggles: Readonly<Record<string, boolean>>,
): string {
  const sortedUpserts: Record<string, unknown> = {};
  for (const key of Object.keys(upserts).sort()) {
    const pkg = upserts[key]!;
    const sortedSources: Record<string, string> = {};
    for (const f of Object.keys(pkg.sourceFiles).sort()) {
      sortedSources[f] = pkg.sourceFiles[f]!;
    }
    const sortedTests: Record<string, string> = {};
    for (const f of Object.keys(pkg.testFiles).sort()) {
      sortedTests[f] = pkg.testFiles[f]!;
    }
    sortedUpserts[key] = {
      pluginId: pkg.pluginId,
      name: pkg.name,
      dependencies: [...pkg.dependencies],
      contractTypes: pkg.contractTypes,
      sourceFiles: sortedSources,
      testFiles: sortedTests,
    };
  }
  const sortedToggles: Record<string, boolean> = {};
  for (const key of Object.keys(toggles).sort()) {
    sortedToggles[key] = toggles[key]!;
  }
  return createHash("sha256")
    .update(JSON.stringify({ upserts: sortedUpserts, toggles: sortedToggles }))
    .digest("hex");
}

function extractDeclaredSymbols(contractTypes: string): {
  slots: string[];
  events: string[];
} {
  const slots: string[] = [];
  const events: string[] = [];
  if (!contractTypes) return { slots, events };

  const slotBlockMatch = contractTypes.match(
    /interface\s+SlotPropsMap\s*\{([\s\S]*?)\}/,
  );
  if (slotBlockMatch?.[1]) {
    for (const m of slotBlockMatch[1].matchAll(/["']([^"']+)["']\s*:/g)) {
      if (m[1]) slots.push(m[1]);
    }
  }

  const eventBlockMatch = contractTypes.match(
    /interface\s+Events\s*\{([\s\S]*?)\}/,
  );
  if (eventBlockMatch?.[1]) {
    for (const m of eventBlockMatch[1].matchAll(/["']([^"']+)["']\s*\(/g)) {
      if (m[1]) events.push(m[1]);
    }
  }

  return { slots, events };
}

export function buildInitialTopologyContext(
  topology: CompositionTopology,
  artifacts: ReadonlyMap<string, PluginArtifact>,
  prompt: string,
): string {
  const slots = new Set<string>();
  const events = new Set<string>();
  const pluginSummaries = topology.plugins.map((p) => {
    const artifact = artifacts.get(artifactKey(p.pluginId, p.versionId));
    const contractTypes = p.contractTypes || artifact?.contractTypes || "";
    const declared = extractDeclaredSymbols(contractTypes);
    for (const s of declared.slots) slots.add(s);
    for (const e of declared.events) events.add(e);
    return {
      pluginId: p.pluginId,
      versionId: p.versionId,
      enabled: p.enabled,
      state: p.state,
      dependencies: p.dependencies,
      providedServices: p.providedServices,
      routes: p.routes,
      contractTypes,
    };
  });

  return JSON.stringify(
    {
      compositionId: topology.compositionId,
      hostSdkContracts: HOST_SDK_CONTRACTS,
      installedPlugins: pluginSummaries,
      registeredSlots: [...slots].sort(),
      registeredEvents: [...events].sort(),
      userRequest: prompt,
    },
    null,
    2,
  );
}
