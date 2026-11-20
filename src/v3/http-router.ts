import type { Fiber } from "cordis";
import type {
  AppRequest,
  AppResponse,
  HttpDispatchInput,
  HttpMethod,
  HttpRouter,
  RouteDescriptor,
  RouteHandlerResult,
} from "./types.js";

interface CompiledRoute {
  readonly id: number;
  readonly pluginId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly canonicalKey: string;
  readonly segments: readonly string[];
  readonly handler: (
    req: AppRequest,
  ) => Promise<RouteHandlerResult> | RouteHandlerResult;
}

function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.replace(/\/+$/, "");
  }
  return path;
}

export function normalizeRoutePath(pluginId: string, subPath: string): string {
  const trimmed = subPath.trim();
  if (trimmed.startsWith("/api/app/")) {
    return stripTrailingSlash(trimmed.replace(/\/{2,}/g, "/"));
  }
  const base = `/api/app/${pluginId}`;
  if (!trimmed || trimmed === "/") {
    return base;
  }
  const suffix = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return stripTrailingSlash(`${base}${suffix}`.replace(/\/{2,}/g, "/"));
}

function splitPath(path: string): string[] {
  const normalized = stripTrailingSlash(path.replace(/\/{2,}/g, "/"));
  if (normalized === "/") return [];
  return normalized.slice(1).split("/");
}

function buildCanonicalKey(method: HttpMethod, segments: readonly string[]): string {
  const pattern = segments
    .map((seg) => (seg.startsWith(":") ? ":*" : seg))
    .join("/");
  return `${method} /${pattern}`;
}

function matchSegments(
  routeSegments: readonly string[],
  requestSegments: readonly string[],
): Record<string, string> | null {
  if (routeSegments.length !== requestSegments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < routeSegments.length; i += 1) {
    const rSeg = routeSegments[i];
    const qSeg = requestSegments[i];
    if (rSeg.startsWith(":")) {
      params[rSeg.slice(1)] = decodeURIComponent(qSeg);
    } else if (rSeg !== qSeg) {
      return null;
    }
  }
  return params;
}

function isPlainAppResponse(value: unknown): value is AppResponse {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.status !== "number") return false;
  const keys = Object.keys(record);
  if (keys.length === 0) return false;
  return keys.every((k) => k === "status" || k === "headers" || k === "body");
}

async function normalizeHandlerResult(result: RouteHandlerResult): Promise<AppResponse> {
  if (result instanceof Response) {
    const headers: Record<string, string> = {};
    result.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const contentType = result.headers.get("content-type") ?? "";
    let body: unknown = undefined;
    if (result.status !== 204) {
      const text = await result.text();
      if (text.length > 0) {
        if (contentType.includes("application/json")) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        } else {
          body = text;
        }
      }
    }
    return { status: result.status, headers, body };
  }

  if (isPlainAppResponse(result)) {
    return {
      status: result.status,
      headers: result.headers,
      body: result.body,
    };
  }

  if (result === undefined) {
    return { status: 204 };
  }

  return { status: 200, body: result };
}

export class HttpRouteRegistry {
  private seq = 0;
  private readonly routesByKey = new Map<string, CompiledRoute>();
  private readonly routesById = new Map<number, CompiledRoute>();

  createScopedRouter(pluginId: string, fiber: Fiber): HttpRouter {
    return {
      route: (method, subPath, handler) => {
        const fullPath = normalizeRoutePath(pluginId, subPath);
        const segments = splitPath(fullPath);
        const canonicalKey = buildCanonicalKey(method, segments);

        const existing = this.routesByKey.get(canonicalKey);
        if (existing) {
          throw new Error(
            `Route conflict: ${method} ${fullPath} is already registered by plugin "${existing.pluginId}"`,
          );
        }

        const id = ++this.seq;
        const entry: CompiledRoute = {
          id,
          pluginId,
          method,
          path: fullPath,
          canonicalKey,
          segments,
          handler,
        };

        const disposeEffect = fiber.effect(() => {
          const current = this.routesByKey.get(canonicalKey);
          if (current && current.id !== id) {
            throw new Error(
              `Route conflict: ${method} ${fullPath} is already registered by plugin "${current.pluginId}"`,
            );
          }
          this.routesByKey.set(canonicalKey, entry);
          this.routesById.set(id, entry);
          return () => {
            if (this.routesByKey.get(canonicalKey)?.id === id) {
              this.routesByKey.delete(canonicalKey);
            }
            this.routesById.delete(id);
          };
        }, `http.route(${method} ${fullPath})`);

        let disposed = false;
        return () => {
          if (disposed) return;
          disposed = true;
          void disposeEffect();
        };
      },
    };
  }

  async dispatch(input: HttpDispatchInput): Promise<AppResponse> {
    const requestSegments = splitPath(input.path);
    let matched: CompiledRoute | undefined;
    let params: Record<string, string> = {};

    for (const candidate of this.routesById.values()) {
      if (candidate.method !== input.method) continue;
      const m = matchSegments(candidate.segments, requestSegments);
      if (m) {
        matched = candidate;
        params = m;
        break;
      }
    }

    if (!matched) {
      return {
        status: 404,
        body: { error: `No route for ${input.method} ${input.path}` },
      };
    }

    const appReq: AppRequest = {
      method: input.method,
      path: stripTrailingSlash(input.path),
      params,
      query: input.query ?? {},
      headers: input.headers ?? {},
      body: input.body,
      rawBody: input.rawBody,
    };

    try {
      const result = await matched.handler(appReq);
      return await normalizeHandlerResult(result);
    } catch (error) {
      const err = error as Error & { status?: number };
      const status =
        typeof err.status === "number" && err.status >= 400 && err.status < 600
          ? err.status
          : 500;
      return {
        status,
        body: { error: err?.message ?? String(error) },
      };
    }
  }

  listRoutes(pluginId?: string): RouteDescriptor[] {
    const routes: RouteDescriptor[] = [];
    for (const entry of this.routesById.values()) {
      if (pluginId && entry.pluginId !== pluginId) continue;
      routes.push({
        pluginId: entry.pluginId,
        method: entry.method,
        path: entry.path,
      });
    }
    return routes;
  }
}
