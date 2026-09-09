import { mkdtemp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../src/server/workspace.js";
import { uiDetailReleaseInput } from "../tests/fixtures/ui-detail.ts";

const dir = await mkdtemp(join(tmpdir(), "cordis-browser-"));
process.env.AI_DISABLED = "1";
process.env.PORT = "4518";
process.env.DATABASE_PATH = join(dir, "test.db");
process.once("exit", () => {
  rmSync(dir, { recursive: true, force: true });
});

const workspace = await Workspace.open(process.env.DATABASE_PATH);
try {
  const input = await uiDetailReleaseInput("e2e-fixture");
  const seeded = workspace.release.record(input);
  const baseline = workspace.composition();
  await workspace.activate(
    {
      versionId: seeded.id,
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
} finally {
  await workspace.close();
}

await import("../dist/server/main.js");
