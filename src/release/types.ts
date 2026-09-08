export type BusinessBundle = {
  files: Record<string, string>;
  outputs: Record<string, string>;
  lockHash: string;
  builder: string;
};
export type Version = {
  bundle?: BusinessBundle;
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
  bundle?: BusinessBundle;
  entry: string;
  service: string;
  pluginId: string;
};
export type RuntimeLike = {
  invoke<T = unknown>(method: string, data?: unknown): Promise<T>;
  close(): Promise<void>;
  onFailure?: () => void;
};
