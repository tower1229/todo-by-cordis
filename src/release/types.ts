export type Version = {
  id: string;
  pluginId: string;
  name: string;
  parentId?: string;
  service: string;
  contractVersion: string;
  source: string;
  code: string;
  definition: unknown;
  evidence: unknown;
  createdAt: string;
  entry: string;
};
export type RuntimeTarget = {
  entry: string;
  service: string;
  pluginId: string;
};
export type RuntimeLike = {
  invoke<T = unknown>(method: string, data?: unknown): Promise<T>;
  close(): Promise<void>;
  onFailure?: () => void;
};
