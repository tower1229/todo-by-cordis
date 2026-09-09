import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../src/server/workspace.js";
import { uiDetailReleaseInput } from "../tests/fixtures/ui-detail.ts";
import { memberUiReleaseInput } from "../tests/fixtures/member-ui.ts";

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

const workspace = await Workspace.open(process.env.DATABASE_PATH);
try {
  const uiDetail = workspace.release.record(
    await uiDetailReleaseInput("e2e-fixture"),
  );
  await seedThenRestore(workspace, uiDetail.id);

  const { panel, composition } = await memberUiReleaseInput("e2e-fixture");
  workspace.release.record(panel);
  const memberUi = workspace.release.record(composition);
  await seedThenRestore(workspace, memberUi.id);
} finally {
  await workspace.close();
}

await import("../dist/server/main.js");
