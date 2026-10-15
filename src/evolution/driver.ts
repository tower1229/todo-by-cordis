export type ModelReply = {
  text: string;
  history: unknown[];
  calls: { id?: string; name: string; args: Record<string, unknown> }[];
  usage: unknown;
  raw: unknown;
  transport?: {
    profile?: string;
    envelopeValid?: boolean;
    schemaHash?: string;
    toolsHash?: string;
    functionMode?: string;
    finishReason?: string;
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
  generate(request: ModelRequest, signal: AbortSignal): Promise<ModelReply>;
}
