import { Workspace } from "../../src/server/workspace.js";
import { randomUUID } from "node:crypto";
const w = await Workspace.open(process.argv[2], {
  checkpoint: (stage) => {
    if (stage === process.argv[3]) process.exit(17);
  },
});
await w.activate({
  workflowId: "review",
  compositionRevision: 1,
  operationId: randomUUID(),
});
await w.close();
