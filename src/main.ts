import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureClientAssets } from "./runtime/client/bundle-builder.js";
import { CompositionRelease } from "./release/composition-release.js";
import {
  createDeepSeekDriver,
  createUnconfiguredModelDriver,
} from "./evolution/model/deepseek.js";
import {
  EvolutionLoop,
  type EvolutionBudgetConfig,
  type ModelDriver,
} from "./evolution/loop.js";
import { startHostServer, type HostServerHandle } from "./supervisor/server/gateway.js";
import { buildSeedPluginFromDir } from "./build/plugin-builder.js";

export { buildSeedPluginFromDir };

export interface StartHostAppOptions {
  readonly dataDir?: string;
  readonly seedPluginDir?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly htmlTitle?: string;
  readonly clientAssetsDir?: string;
  readonly driver?: ModelDriver;
  readonly defaultBudget?: Partial<EvolutionBudgetConfig>;
}

export interface HostAppHandle {
  readonly url: string;
  readonly port: number;
  readonly dataDir: string;
  readonly release: CompositionRelease;
  readonly evolution: EvolutionLoop;
  readonly server: HostServerHandle;
  close(): Promise<void>;
}

export function loadDotEnvIfPresent(
  envPath = resolve(".env"),
  targetEnv: NodeJS.ProcessEnv = process.env,
): void {
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx <= 0) continue;
    const key = line.slice(0, eqIdx).trim();
    if (!key || targetEnv[key] !== undefined) continue;
    let value = line.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    targetEnv[key] = value;
  }
}

export async function startHostApp(
  options: StartHostAppOptions = {},
): Promise<HostAppHandle> {
  const dataDir = resolve(
    options.dataDir ?? process.env.APP_DATA_DIR ?? ".runtime/host",
  );
  const seedPluginDir = resolve(
    options.seedPluginDir ??
      process.env.SEED_PLUGIN_DIR ??
      "plugins/todo-core",
  );
  const hostname = options.hostname ?? process.env.HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.PORT ?? 4517);
  const htmlTitle =
    options.htmlTitle ??
    process.env.APP_TITLE ??
    "Cordis Self-Iteration Host";

  mkdirSync(dataDir, { recursive: true });
  const clientAssetsDir =
    options.clientAssetsDir ?? (await ensureClientAssets());

  const release = new CompositionRelease({
    controlDbPath: join(dataDir, "supervisor.db"),
    businessDbPath: join(dataDir, "app.db"),
    workDir: join(dataDir, "work"),
    clientAssetsDir,
    enablePreviewClientHost: true,
  });

  const existingStatus = release.getStatus();
  if (existingStatus.activeComposition) {
    await release.bootstrap();
  } else {
    const seed = await buildSeedPluginFromDir(seedPluginDir);
    await release.bootstrap({
      composition: seed.composition,
      artifacts: [seed.artifact],
    });
  }

  const driver =
    options.driver ??
    (process.env.DEEPSEEK_API_KEY
      ? createDeepSeekDriver({
          apiKey: process.env.DEEPSEEK_API_KEY,
          ...(process.env.DEEPSEEK_ENDPOINT
            ? { endpoint: process.env.DEEPSEEK_ENDPOINT }
            : {}),
        })
      : createUnconfiguredModelDriver());

  const evolution = new EvolutionLoop({
    release,
    modelDriver: driver,
    ...(options.defaultBudget
      ? { defaultBudget: options.defaultBudget }
      : {}),
  });
  evolution.recoverOnStartup();
  release.setEvolutionController(evolution);

  const server = await startHostServer(release.runtime, {
    hostname,
    port,
    htmlTitle,
    clientAssetsDir,
    enableClientHost: true,
    releaseController: release,
    evolutionController: evolution,
  });
  release.setProductionUrl(server.url);

  let closed = false;
  return {
    url: server.url,
    port: server.port,
    dataDir,
    release,
    evolution,
    server,
    async close() {
      if (closed) return;
      closed = true;
      await evolution.close();
      await server.close();
      await release.close();
    },
  };
}

const isDirectEntry =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectEntry) {
  loadDotEnvIfPresent();
  startHostApp()
    .then((app) => {
      console.log(`[host] SupervisorShell listening on ${app.url}`);
      console.log(`[host] Data directory: ${app.dataDir}`);
      const shutdown = () => {
        void app.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("[host] Failed to start server:", err);
      process.exit(1);
    });
}
