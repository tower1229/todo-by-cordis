import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { createApp } from "../../src/server/app.js";
import { ExperienceSessionHost } from "../../src/server/experience-session.js";

test("createApp without testClock does not expose clock routes", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-clock-routes-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  const sessions = new ExperienceSessionHost(workspace);
  t.after(() => sessions.close());
  const app = createApp(workspace, undefined, sessions);
  const get = await app.request("/api/test/clock");
  assert.equal(get.status, 404);
  const advance = await app.request("/api/test/clock/advance", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ms: 1 }),
  });
  assert.equal(advance.status, 404);
});
