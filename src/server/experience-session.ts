import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  experienceSessionBanner,
  type ExperienceSessionView,
} from "../shared/assistant.js";
import {
  AppError,
  type Command,
  type Composition,
  type Task,
} from "../shared/contracts.js";
import { Workspace } from "./workspace.js";
import { importCompositionVersions } from "./workspace-acceptance.js";

const TASK_TITLE = "候选体验任务";

export type ExperienceSessionSnapshot = ExperienceSessionView & {
  composition: Composition;
  task: Task;
};

type ActiveSession = {
  id: string;
  runId: string;
  candidateId: string;
  versionId: string;
  evidenceHash: string;
  formalCompositionRevision: number;
  workspace: Workspace;
  directory: string;
  taskId: string;
  timer: ReturnType<typeof setTimeout>;
};

/** Host-owned isolated candidate experience; browser never supplies DB paths. */
export class ExperienceSessionHost {
  private active?: ActiveSession;

  constructor(
    private formal: Workspace,
    private ttlMs = 30 * 60 * 1000,
  ) {}

  private snapshot(active: ActiveSession): ExperienceSessionSnapshot {
    const task = active.workspace.read(active.taskId);
    return {
      id: active.id,
      status: "active",
      banner: experienceSessionBanner,
      runId: active.runId,
      candidateId: active.candidateId,
      taskId: task.id,
      note: "体验写入仅落在隔离库；关闭体验不会自动应用或取消候选。",
      composition: active.workspace.composition(),
      task,
    };
  }

  async start(input: {
    runId: string;
    candidateId: string;
    versionId: string;
    evidenceHash: string;
    compositionRevision: number;
    signal?: AbortSignal;
  }): Promise<ExperienceSessionSnapshot> {
    const formalRevision = this.formal.composition().revision;
    if (formalRevision !== input.compositionRevision)
      throw new AppError("PLAN_STALE", "基础组合已变化，请重新规划", 409);
    if (
      this.active &&
      this.active.runId === input.runId &&
      this.active.candidateId === input.candidateId &&
      this.active.versionId === input.versionId &&
      this.active.formalCompositionRevision === input.compositionRevision
    )
      return this.snapshot(this.active);

    await this.closeActive();

    const version = this.formal.release.get(input.versionId);
    if (!(version.evidence as { passed?: boolean })?.passed)
      throw new AppError("UNVERIFIED_VERSION", "候选尚未通过验证", 409);
    input.signal?.throwIfAborted();

    const directory = await mkdtemp(join(tmpdir(), "cordis-experience-"));
    const isolated = await Workspace.open(join(directory, "workspace.db"), {
      acceptanceProbe: true,
    });
    try {
      importCompositionVersions(this.formal, isolated, version);
      await isolated.activateForAcceptance(version.id, input.signal);
      const created = await isolated.command({
        type: "create",
        title: TASK_TITLE,
        compositionRevision: isolated.composition().revision,
        operationId: randomUUID(),
      });
      if (!created.task)
        throw new AppError("INTERNAL_ERROR", "无法创建体验任务", 500);
      const id = randomUUID();
      const timer = setTimeout(() => {
        void this.closeActive();
      }, this.ttlMs);
      timer.unref();
      this.active = {
        id,
        runId: input.runId,
        candidateId: input.candidateId,
        versionId: input.versionId,
        evidenceHash: input.evidenceHash,
        formalCompositionRevision: input.compositionRevision,
        workspace: isolated,
        directory,
        taskId: created.task.id,
        timer,
      };
      return this.snapshot(this.active);
    } catch (error) {
      await isolated.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  observe(input?: {
    sessionId?: string;
    runId?: string;
  }): ExperienceSessionView | { status: "none" } {
    if (!this.active) return { status: "none" };
    if (input?.sessionId && input.sessionId !== this.active.id)
      return { status: "none" };
    if (input?.runId && input.runId !== this.active.runId)
      return { status: "none" };
    if (
      this.formal.composition().revision !==
      this.active.formalCompositionRevision
    ) {
      return {
        id: this.active.id,
        status: "invalid",
        banner: experienceSessionBanner,
        runId: this.active.runId,
        candidateId: this.active.candidateId,
        taskId: this.active.taskId,
        note: "正式组合已变化，体验会话已失效，请重新打开体验。",
        invalidReason: "composition-changed",
      };
    }
    return {
      id: this.active.id,
      status: "active",
      banner: experienceSessionBanner,
      runId: this.active.runId,
      candidateId: this.active.candidateId,
      taskId: this.active.taskId,
      note: "体验写入仅落在隔离库；关闭体验不会自动应用或取消候选。",
    };
  }

  readSnapshot(sessionId: string): ExperienceSessionSnapshot {
    return this.snapshot(this.assertActive(sessionId));
  }

  assertActive(sessionId: string): ActiveSession {
    if (!this.active || this.active.id !== sessionId)
      throw new AppError("EXPERIENCE_SESSION", "体验会话不存在或已结束", 404);
    if (
      this.formal.composition().revision !==
      this.active.formalCompositionRevision
    )
      throw new AppError(
        "EXPERIENCE_STALE",
        "体验会话已失效，请重新打开",
        409,
      );
    return this.active;
  }

  workspaceFor(sessionId: string): Workspace {
    return this.assertActive(sessionId).workspace;
  }

  async command(
    sessionId: string,
    command: Omit<Command, "compositionRevision" | "operationId"> & {
      operationId: string;
    },
  ) {
    const workspace = this.workspaceFor(sessionId);
    return workspace.command({
      ...command,
      compositionRevision: workspace.composition().revision,
    });
  }

  async end(sessionId?: string): Promise<void> {
    if (sessionId && (!this.active || this.active.id !== sessionId)) return;
    await this.closeActive();
  }

  endForRun(runId: string): void {
    if (this.active?.runId === runId) void this.closeActive();
  }

  rejectUntrustedFields(body: Record<string, unknown>) {
    if (
      "databasePath" in body ||
      "dbPath" in body ||
      "filename" in body
    )
      throw new AppError("FORBIDDEN", "不能指定数据库路径", 403);
  }

  private async closeActive() {
    const current = this.active;
    if (!current) return;
    this.active = undefined;
    clearTimeout(current.timer);
    await current.workspace.close().catch(() => undefined);
    await rm(current.directory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }

  async close() {
    await this.closeActive();
  }
}
