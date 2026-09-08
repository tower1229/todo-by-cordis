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
