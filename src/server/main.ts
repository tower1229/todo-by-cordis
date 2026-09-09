import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "./workspace.js";
import { createApp } from "./app.js";
import { existsSync } from "node:fs";
import { Evolution } from "../evolution/evolution.js";
import { Gemini } from "../evolution/gemini.js";
import { EvolutionDomain } from "./evolution-domain.js";
if (existsSync(".env")) process.loadEnvFile(".env");
const workspace = await Workspace.open(
  process.env.DATABASE_PATH ?? ".runtime/workspace.db",
);
if (process.env.E2E_FIXTURES === "1") {
  const fixture = await readFile(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../tests/fixtures/ui-detail-plugin.mjs",
    ),
    "utf8",
  );
  const seeded = workspace.release.record({
    pluginId: "ui-detail",
    name: "UI 贡献证明",
    service: "workflow",
    contractVersion: "workflow/1",
    source: fixture,
    code: fixture,
    definition: {
      id: "ui-detail",
      name: "UI 贡献证明",
      version: "1.0.0",
      initialState: "open",
      states: {
        open: { label: "未完成", category: "open" },
        done: { label: "已完成", category: "done" },
      },
      actions: [
        { id: "complete", label: "完成", from: ["open"] },
        { id: "reopen", label: "重新打开", from: ["done"] },
      ],
      fields: [],
    },
    evidence: { passed: true, origin: "e2e-fixture" },
  });
  const baseline = workspace.composition();
  await workspace.activate(
    {
      versionId: seeded.id,
      compositionRevision: baseline.revision,
      operationId: "e2e-seed-ui-detail",
    },
    () => undefined,
  );
  const afterSeed = workspace.composition();
  await workspace.activate(
    {
      versionId: afterSeed.previousVersionId!,
      compositionRevision: afterSeed.revision,
      operationId: "e2e-seed-restore-default",
    },
    () => undefined,
  );
}
const assistant =
  process.env.GEMINI_API_KEY && process.env.AI_DISABLED !== "1"
    ? new Evolution(
        workspace.db,
        new Gemini(process.env.GEMINI_API_KEY),
        new EvolutionDomain(workspace),
      )
    : undefined;
const app = createApp(workspace, assistant);
app.use("/*", serveStatic({ root: "./dist/web" }));
app.get("*", serveStatic({ path: "./dist/web/index.html" }));
const server = serve(
  {
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: Number(process.env.PORT ?? 4517),
  },
  (info) => console.log(`Cordis: http://127.0.0.1:${info.port}`),
);
let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await assistant?.close();
  await workspace.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
