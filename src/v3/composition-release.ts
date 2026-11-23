import { randomUUID } from "node:crypto";
import {
  type AffectedPluginSummary,
  type CandidateReceipt,
  type ChangeBrief,
  type CompositionRecord,
  ControlStore,
} from "./control-store.js";
import { SupervisedCordisRuntime } from "./cordis-runtime.js";
import type {
  EvolutionHttpController,
  ReleaseHttpController,
} from "./http-gateway.js";
import {
  NO_BEHAVIOR_DIFF_WARNING,
  type VerificationReport,
} from "./plugin-verifier.js";
import {
  PreviewSessionHost,
  type PreviewSessionInfo,
} from "./preview-session.js";
import type {
  CompositionSnapshot,
  PluginArtifact,
  RuntimeHealth,
} from "./types.js";

export class ReleaseError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "ReleaseError";
  }
}

export class ReleaseConflictError extends ReleaseError {
  constructor(
    message: string,
    readonly expectedBaseCompositionId: string,
    readonly actualActiveCompositionId: string | null,
  ) {
    super(message, 409, "OPTIMISTIC_LOCK_CONFLICT");
    this.name = "ReleaseConflictError";
  }
}

export interface CompositionReleaseOptions {
  readonly controlDbPath: string;
  readonly businessDbPath: string;
  readonly workDir: string;
  readonly clientAssetsDir?: string;
  readonly enablePreviewClientHost?: boolean;
  readonly productionUrl?: string;
}

export interface RegisterCandidateInput {
  readonly candidateId?: string;
  readonly baseCompositionId: string;
  readonly candidateComposition: CompositionSnapshot;
  readonly artifacts: readonly PluginArtifact[];
  readonly verificationReport: VerificationReport;
  readonly summary?: string;
}

export interface ApplyCandidateInput {
  readonly candidateId: string;
  readonly expectedBaseCompositionId: string;
  readonly deferPreviewCleanupMs?: number;
}

export interface ReleaseTransitionResult {
  readonly composition: CompositionRecord;
  readonly health: RuntimeHealth;
}

export interface ReleaseStatusSnapshot {
  readonly activeCompositionId: string | null;
  readonly activeComposition: CompositionRecord | null;
  readonly compositions: readonly CompositionRecord[];
  readonly candidates: readonly CandidateReceipt[];
  readonly activePreviews: readonly PreviewSessionInfo[];
  readonly productionUrl?: string;
}

export function buildChangeBrief(
  baseline: CompositionSnapshot | undefined,
  candidate: CompositionSnapshot,
  report: VerificationReport,
  summary?: string,
): ChangeBrief {
  const baselineMap = new Map(
    (baseline?.members ?? []).map((m) => [m.pluginId, m]),
  );
  const affectedPlugins: AffectedPluginSummary[] = [];

  for (const member of candidate.members) {
    const prev = baselineMap.get(member.pluginId);
    if (!prev) {
      affectedPlugins.push({
        pluginId: member.pluginId,
        action: "added",
        toVersionId: member.versionId,
      });
    } else if (prev.versionId !== member.versionId) {
      affectedPlugins.push({
        pluginId: member.pluginId,
        action: "upgraded",
        fromVersionId: prev.versionId,
        toVersionId: member.versionId,
      });
    } else if (prev.enabled !== member.enabled) {
      affectedPlugins.push({
        pluginId: member.pluginId,
        action: member.enabled ? "enabled" : "disabled",
        fromVersionId: prev.versionId,
        toVersionId: member.versionId,
      });
    }
  }

  const disabledChecks =
    report.fullCompositionSmoke?.disabledPluginDataChecks ?? [];
  const allPreserved = disabledChecks.every((c) => c.preserved);
  const compatible = report.ok && allPreserved;

  const dataSummary = !report.ok
    ? "验证未通过，禁止应用"
    : disabledChecks.length > 0
      ? allPreserved
        ? `已核验 ${disabledChecks.length} 个停用插件的历史数据表完好无损，与正式业务库兼容`
        : "检测到停用插件数据完整性异常"
      : "已通过真实克隆数据冒烟验证，与当前业务库兼容";

  const warnings = [...(report.warnings ?? [])];
  if (
    report.noBehaviorDiffWarning &&
    !warnings.includes(NO_BEHAVIOR_DIFF_WARNING)
  ) {
    warnings.push(NO_BEHAVIOR_DIFF_WARNING);
  }

  return {
    summary:
      summary ??
      (affectedPlugins.length > 0
        ? `影响 ${affectedPlugins.length} 个插件：${affectedPlugins.map((p) => `${p.pluginId}(${p.action})`).join(", ")}`
        : "组合配置更新"),
    affectedPlugins,
    dataCompatibility: {
      compatible,
      summary: dataSummary,
      disabledPluginDataChecks: disabledChecks,
    },
    testChangeDisclosures: report.testChangeDisclosures,
    noBehaviorDiffWarning: Boolean(report.noBehaviorDiffWarning),
    warnings,
  };
}

