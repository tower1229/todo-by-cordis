import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../../src/release/storage.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

export const uiDetailDefinition: WorkflowDefinition = {
  id: "ui-detail",
  name: "UI 贡献证明",
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

export async function uiDetailPluginCode() {
  return readFile(join(fixtureDir, "ui-detail-plugin.mjs"), "utf8");
}

export async function uiDetailReleaseInput(origin: string) {
  const code = await uiDetailPluginCode();
  return {
    pluginId: "ui-detail",
    name: "UI 贡献证明",
    service: "workflow",
    contractVersion: "workflow/1",
    source: code,
    code,
    definition: uiDetailDefinition,
    evidence: { passed: true, origin },
  };
}

export async function uiDetailVersionId(origin: string) {
  return hash(await uiDetailReleaseInput(origin));
}
