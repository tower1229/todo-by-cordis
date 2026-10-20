import type { WorkflowRule } from "./assistant.js";
import type { WorkflowDefinition } from "./contracts.js";

export type WorkflowProtocolOwner = "model" | "host";

/** Immutable host input, independent of candidate-authored source and test examples. */
export type WorkflowProtocolProfile = {
  version: "host-workflow/1";
  definition: WorkflowDefinition;
  rules: WorkflowRule[];
};
