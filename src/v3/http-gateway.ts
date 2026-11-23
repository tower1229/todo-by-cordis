import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import {
  ensureV3ClientAssets,
  renderV3HostHtml,
} from "./client-bundle-builder.js";
import type {
  ApplyCandidateInput,
  ReleaseStatusSnapshot,
  ReleaseTransitionResult,
} from "./composition-release.js";
import type {
  EvolutionBudgetConfig,
  EvolutionRunView,
  EvolutionStreamEvent,
} from "./evolution-loop.js";
import type {
  PreviewBannerContext,
  PreviewSessionInfo,
} from "./preview-session.js";
import type {
  ActiveClientComposition,
  ClientDiagnostic,
  HttpMethod,
  ServerCordisRuntime,
} from "./types.js";

export interface ReleaseHttpController {
  getStatus(): ReleaseStatusSnapshot;
  openPreview(candidateId: string): Promise<PreviewSessionInfo>;
  closePreview(sessionId: string): Promise<boolean>;
  getPreviewSession(sessionId: string): PreviewSessionInfo | undefined;
  apply(input: ApplyCandidateInput): Promise<ReleaseTransitionResult>;
  rollback(targetCompositionId: string): Promise<ReleaseTransitionResult>;
}

export interface EvolutionHttpController {
  listRuns(): EvolutionRunView[];
  getRun(runId: string): EvolutionRunView | undefined;
  startRun(
    prompt: string,
    options?: { readonly budget?: Partial<EvolutionBudgetConfig> },
  ): Promise<EvolutionRunView>;
  answerClarification(
    runId: string,
    answer: string,
  ): Promise<EvolutionRunView>;
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

const ALLOWED_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

function contentTypeForFile(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".mjs":
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    default:
      return "application/octet-stream";
  }
}

export interface V3HttpGatewayContext {
  readonly app: Hono;
  getClientDiagnostics(): readonly ClientDiagnostic[];
  disconnectSseClients(): number;
}

export interface CreateV3HttpAppOptions {
  readonly clientAssetsDir?: string;
  readonly htmlTitle?: string;
  readonly sseHeartbeatMs?: number;
  readonly releaseController?: ReleaseHttpController;
  readonly evolutionController?: EvolutionHttpController;
  readonly previewContext?: PreviewBannerContext;
}

