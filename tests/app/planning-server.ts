import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../../src/server/workspace.js";
import { createApp } from "../../src/server/app.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
const dir = mkdtempSync(join(tmpdir(), "cordis-browser-plan-"));
const workspace = await Workspace.open(join(dir, "workspace.db"));
const fixture = new PlanningDriver();
let clarify = false;
const evolution = new Evolution(
  workspace.db,
  {
    async generate(request) {
      if (request.message) {
        const input = JSON.parse(request.message) as { revisions: unknown[] };
        clarify = input.revisions.length === 1;
      }
      if (clarify && request.history.length)
        return toolReply("request_clarification", {
          question: "复盘是必填还是选填？",
        });
      return fixture.generate(request);
    },
  },
  new EvolutionDomain(workspace),
);
const app = createApp(workspace, evolution);
app.use("/*", serveStatic({ root: "./dist/web" }));
app.get("*", serveStatic({ path: "./dist/web/index.html" }));
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 4519 });
async function stop() {
  await new Promise<void>((r) => server.close(() => r()));
  await evolution.close();
  await workspace.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
