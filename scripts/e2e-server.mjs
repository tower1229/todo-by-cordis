/**
 * Browser e2e host. Schedule tests must advance time via /api/test/clock
 * (controllable clock injected at Workspace.open). Do not rely on wall-clock
 * waitForTimeout to fire schedule jobs on this server.
 */
import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../src/server/workspace.js";
import { createControllableClock } from "../src/server/host/clock.js";
import { startHost } from "../src/server/host/bootstrap.js";
import { uiDetailReleaseInput } from "../tests/fixtures/ui-detail.ts";
import { memberUiReleaseInput } from "../tests/fixtures/member-ui.ts";
import { hookedReleaseInput } from "../tests/fixtures/hooked.ts";

const dir = await mkdtemp(join(tmpdir(), "cordis-browser-"));
process.env.AI_DISABLED = "1";
process.env.PORT = "4518";
process.env.DATABASE_PATH = join(dir, "test.db");
process.once("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});

async function seedThenRestore(workspace, versionId) {
  const baseline = workspace.composition();
  await workspace.activate(
    {
      versionId,
      compositionRevision: baseline.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  const afterSeed = workspace.composition();
  if (!afterSeed.previousVersionId)
    throw new Error("e2e seed missing previousVersionId");
  await workspace.activate(
    {
      versionId: afterSeed.previousVersionId,
      compositionRevision: afterSeed.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
}

const clock = createControllableClock(Date.now());
const workspace = await Workspace.open(process.env.DATABASE_PATH, { clock });

const uiDetail = workspace.release.record(
  await uiDetailReleaseInput("e2e-fixture"),
);
await seedThenRestore(workspace, uiDetail.id);

const { panel, composition } = await memberUiReleaseInput("e2e-fixture");
workspace.release.record(panel);
const memberUi = workspace.release.record(composition);
await seedThenRestore(workspace, memberUi.id);

const hooked = workspace.release.record(
  await hookedReleaseInput("e2e-fixture"),
);
await seedThenRestore(workspace, hooked.id);

await startHost({
  workspace,
  port: Number(process.env.PORT ?? 4518),
  testClock: clock,
  logLabel: "Cordis e2e",
});
