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

export const missPolicies = ["skip", "run-once"] as const;
export type MissPolicy = (typeof missPolicies)[number];

export const taskEventKinds = [
  "task.created",
  "task.updated",
  "task.deleted",
] as const;
export type TaskEventKind = (typeof taskEventKinds)[number];

export const extensionCapabilityStatuses = [
  "active",
  "stub",
  "declared",
] as const;
export type ExtensionCapabilityStatus =
  (typeof extensionCapabilityStatuses)[number];

export const EXTENSIONS_CONTRACT = "extensions/1" as const;

export type CommandRegistration = {
  id: string;
  label: string;
  from?: string[];
};

export type ScheduleRegistration = {
  id: string;
  /**
   * Absolute ISO time, or when atKind is "field", the task field key holding ISO/wall time.
   */
  at: string;
  /** Defaults to "absolute". */
  atKind?: "absolute" | "field";
  timezone?: string;
  dedupeKey: string;
  onFire: {
    type: "action";
    commandId: string;
    /** Required for absolute jobs; field jobs fill taskId per armed task. */
    taskId?: string;
    input?: Record<string, string>;
  };
  missPolicy: MissPolicy;
};

export type LifecycleContribution = {
  activate?: boolean;
  ready?: boolean;
  quiesce?: boolean;
  dispose?: boolean;
};

export type UiSlotRegistration = {
  id: string;
  slot: string;
  order?: number;
};

export type QueryFilterRegistration = {
  id: string;
  label: string;
};

export type QuerySortRegistration = {
  id: string;
  label: string;
  primary?: boolean;
};

export type ServiceRegistration = {
  id: string;
  version: string;
};

export type ExtensionContribution = {
  commands?: CommandRegistration[];
  fields?: Field[];
  beforeCommit?: boolean;
  events?: TaskEventKind[];
  schedules?: ScheduleRegistration[];
  lifecycle?: LifecycleContribution;
  uiSlots?: UiSlotRegistration[];
  queryFilters?: QueryFilterRegistration[];
  querySorts?: QuerySortRegistration[];
  diagnostics?: boolean;
  services?: ServiceRegistration[];
};

export type BeforeCommitInput = {
  task: Task;
  draft: Task;
  action: string;
  input: Record<string, string>;
  decision: Extract<WorkflowDecision, { kind: "commit" }>;
};

export type HookAnnotations = {
  annotations?: string[];
};

export type BeforeCommitResult =
  | {
      kind: "ok";
      fields?: Record<string, string>;
      state?: string;
      annotations?: string[];
    }
  | { kind: "reject"; message: string };

export type TaskEvent = {
  kind: TaskEventKind;
  task: Task;
  changedPaths: string[];
  revision: number;
  source: string;
};

export type TaskEventResult = void | HookAnnotations;

export type ExtensionCapability = {
  interfaceId: string;
  status: ExtensionCapabilityStatus;
  providerId: string;
  count: number;
};

export type ExtensionSummary = {
  contractVersion: typeof EXTENSIONS_CONTRACT | null;
  capabilities: ExtensionCapability[];
};

export const emptyContribution = (): ExtensionContribution => ({});

export type Plugin = {
  describe(): WorkflowDefinition;
  decide(data: {
    task: Task;
    action: string;
    input: Record<string, string>;
  }): WorkflowDecision;
  contribute?(): ExtensionContribution;
  lifecycleActivate?(data?: Record<string, never>): void | HookAnnotations;
  lifecycleReady?(data?: Record<string, never>): void | HookAnnotations;
  lifecycleQuiesce?(data?: Record<string, never>): void | HookAnnotations;
  lifecycleDispose?(data?: Record<string, never>): void | HookAnnotations;
  beforeCommit?(data: BeforeCommitInput): BeforeCommitResult;
  onTaskEvent?(data: TaskEvent): TaskEventResult;
};
