import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ensureV3ClientAssets } from "./client-bundle-builder.js";
import { CompositionRelease } from "./composition-release.js";
import {
  createDeepSeekModelDriver,
  createUnconfiguredModelDriver,
} from "./deepseek-driver.js";
import {
  EvolutionLoop,
  type EvolutionBudgetConfig,
  type ModelDriver,
} from "./evolution-loop.js";
import { startV3HttpServer, type V3HttpServerHandle } from "./http-gateway.js";
import { buildPluginPackage } from "./plugin-builder.js";
import type { CompositionSnapshot, PluginArtifact } from "./types.js";

export interface StartV3AppOptions {
  readonly dataDir?: string;
  readonly seedPluginDir?: string;
  readonly hostname?: string;
  readonly port?: number;
  readonly htmlTitle?: string;
  readonly clientAssetsDir?: string;
  readonly driver?: ModelDriver;
  readonly defaultBudget?: Partial<EvolutionBudgetConfig>;
}

export interface V3AppHandle {
  readonly url: string;
  readonly port: number;
  readonly dataDir: string;
  readonly release: CompositionRelease;
  readonly evolution: EvolutionLoop;
  readonly server: V3HttpServerHandle;
  close(): Promise<void>;
}

interface SeedPluginManifest {
  readonly pluginId?: string;
  readonly id?: string;
  readonly name?: string;
  readonly dependencies?: readonly string[];
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

function readOptionalFile(filePath: string): string | undefined {
  return existsSync(filePath) ? readFileSync(filePath, "utf8") : undefined;
}

function readTestFiles(pluginDir: string): Record<string, string> {
  const testsDir = join(pluginDir, "tests");
  if (!existsSync(testsDir)) return {};
  const result: Record<string, string> = {};
  for (const entry of readdirSync(testsDir)) {
    if (!entry.endsWith(".ts") && !entry.endsWith(".tsx")) continue;
    result[entry] = readFileSync(join(testsDir, entry), "utf8");
  }
  return result;
}

export async function buildSeedPluginFromDir(
  seedPluginDir: string,
): Promise<{ composition: CompositionSnapshot; artifact: PluginArtifact }> {
  const manifestPath = join(seedPluginDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Seed plugin manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(
    readFileSync(manifestPath, "utf8"),
  ) as SeedPluginManifest;
  const pluginId = manifest.pluginId ?? manifest.id;
  if (!pluginId) {
    throw new Error(`Seed plugin manifest missing pluginId: ${manifestPath}`);
  }
  const artifact = await buildPluginPackage({
    pluginId,
    name: manifest.name ?? pluginId,
    dependencies: [...(manifest.dependencies ?? [])],
    contractTypes: readOptionalFile(join(seedPluginDir, "contract.d.ts")),
    serverSource: readOptionalFile(join(seedPluginDir, "server.ts")),
    clientSource: readOptionalFile(join(seedPluginDir, "client.tsx")),
    testFiles: readTestFiles(seedPluginDir),
  });
  const composition: CompositionSnapshot = {
    compositionId: `seed-${artifact.pluginId}-v1`,
    parentCompositionId: null,
    members: [
      {
        pluginId: artifact.pluginId,
        versionId: artifact.versionId,
        enabled: true,
      },
    ],
    createdAt: new Date().toISOString(),
  };
  return { composition, artifact };
}

export async function startV3App(
  options: StartV3AppOptions = {},
): Promise<V3AppHandle> {
  const dataDir = resolve(
    options.dataDir ?? process.env.V3_DATA_DIR ?? ".runtime/v3",
  );
  const seedPluginDir = resolve(
    options.seedPluginDir ??
      process.env.V3_SEED_PLUGIN_DIR ??
      "plugins/todo-core",
  );
  const hostname = options.hostname ?? process.env.HOST ?? "127.0.0.1";
  const port = options.port ?? Number(process.env.PORT ?? 4517);
  const htmlTitle =
    options.htmlTitle ??
    process.env.V3_APP_TITLE ??
    "Cordis Self-Iteration Host";

  mkdirSync(dataDir, { recursive: true });
  const clientAssetsDir =
    options.clientAssetsDir ?? (await ensureV3ClientAssets());

  const release = new CompositionRelease({
    controlDbPath: join(dataDir, "control.db"),
    businessDbPath: join(dataDir, "business.db"),
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
      ? createDeepSeekModelDriver({
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

  const server = await startV3HttpServer(release.runtime, {
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
  startV3App()
    .then((app) => {
      console.log(`[v3] SupervisorShell listening on ${app.url}`);
      console.log(`[v3] Data directory: ${app.dataDir}`);
      const shutdown = () => {
        void app.close().finally(() => process.exit(0));
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);
    })
    .catch((err) => {
      console.error("[v3] Failed to start server:", err);
      process.exit(1);
    });
}
