import type {} from "cordis";

export type TaskState = "open" | "done";

export interface TaskItem {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly state: TaskState;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateTaskInput {
  readonly title: string;
  readonly notes?: string;
}

export interface UpdateTaskPatch {
  readonly title?: string;
  readonly notes?: string;
}

export interface BeforeTransitionPayload {
  readonly task: TaskItem;
  readonly nextState: TaskState;
  readonly meta?: Record<string, unknown>;
}

export interface TodoService {
  list(filter?: { readonly state?: TaskState }): TaskItem[];
  get(id: string): TaskItem | null;
  create(input: string | CreateTaskInput): TaskItem;
  update(id: string, patch: UpdateTaskPatch): TaskItem | null;
  delete(id: string): boolean;
  transition(
    id: string,
    nextState: TaskState,
    meta?: Record<string, unknown>,
  ): Promise<TaskItem>;
}

declare module "cordis" {
  interface Context {
    todo: TodoService;
  }
  interface Events {
    "todo:before-transition"(
      payload: BeforeTransitionPayload,
    ): Promise<void | false | string> | void | false | string;
    "todo:changed"(task: TaskItem): void;
  }
}