export function createV3HttpGateway(
  runtime: ServerCordisRuntime,
  options?: CreateV3HttpAppOptions,
): V3HttpGatewayContext {
  const app = new Hono();
  const encoder = new TextEncoder();
  const activeSseClosers = new Set<() => void>();
  const diagnostics: ClientDiagnostic[] = [];
  const heartbeatMs = options?.sseHeartbeatMs ?? 15000;
  const resolvedAssetsDir = options?.clientAssetsDir
    ? resolve(options.clientAssetsDir)
    : null;

  app.get("/api/v3/runtime/introspect", async (c) => {
    try {
      const topology = await runtime.introspect();
      return c.json(topology, 200);
    } catch (error) {
      const err = error as Error;
      return c.json({ error: err?.message ?? String(error) }, 503);
    }
  });

  app.get("/api/v3/client/composition", (c) => {
    return c.json(runtime.getActiveClientComposition(), 200);
  });

  app.get("/api/v3/client/events", (c) => {
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

        // Fast reconnect backoff + authoritative full composition snapshot on handshake
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

  app.post("/api/v3/client-diagnostics", async (c) => {
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

  app.get("/api/v3/client-diagnostics", (c) => {
    return c.json({ diagnostics }, 200);
  });

  if (options?.releaseController) {
    const release = options.releaseController;
    const previewContext = options.previewContext ?? null;

    const toReleaseErrorResponse = (error: unknown) => {
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
    };

    app.get("/api/v3/release/status", (c) => {
      return c.json(
        {
          ...release.getStatus(),
          previewContext,
        },
        200,
      );
    });

    app.post("/api/v3/release/preview", async (c) => {
      try {
        const body = (await c.req.json()) as { candidateId?: string };
        if (!body || typeof body.candidateId !== "string") {
          return c.json({ error: "candidateId is required" }, 400);
        }
        const session = await release.openPreview(body.candidateId);
        return c.json({ session }, 201);
      } catch (error) {
        const mapped = toReleaseErrorResponse(error);
        return c.json(mapped.body, mapped.status);
      }
    });

    app.delete("/api/v3/release/preview/:sessionId", async (c) => {
      const sessionId = c.req.param("sessionId");
      const closed = await release.closePreview(sessionId);
      if (!closed) {
        return c.json({ error: `Preview session ${sessionId} not found` }, 404);
      }
      return c.json({ closed: true, sessionId }, 200);
    });

    app.post("/api/v3/release/apply", async (c) => {
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
            {
              error:
                "candidateId and expectedBaseCompositionId are required",
            },
            400,
          );
        }
        const result = await release.apply({
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

    app.post("/api/v3/release/rollback", async (c) => {
      try {
        const body = (await c.req.json()) as { targetCompositionId?: string };
        if (!body || typeof body.targetCompositionId !== "string") {
          return c.json({ error: "targetCompositionId is required" }, 400);
        }
        const result = await release.rollback(body.targetCompositionId);
        return c.json(result, 200);
      } catch (error) {
        const mapped = toReleaseErrorResponse(error);
        return c.json(mapped.body, mapped.status);
      }
    });

    app.get("/preview/:sessionId", (c) => {
      const sessionId = c.req.param("sessionId");
      const session = release.getPreviewSession(sessionId);
      if (!session) {
        return c.json({ error: `Preview session ${sessionId} not found` }, 404);
      }
      return c.redirect(session.previewUrl, 302);
    });
  } else {
    app.get("/api/v3/release/status", (c) => {
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
  }

  const evolutionController = options?.evolutionController;
  if (evolutionController) {
    const mapEvoError = (error: unknown) => {
      const err = error as Error & { statusCode?: number; code?: string };
      const status =
        typeof err?.statusCode === "number" ? err.statusCode : 500;
      return {
        status,
        body: {
          error: err?.message ?? String(error),
          ...(err?.code ? { code: err.code } : {}),
        },
      };
    };

    app.get("/api/v3/evolution/runs", (c) => {
      return c.json({ runs: evolutionController.listRuns() }, 200);
    });

    app.get("/api/v3/evolution/runs/:runId", (c) => {
      const run = evolutionController.getRun(c.req.param("runId"));
      if (!run) {
        return c.json({ error: "Run not found" }, 404);
      }
      return c.json({ run }, 200);
    });

    app.post("/api/v3/evolution/runs", async (c) => {
      try {
        const body = (await c.req.json()) as {
          prompt?: string;
          budget?: Partial<EvolutionBudgetConfig>;
        };
        const run = await evolutionController.startRun(
          body.prompt ?? "",
          body.budget ? { budget: body.budget } : undefined,
        );
        return c.json({ run }, 201);
      } catch (error) {
        const mapped = mapEvoError(error);
        return c.json(mapped.body, mapped.status as 400);
      }
    });

    app.post("/api/v3/evolution/runs/:runId/clarify", async (c) => {
      try {
        const body = (await c.req.json()) as { answer?: string };
        const run = await evolutionController.answerClarification(
          c.req.param("runId"),
          body.answer ?? "",
        );
        return c.json({ run }, 200);
      } catch (error) {
        const mapped = mapEvoError(error);
        return c.json(mapped.body, mapped.status as 400);
      }
    });

    app.post("/api/v3/evolution/runs/:runId/budget", async (c) => {
      try {
        const body = (await c.req.json()) as {
          additionalCalls?: number;
          additionalActiveMs?: number;
        };
        const run = await evolutionController.extendBudget(
          c.req.param("runId"),
          {
            additionalCalls: body.additionalCalls,
            additionalActiveMs: body.additionalActiveMs,
          },
        );
        return c.json({ run }, 200);
      } catch (error) {
        const mapped = mapEvoError(error);
        return c.json(mapped.body, mapped.status as 400);
      }
    });

    app.post("/api/v3/evolution/runs/:runId/continue", async (c) => {
      try {
        const body = (await c.req.json()) as { message?: string };
        const run = await evolutionController.continueInPreview(
          c.req.param("runId"),
          body.message ?? "",
        );
        return c.json({ run }, 200);
      } catch (error) {
        const mapped = mapEvoError(error);
        return c.json(mapped.body, mapped.status as 400);
      }
    });

    app.post("/api/v3/evolution/runs/:runId/cancel", async (c) => {
      try {
        const run = await evolutionController.cancelRun(c.req.param("runId"));
        return c.json({ run }, 200);
      } catch (error) {
        const mapped = mapEvoError(error);
        return c.json(mapped.body, mapped.status as 400);
      }
    });

    app.post("/api/v3/evolution/runs/:runId/restore-preview", async (c) => {
      try {
        const session = await evolutionController.restorePreview(
          c.req.param("runId"),
        );
        return c.json({ session }, 200);
      } catch (error) {
        const mapped = mapEvoError(error);
        return c.json(mapped.body, mapped.status as 400);
      }
    });

    app.post("/api/v3/evolution/runs/:runId/apply", async (c) => {
      try {
        const result = await evolutionController.applyRun(c.req.param("runId"));
        return c.json({ result }, 200);
      } catch (error) {
        const mapped = mapEvoError(error);
        return c.json(mapped.body, mapped.status as 400);
      }
    });

    app.get("/api/v3/evolution/events", (c) => {
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
  } else {
    app.get("/api/v3/evolution/runs", (c) => {
      return c.json({ runs: [], enabled: false }, 200);
    });
  }

  app.get("/plugins/:pluginId/:versionId/client.mjs", (c) => {
    const pluginId = c.req.param("pluginId");
    const versionId = c.req.param("versionId");
    const artifact = runtime.getArtifact(pluginId, versionId);
    if (!artifact || artifact.clientCode === undefined) {
      return c.json(
        { error: `Client module not found for ${pluginId}@${versionId}` },
        404,
      );
    }
    return new Response(artifact.clientCode, {
      status: 200,
      headers: {
        "content-type": "application/javascript; charset=utf-8",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  app.get("/assets/v3/*", (c) => {
    if (!resolvedAssetsDir) {
      return c.json({ error: "Client assets directory is not configured" }, 404);
    }
    const url = new URL(c.req.url);
    const relPath = decodeURIComponent(
      url.pathname.slice("/assets/v3/".length),
    );
    if (!relPath || relPath.includes("\0")) {
      return c.json({ error: "Invalid asset path" }, 400);
    }
    const targetPath = resolve(resolvedAssetsDir, relPath);
    if (
      targetPath !== resolvedAssetsDir &&
      !targetPath.startsWith(`${resolvedAssetsDir}${sep}`)
    ) {
      return c.json({ error: "Forbidden asset path" }, 403);
    }
    if (!existsSync(targetPath) || !statSync(targetPath).isFile()) {
      return c.json({ error: "Asset not found" }, 404);
    }
    const content = readFileSync(targetPath);
    return new Response(content, {
      status: 200,
      headers: {
        "content-type": contentTypeForFile(targetPath),
        "cache-control": "no-cache",
      },
    });
  });

  app.all("/api/app/*", async (c) => {
    const method = c.req.method.toUpperCase() as HttpMethod;
    if (!ALLOWED_METHODS.has(method)) {
      return c.json({ error: `Method ${method} not allowed` }, 405);
    }

    const url = new URL(c.req.url);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });

    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    let body: unknown = undefined;
    let rawBody: string | undefined = undefined;
    if (method !== "GET" && method !== "DELETE") {
      rawBody = await c.req.text();
      if (rawBody.length > 0) {
        const contentType = headers["content-type"] ?? "";
        if (contentType.includes("application/json")) {
          try {
            body = JSON.parse(rawBody);
          } catch {
            return c.json({ error: "Invalid JSON request body" }, 400);
          }
        } else {
          body = rawBody;
        }
      }
    }

    try {
      const res = await runtime.handleHttpRequest({
        method,
        path: url.pathname,
        query,
        headers,
        body,
        rawBody,
      });

      const responseHeaders = new Headers(res.headers);
      if (res.status === 204 || res.body === undefined) {
        return new Response(null, {
          status: res.status,
          headers: responseHeaders,
        });
      }
      if (typeof res.body === "string") {
        if (!responseHeaders.has("content-type")) {
          responseHeaders.set("content-type", "text/plain; charset=utf-8");
        }
        return new Response(res.body, {
          status: res.status,
          headers: responseHeaders,
        });
      }
      if (!responseHeaders.has("content-type")) {
        responseHeaders.set("content-type", "application/json; charset=utf-8");
      }
      return new Response(JSON.stringify(res.body), {
        status: res.status,
        headers: responseHeaders,
      });
    } catch (error) {
      const err = error as Error;
      const msg = err?.message ?? String(error);
      const isTimeout = /timeout|超时/i.test(msg);
      return c.json({ error: msg }, isTimeout ? 504 : 503);
    }
  });

  const serveHostHtml = () =>
    new Response(renderV3HostHtml({ title: options?.htmlTitle }), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });

  app.get("/", () => serveHostHtml());
  // Client-side plugin routes SPA fallback (exclude API, plugins, assets)
  app.get("*", (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (
      pathname.startsWith("/api/") ||
      pathname.startsWith("/plugins/") ||
      pathname.startsWith("/assets/")
    ) {
      return c.json({ error: "Not found" }, 404);
    }
    return serveHostHtml();
  });

  return {
    app,
    getClientDiagnostics: () => [...diagnostics],
    disconnectSseClients: () => {
      const count = activeSseClosers.size;
      for (const close of [...activeSseClosers]) {
        close();
      }
      return count;
    },
  };
}

export function createV3HttpApp(
  runtime: ServerCordisRuntime,
  options?: CreateV3HttpAppOptions,
): Hono {
  return createV3HttpGateway(runtime, options).app;
}

export interface V3HttpServerHandle {
  readonly url: string;
  readonly port: number;
  getClientDiagnostics(): readonly ClientDiagnostic[];
  disconnectSseClients(): number;
  close(): Promise<void>;
}

export interface StartV3HttpServerOptions extends CreateV3HttpAppOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly enableClientHost?: boolean;
}

export async function startV3HttpServer(
  runtime: ServerCordisRuntime,
  options?: StartV3HttpServerOptions,
): Promise<V3HttpServerHandle> {
  let clientAssetsDir = options?.clientAssetsDir;
  if (!clientAssetsDir && options?.enableClientHost !== false) {
    clientAssetsDir = await ensureV3ClientAssets();
  }

  const gateway = createV3HttpGateway(runtime, {
    ...options,
    ...(clientAssetsDir ? { clientAssetsDir } : {}),
  });
  const hostname = options?.hostname ?? "127.0.0.1";
  const requestedPort = options?.port ?? 0;

  return new Promise<V3HttpServerHandle>((resolveServer, reject) => {
    const server = serve(
      {
        fetch: gateway.app.fetch,
        port: requestedPort,
        hostname,
      },
      (info: AddressInfo) => {
        resolveServer({
          url: `http://${hostname}:${info.port}`,
          port: info.port,
          getClientDiagnostics: gateway.getClientDiagnostics,
          disconnectSseClients: gateway.disconnectSseClients,
          close: () =>
            new Promise<void>((res, rej) => {
              gateway.disconnectSseClients();
              if ("closeAllConnections" in server && typeof server.closeAllConnections === "function") {
                server.closeAllConnections();
              }
              server.close((err) => {
                if (err) rej(err);
                else res();
              });
            }),
        });
      },
    );
    server.on("error", reject);
  });
}
