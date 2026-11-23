import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SupervisedCordisRuntime } from "./cordis-runtime.js";
import { cloneSqliteDatabaseOnline } from "./db-snapshot.js";
import {
  type ReleaseHttpController,
  type V3HttpServerHandle,
  startV3HttpServer,
} from "./http-gateway.js";
import type { CompositionSnapshot, PluginArtifact } from "./types.js";

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
  readonly productionUrl?: string;
}

interface ManagedPreviewSession {
  readonly info: PreviewSessionInfo;
  readonly tempDir: string;
  readonly runtime: SupervisedCordisRuntime;
  readonly server: V3HttpServerHandle;
}

export class PreviewSessionHost {
  private readonly sessions = new Map<string, ManagedPreviewSession>();

  async openSession(
    input: OpenPreviewSessionInput,
  ): Promise<PreviewSessionInfo> {
    const sessionId = `prev-${randomUUID().slice(0, 8)}`;
    const tempDir = mkdtempSync(join(tmpdir(), `v3-preview-${sessionId}-`));
    const previewDbPath = join(tempDir, "preview-business.db");
    const workDir = join(tempDir, "work");

    let runtime: SupervisedCordisRuntime | null = null;
    let server: V3HttpServerHandle | null = null;

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

      server = await startV3HttpServer(runtime, {
        ...(input.clientAssetsDir
          ? { clientAssetsDir: input.clientAssetsDir }
          : {}),
        enableClientHost: input.enableClientHost ?? true,
        ...(input.releaseController
          ? { releaseController: input.releaseController }
          : {}),
        previewContext: {
          sessionId,
          candidateId: input.candidateId,
          baseCompositionId: input.baseCompositionId,
          ...(input.productionUrl ? { productionUrl: input.productionUrl } : {}),
        },
      });

      const info: PreviewSessionInfo = {
        sessionId,
        candidateId: input.candidateId,
        baseCompositionId: input.baseCompositionId,
        previewUrl: server.url,
        previewDbPath,
        createdAt: new Date().toISOString(),
      };

      this.sessions.set(sessionId, {
        info,
        tempDir,
        runtime,
        server,
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

  listSessions(): PreviewSessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info);
  }

  async closeSession(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    this.sessions.delete(sessionId);

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