export class CompositionRelease implements ReleaseHttpController {
  readonly controlStore: ControlStore;
  readonly runtime: SupervisedCordisRuntime;
  readonly previewHost: PreviewSessionHost;
  readonly businessDbPath: string;
  private clientAssetsDir?: string;
  private productionUrl?: string;
  private evolutionController?: EvolutionHttpController;
  private readonly enablePreviewClientHost: boolean;
  private transitionChain: Promise<unknown> = Promise.resolve();

  constructor(options: CompositionReleaseOptions) {
    if (options.controlDbPath === options.businessDbPath) {
      throw new Error(
        "controlDbPath and businessDbPath must be physically separate files",
      );
    }
    this.businessDbPath = options.businessDbPath;
    this.clientAssetsDir = options.clientAssetsDir;
    this.productionUrl = options.productionUrl;
    this.enablePreviewClientHost = options.enablePreviewClientHost ?? true;
    this.controlStore = new ControlStore(options.controlDbPath);
    this.runtime = new SupervisedCordisRuntime({
      dbPath: options.businessDbPath,
      workDir: options.workDir,
    });
    this.previewHost = new PreviewSessionHost();
  }

  setProductionUrl(url: string): void {
    this.productionUrl = url;
  }

  setClientAssetsDir(dir: string): void {
    this.clientAssetsDir = dir;
  }

  setEvolutionController(controller: EvolutionHttpController): void {
    this.evolutionController = controller;
  }

  async bootstrap(initial?: {
    readonly composition: CompositionSnapshot;
    readonly artifacts: readonly PluginArtifact[];
    readonly summary?: string;
  }): Promise<RuntimeHealth | null> {
    // Restore all persisted artifacts into production runtime
    for (const artifact of this.controlStore.listArtifacts()) {
      this.runtime.registerArtifact(artifact);
    }

    const active = this.controlStore.getActiveComposition();
    if (active) {
      return await this.runtime.applyComposition(active);
    }

    if (!initial) {
      return null;
    }

    for (const artifact of initial.artifacts) {
      this.controlStore.saveArtifact(artifact);
      this.runtime.registerArtifact(artifact);
    }

    const record: CompositionRecord = {
      ...initial.composition,
      kind: "initial",
      summary: initial.summary ?? "初始应用组合",
    };

    const health = await this.runtime.applyComposition(record);
    const cas = this.controlStore.compareAndSetActiveComposition(null, record);
    if (!cas.committed) {
      throw new ReleaseConflictError(
        `Bootstrap conflict: active composition already set to ${cas.actualActiveCompositionId}`,
        "",
        cas.actualActiveCompositionId,
      );
    }
    return health;
  }

  registerVerifiedCandidate(input: RegisterCandidateInput): CandidateReceipt {
    const candidateId =
      input.candidateId ?? `cand-${randomUUID().slice(0, 8)}`;

    for (const artifact of input.artifacts) {
      this.controlStore.saveArtifact(artifact);
    }

    const baseline = this.controlStore.getComposition(input.baseCompositionId);
    const changeBrief = buildChangeBrief(
      baseline,
      input.candidateComposition,
      input.verificationReport,
      input.summary,
    );

    const receipt: CandidateReceipt = {
      candidateId,
      baseCompositionId: input.baseCompositionId,
      candidateComposition: input.candidateComposition,
      changeBrief,
      verificationReport: input.verificationReport,
      status: input.verificationReport.ok ? "verified" : "rejected",
      createdAt: new Date().toISOString(),
      appliedAt: null,
    };

    this.controlStore.saveCandidateReceipt(receipt);
    return receipt;
  }

