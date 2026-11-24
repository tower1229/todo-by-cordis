import type { Context as HonoContext, Hono } from "hono";
import type { ReleaseTransitionResult } from "../../release/composition-release.js";
import type {
  EvolutionBudgetConfig,
  EvolutionRunView,
  EvolutionStreamEvent,
} from "../../evolution/loop.js";
import type { PreviewSessionInfo } from "../../release/preview-session.js";

export interface EvolutionHttpController {
  listRuns(): EvolutionRunView[];
  getRun(runId: string): EvolutionRunView | undefined;
  startRun(
    prompt: string,
    options?: { readonly budget?: Partial<EvolutionBudgetConfig> },
  ): Promise<EvolutionRunView>;
  answerClarification(runId: string, answer: string): Promise<EvolutionRunView>;
  extendBudget(
    runId: string,
    input: {
      readonly additionalCalls?: number;
      readonly additionalActiveMs?: number;
    },
  ): Promise<EvolutionRunView>;
  continueInPreview(runId: string, message: string): Promise<EvolutionRunView>;
  cancelRun(runId: string): Promise<EvolutionRunView>;
  restorePreview(runId: string): Promise<PreviewSessionInfo>;
  applyRun(runId: string): Promise<ReleaseTransitionResult>;
  subscribe(listener: (event: EvolutionStreamEvent) => void): () => void;
}

function mapEvolutionError(error: unknown) {
  const err = error as Error & { statusCode?: number; code?: string };
  const status = typeof err?.statusCode === "number" ? err.statusCode : 500;
  return {
    status,
    body: {
      error: err?.message ?? String(error),
      ...(err?.code ? { code: err.code } : {}),
    },
  };
}

export function registerEvolutionRoutes(input: {
  readonly app: Hono;
  readonly evolutionController?: EvolutionHttpController;
  readonly encoder: TextEncoder;
  readonly heartbeatMs: number;
  readonly activeSseClosers: Set<() => void>;
}): void {
  const { app, evolutionController, encoder, heartbeatMs, activeSseClosers } =
    input;

  if (!evolutionController) {
    app.get("/api/host/evolution/runs", (c) => {
      return c.json({ runs: [], enabled: false }, 200);
    });
    return;
  }

  const evoPost = (
    path: string,
    handler: (c: HonoContext) => Promise<Response>,
  ) => {
    app.post(path, async (c) => {
      try {
        return await handler(c);
      } catch (error) {
        const mapped = mapEvolutionError(error);
        return c.json(mapped.body, mapped.status as 400);
      }
    });
  };

  app.get("/api/host/evolution/runs", (c) => {
    return c.json({ runs: evolutionController.listRuns() }, 200);
  });

  app.get("/api/host/evolution/runs/:runId", (c) => {
    const run = evolutionController.getRun(c.req.param("runId"));
    if (!run) {
      return c.json({ error: "Run not found" }, 404);
    }
    return c.json({ run }, 200);
  });

  evoPost("/api/host/evolution/runs", async (c) => {
    const body = (await c.req.json()) as {
      prompt?: string;
      budget?: Partial<EvolutionBudgetConfig>;
    };
    const run = await evolutionController.startRun(
      body.prompt ?? "",
      body.budget ? { budget: body.budget } : undefined,
    );
    return c.json({ run }, 201);
  });

  evoPost("/api/host/evolution/runs/:runId/clarify", async (c) => {
    const body = (await c.req.json()) as { answer?: string };
    const run = await evolutionController.answerClarification(
      c.req.param("runId") ?? "",
      body.answer ?? "",
    );
    return c.json({ run }, 200);
  });

  evoPost("/api/host/evolution/runs/:runId/budget", async (c) => {
    const body = (await c.req.json()) as {
      additionalCalls?: number;
      additionalActiveMs?: number;
    };
    const run = await evolutionController.extendBudget(
      c.req.param("runId") ?? "",
      {
        additionalCalls: body.additionalCalls,
        additionalActiveMs: body.additionalActiveMs,
      },
    );
    return c.json({ run }, 200);
  });

  evoPost("/api/host/evolution/runs/:runId/continue", async (c) => {
    const body = (await c.req.json()) as { message?: string };
    const run = await evolutionController.continueInPreview(
      c.req.param("runId") ?? "",
      body.message ?? "",
    );
    return c.json({ run }, 200);
  });

  evoPost("/api/host/evolution/runs/:runId/cancel", async (c) => {
    const run = await evolutionController.cancelRun(c.req.param("runId") ?? "");
    return c.json({ run }, 200);
  });

  evoPost("/api/host/evolution/runs/:runId/restore-preview", async (c) => {
    const session = await evolutionController.restorePreview(
      c.req.param("runId") ?? "",
    );
    return c.json({ session }, 200);
  });

  evoPost("/api/host/evolution/runs/:runId/apply", async (c) => {
    const result = await evolutionController.applyRun(
      c.req.param("runId") ?? "",
    );
    return c.json({ result }, 200);
  });

  app.get("/api/host/evolution/events", (c) => {
    let cleanup: (() => void) | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let closed = false;
        const sendRaw = (chunk: string) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(chunk));
          } catch {
            closeStream();
          }
        };

        const unsubscribe = evolutionController.subscribe((event) => {
          sendRaw(`event: ${event.type}\ndata: ${JSON.stringify(event.run)}\n\n`);
        });

        const heartbeat = setInterval(() => {
          sendRaw(": heartbeat\n\n");
        }, heartbeatMs);
        heartbeat.unref?.();

        const closeStream = () => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          activeSseClosers.delete(closeStream);
          try {
            controller.close();
          } catch {
            // ignore
          }
        };

        cleanup = closeStream;
        activeSseClosers.add(closeStream);
        c.req.raw.signal.addEventListener("abort", closeStream, { once: true });

        sendRaw(
          `event: snapshot\ndata: ${JSON.stringify({ runs: evolutionController.listRuns() })}\n\n`,
        );
      },
      cancel() {
        cleanup?.();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      },
    });
  });
}
