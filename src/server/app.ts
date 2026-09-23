import { Hono } from "hono";
import { AppError } from "../shared/contracts.js";
import { Workspace } from "./workspace.js";
import {
  unavailableAssistant,
  parseAssistantCommand,
  type AssistantService,
} from "./assistant.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  ExperienceSessionHost,
} from "./experience-session.js";
import type { Command } from "../shared/contracts.js";
import {
  isControllableClock,
  type ControllableClock,
} from "./host/clock.js";

export type CreateAppOptions = {
  /**
   * Host-test only. When a controllable clock was injected at Workspace.open,
   * expose advance for browser harnesses. Never registered in production.
   */
  testClock?: ControllableClock;
};

export function createApp(
  workspace: Workspace,
  assistant: AssistantService = unavailableAssistant,
  sessions: ExperienceSessionHost = new ExperienceSessionHost(workspace),
  options: CreateAppOptions = {},
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
  app.get("/api/experience", (c) => {
    const observed = sessions.observe({
      sessionId: c.req.query("sessionId"),
      runId: c.req.query("runId"),
    });
    if (observed.status === "none") return c.json(observed);
    if (observed.status === "invalid") return c.json(observed);
    return c.json(sessions.readSnapshot(observed.id));
  });
  app.post("/api/experience/end", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    sessions.rejectUntrustedFields(body);
    const sessionId =
      typeof body.sessionId === "string" ? body.sessionId : undefined;
    await sessions.end(sessionId);
    return c.json({ ok: true });
  });
  app.post("/api/experience/commands", async (c) => {
    const body = (await c.req.json()) as Record<string, unknown>;
    sessions.rejectUntrustedFields(body);
    if (typeof body.sessionId !== "string" || !body.sessionId)
      throw new AppError("INVALID_INPUT", "体验会话无效");
    const { sessionId, ...rest } = body;
    const command = rest as Omit<Command, "compositionRevision">;
    if (typeof command.operationId !== "string" || !command.operationId)
      throw new AppError("INVALID_INPUT", "操作标识无效");
    return c.json(await sessions.command(sessionId, command));
  });

  const testClock = options.testClock;
  if (testClock && isControllableClock(testClock)) {
    app.post("/api/test/clock/advance", async (c) => {
      const body = (await c.req.json()) as { ms?: unknown };
      if (
        typeof body.ms !== "number" ||
        !Number.isFinite(body.ms) ||
        body.ms < 0
      )
        throw new AppError("INVALID_INPUT", "时钟推进毫秒无效");
      await testClock.advance(body.ms);
      return c.json({ now: testClock.now() });
    });
    app.get("/api/test/clock", (c) => c.json({ now: testClock.now() }));
  }

  return app;
}
