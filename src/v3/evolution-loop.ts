import { createHash, randomUUID } from "node:crypto";
import {
  BudgetExhaustedError,
  BudgetScheduler,
} from "../evolution/budget.js";
import {
  type Driver,
  ModelTransportError,
  type ModelRequest,
} from "../evolution/driver.js";
import { transportTimeoutRetryable } from "../evolution/transport-failure.js";
import type {
  CompositionRelease,
  ReleaseTransitionResult,
} from "./composition-release.js";
import type {
  ChangeBrief,
  EvolutionBudgetLedger,
  EvolutionClarificationPrompt,
  EvolutionProgressEvent,
  EvolutionRunRecord,
  EvolutionRunStage,
  EvolutionRunStatus,
  StagedPluginPackage,
  StagedWorkspaceState,
} from "./control-store.js";
import {
  PluginBuildError,
  buildPluginPackage,
} from "./plugin-builder.js";
import {
  type VerificationReport,
  type VerifyCandidateInput,
  verifyCandidate,
} from "./plugin-verifier.js";
import type { PreviewSessionInfo } from "./preview-session.js";
import { artifactKey } from "./topology.js";
import type {
  CompositionMember,
  CompositionSnapshot,
  CompositionTopology,
  PluginArtifact,
} from "./types.js";

export type EvolutionToolName =
  | "inspect_plugin"
  | "clarify_request"
  | "stage_plugin_changes"
  | "verify_candidate"
  | "present_preview";

export interface EvolutionToolDefinition {
  readonly name: EvolutionToolName;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ModelDriverRequest {
  readonly system: string;
  readonly history: readonly unknown[];
  readonly tools: readonly EvolutionToolDefinition[];
}

export interface ModelDriverReply {
  readonly text?: string;
  readonly calls?: readonly ModelToolCall[];
  readonly protocolErrors?: readonly string[];
  readonly history?: readonly unknown[];
  readonly raw: unknown;
  readonly usage?: {
    readonly promptTokens?: number;
    readonly completionTokens?: number;
    readonly totalTokens?: number;
    readonly unknown?: boolean;
  };
}

export interface ModelDriver {
  generate(
    request: ModelDriverRequest,
    signal: AbortSignal,
  ): Promise<ModelDriverReply>;
}

export interface EvolutionBudgetConfig {
  readonly callLimit: number;
  readonly activeMsLimit: number;
}

export const DEFAULT_EVOLUTION_BUDGET: EvolutionBudgetConfig = {
  callLimit: 10,
  activeMsLimit: 180_000,
};

export const UNKNOWN_USAGE_CONSERVATIVE_TOKENS = 4096;

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

const ALLOWED_TOOL_NAMES = new Set<string>(EVOLUTION_TOOLS.map((t) => t.name));

export function createDeepSeekModelDriver(driver: Driver): ModelDriver {
  return {
    async generate(request, signal) {
      const modelReq: ModelRequest = {
        instruction: request.system,
        history: [...request.history],
        tools: request.tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        phase: "generation",
      };
      const reply = await driver.generate(modelReq, signal);
      const usageObj =
        reply.usage && typeof reply.usage === "object"
          ? (reply.usage as Record<string, unknown>)
          : null;
      const promptTokens =
        typeof usageObj?.promptTokens === "number"
          ? usageObj.promptTokens
          : typeof usageObj?.prompt_tokens === "number"
            ? usageObj.prompt_tokens
            : undefined;
      const completionTokens =
        typeof usageObj?.completionTokens === "number"
          ? usageObj.completionTokens
          : typeof usageObj?.completion_tokens === "number"
            ? usageObj.completion_tokens
            : undefined;
      const totalTokens =
        typeof usageObj?.totalTokens === "number"
          ? usageObj.totalTokens
          : typeof usageObj?.total_tokens === "number"
            ? usageObj.total_tokens
            : undefined;
      const usageUnknown =
        promptTokens === undefined &&
        completionTokens === undefined &&
        totalTokens === undefined;
      const normalizedCalls = reply.calls?.map((c, idx) => ({
        id: c.id ?? `call-${idx}-${randomUUID().slice(0, 8)}`,
        name: c.name,
        args: c.args,
      }));
      const missingCallId = Boolean(
        reply.calls?.some((c) => typeof c.id !== "string" || c.id.length === 0),
      );
      const lastHistoryEntry =
        Array.isArray(reply.history) && reply.history.length > 0
          ? reply.history[reply.history.length - 1]
          : undefined;
      const historyAssistantMsg =
        lastHistoryEntry &&
        typeof lastHistoryEntry === "object" &&
        !Array.isArray(lastHistoryEntry) &&
        (lastHistoryEntry as Record<string, unknown>).role === "assistant"
          ? (lastHistoryEntry as Record<string, unknown>)
          : null;
      const assistantMessage: Record<string, unknown> =
        historyAssistantMsg && !missingCallId
          ? historyAssistantMsg
          : {
              role: "assistant",
              content: reply.text ?? "",
              ...(!missingCallId && normalizedCalls && normalizedCalls.length > 0
                ? {
                    tool_calls: normalizedCalls.map((c) => ({
                      id: c.id,
                      type: "function",
                      function: {
                        name: c.name,
                        arguments: JSON.stringify(c.args ?? {}),
                      },
                    })),
                  }
                : {}),
            };
      return {
        text: reply.text,
        calls: normalizedCalls,
        ...(reply.protocolErrors && reply.protocolErrors.length > 0
          ? { protocolErrors: reply.protocolErrors }
          : {}),
        raw: assistantMessage,
        usage: {
          promptTokens,
          completionTokens,
          totalTokens,
          unknown: usageUnknown,
        },
      };
    },
  };
}

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
      installedPlugins: pluginSummaries,
      registeredSlots: [...slots].sort(),
      registeredEvents: [...events].sort(),
      userRequest: prompt,
    },
    null,
    2,
  );
}

