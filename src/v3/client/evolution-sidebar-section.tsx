import { useCallback, useEffect, useState } from "react";
import { Button } from "@base-ui/react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  MessageSquare,
  PlusCircle,
  Send,
  Sparkles,
  Square,
} from "lucide-react";
import type { EvolutionRunView } from "../evolution-loop.js";

const STAGE_LABELS: Record<string, string> = {
  queued: "已排队",
  calling_model: "模型推理中",
  inspecting_plugin: "读取插件源码",
  staging_changes: "写入沙箱变更",
  verifying_candidate: "构建与四道门禁验证中",
  opening_preview: "挂载隔离预览中",
  awaiting_clarification: "等待需求澄清",
  awaiting_budget: "预算耗尽暂停",
  preview_ready: "隔离预览就绪",
  applied: "已确认应用",
  cancelled: "已取消",
  interrupted: "重启中断（未自动续调）",
  failed: "执行失败",
};

interface EvolutionSidebarSectionProps {
  readonly onApplied?: () => void;
  readonly productionUrl?: string;
}

export function EvolutionSidebarSection({
  onApplied,
  productionUrl,
}: EvolutionSidebarSectionProps) {
  const [runs, setRuns] = useState<EvolutionRunView[]>([]);
  const [promptInput, setPromptInput] = useState("");
  const [clarifyInput, setClarifyInput] = useState("");
  const [refineInput, setRefineInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upsertRun = useCallback((incoming: EvolutionRunView) => {
    setRuns((prev) => {
      const idx = prev.findIndex((r) => r.runId === incoming.runId);
      if (idx === -1) return [incoming, ...prev];
      const existing = prev[idx]!;
      if (incoming.events.length < existing.events.length) {
        return prev;
      }
      const next = [...prev];
      next[idx] = incoming;
      return next;
    });
  }, []);

  const fetchRuns = useCallback(async () => {
    try {
      const res = await fetch("/api/v3/evolution/runs", {
        headers: { accept: "application/json" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as { runs?: EvolutionRunView[] };
      if (Array.isArray(data.runs)) {
        setRuns(data.runs);
      }
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    void fetchRuns();
    const es = new EventSource("/api/v3/evolution/events");
    es.addEventListener("snapshot", (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data) as {
          runs?: EvolutionRunView[];
        };
        if (Array.isArray(data.runs)) {
          setRuns(data.runs);
        }
      } catch {
        // ignore
      }
    });
    es.addEventListener("run_updated", (ev) => {
      try {
        const run = JSON.parse((ev as MessageEvent).data) as EvolutionRunView;
        upsertRun(run);
      } catch {
        // ignore
      }
    });
    return () => {
      es.close();
    };
  }, [fetchRuns, upsertRun]);

  const activeRun = runs[0] ?? null;
  const hidePromptEditor =
    activeRun?.status === "running" || activeRun?.status === "awaiting_budget";

  const postEvolution = async <T extends { error?: string }>(
    url: string,
    body: Record<string, unknown> | undefined,
    fallbackError: string,
    onSuccess: (data: T) => void,
  ) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(url, {
        method: "POST",
        ...(body
          ? {
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            }
          : {}),
      });
      const data = (await res.json()) as T;
      if (!res.ok) {
        setError(data.error ?? `${fallbackError} (${res.status})`);
        return;
      }
      onSuccess(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleStartRun = () => {
    const trimmed = promptInput.trim();
    if (!trimmed) return;
    void postEvolution<{ run?: EvolutionRunView; error?: string }>(
      "/api/v3/evolution/runs",
      { prompt: trimmed },
      "启动自迭代失败",
      (data) => {
        if (!data.run) return;
        setPromptInput("");
        upsertRun(data.run);
      },
    );
  };

  const handleAnswerClarification = (runId: string, answer: string) => {
    const trimmed = answer.trim();
    if (!trimmed) return;
    void postEvolution<{ run?: EvolutionRunView; error?: string }>(
      `/api/v3/evolution/runs/${encodeURIComponent(runId)}/clarify`,
      { answer: trimmed },
      "提交澄清失败",
      (data) => {
        if (!data.run) return;
        setClarifyInput("");
        upsertRun(data.run);
      },
    );
  };

  const handleExtendBudget = (runId: string) => {
    void postEvolution<{ run?: EvolutionRunView; error?: string }>(
      `/api/v3/evolution/runs/${encodeURIComponent(runId)}/budget`,
      { additionalCalls: 5, additionalActiveMs: 120_000 },
      "追加预算失败",
      (data) => {
        if (data.run) upsertRun(data.run);
      },
    );
  };

  const handleContinueInPreview = (runId: string) => {
    const trimmed = refineInput.trim();
    if (!trimmed) return;
    void postEvolution<{ run?: EvolutionRunView; error?: string }>(
      `/api/v3/evolution/runs/${encodeURIComponent(runId)}/continue`,
      { message: trimmed },
      "提交微调失败",
      (data) => {
        if (!data.run) return;
        setRefineInput("");
        upsertRun(data.run);
      },
    );
  };

  const handleCancel = (runId: string) => {
    void postEvolution<{ run?: EvolutionRunView; error?: string }>(
      `/api/v3/evolution/runs/${encodeURIComponent(runId)}/cancel`,
      undefined,
      "取消失败",
      (data) => {
        if (data.run) upsertRun(data.run);
      },
    );
  };

  const handleRestorePreview = (runId: string) => {
    void postEvolution<{ session?: { previewUrl: string }; error?: string }>(
      `/api/v3/evolution/runs/${encodeURIComponent(runId)}/restore-preview`,
      undefined,
      "打开预览失败",
      (data) => {
        if (data.session) {
          window.location.href = data.session.previewUrl;
        }
      },
    );
  };

  const handleApplyRun = (runId: string) => {
    void postEvolution<{ error?: string }>(
      `/api/v3/evolution/runs/${encodeURIComponent(runId)}/apply`,
      undefined,
      "确认应用失败",
      () => {
        onApplied?.();
        if (productionUrl) {
          window.location.href = productionUrl;
        }
      },
    );
  };

  return (
    <section data-evolution-panel="true" className="space-y-3">
      <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
        <Sparkles className="size-3.5 text-accent" aria-hidden="true" />
        <span>自迭代 Agent</span>
      </div>

      {error && (
        <div
          data-evolution-error="true"
          className="rounded-lg border border-danger/30 bg-danger/5 p-2 text-danger"
        >
          {error}
        </div>
      )}

      {!hidePromptEditor && (
        <div className="space-y-2 rounded-lg border border-line bg-canvas p-2.5">
          <textarea
            data-evolution-prompt-input="true"
            value={promptInput}
            onChange={(e) => setPromptInput(e.target.value)}
            placeholder="用自然语言描述你想改进或新增的功能..."
            rows={2}
            className="w-full resize-none rounded-md border border-line bg-surface px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent"
          />
          <div className="flex justify-end">
            <Button
              type="button"
              data-evolution-submit-btn="true"
              disabled={busy || !promptInput.trim()}
              onClick={handleStartRun}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              <Send className="size-3" aria-hidden="true" />
              <span>提交需求</span>
            </Button>
          </div>
        </div>
      )}

      {activeRun && (
        <div
          data-evolution-run={activeRun.runId}
          data-evolution-status={activeRun.status}
          data-evolution-stage={activeRun.stage}
          className="space-y-2.5 rounded-lg border border-line bg-canvas p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[11px] text-muted">
              {activeRun.runId}
            </span>
            <span
              data-evolution-stage-label="true"
              className="rounded-full border border-line bg-surface px-2 py-0.5 text-[11px] font-medium text-ink"
            >
              {STAGE_LABELS[activeRun.stage] ?? activeRun.stage}
            </span>
          </div>

          <div className="text-ink">{activeRun.prompt}</div>

          <div
            data-evolution-budget="true"
            className="flex items-center justify-between text-[11px] text-muted"
          >
            <span>
              模型调用：{activeRun.budget.callsUsed} /{" "}
              {activeRun.budget.callLimit}
            </span>
            <span>
              活动耗时：{Math.round(activeRun.budget.activeMsUsed / 1000)}s /{" "}
              {Math.round(activeRun.budget.activeMsLimit / 1000)}s
            </span>
          </div>

          {activeRun.status === "running" && (
            <div className="flex justify-end">
              <Button
                type="button"
                data-evolution-cancel-btn="true"
                disabled={busy}
                onClick={() => handleCancel(activeRun.runId)}
                className="inline-flex h-7 items-center gap-1 rounded-md border border-danger/30 bg-surface px-2 text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                <Square className="size-3" aria-hidden="true" />
                <span>停止</span>
              </Button>
            </div>
          )}

          {activeRun.status === "awaiting_clarification" &&
            activeRun.clarification && (
              <div
                data-evolution-clarification="true"
                className="space-y-2 rounded-md border border-accent/30 bg-accent-soft p-2.5"
              >
                <div className="text-[11px] font-medium text-accent">
                  需要你选择
                </div>
                <div className="font-medium text-ink">
                  {activeRun.clarification.question}
                </div>
                {activeRun.clarification.options &&
                  activeRun.clarification.options.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {activeRun.clarification.options.map((opt) => (
                        <Button
                          key={opt}
                          type="button"
                          data-evolution-clarify-option={opt}
                          disabled={busy}
                          onClick={() =>
                            handleAnswerClarification(activeRun.runId, opt)
                          }
                          className="rounded-md border border-line bg-surface px-2 py-1 text-[11px] text-ink hover:bg-canvas"
                        >
                          {opt}
                        </Button>
                      ))}
                    </div>
                  )}
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    data-evolution-clarify-input="true"
                    value={clarifyInput}
                    onChange={(e) => setClarifyInput(e.target.value)}
                    placeholder="输入你的明确答复..."
                    className="flex-1 rounded-md border border-line bg-surface px-2 py-1 text-xs text-ink outline-none focus:border-accent"
                  />
                  <Button
                    type="button"
                    data-evolution-clarify-submit="true"
                    disabled={busy || !clarifyInput.trim()}
                    onClick={() =>
                      handleAnswerClarification(activeRun.runId, clarifyInput)
                    }
                    className="rounded-md bg-accent px-2.5 py-1 text-white disabled:opacity-50"
                  >
                    提交回答
                  </Button>
                </div>
              </div>
            )}

          {activeRun.status === "awaiting_budget" && (
            <div
              data-evolution-budget-paused="true"
              className="space-y-2 rounded-md border border-line bg-surface p-2.5"
            >
              <div className="flex items-center gap-1.5 font-medium text-ink">
                <AlertTriangle
                  className="size-3.5 shrink-0 text-accent"
                  aria-hidden="true"
                />
                <span>{activeRun.error ?? "已达到单次运行预算上限"}</span>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  data-evolution-extend-budget-btn="true"
                  disabled={busy}
                  onClick={() => handleExtendBudget(activeRun.runId)}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  <PlusCircle className="size-3.5" aria-hidden="true" />
                  <span>继续进行</span>
                </Button>
                <Button
                  type="button"
                  data-evolution-end-btn="true"
                  disabled={busy}
                  onClick={() => handleCancel(activeRun.runId)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-canvas px-2.5 font-medium text-muted hover:text-ink disabled:opacity-50"
                >
                  <span>结束本次改进</span>
                </Button>
              </div>
            </div>
          )}

          {activeRun.status === "interrupted" && (
            <div
              data-evolution-interrupted="true"
              className="rounded-md border border-danger/30 bg-danger/5 p-2 text-danger"
            >
              {activeRun.error ?? "服务重启，在途运行已中断且不会自动续调模型"}
            </div>
          )}

          {activeRun.status === "preview_ready" && (
            <div
              data-evolution-preview-ready="true"
              className="space-y-2.5 rounded-md border border-accent/30 bg-surface p-2.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-medium text-accent">
                  尚未应用
                </span>
              </div>
              {activeRun.changeBrief && (
                <div className="space-y-1">
                  <div className="font-medium text-ink">
                    《变更简报》：{activeRun.changeBrief.summary}
                  </div>
                  {activeRun.highlights.length > 0 && (
                    <ul className="list-disc pl-4 text-[11px] text-muted">
                      {activeRun.highlights.map((h, i) => (
                        <li key={i}>{h}</li>
                      ))}
                    </ul>
                  )}
                  <div className="text-[11px] text-muted">
                    数据兼容：{activeRun.changeBrief.dataCompatibility.summary}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  data-evolution-open-preview-btn="true"
                  disabled={busy}
                  onClick={() => handleRestorePreview(activeRun.runId)}
                  className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-canvas px-2.5 font-medium text-ink hover:bg-accent-soft disabled:opacity-50"
                >
                  <Eye className="size-3.5" aria-hidden="true" />
                  <span>打开/恢复预览</span>
                </Button>
                <Button
                  type="button"
                  data-evolution-apply-btn="true"
                  disabled={busy}
                  onClick={() => handleApplyRun(activeRun.runId)}
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  <span>确认应用</span>
                </Button>
              </div>

              <div className="space-y-1.5 border-t border-line pt-2">
                <div className="flex items-center gap-1 text-[11px] text-muted">
                  <MessageSquare className="size-3" aria-hidden="true" />
                  <span>在预览中继续微调</span>
                </div>
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    data-evolution-refine-input="true"
                    value={refineInput}
                    onChange={(e) => setRefineInput(e.target.value)}
                    placeholder="输入微调要求，验证后自动热刷新预览..."
                    className="flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-xs text-ink outline-none focus:border-accent"
                  />
                  <Button
                    type="button"
                    data-evolution-refine-submit="true"
                    disabled={busy || !refineInput.trim()}
                    onClick={() => handleContinueInPreview(activeRun.runId)}
                    className="rounded-md bg-accent px-2.5 py-1 text-white disabled:opacity-50"
                  >
                    微调
                  </Button>
                </div>
              </div>
            </div>
          )}

          {activeRun.events.length > 0 && (
            <div
              data-evolution-events="true"
              className="max-h-32 space-y-1 overflow-y-auto border-t border-line pt-2 text-[11px] text-muted"
            >
              {activeRun.events.map((ev) => (
                <div key={ev.seq} className="flex items-start gap-1.5">
                  <span className="font-mono text-[10px] opacity-70">
                    #{ev.seq}
                  </span>
                  <span>{ev.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
