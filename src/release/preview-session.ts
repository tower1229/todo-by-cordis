import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisedCordisRuntime } from "../runtime/server/supervised-runtime.js";
import { cloneSqliteDatabaseOnline } from "../verify/db-snapshot.js";
import {
  type EvolutionHttpController,
  type ReleaseHttpController,
  type HostServerHandle,
  startHostServer,
} from "../supervisor/server/gateway.js";
import type { CompositionSnapshot, PluginArtifact } from "../contracts/types.js";

export interface PreviewSessionInfo {
  readonly sessionId: string;
  readonly candidateId: string;
  readonly baseCompositionId: string;
  readonly previewUrl: string;
  readonly previewDbPath: string;
  readonly createdAt: string;
}

export interface PreviewBannerContext {
  readonly sessionId: string;
  readonly candidateId: string;
  readonly baseCompositionId: string;
  readonly productionUrl?: string;
}

export interface OpenPreviewSessionInput {
  readonly candidateId: string;
  readonly baseCompositionId: string;
  readonly candidateComposition: CompositionSnapshot;
  readonly artifacts: readonly PluginArtifact[];
  readonly productionDbPath: string;
  readonly clientAssetsDir?: string;
  readonly enableClientHost?: boolean;
  readonly releaseController?: ReleaseHttpController;
  readonly evolutionController?: EvolutionHttpController;
  readonly productionUrl?: string;
  readonly idleTimeoutMs?: number;
}

export interface RefreshPreviewSessionInput {
  readonly candidateId: string;
  readonly baseCompositionId: string;
  readonly candidateComposition: CompositionSnapshot;
  readonly artifacts: readonly PluginArtifact[];
}

const DEFAULT_PREVIEW_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

interface ManagedPreviewSession {
  info: PreviewSessionInfo;
  readonly previewContext: {
    sessionId: string;
    candidateId: string;
    baseCompositionId: string;
    productionUrl?: string;
  };
  readonly tempDir: string;
  readonly runtime: SupervisedCordisRuntime;
  readonly server: HostServerHandle;
  readonly idleTimer?: NodeJS.Timeout;
}

export class PreviewSessionHost {
  private readonly sessions = new Map<string, ManagedPreviewSession>();

  async openSession(
    input: OpenPreviewSessionInput,
  ): Promise<PreviewSessionInfo> {
    const sessionId = `prev-${randomUUID().slice(0, 8)}`;
    const tempDir = mkdtempSync(join(tmpdir(), `host-preview-${sessionId}-`));
    const previewDbPath = join(tempDir, "preview-app.db");
    const workDir = join(tempDir, "work");

    let runtime: SupervisedCordisRuntime | null = null;
    let server: HostServerHandle | null = null;

    try {
      if (existsSync(input.productionDbPath)) {
        await cloneSqliteDatabaseOnline(input.productionDbPath, previewDbPath);
      }

      runtime = new SupervisedCordisRuntime({
        dbPath: previewDbPath,
        workDir,
      });

      for (const artifact of input.artifacts) {
        runtime.registerArtifact(artifact);
      }

      await runtime.applyComposition(input.candidateComposition);

      const previewContext: ManagedPreviewSession["previewContext"] = {
        sessionId,
        candidateId: input.candidateId,
        baseCompositionId: input.baseCompositionId,
        ...(input.productionUrl ? { productionUrl: input.productionUrl } : {}),
      };

      server = await startHostServer(runtime, {
        ...(input.clientAssetsDir
          ? { clientAssetsDir: input.clientAssetsDir }
          : {}),
        enableClientHost: input.enableClientHost ?? true,
        ...(input.releaseController
          ? { releaseController: input.releaseController }
          : {}),
        ...(input.evolutionController
          ? { evolutionController: input.evolutionController }
          : {}),
        previewContext,
      });

      const info: PreviewSessionInfo = {
        sessionId,
        candidateId: input.candidateId,
        baseCompositionId: input.baseCompositionId,
        previewUrl: server.url,
        previewDbPath,
        createdAt: new Date().toISOString(),
      };

      const idleTimeoutMs =
        input.idleTimeoutMs ?? DEFAULT_PREVIEW_IDLE_TIMEOUT_MS;
      let idleTimer: NodeJS.Timeout | undefined;
      if (idleTimeoutMs > 0) {
        idleTimer = setTimeout(() => {
          void this.closeSession(sessionId);
        }, idleTimeoutMs);
        idleTimer.unref?.();
      }

      this.sessions.set(sessionId, {
        info,
        previewContext,
        tempDir,
        runtime,
        server,
        ...(idleTimer ? { idleTimer } : {}),
      });

      return info;
    } catch (error) {
      if (server) {
        await server.close().catch(() => {});
      }
      if (runtime) {
        await runtime.close().catch(() => {});
      }
      rmSync(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  getSession(sessionId: string): PreviewSessionInfo | undefined {
    return this.sessions.get(sessionId)?.info;
  }

  async refreshSession(
    sessionId: string,
    input: RefreshPreviewSessionInput,
  ): Promise<PreviewSessionInfo | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    for (const artifact of input.artifacts) {
      session.runtime.registerArtifact(artifact);
    }
    await session.runtime.applyComposition(input.candidateComposition);

    session.previewContext.candidateId = input.candidateId;
    session.previewContext.baseCompositionId = input.baseCompositionId;
    session.info = {
      ...session.info,
      candidateId: input.candidateId,
      baseCompositionId: input.baseCompositionId,
    };
    return session.info;
  }

  listSessions(): PreviewSessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);
    if (session.idleTimer) {
      clearTimeout(session.idleTimer);
    }

    await session.server.close().catch(() => {});
    await session.runtime.close().catch(() => {});
    rmSync(session.tempDir, { recursive: true, force: true });
    return true;
  }

  async closeSessionsForCandidate(candidateId: string): Promise<number> {
    const targets = [...this.sessions.values()]
      .filter((s) => s.info.candidateId === candidateId)
      .map((s) => s.info.sessionId);
    for (const sessionId of targets) {
      await this.closeSession(sessionId);
    }
    return targets.length;
  }

  async closeAll(): Promise<void> {
    const sessionIds = [...this.sessions.keys()];
    for (const sessionId of sessionIds) {
      await this.closeSession(sessionId);
    }
  }
}
