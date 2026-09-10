import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Workspace } from "../../src/server/workspace.js";
import { memberUiWorkflowDefinition } from "../fixtures/member-ui.js";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

export const dualWorkflowDefinition = memberUiWorkflowDefinition;

/** Dual-plugin composition fixture shared by Workspace and Evolution enable tests. */
export async function activateDual(w: Workspace) {
  const workflowCode = await readFile(join(fixtureDir, "aux-workflow.mjs"), "utf8");
  const tagsCode = await readFile(join(fixtureDir, "tags-plugin.mjs"), "utf8");
  const dueCode = await readFile(join(fixtureDir, "due-plugin.mjs"), "utf8");
  const tags = w.release.record({
    pluginId: "tags",
    name: "标签插件",
    service: "plugin:tags",
    contractVersion: "extensions/1",
    source: tagsCode,
    code: tagsCode,
    definition: { id: "tags" },
    evidence: { passed: true, origin: "test" },
  });
  const due = w.release.record({
    pluginId: "due",
    name: "截止日期插件",
    service: "plugin:due",
    contractVersion: "extensions/1",
    source: dueCode,
    code: dueCode,
    definition: { id: "due" },
    evidence: { passed: true, origin: "test" },
  });
  const composition = w.release.record({
    pluginId: "aux-workflow",
    name: "双贡献组合",
    service: "workflow",
    contractVersion: "workflow/1",
    source: workflowCode,
    code: workflowCode,
    definition: dualWorkflowDefinition,
    evidence: { passed: true, origin: "test" },
    members: [
      { pluginId: "aux-workflow", enabled: true, role: "workflow" },
      {
        pluginId: "tags",
        versionId: tags.id,
        enabled: true,
        role: "auxiliary",
      },
      {
        pluginId: "due",
        versionId: due.id,
        enabled: true,
        role: "auxiliary",
      },
    ],
  });
  const before = w.composition();
  await w.activate(
    {
      versionId: composition.id,
      compositionRevision: before.revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  return { composition, tags, due };
}
