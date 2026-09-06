import { Hono } from "hono";
import { AppError } from "../shared/contracts.js";
import { Workspace } from "./workspace.js";
export function createApp(workspace: Workspace) {
  const app = new Hono();
  app.onError((error, c) => {
    const known = error instanceof AppError;
    return c.json(
      {
        code: known ? error.code : "INTERNAL_ERROR",
        message: error.message || "操作失败，请重试",
      },
      (known ? error.status : 500) as any,
    );
  });
  app.get("/api/tasks", (c) =>
    c.json(
      workspace.query(
        c.req.query("search"),
        c.req.query("category"),
        Number(c.req.query("offset") ?? 0) || 0,
      ),
    ),
  );
  app.get("/api/tasks/:id", (c) => c.json(workspace.read(c.req.param("id"))));
  app.post("/api/commands", async (c) =>
    c.json(await workspace.command(await c.req.json())),
  );
  app.get("/api/operations/:id", (c) =>
    c.json(workspace.operation(c.req.param("id"))),
  );
  app.get("/api/composition", (c) => c.json(workspace.composition()));
  app.post("/api/releases", async (c) =>
    c.json(await workspace.activate(await c.req.json())),
  );
  app.post("/api/runtime/retry", async (c) => {
    await workspace.restart();
    return c.json(workspace.composition());
  });
  return app;
}
