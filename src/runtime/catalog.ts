import { workflow as standard } from "./plugins/default.js";
import { workflow as review } from "./plugins/review.js";
import type { WorkflowId } from "../shared/contracts.js";
export const catalog = { default: standard, review };
export function isWorkflowId(id: unknown): id is WorkflowId {
  return id === "default" || id === "review";
}
