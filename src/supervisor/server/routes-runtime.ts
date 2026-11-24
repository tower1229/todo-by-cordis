import type { Hono } from "hono";
import type {
  ActiveClientComposition,
  ClientDiagnostic,
  ServerCordisRuntime,
} from "../../contracts/types.js";

export function registerRuntimeRoutes(input: {
  readonly app: Hono;
  readonly runtime: ServerCordisRuntime;
  readonly encoder: TextEncoder;
  readonly heartbeatMs: number;
  readonly activeSseClosers: Set<() => void>;
  readonly diagnostics: ClientDiagnostic[];
}): void {
  const { app, runtime, encoder, heartbeatMs, activeSseClosers, diagnostics } =
    input;

  app.get("/api/host/runtime/introspect", async (c) => {
    try {
      const topology = await runtime.introspect();
      return c.json(topology, 200);
    } catch (error) {
      const err = error as Error;
      return c.json({ error: err?.message ?? String(error) }, 503);
    }
  });

  app.get("/api/host/client/composition", (c) => {
    return c.json(runtime.getActiveClientComposition(), 200);
  });

  app.get("/api/host/client/events", (c) => {
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

        const sendComposition = (composition: ActiveClientComposition) => {
          sendRaw(
            `event: composition\ndata: ${JSON.stringify(composition)}\n\n`,
          );
        };

        const unsubscribe = runtime.subscribeComposition((composition) => {
          sendComposition(composition);
        });

        const heartbeat = setInterval(() => {
          sendRaw(": ping\n\n");
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
            // Stream already closed
          }
        };

        cleanup = closeStream;
        activeSseClosers.add(closeStream);

        c.req.raw.signal.addEventListener("abort", closeStream, { once: true });

        sendRaw("retry: 300\n\n");
        sendComposition(runtime.getActiveClientComposition());
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
      },
    });
  });

  app.post("/api/host/client-diagnostics", async (c) => {
    try {
      const body = (await c.req.json()) as Partial<ClientDiagnostic>;
      if (!body || typeof body.pluginId !== "string") {
        return c.json({ error: "pluginId is required" }, 400);
      }
      const record: ClientDiagnostic = {
        id:
          typeof body.id === "string"
            ? body.id
            : `srv-diag-${diagnostics.length + 1}`,
        timestamp:
          typeof body.timestamp === "string"
            ? body.timestamp
            : new Date().toISOString(),
        pluginId: body.pluginId,
        ...(typeof body.versionId === "string"
          ? { versionId: body.versionId }
          : {}),
        kind:
          body.kind === "render-error" ||
          body.kind === "load-error" ||
          body.kind === "reconcile-error"
            ? body.kind
            : "render-error",
        ...(typeof body.slotName === "string"
          ? { slotName: body.slotName }
          : {}),
        ...(typeof body.routePath === "string"
          ? { routePath: body.routePath }
          : {}),
        message: typeof body.message === "string" ? body.message : "",
        ...(typeof body.stack === "string" ? { stack: body.stack } : {}),
      };
      diagnostics.unshift(record);
      if (diagnostics.length > 100) {
        diagnostics.length = 100;
      }
      return c.json({ recorded: true, diagnostic: record }, 201);
    } catch {
      return c.json({ error: "Invalid JSON diagnostic payload" }, 400);
    }
  });

  app.get("/api/host/client-diagnostics", (c) => {
    return c.json({ diagnostics }, 200);
  });
}
