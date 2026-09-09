import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../../src/release/storage.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";
import type { Version } from "../../src/release/types.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

export const memberUiWorkflowDefinition: WorkflowDefinition = {
  id: "aux-workflow",
  name: "组合主流程",
  version: "1.0.0",
  initialState: "open",
  states: {
    open: { label: "未完成", category: "open" },
    done: { label: "已完成", category: "done" },
  },
  actions: [
    { id: "complete", label: "完成", from: ["open"] },
    { id: "reopen", label: "重新打开", from: ["done"] },
  ],
  fields: [],
};

type ReleaseInput = Omit<Version, "id" | "entry" | "createdAt">;

export async function panelPluginCode() {
  return readFile(join(fixtureDir, "panel-plugin.mjs"), "utf8");
}

export async function auxWorkflowCode() {
  return readFile(join(fixtureDir, "aux-workflow.mjs"), "utf8");
}

export async function panelReleaseInput(origin: string): Promise<ReleaseInput> {
  const code = await panelPluginCode();
  return {
    pluginId: "panel",
    name: "备注面板插件",
    service: "plugin:panel",
    contractVersion: "extensions/1",
    source: code,
    code,
    definition: { id: "panel" },
    evidence: { passed: true, origin },
  };
}

export async function memberUiReleaseInput(
  origin: string,
): Promise<{ panel: ReleaseInput; composition: ReleaseInput }> {
  const panel = await panelReleaseInput(origin);
  const panelId = hash(panel);
  const code = await auxWorkflowCode();
  const composition: ReleaseInput = {
    pluginId: "aux-workflow",
    name: "成员启用 UI 组合",
    service: "workflow",
    contractVersion: "workflow/1",
    source: code,
    code,
    definition: memberUiWorkflowDefinition,
    evidence: { passed: true, origin },
    members: [
      { pluginId: "aux-workflow", enabled: true, role: "workflow" },
      {
        pluginId: "panel",
        versionId: panelId,
        enabled: true,
        role: "auxiliary",
      },
    ],
  };
  return { panel, composition };
}

export async function memberUiVersionId(origin: string) {
  const { composition } = await memberUiReleaseInput(origin);
  return hash(composition);
}