  async openPreview(candidateId: string): Promise<PreviewSessionInfo> {
    const receipt = this.controlStore.getCandidateReceipt(candidateId);
    if (!receipt) {
      throw new ReleaseError(
        `Candidate ${candidateId} not found`,
        404,
        "CANDIDATE_NOT_FOUND",
      );
    }
    if (!receipt.verificationReport.ok || receipt.status !== "verified") {
      throw new ReleaseError(
        `Candidate ${candidateId} is not verified and eligible for preview (status=${receipt.status})`,
        400,
        "CANDIDATE_NOT_VERIFIED",
      );
    }

    // Close any active preview sessions when opening/switching preview so worker subprocesses & temp dirs are released
    await this.previewHost.closeAll();

    const artifacts = this.controlStore.listArtifacts();
    return await this.previewHost.openSession({
      candidateId: receipt.candidateId,
      baseCompositionId: receipt.baseCompositionId,
      candidateComposition: receipt.candidateComposition,
      artifacts,
      productionDbPath: this.businessDbPath,
      ...(this.clientAssetsDir ? { clientAssetsDir: this.clientAssetsDir } : {}),
      enableClientHost: this.enablePreviewClientHost,
      releaseController: this,
      ...(this.evolutionController
        ? { evolutionController: this.evolutionController }
        : {}),
      ...(this.productionUrl ? { productionUrl: this.productionUrl } : {}),
    });
  }

  async refreshOrOpenPreview(
    existingSessionId: string | null,
    candidateId: string,
  ): Promise<PreviewSessionInfo> {
    const receipt = this.controlStore.getCandidateReceipt(candidateId);
    if (!receipt) {
      throw new ReleaseError(
        `Candidate ${candidateId} not found`,
        404,
        "CANDIDATE_NOT_FOUND",
      );
    }
    if (!receipt.verificationReport.ok || receipt.status !== "verified") {
      throw new ReleaseError(
        `Candidate ${candidateId} is not verified and eligible for preview (status=${receipt.status})`,
        400,
        "CANDIDATE_NOT_VERIFIED",
      );
    }

    if (existingSessionId && this.previewHost.getSession(existingSessionId)) {
      const artifacts = this.controlStore.listArtifacts();
      const refreshed = await this.previewHost.refreshSession(
        existingSessionId,
        {
          candidateId: receipt.candidateId,
          baseCompositionId: receipt.baseCompositionId,
          candidateComposition: receipt.candidateComposition,
          artifacts,
        },
      );
      if (refreshed) {
        return refreshed;
      }
    }

    return await this.openPreview(candidateId);
  }

  async closePreview(sessionId: string): Promise<boolean> {
    return await this.previewHost.closeSession(sessionId);
  }

  getPreviewSession(sessionId: string): PreviewSessionInfo | undefined {
    return this.previewHost.getSession(sessionId);
  }

  async apply(input: ApplyCandidateInput): Promise<ReleaseTransitionResult> {
    return await this.enqueueTransition(async () => {
      const receipt = this.controlStore.getCandidateReceipt(input.candidateId);
      if (!receipt) {
        throw new ReleaseError(
          `Candidate ${input.candidateId} not found`,
          404,
          "CANDIDATE_NOT_FOUND",
        );
      }
      if (!receipt.verificationReport.ok || receipt.status !== "verified") {
        throw new ReleaseError(
          `Candidate ${input.candidateId} does not have a valid verified receipt (status=${receipt.status})`,
          400,
          "INVALID_VERIFICATION_RECEIPT",
        );
      }

      const currentActiveId = this.controlStore.getActiveCompositionId();
      if (
        currentActiveId !== input.expectedBaseCompositionId ||
        receipt.baseCompositionId !== currentActiveId
      ) {
        throw new ReleaseConflictError(
          `Optimistic lock conflict: expected base ${input.expectedBaseCompositionId} (receipt base ${receipt.baseCompositionId}), but active composition is ${currentActiveId ?? "none"}`,
          input.expectedBaseCompositionId,
          currentActiveId,
        );
      }

      this.registerCompositionArtifacts(receipt.candidateComposition.members);

      const nextComposition: CompositionRecord = {
        ...receipt.candidateComposition,
        parentCompositionId: currentActiveId,
        kind: "apply",
        candidateId: receipt.candidateId,
        summary: receipt.changeBrief.summary,
        createdAt: new Date().toISOString(),
      };

      const health = await this.runtime.applyComposition(nextComposition);

      const cas = this.controlStore.compareAndSetActiveComposition(
        currentActiveId,
        nextComposition,
        { markCandidateApplied: receipt.candidateId },
      );

      if (!cas.committed) {
        // Restore previous composition if concurrent writer somehow slipped in
        const prev = currentActiveId
          ? this.controlStore.getComposition(currentActiveId)
          : undefined;
        if (prev) {
          await this.runtime.applyComposition(prev).catch(() => {});
        }
        throw new ReleaseConflictError(
          `Optimistic lock conflict during commit: active composition changed to ${cas.actualActiveCompositionId}`,
          input.expectedBaseCompositionId,
          cas.actualActiveCompositionId,
        );
      }

      if (input.deferPreviewCleanupMs && input.deferPreviewCleanupMs > 0) {
        const timer = setTimeout(() => {
          void this.previewHost.closeSessionsForCandidate(receipt.candidateId);
        }, input.deferPreviewCleanupMs);
        timer.unref?.();
      } else {
        await this.previewHost.closeSessionsForCandidate(receipt.candidateId);
      }

      return { composition: nextComposition, health };
    });
  }

