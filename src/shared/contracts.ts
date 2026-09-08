export type {
  WorkflowId,
  Task,
  Field,
  Action,
  WorkflowDefinition,
  WorkflowDecision,
  Workflow,
} from "../server/business/contracts.js";
import type {
  Task,
  WorkflowDefinition,
  WorkflowDecision,
  WorkflowId,
  Field,
} from "../server/business/contracts.js";
export type Command = {
  operationId: string;
  compositionRevision: number;
  expectedRevision?: number;
  type: "create" | "edit" | "action" | "delete" | "restore";
  taskId?: string;
  title?: string;
  description?: string;
  actionId?: string;
  input?: Record<string, string>;
};
export type CommandResult = { task?: Task; decision?: WorkflowDecision };
export type Composition = {
  revision: number;
  workflow: WorkflowDefinition;
  status: "ready" | "recovering" | "unavailable";
  buildHash: string;
  versionId: string;
  previousVersionId?: string;
  activationPending?: boolean;
  recovery?: {
    attemptedVersionId: string;
    restoredVersionId: string;
    reason: string;
    revision: number;
    at: string;
  };
  retainedFields: Field[];
  history: {
    id: number;
    workflowId: WorkflowId;
    versionId: string;
    name: string;
    createdAt: string;
    pausedMs: number;
    preparationMs: number;
  }[];
};
export type TaskList = {
  tasks: Task[];
  total: number;
  counts: { open: number; done: number };
  revision: number;
};
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
