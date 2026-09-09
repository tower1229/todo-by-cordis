import { Hono } from "hono";
import { AppError } from "../shared/contracts.js";
import { Workspace } from "./workspace.js";
import {
  unavailableAssistant,
  parseAssistantCommand,
  type AssistantService,
} from "./assistant.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
export function createApp(
  workspace: Workspace,
  assistant: AssistantService = unavailableAssistant,
) {
  const app = new Hono();
  app.onError((error, c) => {
    const known = error instanceof AppError;
    return c.json(
      {
        code: known ? error.code : "INTERNAL_ERROR",
        message: error.message || "操作失败，请重试",
      },
      (known ? error.status : 500) as ContentfulStatusCode,
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
  app.post("/api/composition/members", async (c) => {
    const body = await c.req.json();
    return c.json(
      await workspace.setMemberEnabled({
        operationId: body.operationId,
        compositionRevision: body.compositionRevision,
        versionId: body.versionId,
        pluginId: body.pluginId,
        enabled: body.enabled,
      }),
    );
  });
  app.get("/api/assistant", async (c) =>
    c.json(
      await assistant.observe(
        c.req.query("runId"),
        Number(c.req.query("after") ?? 0) || 0,
      ),
    ),
  );
  app.post("/api/assistant/commands", async (c) =>
    c.json(await assistant.command(parseAssistantCommand(await c.req.json()))),
  );
  app.post("/api/runtime/restore", async (c) => {
    const { operationId, compositionRevision, versionId, workflowId } =
      await c.req.json();
    return c.json(
      await workspace.activate({
        operationId,
        compositionRevision,
        ...(versionId || workflowId
          ? {
              ...(versionId ? { versionId } : {}),
              ...(workflowId ? { workflowId } : {}),
            }
          : { versionId: workspace.previousVersionId() }),
      }),
    );
  });
  app.post("/api/runtime/retry", async (c) => {
    await workspace.restart();
    return c.json(workspace.composition());
  });
  return app;
}