export interface EvolutionRunView {
  readonly runId: string;
  readonly baseCompositionId: string;
  readonly status: EvolutionRunStatus;
  readonly stage: EvolutionRunStage;
  readonly prompt: string;
  readonly clarification: EvolutionClarificationPrompt | null;
  readonly budget: EvolutionBudgetLedger;
  readonly candidateId: string | null;
  readonly previewSessionId: string | null;
  readonly previewUrl: string | null;
  readonly changeBrief: ChangeBrief | null;
  readonly highlights: readonly string[];
  readonly events: readonly EvolutionProgressEvent[];
  readonly error: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toEvolutionRunView(run: EvolutionRunRecord): EvolutionRunView {
  return {
    runId: run.runId,
    baseCompositionId: run.baseCompositionId,
    status: run.status,
    stage: run.stage,
    prompt: run.prompt,
    clarification: run.clarification,
    budget: run.budget,
    candidateId: run.candidateId,
    previewSessionId: run.previewSessionId,
    previewUrl: run.previewUrl,
    changeBrief: run.changeBrief,
    highlights: run.highlights,
    events: run.events,
    error: run.error,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

export interface EvolutionStreamEvent {
  readonly type: "run_updated";
  readonly run: EvolutionRunView;
}

export class EvolutionError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "EvolutionError";
  }
}

export interface EvolutionLoopOptions {
  readonly release: CompositionRelease;
  readonly modelDriver: ModelDriver;
  readonly defaultBudget?: Partial<EvolutionBudgetConfig>;
  readonly workspaceRoot?: string;
  readonly verifyFn?: (
    input: VerifyCandidateInput,
  ) => Promise<VerificationReport>;
}

const SYSTEM_PROMPT = [
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
  "Plugin authoring surface (follow the seed plugins exactly):",
  "- server.ts: `export default class X extends Service` using `ctx.db` (ScopedDb; tables auto-namespaced as `plg_<pluginId>__*`), `ctx.http.route(method, subPath, handler)` (served at `/api/app/<pluginId><subPath>`), and `ctx.emit` / `ctx.on` for events; host helpers (`ScopedDb`, `dispatchServerBail`) come from `@host/server-sdk`.",
  "- client.tsx: `export function apply(ctx: Context)`; pages via `ctx.router.registerPage({ path, navLabel, component, order? })`; downstream UI via `ctx.slots.register(slotName, Component, { order? })` for slot names listed in the topology's registeredSlots; render upstream slots with `<Slot name=\"...\" props={...} />`.",
  "- Client imports come from `@host/client-sdk` (`Slot`, `useClientContext`, `useClientRoutes`, `useNavigate`, `dispatchClientBail`). The client services are `ctx.router` and `ctx.slots` (plural); `ctx.slot` does not exist.",
  "- Never ship diagnostic/probing constants (DIAG_*) or speculative multi-shape registration helpers inside plugin code; read the verification error and fix the API usage directly.",
  "Plugin contract tests (tests/*.spec.ts):",
  "- Export `default async function (ctx: PluginTestContext)` and drive assertions via HTTP `ctx.request({ method, path, body })` (and optionally `ctx.openBrowserPage` / `ctx.introspect`).",
  "- Mirror existing seed plugin tests (e.g. todo-core.spec.ts): assert status codes and response bodies; do NOT use Cordis `ctx.inject` / `ctx.get` / direct service property access inside tests.",
  "- Cross-plugin behavior must be verified through public HTTP APIs and UI, never by probing another plugin's internal service object.",
  "- Keep tests short and deterministic; do not add diagnostic-only endpoints solely to debug inject/get.",
].join("\n");

export class EvolutionLoop {
  private readonly release: CompositionRelease;
  private readonly modelDriver: ModelDriver;
  private readonly defaultBudget: EvolutionBudgetConfig;
  private readonly workspaceRoot?: string;
  private readonly verifyFn: (
    input: VerifyCandidateInput,
  ) => Promise<VerificationReport>;
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly activeLoops = new Map<string, Promise<EvolutionRunView>>();
  private readonly listeners = new Set<(event: EvolutionStreamEvent) => void>();

