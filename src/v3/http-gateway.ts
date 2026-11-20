import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { AddressInfo } from "node:net";
import type { HttpMethod, ServerCordisRuntime } from "./types.js";

const ALLOWED_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

export function createV3HttpApp(runtime: ServerCordisRuntime): Hono {
  const app = new Hono();

  app.get("/api/v3/runtime/introspect", async (c) => {
    try {
      const topology = await runtime.introspect();
      return c.json(topology, 200);
    } catch (error) {
      const err = error as Error;
      return c.json({ error: err?.message ?? String(error) }, 503);
    }
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

  return app;
}

export interface V3HttpServerHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startV3HttpServer(
  runtime: ServerCordisRuntime,
  options?: { readonly port?: number; readonly hostname?: string },
): Promise<V3HttpServerHandle> {
  const app = createV3HttpApp(runtime);
  const hostname = options?.hostname ?? "127.0.0.1";
  const requestedPort = options?.port ?? 0;

  return new Promise<V3HttpServerHandle>((resolve, reject) => {
    const server = serve(
      {
        fetch: app.fetch,
        port: requestedPort,
        hostname,
      },
      (info: AddressInfo) => {
        resolve({
          url: `http://${hostname}:${info.port}`,
          port: info.port,
          close: () =>
            new Promise<void>((res, rej) => {
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
