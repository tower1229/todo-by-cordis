import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import type { ServerType } from "@hono/node-server";
import {
  Workspace,
  type WorkspaceOpenOptions,
} from "../workspace.js";
import { createApp, type CreateAppOptions } from "../app.js";
import { ExperienceSessionHost } from "../experience-session.js";
import type { AssistantService } from "../assistant.js";
import type { HostClock, ControllableClock } from "./clock.js";

export type ClosableAssistant = AssistantService & {
  close?: () => Promise<void>;
};

export type HostBootstrapResult = {
  workspace: Workspace;
  experienceSessions: ExperienceSessionHost;
  assistant?: ClosableAssistant;
  app: ReturnType<typeof createApp>;
  server: ServerType;
  stop: () => Promise<void>;
};

export type HostBootstrapOptions = {
  port: number;
  hostname?: string;
  /** Open a new workspace at this path (ignored when workspace is provided). */
  databasePath?: string;
  /** Reuse an already-opened workspace (e.g. after e2e seeding). */
  workspace?: Workspace;
  /** Injected into Workspace.open; production omits (system clock). */
  clock?: HostClock;
  /** When set, mounts /api/test/clock* (test harness only). */
  testClock?: ControllableClock;
  createAssistant?: (
    workspace: Workspace,
    sessions: ExperienceSessionHost,
  ) => ClosableAssistant | undefined;
  staticRoot?: string;
  logLabel?: string;
  /** Defaults to true (production). Set false when the caller owns process exit. */
  exitOnStop?: boolean;
  workspaceOptions?: Omit<WorkspaceOpenOptions, "clock">;
};

/**
 * Shared host HTTP bootstrap for production main and e2e servers.
 * Clock / testClock are optional host-test DI only.
 */
export async function startHost(
  options: HostBootstrapOptions,
): Promise<HostBootstrapResult> {
  const workspace =
    options.workspace ??
    (await Workspace.open(
      options.databasePath ??
        (() => {
          throw new Error("databasePath or workspace is required");
        })(),
      {
        ...options.workspaceOptions,
        ...(options.clock ? { clock: options.clock } : {}),
      },
    ));
  const experienceSessions = new ExperienceSessionHost(workspace);
  const assistant = options.createAssistant?.(workspace, experienceSessions);
  const appOptions: CreateAppOptions = {};
  if (options.testClock) appOptions.testClock = options.testClock;
  const app = createApp(
    workspace,
    assistant,
    experienceSessions,
    appOptions,
  );
  const root = options.staticRoot ?? "./dist/web";
  app.use("/*", serveStatic({ root }));
  app.get("*", serveStatic({ path: `${root}/index.html` }));
  const hostname = options.hostname ?? "127.0.0.1";
  const server = serve(
    {
      fetch: app.fetch,
      hostname,
      port: options.port,
    },
    (info) =>
      console.log(
        `${options.logLabel ?? "Cordis"}: http://${hostname}:${info.port}`,
      ),
  );
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await assistant?.close?.();
    await experienceSessions.close();
    await workspace.close();
    if (options.exitOnStop !== false) process.exit(0);
  };
  process.on("SIGINT", () => {
    void stop();
  });
  process.on("SIGTERM", () => {
    void stop();
  });
  return {
    workspace,
    experienceSessions,
    assistant,
    app,
    server,
    stop,
  };
}
