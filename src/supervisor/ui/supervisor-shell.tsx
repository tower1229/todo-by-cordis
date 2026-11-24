import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Dialog } from "@base-ui/react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  History,
  Layers,
  RotateCcw,
  ShieldAlert,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  useClientDiagnostics,
  useClientRuntimeBridge,
  useClientRuntimeSnapshot,
} from "../../runtime/client/runtime-bridge.js";
import type { ReleaseStatusSnapshot } from "../../release/composition-release.js";
import type { CandidateReceipt } from "../../release/control-store.js";
import type { PreviewBannerContext } from "../../release/preview-session.js";
import { EvolutionDrawer } from "./evolution-drawer.js";

interface ReleaseStatusPayload extends ReleaseStatusSnapshot {
  readonly previewContext: PreviewBannerContext | null;
}

/**
 * Zero-business thin Supervisor Shell root.
 * Mounted outside `#app-root` so plugin render errors never block or obscure host controls.
 */
export function SupervisorShell() {
  const snapshot = useClientRuntimeSnapshot();
  const diagnostics = useClientDiagnostics();
  const bridge = useClientRuntimeBridge();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [releaseStatus, setReleaseStatus] =
    useState<ReleaseStatusPayload | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [expandedEvidenceId, setExpandedEvidenceId] = useState<string | null>(
    null,
  );
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const statusRequestSeqRef = useRef(0);

  const fetchReleaseStatus = useCallback(async () => {
    const seq = ++statusRequestSeqRef.current;
    try {
      const res = await fetch("/api/host/release/status", {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        return;
      }
      const data = (await res.json()) as ReleaseStatusPayload;
      if (seq === statusRequestSeqRef.current) {
        setReleaseStatus(data);
      }
    } catch {
      // Release control endpoints are optional in bare runtime mode
    }
  }, []);

  useEffect(() => {
    void fetchReleaseStatus();
  }, [fetchReleaseStatus, snapshot.compositionId]);

  const connectionLabel =
    snapshot.connectionState === "connected"
      ? "实时同步"
      : snapshot.connectionState === "reconnecting"
        ? "重连中"
        : "连接中";

  const isOnline = snapshot.connectionState === "connected";
  const previewCtx = releaseStatus?.previewContext ?? null;
  const verifiedCandidates = (releaseStatus?.candidates ?? []).filter(
    (c) => c.status === "verified",
  );
  const previewCandidate: CandidateReceipt | undefined = previewCtx
    ? releaseStatus?.candidates.find(
        (c) => c.candidateId === previewCtx.candidateId,
      )
    : undefined;

  const openDrawer = (trigger: HTMLElement | null) => {
    returnFocusRef.current = trigger;
    setDrawerOpen(true);
    void fetchReleaseStatus();
  };

  const handleOpenPreview = async (candidateId: string) => {
    setBusyAction(`preview:${candidateId}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await fetch("/api/host/release/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId }),
      });
      const data = (await res.json()) as {
        session?: { previewUrl: string; sessionId: string };
        error?: string;
      };
      if (!res.ok || !data.session) {
        setActionError(data.error ?? `打开预览失败 (${res.status})`);
        return;
      }
      await fetchReleaseStatus();
      window.location.href = data.session.previewUrl;
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleApply = async (
    candidateId: string,
    expectedBaseCompositionId: string,
  ) => {
    setBusyAction(`apply:${candidateId}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await fetch("/api/host/release/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ candidateId, expectedBaseCompositionId }),
      });
      const data = (await res.json()) as {
        composition?: { compositionId: string };
        error?: string;
      };
      if (!res.ok) {
        setActionError(data.error ?? `应用失败 (${res.status})`);
        return;
      }
      setActionNotice(
        `已应用组合 ${data.composition?.compositionId ?? candidateId}`,
      );
      if (previewCtx?.productionUrl) {
        window.location.href = previewCtx.productionUrl;
        return;
      }
      await fetchReleaseStatus();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusyAction(null);
    }
  };

  const handleRollback = async (targetCompositionId: string) => {
    const expectedCurrentCompositionId =
      releaseStatus?.activeCompositionId ?? snapshot.compositionId;
    if (!expectedCurrentCompositionId) {
      setActionError("当前活动组合未就绪，无法执行撤回");
      return;
    }
    setBusyAction(`rollback:${targetCompositionId}`);
    setActionError(null);
    setActionNotice(null);
    try {
      const res = await fetch("/api/host/release/rollback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          targetCompositionId,
          expectedCurrentCompositionId,
        }),
      });
      const data = (await res.json()) as {
        composition?: { compositionId: string };
        error?: string;
      };
      if (!res.ok) {
        setActionError(data.error ?? `撤回失败 (${res.status})`);
        return;
      }
      setActionNotice(`已撤回至 ${targetCompositionId}`);
      await fetchReleaseStatus();
    } catch (error) {
      setActionError(
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <header
      data-supervisor-shell="true"
      className="relative z-50 border-b border-line bg-surface/95 text-ink backdrop-blur-xs"
    >
      {previewCtx && (
        <div
          data-supervisor-preview-banner="true"
          className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-xs text-amber-950 dark:text-amber-100"
        >
          <div className="mx-auto flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Eye className="size-3.5 shrink-0 text-amber-600" aria-hidden="true" />
              <span className="font-semibold">隔离预览模式</span>
              <span className="opacity-85">
                候选 {previewCtx.candidateId} ·
                基于克隆数据副本运行，当前所有增删改不会影响正式业务库
              </span>
            </div>
            <div className="flex items-center gap-2">
              {previewCandidate && (
                <Button
                  type="button"
                  data-supervisor-apply-btn="true"
                  disabled={busyAction !== null}
                  onClick={() =>
                    void handleApply(
                      previewCandidate.candidateId,
                      previewCandidate.baseCompositionId,
                    )
                  }
                  className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  <CheckCircle2 className="size-3.5" aria-hidden="true" />
                  <span>确认应用</span>
                </Button>
              )}
              {previewCtx.productionUrl && (
                <Button
                  type="button"
                  data-supervisor-exit-preview="true"
                  disabled={busyAction !== null}
                  onClick={() => {
                    const targetUrl = previewCtx.productionUrl!;
                    void fetch(
                      `/api/host/release/preview/${encodeURIComponent(previewCtx.sessionId)}`,
                      { method: "DELETE" },
                    ).finally(() => {
                      window.location.href = targetUrl;
                    });
                  }}
                  className="inline-flex h-7 items-center rounded-md border border-line bg-surface px-2.5 font-medium text-ink hover:bg-canvas disabled:opacity-50"
                >
                  返回正式环境
                </Button>
              )}
            </div>
          </div>
          {actionError && !drawerOpen && (
            <div
              data-supervisor-banner-error="true"
              className="mx-auto mt-1.5 rounded border border-danger/30 bg-danger/10 px-2.5 py-1 text-danger"
            >
              {actionError}
            </div>
          )}
        </div>
      )}

      <div className="mx-auto flex h-11 w-full items-center justify-between gap-3 px-4 text-xs">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="font-semibold tracking-tight text-ink">
            Cordis Supervisor
          </span>
          <span
            data-supervisor-connection={snapshot.connectionState}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
              isOnline
                ? "bg-accent-soft text-accent"
                : "bg-danger/10 text-danger"
            }`}
          >
            {isOnline ? (
              <Wifi className="size-3" aria-hidden="true" />
            ) : (
              <WifiOff className="size-3" aria-hidden="true" />
            )}
            <span>{connectionLabel}</span>
          </span>
          <span
            data-supervisor-composition={snapshot.compositionId || "none"}
            className="hidden truncate text-muted sm:inline"
          >
            组合: {snapshot.compositionId || "待同步"} ·{" "}
            {snapshot.mountedPlugins.length} 个活跃插件
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {verifiedCandidates.length > 0 && !previewCtx && (
            <Button
              type="button"
              data-supervisor-candidates-badge={verifiedCandidates.length}
              onClick={(e) => openDrawer(e.currentTarget)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-accent/30 bg-accent-soft px-2.5 font-medium text-accent transition-colors hover:opacity-90"
            >
              <CheckCircle2 className="size-3.5" aria-hidden="true" />
              <span>{verifiedCandidates.length} 个待确认候选</span>
            </Button>
          )}
          {diagnostics.length > 0 && (
            <Button
              type="button"
              data-supervisor-diagnostics-badge={diagnostics.length}
              onClick={(e) => openDrawer(e.currentTarget)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-danger/25 bg-danger/5 px-2.5 font-medium text-danger transition-colors hover:bg-danger/10"
            >
              <AlertTriangle className="size-3.5" aria-hidden="true" />
              <span>{diagnostics.length} 项局部异常</span>
            </Button>
          )}
          <Button
            type="button"
            data-supervisor-toggle-drawer="true"
            onClick={(e) =>
              drawerOpen ? setDrawerOpen(false) : openDrawer(e.currentTarget)
            }
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line bg-surface px-2.5 font-medium text-ink transition-colors hover:bg-canvas"
          >
            <Layers className="size-3.5 text-muted" aria-hidden="true" />
            <span>组合状态</span>
          </Button>
        </div>
      </div>

      <Dialog.Root open={drawerOpen} onOpenChange={setDrawerOpen} modal={false}>
        <Dialog.Portal>
          <Dialog.Popup
            data-supervisor-drawer="true"
            aria-label="运行组合与发布控制"
            finalFocus={() =>
              returnFocusRef.current?.isConnected
                ? returnFocusRef.current
                : false
            }
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-line bg-surface shadow-xl outline-none"
          >
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
              <Dialog.Title className="text-sm font-semibold text-ink">
                运行组合与发布控制
              </Dialog.Title>
              <Dialog.Close
                aria-label="关闭组合状态面板"
                className="inline-flex size-9 items-center justify-center rounded-md text-muted transition-colors hover:bg-canvas hover:text-ink"
              >
                <X className="size-4" aria-hidden="true" />
              </Dialog.Close>
            </div>

            <div className="flex-1 space-y-5 overflow-y-auto p-4 text-xs">
              {actionError && (
                <div
                  data-supervisor-action-error="true"
                  className="rounded-lg border border-danger/30 bg-danger/5 p-2.5 text-danger"
                >
                  {actionError}
                </div>
              )}
              {actionNotice && (
                <div
                  data-supervisor-action-notice="true"
                  className="rounded-lg border border-accent/30 bg-accent-soft p-2.5 text-accent"
                >
                  {actionNotice}
                </div>
              )}

              <EvolutionDrawer
                onApplied={() => {
                  void fetchReleaseStatus();
                }}
                productionUrl={previewCtx?.productionUrl}
              />

              <section className="space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  当前权威组合
                </div>
                <div className="rounded-lg border border-line bg-canvas p-3">
                  <div className="font-mono text-xs text-ink">
                    {snapshot.compositionId || "(空)"}
                  </div>
                  <div className="mt-1 text-muted">
                    连接状态：{connectionLabel} · 活跃插件：
                    {snapshot.mountedPlugins.length}
                  </div>
                </div>
              </section>

              {verifiedCandidates.length > 0 && (
                <section
                  data-supervisor-change-brief="true"
                  className="space-y-2.5"
                >
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    待确认候选与《变更简报》 ({verifiedCandidates.length})
                  </div>
                  <div className="space-y-3">
                    {verifiedCandidates.map((cand) => {
                      const brief = cand.changeBrief;
                      const isExpanded =
                        expandedEvidenceId === cand.candidateId;
                      return (
                        <div
                          key={cand.candidateId}
                          data-supervisor-candidate={cand.candidateId}
                          className="space-y-2.5 rounded-lg border border-line bg-canvas p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="font-mono font-semibold text-ink">
                                {cand.candidateId}
                              </div>
                              <div className="mt-0.5 text-muted">
                                {brief.summary}
                              </div>
                            </div>
                            <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] text-accent">
                              已通过门禁
                            </span>
                          </div>

                          <div className="space-y-1">
                            <div className="font-medium text-ink">
                              受影响插件
                            </div>
                            <ul className="space-y-1">
                              {brief.affectedPlugins.map((p) => (
                                <li
                                  key={`${p.pluginId}-${p.toVersionId}`}
                                  className="font-mono text-[11px] text-muted"
                                >
                                  {p.pluginId}: {p.action}
                                  {p.fromVersionId
                                    ? ` (${p.fromVersionId} → ${p.toVersionId})`
                                    : ` (${p.toVersionId})`}
                                </li>
                              ))}
                            </ul>
                          </div>

                          <div className="rounded border border-line bg-surface p-2 text-[11px]">
                            <span className="font-medium text-ink">
                              数据兼容性：
                            </span>
                            <span className="text-muted">
                              {brief.dataCompatibility.summary}
                            </span>
                          </div>

                          {brief.noBehaviorDiffWarning && (
                            <div
                              data-supervisor-no-diff-warning="true"
                              className="flex items-start gap-1.5 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-900 dark:text-amber-100"
                            >
                              <ShieldAlert
                                className="mt-0.5 size-3.5 shrink-0"
                                aria-hidden="true"
                              />
                              <span>无行为差分断言，请人工核验预览</span>
                            </div>
                          )}

                          {brief.testChangeDisclosures.length > 0 && (
                            <div
                              data-supervisor-test-diffs="true"
                              className="space-y-1 rounded border border-amber-500/30 bg-amber-500/5 p-2 text-[11px]"
                            >
                              <div className="font-medium text-ink">
                                既有测试变更 Diff (
                                {brief.testChangeDisclosures.length})
                              </div>
                              {brief.testChangeDisclosures.map((disc) => (
                                <div key={disc.pluginId} className="space-y-1">
                                  <div className="font-mono text-muted">
                                    {disc.pluginId}: {disc.fileDiffs.length}{" "}
                                    个测试文件变更
                                  </div>
                                  {disc.fileDiffs.map((entry) => (
                                    <pre
                                      key={entry.file}
                                      className="max-h-24 overflow-auto rounded bg-surface p-1.5 font-mono text-[10px] text-muted"
                                    >
                                      {entry.file} ({entry.status})
                                      {"\n"}
                                      {entry.diffSummary}
                                    </pre>
                                  ))}
                                </div>
                              ))}
                            </div>
                          )}

                          <div className="flex flex-wrap items-center gap-2 pt-1">
                            {!previewCtx && (
                              <Button
                                type="button"
                                data-supervisor-open-preview-btn={
                                  cand.candidateId
                                }
                                disabled={busyAction !== null}
                                onClick={() =>
                                  void handleOpenPreview(cand.candidateId)
                                }
                                className="inline-flex h-7 items-center gap-1 rounded-md border border-line bg-surface px-2.5 font-medium text-ink hover:bg-canvas disabled:opacity-50"
                              >
                                <Eye className="size-3.5" aria-hidden="true" />
                                <span>打开隔离预览</span>
                              </Button>
                            )}
                            <Button
                              type="button"
                              data-supervisor-apply-btn="true"
                              data-supervisor-apply-candidate={cand.candidateId}
                              disabled={busyAction !== null}
                              onClick={() =>
                                void handleApply(
                                  cand.candidateId,
                                  cand.baseCompositionId,
                                )
                              }
                              className="inline-flex h-7 items-center gap-1 rounded-md bg-accent px-2.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
                            >
                              <CheckCircle2
                                className="size-3.5"
                                aria-hidden="true"
                              />
                              <span>确认应用</span>
                            </Button>
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedEvidenceId(
                                  isExpanded ? null : cand.candidateId,
                                )
                              }
                              className="text-[11px] text-accent hover:underline"
                            >
                              {isExpanded ? "收起验证证据" : "查看验证证据"}
                            </button>
                          </div>

                          {isExpanded && (
                            <pre
                              data-supervisor-evidence={cand.candidateId}
                              className="max-h-40 overflow-auto rounded border border-line bg-surface p-2 font-mono text-[10px] text-muted"
                            >
                              {JSON.stringify(
                                {
                                  probedPlugins:
                                    cand.verificationReport.probedPlugins,
                                  ablationCount:
                                    cand.verificationReport.ablationResults
                                      .length,
                                  subgraphCount:
                                    cand.verificationReport.subgraphResults
                                      ?.length ?? 0,
                                  fullSmokePassed:
                                    cand.verificationReport.fullCompositionSmoke
                                      ?.passed ?? null,
                                },
                                null,
                                2,
                              )}
                            </pre>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {releaseStatus && releaseStatus.compositions.length > 0 && (
                <section data-supervisor-history="true" className="space-y-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-muted">
                    <History className="size-3.5" aria-hidden="true" />
                    <span>
                      组合历史与一键撤回 ({releaseStatus.compositions.length})
                    </span>
                  </div>
                  <ul className="space-y-2">
                    {releaseStatus.compositions.map((comp) => {
                      const isActive =
                        comp.compositionId ===
                        releaseStatus.activeCompositionId;
                      return (
                        <li
                          key={comp.compositionId}
                          data-supervisor-history-item={comp.compositionId}
                          className="rounded-lg border border-line bg-surface p-2.5"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono font-medium text-ink">
                              {comp.compositionId}
                            </span>
                            {isActive ? (
                              <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] text-accent">
                                当前正式
                              </span>
                            ) : (
                              <Button
                                type="button"
                                data-supervisor-rollback-btn={
                                  comp.compositionId
                                }
                                disabled={busyAction !== null}
                                onClick={() =>
                                  void handleRollback(comp.compositionId)
                                }
                                className="inline-flex h-6 items-center gap-1 rounded border border-line bg-canvas px-2 text-[11px] font-medium text-ink hover:bg-surface disabled:opacity-50"
                              >
                                <RotateCcw
                                  className="size-3"
                                  aria-hidden="true"
                                />
                                <span>一键撤回</span>
                              </Button>
                            )}
                          </div>
                          <div className="mt-1 text-[11px] text-muted">
                            {comp.kind}
                            {comp.summary ? ` · ${comp.summary}` : ""}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <section className="space-y-2">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                  客户端插件 Fiber
                </div>
                {snapshot.mountedPlugins.length === 0 ? (
                  <p className="text-muted">当前无已挂载插件</p>
                ) : (
                  <ul className="space-y-2">
                    {snapshot.mountedPlugins.map((plugin) => (
                      <li
                        key={`${plugin.pluginId}@${plugin.versionId}`}
                        className="rounded-lg border border-line bg-surface p-2.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-ink">
                            {plugin.pluginId}
                          </span>
                          <span className="rounded bg-accent-soft px-1.5 py-0.5 font-mono text-[11px] text-accent">
                            {plugin.state}
                          </span>
                        </div>
                        <div className="mt-1 font-mono text-[11px] text-muted">
                          v:{plugin.versionId}
                          {plugin.hasStyleCss ? " · css" : ""}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    局部渲染与加载诊断 ({diagnostics.length})
                  </span>
                  {diagnostics.length > 0 && (
                    <button
                      type="button"
                      onClick={() => bridge.clearDiagnostics()}
                      className="text-accent hover:underline"
                    >
                      清空
                    </button>
                  )}
                </div>
                {diagnostics.length === 0 ? (
                  <p className="text-muted">无异常记录</p>
                ) : (
                  <ul className="space-y-2">
                    {diagnostics.map((diag) => (
                      <li
                        key={diag.id}
                        data-supervisor-diagnostic-plugin={diag.pluginId}
                        className="rounded-lg border border-danger/25 bg-danger/5 p-2.5 text-danger"
                      >
                        <div className="font-medium">
                          {diag.pluginId} ({diag.kind})
                          {diag.slotName ? ` · slot:${diag.slotName}` : ""}
                        </div>
                        <div className="mt-0.5 break-words opacity-90">
                          {diag.message}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </header>
  );
}
