import { randomUUID } from "node:crypto";
import {
  BudgetExhaustedError,
  assertRunBudgetAvailable,
} from "./budget.js";
import {
  ModelTransportError,
  type EvolutionToolDefinition,
  type EvolutionToolName,
  type ModelDriver,
  type ModelDriverReply,
  type ModelDriverRequest,
  type ModelToolCall,
} from "./model/types.js";
import { transportTimeoutRetryable } from "./model/transport-failure.js";
import type {
  CompositionRelease,
  ReleaseTransitionResult,
} from "../release/composition-release.js";
import type {
  ChangeBrief,
  EvolutionBudgetLedger,
  EvolutionClarificationPrompt,
  EvolutionProgressEvent,
  EvolutionRunRecord,
  EvolutionRunStage,
  EvolutionRunStatus,
} from "../release/control-store.js";
import {
  HOST_SDK_CONTRACTS,
  SYSTEM_PROMPT,
  buildInitialTopologyContext,
  computeWorkspaceHash,
} from "./context-builder.js";
import {
  ALLOWED_TOOL_NAMES,
  EVOLUTION_TOOLS,
  executeInspectPlugin,
  executeStagePluginChanges,
  executeVerifyCandidate,
} from "./tools.js";
import {
  type VerificationReport,
  type VerifyCandidateInput,
  verifyCandidate,
} from "../verify/index.js";
import type { PreviewSessionInfo } from "../release/preview-session.js";
import { artifactKey } from "../contracts/topology.js";
import type { PluginArtifact } from "../contracts/types.js";

export type {
  EvolutionToolDefinition,
  EvolutionToolName,
  ModelDriver,
  ModelDriverReply,
  ModelDriverRequest,
  ModelToolCall,
};
export {
  EVOLUTION_TOOLS,
  HOST_SDK_CONTRACTS,
  buildInitialTopologyContext,
  computeWorkspaceHash,
};

export interface EvolutionBudgetConfig {
  readonly callLimit: number;
  readonly activeMsLimit: number;
}

export const DEFAULT_EVOLUTION_BUDGET: EvolutionBudgetConfig = {
  callLimit: 10,
  activeMsLimit: 180_000,
};

export const UNKNOWN_USAGE_CONSERVATIVE_TOKENS = 4096;

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
    if (active) return await active;
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
      messages: [{ role: "user", content: initialContext }],
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

    if (run.previewSessionId) {
      try {
        await this.release.closePreview(run.previewSessionId);
      } catch {
        // Ignore already-closed preview session errors
      }
    }

    const updated = this.appendEvent(
      {
        ...run,
        status: "cancelled",
        stage: "cancelled",
        clarification: null,
        previewSessionId: null,
        previewUrl: null,
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
        if (run) return toEvolutionRunView(run);
        throw new EvolutionError(`Run ${runId} not found`, 404, "RUN_NOT_FOUND");
      }

      if (signal.aborted) {
        return toEvolutionRunView(run);
      }

      try {
        assertRunBudgetAvailable(run.budget);
      } catch (error) {
        if (error instanceof BudgetExhaustedError) {
          const paused = this.appendEvent(
            {
              ...run,
              status: "awaiting_budget",
              stage: "awaiting_budget",
              budget: {
                ...run.budget,
                exhaustedResource: error.resource,
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
        { ...run, stage: "calling_model" },
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
        const message = error instanceof Error ? error.message : String(error);
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
          { ...run, messages: [...run.messages, nextHistoryMessage] },
          "calling_model",
          `模型响应协议校验失败，已回喂修正：${reply.protocolErrors.join("；")}`,
        );
        this.persistAndEmit(run);
        continue;
      }

      if (calls.length === 0) {
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

      const turnResult = await this.dispatchToolTurn(run, calls, signal);
      if (turnResult.done) {
        return turnResult.view;
      }
      run = turnResult.run;
    }
  }

  private async dispatchToolTurn(
    initialRun: EvolutionRunRecord,
    calls: readonly ModelToolCall[],
    signal: AbortSignal,
  ): Promise<
    | { readonly done: true; readonly view: EvolutionRunView }
    | { readonly done: false; readonly run: EvolutionRunRecord }
  > {
    let run = initialRun;
    const toolResponses: Array<{
      functionResponse: {
        id: string;
        name: string;
        response: Record<string, unknown>;
      };
    }> = [];

    for (const call of calls) {
      if (signal.aborted) {
        return {
          done: true,
          view: toEvolutionRunView(
            this.release.controlStore.getEvolutionRun(run.runId) ?? run,
          ),
        };
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
        const callIndex = calls.indexOf(call);
        const skippedResponses = calls.slice(callIndex + 1).map((skipped) => ({
          functionResponse: {
            id: skipped.id,
            name: skipped.name,
            response: {
              ok: false,
              skipped: true,
              reason: "paused_for_clarification",
            },
          },
        }));
        const pendingSiblingResponses = [...toolResponses, ...skippedResponses];
        const messagesWithSiblings =
          pendingSiblingResponses.length > 0
            ? [...run.messages, { role: "user", parts: pendingSiblingResponses }]
            : run.messages;
        run = this.appendEvent(
          {
            ...run,
            status: "awaiting_clarification",
            stage: "awaiting_clarification",
            clarification,
            messages: messagesWithSiblings,
          },
          "awaiting_clarification",
          `等待用户澄清：${clarification.question}`,
        );
        this.persistAndEmit(run);
        return { done: true, view: toEvolutionRunView(run) };
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
        const result = executeInspectPlugin(this.release, run, pluginId);
        toolResponses.push({
          functionResponse: { id: call.id, name: call.name, response: result },
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
        const { nextWorkspace, response } = executeStagePluginChanges(
          this.release,
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
          functionResponse: { id: call.id, name: call.name, response },
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
        const { nextWorkspace, response, summaryMessage } =
          await executeVerifyCandidate({
            release: this.release,
            run,
            pureVisualOrRefactor: Boolean(call.args.pureVisualOrRefactor),
            workspaceRoot: this.workspaceRoot,
            verifyFn: this.verifyFn,
          });
        if (this.isCancelled(run.runId, signal)) {
          return {
            done: true,
            view: toEvolutionRunView(
              this.release.controlStore.getEvolutionRun(run.runId) ?? run,
            ),
          };
        }
        run = this.appendEvent(
          { ...run, stagedWorkspace: nextWorkspace },
          "verifying_candidate",
          summaryMessage,
        );
        this.persistAndEmit(run);
        toolResponses.push({
          functionResponse: { id: call.id, name: call.name, response },
        });
        continue;
      }

      if (call.name === "present_preview") {
        const summary =
          typeof call.args.summary === "string" ? call.args.summary.trim() : "";
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
            "已拦截未经验证的 present_preview 调用",
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
        if (this.isCancelled(run.runId, signal)) {
          if (!run.previewSessionId) {
            await this.release.closePreview(session.sessionId).catch(() => {});
          }
          return {
            done: true,
            view: toEvolutionRunView(
              this.release.controlStore.getEvolutionRun(run.runId) ?? run,
            ),
          };
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
        return { done: true, view: toEvolutionRunView(run) };
      }
    }

    if (toolResponses.length > 0) {
      run = {
        ...run,
        messages: [...run.messages, { parts: toolResponses }],
        updatedAt: new Date().toISOString(),
      };
      this.persistAndEmit(run);
    }

    return { done: false, run };
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

  private isCancelled(runId: string, signal: AbortSignal): boolean {
    if (signal.aborted) return true;
    return (
      this.release.controlStore.getEvolutionRun(runId)?.status === "cancelled"
    );
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
