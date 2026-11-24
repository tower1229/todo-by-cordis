import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import {
  ensureClientAssets,
  renderHostHtml,
} from "../../runtime/client/bundle-builder.js";
import {
  type EvolutionHttpController,
  registerEvolutionRoutes,
} from "./routes-evolution.js";
import {
  type ReleaseHttpController,
  registerReleaseRoutes,
} from "./routes-release.js";
import { registerRuntimeRoutes } from "./routes-runtime.js";
import type { PreviewBannerContext } from "../../release/preview-session.js";
import type {
  ClientDiagnostic,
  HttpMethod,
  ServerCordisRuntime,
} from "../../contracts/types.js";

export type { EvolutionHttpController, ReleaseHttpController };

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

export interface HostGatewayContext {
  readonly app: Hono;
  getClientDiagnostics(): readonly ClientDiagnostic[];
  disconnectSseClients(): number;
}

export interface CreateHostGatewayOptions {
  readonly clientAssetsDir?: string;
  readonly htmlTitle?: string;
  readonly sseHeartbeatMs?: number;
  readonly releaseController?: ReleaseHttpController;
  readonly evolutionController?: EvolutionHttpController;
  readonly previewContext?: PreviewBannerContext;
}

export function createHostGateway(
  runtime: ServerCordisRuntime,
  options?: CreateHostGatewayOptions,
): HostGatewayContext {
  const app = new Hono();
  const encoder = new TextEncoder();
  const activeSseClosers = new Set<() => void>();
  const diagnostics: ClientDiagnostic[] = [];
  const heartbeatMs = options?.sseHeartbeatMs ?? 15000;
  const resolvedAssetsDir = options?.clientAssetsDir
    ? resolve(options.clientAssetsDir)
    : null;

  registerRuntimeRoutes({
    app,
    runtime,
    encoder,
    heartbeatMs,
    activeSseClosers,
    diagnostics,
  });

  registerReleaseRoutes({
    app,
    releaseController: options?.releaseController,
    previewContext: options?.previewContext,
  });

  registerEvolutionRoutes({
    app,
    evolutionController: options?.evolutionController,
    encoder,
    heartbeatMs,
    activeSseClosers,
  });

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

  app.get("/assets/host/*", (c) => {
    if (!resolvedAssetsDir) {
      return c.json({ error: "Client assets directory is not configured" }, 404);
    }
    const url = new URL(c.req.url);
    const relPath = decodeURIComponent(url.pathname.slice("/assets/host/".length));
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
        return new Response(null, { status: res.status, headers: responseHeaders });
      }
      if (typeof res.body === "string") {
        if (!responseHeaders.has("content-type")) {
          responseHeaders.set("content-type", "text/plain; charset=utf-8");
        }
        return new Response(res.body, { status: res.status, headers: responseHeaders });
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
    new Response(renderHostHtml({ title: options?.htmlTitle }), {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-cache",
      },
    });

  app.get("/", () => serveHostHtml());
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

export function createHostApp(
  runtime: ServerCordisRuntime,
  options?: CreateHostGatewayOptions,
): Hono {
  return createHostGateway(runtime, options).app;
}

export interface HostServerHandle {
  readonly url: string;
  readonly port: number;
  getClientDiagnostics(): readonly ClientDiagnostic[];
  disconnectSseClients(): number;
  close(): Promise<void>;
}

export interface StartHostServerOptions extends CreateHostGatewayOptions {
  readonly port?: number;
  readonly hostname?: string;
  readonly enableClientHost?: boolean;
}

export async function startHostServer(
  runtime: ServerCordisRuntime,
  options?: StartHostServerOptions,
): Promise<HostServerHandle> {
  let clientAssetsDir = options?.clientAssetsDir;
  if (!clientAssetsDir && options?.enableClientHost !== false) {
    clientAssetsDir = await ensureClientAssets();
  }

  const gateway = createHostGateway(runtime, {
    ...options,
    ...(clientAssetsDir ? { clientAssetsDir } : {}),
  });
  const hostname = options?.hostname ?? "127.0.0.1";
  const requestedPort = options?.port ?? 0;

  return new Promise<HostServerHandle>((resolveServer, reject) => {
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
              if (
                "closeAllConnections" in server &&
                typeof server.closeAllConnections === "function"
              ) {
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
