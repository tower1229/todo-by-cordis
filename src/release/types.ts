import {
  compositionMemberRoles,
  type CompositionMemberRole,
} from "../shared/contracts.js";

export type BusinessBundle = {
  files: Record<string, string>;
  outputs: Record<string, string>;
  lockHash: string;
  builder: string;
};

export const versionMemberRoles = compositionMemberRoles;
export type VersionMemberRole = CompositionMemberRole;

/** Lock entry for a composition; omit versionId to mean this Version.id. */
export type VersionMember = {
  pluginId: string;
  versionId?: string;
  enabled: boolean;
  role: VersionMemberRole;
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
  /** Absent => single-element composition of this version. */
  members?: VersionMember[];
};

export type RuntimePluginTarget = {
  pluginId: string;
  entry: string;
  service: string;
  bundle?: BusinessBundle;
  role: VersionMemberRole;
};

export type RuntimeTarget = {
  bundle?: BusinessBundle;
  entry: string;
  service: string;
  pluginId: string;
  /** When present, all enabled plugins loaded in one child; includes primary. */
  plugins?: RuntimePluginTarget[];
};

export type RuntimeLike = {
  invoke<T = unknown>(
    method: string,
    data?: unknown,
    pluginId?: string,
  ): Promise<T>;
  close(): Promise<void>;
  onFailure?: () => void;
};

/** Version plus resolved runtime plugins for child launch. */
export type LaunchTarget = Version & {
  plugins?: RuntimePluginTarget[];
};
