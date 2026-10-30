import type { ModelNetwork } from "./model-network.js";
import type { TransportFailure } from "./transport-failure.js";
export type ModelReply = {
  text: string;
  history: unknown[];
  calls: { id?: string; name: string; args: Record<string, unknown> }[];
  usage: unknown;
  raw: unknown;
  protocolErrors?: string[];
  transport?: {
    profile?: string;
    outputPolicy?: ReturnType<typeof import("./model-policy.js").modelPolicy>;
    requestedModel?: string;
    actualModel?: string;
    envelopeValid?: boolean;
    schemaHash?: string;
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
      /** UTF-8 JSON body handed to HTTP; not proof of provider receipt or billed tokens. */
      requestBodyBytes?: number;
      whitespaceBytes: number;
    };
  };
};
export class ModelTransportError extends Error {
  constructor(
    message: string,
    readonly transport: NonNullable<ModelReply["transport"]>,
    readonly httpStatus?: number,
  ) {
    super(message);
  }
}
export type ModelRequest = {
  resourceWindow?: { remainingMilliseconds: number; reservedMilliseconds: number; modelMilliseconds: number };
  phase?: import("./budget.js").ModelPhase;
  instruction: string;
  history: unknown[];
  message?: string;
  schema?: Record<string, unknown>;
  tools?: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  }[];
};
export interface Driver {
  generate(
    request: ModelRequest,
    signal: AbortSignal,
    onTransport?: (transport: NonNullable<ModelReply["transport"]>) => void,
  ): Promise<ModelReply>;
}
