import { Workspace } from "../../src/server/workspace.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import {
  source,
  candidateSource,
  candidateScope,
} from "./evolution-fixture.js";
const w = await Workspace.open(process.argv[2], {
  checkpoint(stage) {
    if (stage === process.argv[3]) process.exit(17);
  },
});
const domain = new EvolutionDomain(w);
const target = {
  kind: "plugin" as const,
  baseVersion: w.activeVersion().id,
  payload: {
    scope: candidateScope,
    pluginId: "reflection",
    name: "Reflection",
    fields: [
      {
        key: "reflection",
        label: "复盘",
        required: true,
        minLength: 1,
        maxLength: 5000,
      },
    ],
  },
};
const id = await domain.candidate(
  candidateSource(source("reflection")),
  target,
  new AbortController().signal,
  () => {},
);
await w.activate(
  { versionId: id, compositionRevision: 1, operationId: "activate" },
  () => {},
);
await w.close();
