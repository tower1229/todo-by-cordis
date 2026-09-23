import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hash } from "../../src/release/storage.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";

const fixtureDir = dirname(fileURLToPath(import.meta.url));

export const hookedDefinition: WorkflowDefinition = {
  id: "hooked",
  name: "钩子夹具",
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

export async function hookedPluginCode() {
  return readFile(join(fixtureDir, "hooked-plugin.mjs"), "utf8");
}

export async function hookedReleaseInput(origin: string) {
  const code = await hookedPluginCode();
  return {
    pluginId: "hooked",
    name: "钩子夹具",
    service: "workflow",
    contractVersion: "workflow/1",
    source: code,
    code,
    definition: hookedDefinition,
    evidence: { passed: true, origin },
  };
}

export async function hookedVersionId(origin: string) {
  return hash(await hookedReleaseInput(origin));
}
