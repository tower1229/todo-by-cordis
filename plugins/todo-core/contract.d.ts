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

export interface TodoListSlotContext {
  readonly tasks: readonly TaskItem[];
  readonly filter: "open" | "done" | "all";
  readonly refresh: () => Promise<void>;
}

export interface TodoItemSlotContext {
  readonly task: TaskItem;
  readonly refresh: () => Promise<void>;
}

declare module "@host/client-sdk" {
  interface SlotPropsMap {
    "todo.header.actions": TodoListSlotContext;
    "todo.sidebar.sections": TodoListSlotContext;
    "todo.list.banner": TodoListSlotContext;
    "todo.item.badges": TodoItemSlotContext;
    "todo.item.detail": TodoItemSlotContext;
  }
}
