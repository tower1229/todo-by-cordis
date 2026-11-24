import type { ModelNetwork } from "./network.js";
import type { ModelOutputPolicy } from "./policy.js";
import type { TransportFailure } from "./transport-failure.js";

export type EvolutionToolName =
  | "inspect_plugin"
  | "clarify_request"
  | "stage_plugin_changes"
  | "verify_candidate"
  | "present_preview";

export interface EvolutionToolDefinition {
  readonly name: EvolutionToolName;
  readonly description: string;
  readonly parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  readonly id: string;
  readonly name: string;
  readonly args: Record<string, unknown>;
}

export interface ModelTransportMeta {
  profile?: string;
  outputPolicy?: ModelOutputPolicy;
  requestedModel?: string;
  actualModel?: string;
  toolsHash?: string;
  functionMode?: string;
  finishReason?: string;
  network?: ModelNetwork;
  failure?: TransportFailure;
  http?: {
    stage: "request" | "body" | "complete";
    status?: number;
    requestId?: string;
    headersMs?: number;
    firstByteMs?: number;
    firstContentMs?: number;
    bodyBytes: number;
    requestBodyBytes?: number;
    whitespaceBytes: number;
  };
}

export interface ModelUsageSummary {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
  readonly unknown?: boolean;
}

export interface ModelDriverRequest {
  readonly system: string;
  readonly history: readonly unknown[];
  readonly tools: readonly EvolutionToolDefinition[];
}

export interface ModelDriverReply {
  readonly text?: string;
  readonly calls?: readonly ModelToolCall[];
  readonly protocolErrors?: readonly string[];
  readonly raw?: unknown;
  readonly usage?: ModelUsageSummary;
  readonly rawUsage?: unknown;
  readonly transport?: ModelTransportMeta;
}

export class ModelTransportError extends Error {
  constructor(
    message: string,
    readonly transport: ModelTransportMeta,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}

export interface ModelDriver {
  generate(
    request: ModelDriverRequest,
    signal: AbortSignal,
  ): Promise<ModelDriverReply>;
}
