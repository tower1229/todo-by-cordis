import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { FixtureDriver } from "./evolution-fixture.js";
const w = await Workspace.open(process.argv[2], {
  checkpoint(stage) {
    if (stage === process.argv[3]) process.exit(17);
  },
});
const e = new Evolution(w.db, new FixtureDriver(), new EvolutionDomain(w));
await e.command({ type: "request", text: "fixture", operationId: "request" });
for (;;) {
  const run = (await e.observe()).run;
  if (run?.status === "awaiting-confirmation") {
    await e.command({
      type: "confirm",
      runId: run.id,
      planId: run.plan.id,
      compositionRevision: run.plan.compositionRevision,
      operationId: "confirm",
    });
    break;
  }
  await new Promise((r) => setTimeout(r, 10));
}
