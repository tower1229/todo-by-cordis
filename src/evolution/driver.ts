export type ModelReply = {
  text: string;
  history: unknown[];
  calls: { id?: string; name: string; args: Record<string, unknown> }[];
  usage: unknown;
  raw: unknown;
};
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
