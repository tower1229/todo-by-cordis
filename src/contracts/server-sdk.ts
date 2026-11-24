import type { Context } from "cordis";
import type {
  AppResponse,
  ClientDiagnostic,
  CompositionTopology,
  HttpDispatchInput,
  HttpRouter,
  SchedulerService,
  ScopedDb,
} from "./types.js";

export type {
  AppRequest,
  AppResponse,
  HttpMethod,
  HttpRouter,
  PluginArtifact,
  PluginManifest,
  RouteHandlerResult,
  SchedulerService,
  ScopedDb,
  ScopedStatement,
} from "./types.js";
export { pluginTablePrefix } from "../runtime/server/scoped-db.js";

export interface PluginContractTestContext {
  request(input: HttpDispatchInput): Promise<AppResponse>;
  introspect(): Promise<CompositionTopology>;
  openBrowserPage(path?: string): Promise<{
    readonly baseUrl: string;
    readonly page: unknown;
    readonly pageErrors: readonly string[];
    readonly consoleErrors: readonly string[];
    getClientDiagnostics(): readonly ClientDiagnostic[];
    close(): Promise<void>;
  }>;
}

export type PluginTestContext = PluginContractTestContext;

/**
 * Execute an asynchronous server-side bail hook via Cordis's public `events.dispatch` API.
 * Mirrors `dispatchClientBail` in `@host/client-sdk`: respects Cordis scope filtering and
 * priority ordering, and short-circuits on `false` or a non-empty reason string.
 */
export async function dispatchServerBail<TPayload>(
  ctx: Context,
  eventName: string,
  payload: TPayload,
): Promise<void | false | string> {
  const events = (
    ctx as unknown as {
      events?: {
        dispatch(
          type: string,
          args: unknown[],
        ): Array<
          (
            payload: TPayload,
          ) => Promise<void | false | string> | void | false | string
        >;
      };
    }
  ).events;
  const callbacks = events?.dispatch("serial", [eventName]) ?? [];
  for (const callback of callbacks) {
    const verdict = await callback(payload);
    if (verdict === false) return false;
    if (typeof verdict === "string" && verdict.length > 0) return verdict;
  }
}

declare module "cordis" {
  interface Context {
    readonly db: ScopedDb;
    readonly http: HttpRouter;
    readonly schedule: SchedulerService;
  }
}
