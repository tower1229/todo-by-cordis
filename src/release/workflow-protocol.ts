import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { hash } from "./storage.js";
import type { WorkflowProtocolProfile } from "../shared/workflow-protocol.js";

/** Pending evidence binds the actual protected implementation; active ABI stays executable. */
export function workflowProtocolKernelHash() {
  return hash(
    [
      "src/release/workflow-protocol.ts",
      "src/runtime/workflow-protocol.ts",
      "src/runtime/child.ts",
      "src/runtime/runtime.ts",
      "src/release/composition.ts",
      "src/shared/workflow-protocol.ts",
      "src/server/business/contracts.ts",
      "src/server/workspace.ts",
    ].map((path) => ({ path, source: readFileSync(resolve(path), "utf8") })),
  );
}

export function workflowProtocolProgram(profile: WorkflowProtocolProfile) {
  return {
    version: profile.version,
    profileHash: hash(profile),
    kernelHash: workflowProtocolKernelHash(),
  };
}
