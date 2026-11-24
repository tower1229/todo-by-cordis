import type { Hono } from "hono";
import type {
  ApplyCandidateInput,
  ReleaseStatusSnapshot,
  ReleaseTransitionResult,
} from "../../release/composition-release.js";
import type {
  PreviewBannerContext,
  PreviewSessionInfo,
} from "../../release/preview-session.js";

export interface ReleaseHttpController {
  getStatus(): ReleaseStatusSnapshot;
  openPreview(candidateId: string): Promise<PreviewSessionInfo>;
  closePreview(sessionId: string): Promise<boolean>;
  getPreviewSession(sessionId: string): PreviewSessionInfo | undefined;
  apply(input: ApplyCandidateInput): Promise<ReleaseTransitionResult>;
  rollback(
    targetCompositionId: string,
    expectedCurrentCompositionId: string,
  ): Promise<ReleaseTransitionResult>;
}

function toReleaseErrorResponse(error: unknown) {
  const err = error as {
    message?: string;
    statusCode?: number;
    code?: string;
    expectedBaseCompositionId?: string;
    actualActiveCompositionId?: string | null;
  };
  const status =
    typeof err?.statusCode === "number"
      ? (err.statusCode as 400 | 404 | 409 | 500)
      : 500;
  return {
    status,
    body: {
      error: err?.message ?? String(error),
      ...(err?.code ? { code: err.code } : {}),
      ...(err?.expectedBaseCompositionId !== undefined
        ? { expectedBaseCompositionId: err.expectedBaseCompositionId }
        : {}),
      ...(err?.actualActiveCompositionId !== undefined
        ? { actualActiveCompositionId: err.actualActiveCompositionId }
        : {}),
    },
  };
}

export function registerReleaseRoutes(input: {
  readonly app: Hono;
  readonly releaseController?: ReleaseHttpController;
  readonly previewContext?: PreviewBannerContext;
}): void {
  const { app, releaseController } = input;
  const previewContext = input.previewContext ?? null;

  if (!releaseController) {
    app.get("/api/host/release/status", (c) => {
      return c.json(
        {
          activeCompositionId: null,
          activeComposition: null,
          compositions: [],
          candidates: [],
          activePreviews: [],
          previewContext: null,
        },
        200,
      );
    });
    return;
  }

  app.get("/api/host/release/status", (c) => {
    return c.json(
      {
        ...releaseController.getStatus(),
        previewContext,
      },
      200,
    );
  });

  app.post("/api/host/release/preview", async (c) => {
    try {
      const body = (await c.req.json()) as { candidateId?: string };
      if (!body || typeof body.candidateId !== "string") {
        return c.json({ error: "candidateId is required" }, 400);
      }
      const session = await releaseController.openPreview(body.candidateId);
      return c.json({ session }, 201);
    } catch (error) {
      const mapped = toReleaseErrorResponse(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  app.delete("/api/host/release/preview/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const closed = await releaseController.closePreview(sessionId);
    if (!closed) {
      return c.json({ error: `Preview session ${sessionId} not found` }, 404);
    }
    return c.json({ closed: true, sessionId }, 200);
  });

  app.post("/api/host/release/apply", async (c) => {
    try {
      const body = (await c.req.json()) as {
        candidateId?: string;
        expectedBaseCompositionId?: string;
      };
      if (
        !body ||
        typeof body.candidateId !== "string" ||
        typeof body.expectedBaseCompositionId !== "string"
      ) {
        return c.json(
          { error: "candidateId and expectedBaseCompositionId are required" },
          400,
        );
      }
      const result = await releaseController.apply({
        candidateId: body.candidateId,
        expectedBaseCompositionId: body.expectedBaseCompositionId,
        ...(previewContext ? { deferPreviewCleanupMs: 100 } : {}),
      });
      return c.json(result, 200);
    } catch (error) {
      const mapped = toReleaseErrorResponse(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  app.post("/api/host/release/rollback", async (c) => {
    try {
      const body = (await c.req.json()) as {
        targetCompositionId?: string;
        expectedCurrentCompositionId?: string;
      };
      if (
        !body ||
        typeof body.targetCompositionId !== "string" ||
        typeof body.expectedCurrentCompositionId !== "string"
      ) {
        return c.json(
          {
            error:
              "targetCompositionId and expectedCurrentCompositionId are required",
          },
          400,
        );
      }
      const result = await releaseController.rollback(
        body.targetCompositionId,
        body.expectedCurrentCompositionId,
      );
      return c.json(result, 200);
    } catch (error) {
      const mapped = toReleaseErrorResponse(error);
      return c.json(mapped.body, mapped.status);
    }
  });

  app.get("/preview/:sessionId", (c) => {
    const sessionId = c.req.param("sessionId");
    const session = releaseController.getPreviewSession(sessionId);
    if (!session) {
      return c.json({ error: `Preview session ${sessionId} not found` }, 404);
    }
    return c.redirect(session.previewUrl, 302);
  });
}
