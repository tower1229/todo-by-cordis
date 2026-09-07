import { workflow as standard } from "./plugins/default.js";
// Compatibility for persisted M1 workspaces, also exercised by runtime tests.
// There is no public endpoint or UI for installing this demonstration workflow.
import { workflow as review } from "./plugins/review.js";
import type { WorkflowId } from "../shared/contracts.js";
export const catalog = { default: standard, review };
export function isWorkflowId(id: unknown): id is WorkflowId {
  return id === "default" || id === "review";
}