  async rollback(
    targetCompositionId: string,
    expectedCurrentCompositionId: string,
  ): Promise<ReleaseTransitionResult> {
    return await this.enqueueTransition(async () => {
      const target = this.controlStore.getComposition(targetCompositionId);
      if (!target) {
        throw new ReleaseError(
          `Target composition ${targetCompositionId} not found in history`,
          404,
          "COMPOSITION_NOT_FOUND",
        );
      }

      const currentActiveId = this.controlStore.getActiveCompositionId();
      if (!currentActiveId) {
        throw new ReleaseError(
          "No active composition to roll back from",
          400,
          "NO_ACTIVE_COMPOSITION",
        );
      }
      if (currentActiveId !== expectedCurrentCompositionId) {
        throw new ReleaseConflictError(
          `Optimistic lock conflict during rollback: expected active composition ${expectedCurrentCompositionId}, but current is ${currentActiveId}`,
          expectedCurrentCompositionId,
          currentActiveId,
        );
      }

      this.registerCompositionArtifacts(target.members);

      const rollbackComposition: CompositionRecord = {
        compositionId: `comp-rb-${randomUUID().slice(0, 8)}`,
        parentCompositionId: currentActiveId,
        members: target.members,
        kind: "rollback",
        targetCompositionId: target.compositionId,
        summary: `撤回至 ${target.compositionId}`,
        createdAt: new Date().toISOString(),
      };

      // Rollback NEVER reverts business.db — only switches composition via dual-side hot-swap
      const health = await this.runtime.applyComposition(rollbackComposition);

      const cas = this.controlStore.compareAndSetActiveComposition(
        expectedCurrentCompositionId,
        rollbackComposition,
      );
      if (!cas.committed) {
        const prev = this.controlStore.getComposition(currentActiveId);
        if (prev) {
          await this.runtime.applyComposition(prev).catch(() => {});
        }
        throw new ReleaseConflictError(
          `Optimistic lock conflict during rollback: active composition changed to ${cas.actualActiveCompositionId}`,
          expectedCurrentCompositionId,
          cas.actualActiveCompositionId,
        );
      }

      await this.previewHost.closeAll();

      return { composition: rollbackComposition, health };
    });
  }

  getStatus(): ReleaseStatusSnapshot {
    const activeComposition = this.controlStore.getActiveComposition() ?? null;
    return {
      activeCompositionId: activeComposition?.compositionId ?? null,
      activeComposition,
      compositions: this.controlStore.listCompositions(),
      candidates: this.controlStore.listCandidateReceipts(),
      activePreviews: this.previewHost.listSessions(),
      ...(this.productionUrl ? { productionUrl: this.productionUrl } : {}),
    };
  }

  async close(): Promise<void> {
    await this.previewHost.closeAll();
    await this.runtime.close();
    this.controlStore.close();
  }

  private registerCompositionArtifacts(
    members: readonly { readonly pluginId: string; readonly versionId: string }[],
  ): void {
    for (const member of members) {
      const artifact = this.controlStore.getArtifact(
        member.pluginId,
        member.versionId,
      );
      if (!artifact) {
        throw new ReleaseError(
          `Missing artifact ${member.pluginId}@${member.versionId} in control store`,
          500,
          "MISSING_ARTIFACT",
        );
      }
      this.runtime.registerArtifact(artifact);
    }
  }

  private enqueueTransition<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.transitionChain.then(fn, fn);
    this.transitionChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}
