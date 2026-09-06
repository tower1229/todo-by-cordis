import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Workspace } from "./workspace.js";
import { createApp } from "./app.js";
const workspace = await Workspace.open(
  process.env.DATABASE_PATH ?? ".runtime/workspace.db",
);
const app = createApp(workspace);
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
  await workspace.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
