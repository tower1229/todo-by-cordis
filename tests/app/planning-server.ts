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
import { candidateSource, candidateScope } from "./evolution-fixture.js";
import { ExecutionDriver } from "./execution-fixture.js";
const dir = mkdtempSync(join(tmpdir(), "cordis-browser-plan-"));
const workspace = await Workspace.open(join(dir, "workspace.db"));
const planning = new PlanningDriver();
let clarify = false;
const evolution = new Evolution(
  workspace.db,
  {
    async generate(request) {
      if (request.tools?.some((t) => t.name === "submit_candidate")) {
        const result = await new ExecutionDriver(planning, "default", "轻快完成", workspace.activeVersion().bundle ? 3 : 1).generate(request);
        if (result.calls[0]?.name === "submit_candidate" && workspace.activeVersion().bundle) {
          result.calls[0].args = JSON.parse(candidateSource(String(result.calls[0].args.source))) as {files:unknown};
          return result;
        }
        if (
          result.calls[0]?.name === "submit_candidate" &&
          !JSON.stringify(request.history).includes("error")
        )
          return {
            ...result,
            calls: [
              {
                name: "submit_candidate",
                args: {
                  source: "const broken: string = 42; export default broken;",
                },
              },
            ],
          };
        return result;
      }
      if (request.message) {
        const input = JSON.parse(request.message) as { revisions: unknown[]; parentRunId?: string };
        clarify = input.revisions.length === 1 && !input.parentRunId;
        planning.finish = input.parentRunId ? {
          workflowRules:[{key:"reflection", label:"复盘", required:true, minLength:3, maxLength:5000}],
          acceptanceReason:"用户要求复盘至少三个字", writableScope:candidateScope,
        } : {};
      }
      if (clarify && request.history.length)
        return toolReply("request_clarification", {
          question: "复盘是必填还是选填？",
        });
      return planning.generate(request);
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
