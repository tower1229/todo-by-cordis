export type WorkflowId = string;
export type Task = {
  id: string;
  title: string;
  description: string;
  state: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  fields: Record<string, string>;
};
export type Field = {
  key: string;
  label: string;
  type: "text";
  required?: boolean;
  description?: string;
};
export type Action = { id: string; label: string; from: string[] };
export type WorkflowDefinition = {
  id: WorkflowId;
  name: string;
  version: string;
  initialState: string;
  states: Record<string, { label: string; category: "open" | "done" }>;
  actions: Action[];
  fields: Field[];
};
export type WorkflowDecision =
  | { kind: "reject"; message: string }
  | { kind: "input-required"; fields: Field[] }
  | { kind: "commit"; state: string; fields: Record<string, string> };
export type Workflow = {
  definition: WorkflowDefinition;
  decide(
    task: Task,
    action: string,
    input: Record<string, string>,
  ): WorkflowDecision;
};
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
