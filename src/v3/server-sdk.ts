import type {} from "cordis";
import type { HttpRouter, SchedulerService, ScopedDb } from "./types.js";

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
export { pluginTablePrefix } from "./scoped-db.js";

declare module "cordis" {
  interface Context {
    readonly db: ScopedDb;
    readonly http: HttpRouter;
    readonly schedule: SchedulerService;
  }
}