  constructor(options: EvolutionLoopOptions) {
    this.release = options.release;
    this.modelDriver = options.modelDriver;
    this.defaultBudget = {
      callLimit:
        options.defaultBudget?.callLimit ?? DEFAULT_EVOLUTION_BUDGET.callLimit,
      activeMsLimit:
        options.defaultBudget?.activeMsLimit ??
        DEFAULT_EVOLUTION_BUDGET.activeMsLimit,
    };
    this.workspaceRoot = options.workspaceRoot;
    this.verifyFn = options.verifyFn ?? verifyCandidate;
  }

  recoverOnStartup(): number {
    return this.release.controlStore.markRunningRunsInterrupted();
  }

  subscribe(listener: (event: EvolutionStreamEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  listRuns(): EvolutionRunView[] {
    return this.release.controlStore
      .listEvolutionRuns()
      .map(toEvolutionRunView);
  }

  getRun(runId: string): EvolutionRunView | undefined {
    const run = this.release.controlStore.getEvolutionRun(runId);
    return run ? toEvolutionRunView(run) : undefined;
  }

  async waitForRun(runId: string): Promise<EvolutionRunView> {
    const active = this.activeLoops.get(runId);
    if (active) {
      return await active;
    }
    const run = this.getRun(runId);
    if (!run) {
      throw new EvolutionError(`Run ${runId} not found`, 404, "RUN_NOT_FOUND");
    }
    return run;
  }

  async startRun(
    prompt: string,
    options?: { readonly budget?: Partial<EvolutionBudgetConfig> },
  ): Promise<EvolutionRunView> {
    const trimmed = prompt.trim();
    if (!trimmed) {
      throw new EvolutionError("需求内容不能为空", 400, "EMPTY_PROMPT");
    }

    const activeComp = this.release.controlStore.getActiveComposition();
    if (!activeComp) {
      throw new EvolutionError(
        "当前没有已激活的组合，无法启动自迭代",
        409,
        "NO_ACTIVE_COMPOSITION",
      );
    }

    const topology = await this.release.runtime.introspect();
    const artifactsMap = new Map<string, PluginArtifact>();
    for (const a of this.release.controlStore.listArtifacts()) {
      artifactsMap.set(artifactKey(a.pluginId, a.versionId), a);
    }

    const initialContext = buildInitialTopologyContext(
      topology,
      artifactsMap,
      trimmed,
    );

    const runId = `evo-${randomUUID().slice(0, 8)}`;
    const now = new Date().toISOString();
    const emptyHash = computeWorkspaceHash({}, {});
    const budget: EvolutionBudgetLedger = {
      callLimit: Math.max(
        1,
        options?.budget?.callLimit ?? this.defaultBudget.callLimit,
      ),
      callsUsed: 0,
      activeMsLimit: Math.max(
        100,
        options?.budget?.activeMsLimit ?? this.defaultBudget.activeMsLimit,
      ),
      activeMsUsed: 0,
      unknownUsageCount: 0,
      estimatedTokens: 0,
      exhaustedResource: null,
    };

    const run: EvolutionRunRecord = {
      runId,
      baseCompositionId: activeComp.compositionId,
      status: "running",
      stage: "queued",
      prompt: trimmed,
      messages: [
        {
          role: "user",
          content: initialContext,
        },
      ],
      stagedWorkspace: {
        upserts: {},
        toggles: {},
        workspaceHash: emptyHash,
        lastVerifiedHash: null,
        lastVerificationReport: null,
        lastBuiltArtifacts: [],
        lastCandidateComposition: null,
      },
      clarification: null,
      budget,
      candidateId: null,
      previewSessionId: null,
      previewUrl: null,
      changeBrief: null,
      highlights: [],
      events: [
        {
          seq: 1,
          timestamp: now,
          stage: "queued",
          message: "已接收需求，开始自迭代执行",
        },
      ],
      error: null,
      createdAt: now,
      updatedAt: now,
    };

    this.persistAndEmit(run);
    this.launchLoop(runId);
    return toEvolutionRunView(run);
  }

  async answerClarification(
    runId: string,
    answer: string,
  ): Promise<EvolutionRunView> {
    const trimmed = answer.trim();
    if (!trimmed) {
      throw new EvolutionError("澄清回答不能为空", 400, "EMPTY_ANSWER");
    }

    const run = this.requireRunRecord(runId);
    if (run.status !== "awaiting_clarification" || !run.clarification) {
      throw new EvolutionError(
        `Run ${runId} is not awaiting clarification (status=${run.status})`,
        409,
        "INVALID_STATE",
      );
    }

    const toolReceipt = {
      parts: [
        {
          functionResponse: {
            id: run.clarification.toolCallId,
            name: "clarify_request",
            response: { ok: true, answer: trimmed },
          },
        },
      ],
    };

    const updated = this.appendEvent(
      {
        ...run,
        status: "running",
        stage: "calling_model",
        clarification: null,
        messages: [...run.messages, toolReceipt],
      },
      "calling_model",
      `已收到用户澄清回答：${trimmed}`,
    );

    this.persistAndEmit(updated);
    this.launchLoop(runId);
    return toEvolutionRunView(updated);
  }

  async extendBudget(
    runId: string,
    input: {
      readonly additionalCalls?: number;
      readonly additionalActiveMs?: number;
    },
  ): Promise<EvolutionRunView> {
    const run = this.requireRunRecord(runId);
    if (run.status !== "awaiting_budget") {
      throw new EvolutionError(
        `Run ${runId} is not awaiting budget (status=${run.status})`,
        409,
        "INVALID_STATE",
      );
    }

    const addCalls = Math.max(0, Math.floor(input.additionalCalls ?? 0));
    const addMs = Math.max(0, Math.floor(input.additionalActiveMs ?? 0));
    if (addCalls === 0 && addMs === 0) {
      throw new EvolutionError(
        "必须追加至少 1 次调用额度或活动时间额度",
        400,
        "INVALID_BUDGET_EXTENSION",
      );
    }

    // Preserve historical callsUsed & activeMsUsed; only increase limits
    const nextBudget: EvolutionBudgetLedger = {
      ...run.budget,
      callLimit: run.budget.callLimit + addCalls,
      activeMsLimit: run.budget.activeMsLimit + addMs,
      exhaustedResource: null,
    };

    const updated = this.appendEvent(
      {
        ...run,
        status: "running",
        stage: "calling_model",
        budget: nextBudget,
        error: null,
      },
      "calling_model",
      `用户已追加预算（+${addCalls} 次调用，+${Math.round(addMs / 1000)}s 活动时间），继续当前运行`,
    );

    this.persistAndEmit(updated);
    this.launchLoop(runId);
    return toEvolutionRunView(updated);
  }

  async continueInPreview(
    runId: string,
    message: string,
  ): Promise<EvolutionRunView> {
    const trimmed = message.trim();
    if (!trimmed) {
      throw new EvolutionError("微调指令不能为空", 400, "EMPTY_MESSAGE");
    }

    const run = this.requireRunRecord(runId);
    if (run.status !== "preview_ready") {
      throw new EvolutionError(
        `Run ${runId} is not in preview_ready state (status=${run.status})`,
        409,
        "INVALID_STATE",
      );
    }

    const updated = this.appendEvent(
      {
        ...run,
        status: "running",
        stage: "calling_model",
        messages: [
          ...run.messages,
          {
            role: "user",
            content: `用户在隔离预览中继续提出微调需求：${trimmed}`,
          },
        ],
        error: null,
      },
      "calling_model",
      `预览内增量微调：${trimmed}`,
    );

    this.persistAndEmit(updated);
    this.launchLoop(runId);
    return toEvolutionRunView(updated);
  }

  async cancelRun(runId: string): Promise<EvolutionRunView> {
    const run = this.requireRunRecord(runId);
    if (
      run.status === "applied" ||
      run.status === "cancelled" ||
      run.status === "failed"
    ) {
      return toEvolutionRunView(run);
    }

    const controller = this.activeControllers.get(runId);
    if (controller) {
      controller.abort(new Error("用户已取消运行"));
    }

    const updated = this.appendEvent(
      {
        ...run,
        status: "cancelled",
        stage: "cancelled",
        clarification: null,
        error: "用户已取消运行",
      },
      "cancelled",
      "运行已取消",
    );
    this.persistAndEmit(updated);
    return toEvolutionRunView(updated);
  }

  async restorePreview(runId: string): Promise<PreviewSessionInfo> {
    const run = this.requireRunRecord(runId);
    if (run.status !== "preview_ready" || !run.candidateId) {
      throw new EvolutionError(
        `Run ${runId} does not have a restorable preview (status=${run.status})`,
        409,
        "PREVIEW_NOT_RESTORABLE",
      );
    }

    const existing = run.previewSessionId
      ? this.release.getPreviewSession(run.previewSessionId)
      : undefined;
    if (existing && existing.candidateId === run.candidateId) {
      return existing;
    }

    const session = await this.release.openPreview(run.candidateId);
    const updated = this.appendEvent(
      {
        ...run,
        previewSessionId: session.sessionId,
        previewUrl: session.previewUrl,
      },
      "preview_ready",
      `已从持久化产物恢复隔离预览会话 (${session.sessionId})`,
    );
    this.persistAndEmit(updated);
    return session;
  }

  async applyRun(runId: string): Promise<ReleaseTransitionResult> {
    const run = this.requireRunRecord(runId);
    if (run.status !== "preview_ready" || !run.candidateId) {
      throw new EvolutionError(
        `Run ${runId} is not ready to apply (status=${run.status})`,
        409,
        "RUN_NOT_READY_TO_APPLY",
      );
    }

    const result = await this.release.apply({
      candidateId: run.candidateId,
      expectedBaseCompositionId: run.baseCompositionId,
      deferPreviewCleanupMs: 500,
    });

    const updated = this.appendEvent(
      {
        ...run,
        status: "applied",
        stage: "applied",
        previewSessionId: null,
        previewUrl: null,
      },
      "applied",
      `候选 ${run.candidateId} 已确认应用到正式组合 (${result.composition.compositionId})`,
    );
    this.persistAndEmit(updated);
    return result;
  }

  async close(): Promise<void> {
    for (const controller of this.activeControllers.values()) {
      controller.abort(new Error("EvolutionLoop closing"));
    }
    this.activeControllers.clear();
    await Promise.allSettled([...this.activeLoops.values()]);
    this.activeLoops.clear();
  }

  private launchLoop(runId: string): void {
    const controller = new AbortController();
    this.activeControllers.set(runId, controller);

    const promise = this.executeLoop(runId, controller.signal).finally(() => {
      if (this.activeControllers.get(runId) === controller) {
        this.activeControllers.delete(runId);
      }
      if (this.activeLoops.get(runId) === promise) {
        this.activeLoops.delete(runId);
      }
    });

    this.activeLoops.set(runId, promise);
  }

  private async executeLoop(
    runId: string,
    signal: AbortSignal,
  ): Promise<EvolutionRunView> {
    while (true) {
      let run = this.release.controlStore.getEvolutionRun(runId);
      if (!run || run.status !== "running") {
        return run
          ? toEvolutionRunView(run)
          : (() => {
              throw new EvolutionError(`Run ${runId} not found`, 404, "RUN_NOT_FOUND");
            })();
      }

      if (signal.aborted) {
        return toEvolutionRunView(run);
      }

      // Check bounded budget via BudgetScheduler before invoking model
      const scheduler = new BudgetScheduler({
        calls: run.budget.callLimit,
        candidates: 1,
        milliseconds: run.budget.activeMsLimit,
      });
      const remainingMs = run.budget.activeMsLimit - run.budget.activeMsUsed;
      try {
        if (remainingMs <= 0) {
          throw new BudgetExhaustedError(
            `已达到 ${Math.round(run.budget.activeMsLimit / 1000)}s 活动时间上限`,
            "milliseconds",
            "generation",
          );
        }
        scheduler.admit(run.budget.callsUsed, "generation", remainingMs);
      } catch (error) {
        if (error instanceof BudgetExhaustedError) {
          const paused = this.appendEvent(
            {
              ...run,
              status: "awaiting_budget",
              stage: "awaiting_budget",
              budget: {
                ...run.budget,
                exhaustedResource:
                  error.resource === "milliseconds" ? "milliseconds" : "calls",
              },
              error: error.message,
            },
            "awaiting_budget",
            `预算耗尽暂停：${error.message}`,
          );
          this.persistAndEmit(paused);
          return toEvolutionRunView(paused);
        }
        throw error;
      }

      run = this.appendEvent(
        {
          ...run,
          stage: "calling_model",
        },
        "calling_model",
        `第 ${run.budget.callsUsed + 1}/${run.budget.callLimit} 次模型调用中`,
      );
      this.persistAndEmit(run);

      const callStarted = Date.now();
      let reply: ModelDriverReply;
      try {
        reply = await this.invokeModelWithTimeoutRetry(run, signal);
      } catch (error) {
        const latest = this.release.controlStore.getEvolutionRun(runId);
        if (signal.aborted || latest?.status === "cancelled") {
          return toEvolutionRunView(latest ?? run);
        }
        const elapsed = Date.now() - callStarted;
        const message =
          error instanceof Error ? error.message : String(error);
        const failed = this.appendEvent(
          {
            ...run,
            status: "failed",
            stage: "failed",
            budget: {
              ...run.budget,
              callsUsed: run.budget.callsUsed + 1,
              activeMsUsed: run.budget.activeMsUsed + elapsed,
            },
            error: message,
          },
          "failed",
          `模型调用失败：${message}`,
        );
        this.persistAndEmit(failed);
        return toEvolutionRunView(failed);
      }

      if (this.isCancelled(runId, signal)) {
        return toEvolutionRunView(
          this.release.controlStore.getEvolutionRun(runId) ?? run,
        );
      }

      const elapsed = Math.max(1, Date.now() - callStarted);
      const usageUnknown =
        !reply.usage ||
        reply.usage.unknown === true ||
        (reply.usage.totalTokens === undefined &&
          reply.usage.promptTokens === undefined &&
          reply.usage.completionTokens === undefined);
      const tokensDelta = usageUnknown
        ? UNKNOWN_USAGE_CONSERVATIVE_TOKENS
        : (reply.usage?.totalTokens ??
          (reply.usage?.promptTokens ?? 0) +
            (reply.usage?.completionTokens ?? 0));

      run = {
        ...run,
        messages: [...run.messages, reply.raw],
        budget: {
          ...run.budget,
          callsUsed: run.budget.callsUsed + 1,
          activeMsUsed: run.budget.activeMsUsed + elapsed,
          unknownUsageCount:
            run.budget.unknownUsageCount + (usageUnknown ? 1 : 0),
          estimatedTokens: run.budget.estimatedTokens + tokensDelta,
        },
        updatedAt: new Date().toISOString(),
      };
      this.persistAndEmit(run);

      const calls = reply.calls ?? [];
      if (reply.protocolErrors && reply.protocolErrors.length > 0) {
        const rawObj =
          reply.raw && typeof reply.raw === "object" && !Array.isArray(reply.raw)
            ? (reply.raw as Record<string, unknown>)
            : null;
        const rawHasToolCalls =
          Array.isArray(rawObj?.tool_calls) && rawObj.tool_calls.length > 0;
        const nextHistoryMessage =
          rawHasToolCalls && calls.length > 0
            ? {
                parts: calls.map((call) => ({
                  functionResponse: {
                    id: call.id,
                    name: call.name,
                    response: {
                      ok: false,
                      protocolErrors: reply.protocolErrors,
                      error: `协议或参数校验失败，未执行工具调用：${reply.protocolErrors!.join("；")}`,
                    },
                  },
                })),
              }
            : {
                role: "user",
                content: `上一轮模型响应存在协议错误（${reply.protocolErrors.join("；")}），未执行任何工具调用，请修正后重新调用工具。`,
              };
        run = this.appendEvent(
          {
            ...run,
            messages: [...run.messages, nextHistoryMessage],
          },
          "calling_model",
          `模型响应协议校验失败，已回喂修正：${reply.protocolErrors.join("；")}`,
        );
        this.persistAndEmit(run);
        continue;
      }

      if (calls.length === 0) {
        // Model returned plain text without tool calls; remind it to use tools
        run = this.appendEvent(
          {
            ...run,
            messages: [
              ...run.messages,
              {
                role: "user",
                content:
                  "请使用 5 项工具之一推进任务（inspect_plugin / clarify_request / stage_plugin_changes / verify_candidate / present_preview）。",
              },
            ],
          },
          "calling_model",
          "模型未调用工具，已提示继续使用工具推进",
        );
        this.persistAndEmit(run);
        continue;
      }

      const toolResponses: Array<{
        functionResponse: {
          id: string;
          name: string;
          response: Record<string, unknown>;
        };
      }> = [];

      let pausedOrCompleted = false;

      for (const call of calls) {
        if (signal.aborted) {
          return toEvolutionRunView(
            this.release.controlStore.getEvolutionRun(runId) ?? run,
          );
        }

        if (!ALLOWED_TOOL_NAMES.has(call.name)) {
          toolResponses.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                ok: false,
                error: `未授权工具 "${call.name}"。仅允许调用：${[...ALLOWED_TOOL_NAMES].join(", ")}`,
              },
            },
          });
          continue;
        }

        if (call.name === "clarify_request") {
          const question =
            typeof call.args.question === "string"
              ? call.args.question.trim()
              : "";
          const options = Array.isArray(call.args.options)
            ? call.args.options.filter(
                (o): o is string => typeof o === "string" && o.trim().length > 0,
              )
            : undefined;
          const clarification: EvolutionClarificationPrompt = {
            question: question || "请进一步明确本次需求的目标与预期行为",
            ...(options && options.length > 0 ? { options } : {}),
            toolCallId: call.id,
            askedAt: new Date().toISOString(),
          };
          run = this.appendEvent(
            {
              ...run,
              status: "awaiting_clarification",
              stage: "awaiting_clarification",
              clarification,
            },
            "awaiting_clarification",
            `等待用户澄清：${clarification.question}`,
          );
          this.persistAndEmit(run);
          pausedOrCompleted = true;
          break;
        }

        if (call.name === "inspect_plugin") {
          const pluginId =
            typeof call.args.pluginId === "string" ? call.args.pluginId : "";
          run = this.appendEvent(
            { ...run, stage: "inspecting_plugin" },
            "inspecting_plugin",
            `读取插件源码与测试：${pluginId}`,
          );
          this.persistAndEmit(run);
          const result = this.handleInspectPlugin(run, pluginId);
          toolResponses.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: result,
            },
          });
          continue;
        }

        if (call.name === "stage_plugin_changes") {
          run = this.appendEvent(
            { ...run, stage: "staging_changes" },
            "staging_changes",
            "正在向沙箱工作区写入插件变更",
          );
          this.persistAndEmit(run);
          const { nextWorkspace, response } = this.handleStagePluginChanges(
            run,
            call.args,
          );
          run = {
            ...run,
            stagedWorkspace: nextWorkspace,
            updatedAt: new Date().toISOString(),
          };
          this.persistAndEmit(run);
          toolResponses.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response,
            },
          });
          continue;
        }

        if (call.name === "verify_candidate") {
          run = this.appendEvent(
            { ...run, stage: "verifying_candidate" },
            "verifying_candidate",
            "正在执行构建与四道验证门禁",
          );
          this.persistAndEmit(run);
          const pureVisualOrRefactor = Boolean(call.args.pureVisualOrRefactor);
          const { nextWorkspace, response, summaryMessage } =
            await this.handleVerifyCandidate(run, pureVisualOrRefactor);
          if (this.isCancelled(runId, signal)) {
            return toEvolutionRunView(
              this.release.controlStore.getEvolutionRun(runId) ?? run,
            );
          }
          run = this.appendEvent(
            {
              ...run,
              stagedWorkspace: nextWorkspace,
            },
            "verifying_candidate",
            summaryMessage,
          );
          this.persistAndEmit(run);
          toolResponses.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response,
            },
          });
          continue;
        }

        if (call.name === "present_preview") {
          const summary =
            typeof call.args.summary === "string"
              ? call.args.summary.trim()
              : "";
          const highlights = Array.isArray(call.args.highlights)
            ? call.args.highlights.filter(
                (h): h is string => typeof h === "string" && h.trim().length > 0,
              )
            : [];

          const ws = run.stagedWorkspace;
          if (
            !ws.lastVerifiedHash ||
            ws.lastVerifiedHash !== ws.workspaceHash ||
            !ws.lastVerificationReport?.ok ||
            !ws.lastCandidateComposition
          ) {
            const rejectMsg =
              "拒绝进入预览：最近一次 verify_candidate 未通过，或工作区存在未验证的脏改动，请先重新通过 verify_candidate。";
            run = this.appendEvent(
              run,
              run.stage,
              `已拦截未经验证的 present_preview 调用`,
            );
            this.persistAndEmit(run);
            toolResponses.push({
              functionResponse: {
                id: call.id,
                name: call.name,
                response: { ok: false, error: rejectMsg },
              },
            });
            continue;
          }

          run = this.appendEvent(
            { ...run, stage: "opening_preview" },
            "opening_preview",
            "门禁全绿，正在挂载隔离预览会话",
          );
          this.persistAndEmit(run);

          const receipt = this.release.registerVerifiedCandidate({
            baseCompositionId: run.baseCompositionId,
            candidateComposition: ws.lastCandidateComposition,
            artifacts: ws.lastBuiltArtifacts ?? [],
            verificationReport: ws.lastVerificationReport,
            summary: summary || undefined,
          });

          const session = await this.release.refreshOrOpenPreview(
            run.previewSessionId,
            receipt.candidateId,
          );
          if (this.isCancelled(runId, signal)) {
            if (!run.previewSessionId) {
              await this.release.closePreview(session.sessionId).catch(() => {});
            }
            return toEvolutionRunView(
              this.release.controlStore.getEvolutionRun(runId) ?? run,
            );
          }

          toolResponses.push({
            functionResponse: {
              id: call.id,
              name: call.name,
              response: {
                ok: true,
                candidateId: receipt.candidateId,
                previewSessionId: session.sessionId,
                previewUrl: session.previewUrl,
              },
            },
          });

          run = this.appendEvent(
            {
              ...run,
              status: "preview_ready",
              stage: "preview_ready",
              candidateId: receipt.candidateId,
              previewSessionId: session.sessionId,
              previewUrl: session.previewUrl,
              changeBrief: receipt.changeBrief,
              highlights,
              messages: [...run.messages, { parts: toolResponses }],
            },
            "preview_ready",
            `隔离预览已就绪 (${session.sessionId})：${receipt.changeBrief.summary}`,
          );
          this.persistAndEmit(run);
          pausedOrCompleted = true;
          break;
        }
      }

      if (pausedOrCompleted) {
        return toEvolutionRunView(run);
      }

      if (toolResponses.length > 0) {
        run = {
          ...run,
          messages: [...run.messages, { parts: toolResponses }],
          updatedAt: new Date().toISOString(),
        };
        this.persistAndEmit(run);
      }
    }
  }

  private async invokeModelWithTimeoutRetry(
    run: EvolutionRunRecord,
    signal: AbortSignal,
  ): Promise<ModelDriverReply> {
    let attempt = 0;
    while (true) {
      try {
        return await this.modelDriver.generate(
          {
            system: SYSTEM_PROMPT,
            history: run.messages,
            tools: EVOLUTION_TOOLS,
          },
          signal,
        );
      } catch (error) {
        if (
          error instanceof ModelTransportError &&
          transportTimeoutRetryable({
            kind: error.transport.failure?.kind,
            attempt,
            calls: run.budget.callsUsed + 1,
            callLimit: run.budget.callLimit,
          })
        ) {
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
  }

  private handleInspectPlugin(
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

    const baseComp = this.release.controlStore.getComposition(
      run.baseCompositionId,
    );
    const member = baseComp?.members.find((m) => m.pluginId === pluginId);
    if (!member) {
      return { ok: false, error: `Plugin "${pluginId}" not found` };
    }
    const artifact = this.release.controlStore.getArtifact(
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

  private handleStagePluginChanges(
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
    const baseline = this.release.controlStore.getComposition(
      run.baseCompositionId,
    );
    if (baseline) {
      for (const member of baseline.members) {
        const artifact = this.release.controlStore.getArtifact(
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

  private async handleVerifyCandidate(
    run: EvolutionRunRecord,
    pureVisualOrRefactor: boolean,
  ): Promise<{
    nextWorkspace: StagedWorkspaceState;
    response: Record<string, unknown>;
    summaryMessage: string;
  }> {
    const baseline = this.release.controlStore.getComposition(
      run.baseCompositionId,
    );
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
    for (const a of this.release.controlStore.listArtifacts()) {
      artifactsMap.set(artifactKey(a.pluginId, a.versionId), a);
    }

    // Collect contractTypes by pluginId (staged overrides baseline)
    const contractByPluginId = new Map<string, string>();
    for (const m of baseline.members) {
      const a = artifactsMap.get(artifactKey(m.pluginId, m.versionId));
      if (a) contractByPluginId.set(m.pluginId, a.contractTypes);
    }
    for (const [pluginId, pkg] of Object.entries(run.stagedWorkspace.upserts)) {
      contractByPluginId.set(pluginId, pkg.contractTypes);
    }

    // Build all staged plugin packages
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
          ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
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
        const message =
          error instanceof Error ? error.message : String(error);
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

    // Assemble candidate composition
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
    for (const [pluginId, enabled] of Object.entries(
      run.stagedWorkspace.toggles,
    )) {
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

    const report = await this.verifyFn({
      baseline,
      candidate: candidateComposition,
      artifacts: artifactsMap,
      productionDbPath: this.release.businessDbPath,
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

  private isCancelled(runId: string, signal: AbortSignal): boolean {
    if (signal.aborted) return true;
    return this.release.controlStore.getEvolutionRun(runId)?.status === "cancelled";
  }

  private requireRunRecord(runId: string): EvolutionRunRecord {
    const run = this.release.controlStore.getEvolutionRun(runId);
    if (!run) {
      throw new EvolutionError(`Run ${runId} not found`, 404, "RUN_NOT_FOUND");
    }
    return run;
  }

  private appendEvent(
    run: EvolutionRunRecord,
    stage: EvolutionRunStage,
    message: string,
    detail?: string,
  ): EvolutionRunRecord {
    const now = new Date().toISOString();
    const nextEvent: EvolutionProgressEvent = {
      seq: run.events.length + 1,
      timestamp: now,
      stage,
      message,
      ...(detail ? { detail } : {}),
    };
    return {
      ...run,
      events: [...run.events, nextEvent],
      updatedAt: now,
    };
  }

  private persistAndEmit(run: EvolutionRunRecord): void {
    this.release.controlStore.saveEvolutionRun(run);
    const view = toEvolutionRunView(run);
    for (const listener of this.listeners) {
      try {
        listener({ type: "run_updated", run: view });
      } catch {
        // Ignore broken SSE listener
      }
    }
  }
}
