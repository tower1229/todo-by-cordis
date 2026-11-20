export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface PluginManifest {
  readonly pluginId: string;
  readonly name: string;
  readonly dependencies: readonly string[];
}

export interface PluginArtifact {
  readonly pluginId: string;
  readonly versionId: string;
  readonly name: string;
  readonly dependencies: readonly string[];
  readonly contractTypes: string;
  readonly serverCode?: string;
  readonly clientCode?: string;
  readonly styleCss?: string;
  readonly sourceFiles: Readonly<Record<string, string>>;
  readonly testFiles: Readonly<Record<string, string>>;
}

export interface CompositionMember {
  readonly pluginId: string;
  readonly versionId: string;
  readonly enabled: boolean;
}

export interface CompositionSnapshot {
  readonly compositionId: string;
  readonly parentCompositionId: string | null;
  readonly members: readonly CompositionMember[];
  readonly createdAt: string;
}

export interface ActiveClientComposition {
  readonly compositionId: string;
  readonly plugins: ReadonlyArray<{
    readonly pluginId: string;
    readonly versionId: string;
    readonly dependencies: readonly string[];
    readonly clientEntryUrl?: string;
    readonly styleCss?: string;
  }>;
}

export interface ScopedStatement {
  run(...params: unknown[]): {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  };
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
}

export interface ScopedDb {
  readonly pluginId: string;
  readonly tablePrefix: string;
  exec(sql: string): void;
  prepare(sql: string): ScopedStatement;
  transaction<T>(fn: () => T): T;
}

export interface HttpDispatchInput {
  readonly method: HttpMethod;
  readonly path: string;
  readonly query?: Record<string, string>;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
  readonly rawBody?: string;
}

export interface AppRequest {
  readonly method: HttpMethod;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: Readonly<Record<string, string>>;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly rawBody?: string;
}

export interface AppResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

export type RouteHandlerResult = Response | AppResponse | unknown;

export interface HttpRouter {
  route(
    method: HttpMethod,
    subPath: string,
    handler: (
      req: AppRequest,
    ) => Promise<RouteHandlerResult> | RouteHandlerResult,
  ): () => void;
}

export interface SchedulerService {
  every(intervalMs: number, task: () => Promise<void> | void): () => void;
  at(
    timestampIso: string,
    key: string,
    task: () => Promise<void> | void,
  ): () => void;
}

export type FiberStateName =
  | "PENDING"
  | "LOADING"
  | "ACTIVE"
  | "FAILED"
  | "DISPOSED"
  | "UNLOADING";

export interface RouteDescriptor {
  readonly pluginId: string;
  readonly method: HttpMethod;
  readonly path: string;
}

export interface PluginTopologyEntry {
  readonly pluginId: string;
  readonly versionId: string;
  readonly enabled: boolean;
  readonly state: FiberStateName;
  readonly dependencies: readonly string[];
  readonly routes: ReadonlyArray<{
    readonly method: HttpMethod;
    readonly path: string;
  }>;
  readonly providedServices: readonly string[];
  readonly activeTimers: number;
  readonly contractTypes: string;
}

export interface CompositionTopology {
  readonly compositionId: string | null;
  readonly workerPid: number | null;
  readonly plugins: readonly PluginTopologyEntry[];
  readonly services: readonly string[];
  readonly routes: readonly RouteDescriptor[];
}

export interface RuntimeHealth {
  readonly compositionId: string;
  readonly mode: "in-process-hot-swap" | "subprocess-rebuilt";
  readonly workerPid: number;
  readonly activePlugins: readonly string[];
}

export interface CordisAppRuntime {
  applyComposition(target: CompositionSnapshot): Promise<RuntimeHealth>;
  introspect(): Promise<CompositionTopology>;
  close(): Promise<void>;
}

export interface ServerCordisRuntime extends CordisAppRuntime {
  registerArtifact(artifact: PluginArtifact): void;
  handleHttpRequest(req: HttpDispatchInput): Promise<AppResponse>;
}
