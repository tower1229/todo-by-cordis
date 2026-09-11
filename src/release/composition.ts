import { AppError } from "../shared/contracts.js";
import type { CompositionMember } from "../shared/contracts.js";
import { hash } from "./storage.js";
import type {
  RuntimePluginTarget,
  Version,
  VersionMember,
} from "./types.js";

/** Host-declared data impact for member enable-status changes (planning / experience). */
export const memberEnabledDataImpact =
  "停用不删除任务字段值；贡献退出活动组合；再启用按当前成员版本契约解释";

export function resolveVersionMembers(version: Version): VersionMember[] {
  if (version.members?.length) return version.members;
  return [
    {
      pluginId: version.pluginId,
      versionId: version.id,
      enabled: true,
      role: "workflow",
    },
  ];
}

/**
 * Full composition lock for a new primary-plugin version of `base`.
 * Unmodified members keep exact versionId/enabled/role; the primary
 * workflow slot binds to `nextPluginId` and omits versionId so it
 * resolves to the new Version.id (supports same-id upgrades and
 * fixture renames like default → reflection).
 */
export function inheritCompositionMembers(
  base: Version,
  nextPluginId = base.pluginId,
): VersionMember[] {
  return resolveVersionMembers(base).map((member) => {
    if (
      member.pluginId === base.pluginId &&
      (!member.versionId || member.versionId === base.id)
    )
      return {
        pluginId: nextPluginId,
        enabled: member.enabled,
        role: member.role,
      };
    return {
      pluginId: member.pluginId,
      versionId: member.versionId ?? base.id,
      enabled: member.enabled,
      role: member.role,
    };
  });
}

/**
 * Ordinary candidate lock: inherit unmodified members, replace upgraded
 * auxiliary versionIds, then append new auxiliary members. Unmodified
 * members keep exact versionId/enabled/role. When `pinWorkflowVersionId`
 * is set (upgrade-only, workflow unchanged), the workflow slot keeps that
 * exact version instead of binding to the new carrier Version.id.
 */
export function composeCandidateMembers(
  base: Version,
  nextPluginId: string,
  additions: VersionMember[] = [],
  upgrades: VersionMember[] = [],
  pinWorkflowVersionId?: string,
): VersionMember[] {
  const upgradeById = new Map(upgrades.map((m) => [m.pluginId, m]));
  const inherited = inheritCompositionMembers(base, nextPluginId).map(
    (member) => {
      const upgrade = upgradeById.get(member.pluginId);
      if (!upgrade) {
        if (
          pinWorkflowVersionId &&
          member.role === "workflow" &&
          !member.versionId
        )
          return {
            pluginId: member.pluginId,
            versionId: pinWorkflowVersionId,
            enabled: member.enabled,
            role: member.role,
          };
        return member;
      }
      if (member.role !== "auxiliary")
        throw new AppError(
          "INVALID_COMPOSITION",
          "普通候选只能升级辅助成员",
        );
      if (!upgrade.versionId)
        throw new AppError("INVALID_COMPOSITION", "辅助插件缺少精确版本");
      upgradeById.delete(member.pluginId);
      return {
        pluginId: member.pluginId,
        versionId: upgrade.versionId,
        enabled: member.enabled,
        role: member.role,
      };
    },
  );
  if (upgradeById.size)
    throw new AppError(
      "UNKNOWN_PLUGIN",
      `组合中不存在该插件：${[...upgradeById.keys()].join("、")}`,
    );
  const ids = new Set(inherited.map((m) => m.pluginId));
  for (const member of additions) {
    if (ids.has(member.pluginId))
      throw new AppError(
        "EXTENSION_CONFLICT",
        `组合内插件身份重复：${member.pluginId}`,
      );
    if (member.role !== "auxiliary")
      throw new AppError(
        "INVALID_COMPOSITION",
        "普通候选只能新增辅助成员",
      );
    if (!member.versionId)
      throw new AppError("INVALID_COMPOSITION", "辅助插件缺少精确版本");
    ids.add(member.pluginId);
  }
  return [...inherited, ...additions];
}

export function compositionMembers(version: Version): CompositionMember[] {
  return resolveVersionMembers(version).map((member) => ({
    pluginId: member.pluginId,
    versionId: member.versionId ?? version.id,
    enabled: member.enabled,
    role: member.role,
  }));
}

export function validateCompositionMembers(
  version: Version,
  getVersion?: (id: string) => Version,
) {
  const members = resolveVersionMembers(version);
  const ids = new Set<string>();
  let workflowCount = 0;
  for (const member of members) {
    if (ids.has(member.pluginId))
      throw new AppError(
        "EXTENSION_CONFLICT",
        `组合内插件身份重复：${member.pluginId}`,
      );
    ids.add(member.pluginId);
    if (member.enabled && member.role === "workflow") workflowCount++;
    if (
      member.role === "auxiliary" &&
      !member.versionId &&
      member.pluginId !== version.pluginId
    )
      throw new AppError("INVALID_COMPOSITION", "辅助插件缺少精确版本");
    if (getVersion) {
      const targetId = member.versionId ?? version.id;
      const target =
        targetId === version.id ? version : getVersion(targetId);
      if (target.pluginId !== member.pluginId)
        throw new AppError(
          "EXTENSION_CONFLICT",
          `成员身份与版本不一致：${member.pluginId}`,
        );
    }
  }
  if (workflowCount !== 1)
    throw new AppError(
      "EXTENSION_CONFLICT",
      "组合内有且仅有一个主工作流提供者",
    );
}

export function resolveRuntimePlugins(
  version: Version,
  getVersion: (id: string) => Version,
): RuntimePluginTarget[] {
  validateCompositionMembers(version, getVersion);
  const plugins: RuntimePluginTarget[] = [];
  for (const member of resolveVersionMembers(version)) {
    if (!member.enabled) continue;
    const targetId = member.versionId ?? version.id;
    const target = targetId === version.id ? version : getVersion(targetId);
    plugins.push({
      pluginId: target.pluginId,
      entry: target.entry,
      service: target.service,
      bundle: target.bundle,
      role: member.role,
    });
  }
  return plugins;
}

export function workflowPluginId(version: Version): string {
  const member = resolveVersionMembers(version).find(
    (m) => m.enabled && m.role === "workflow",
  );
  if (!member)
    throw new AppError("EXTENSION_CONFLICT", "组合缺少主工作流提供者");
  return member.pluginId;
}

/** Stable digest of the full composition lock, including disabled members. */
export function compositionBuildHash(
  version: Version,
  getVersion: (id: string) => Version,
): string {
  const entries = resolveVersionMembers(version).map((member) => {
    const targetId = member.versionId ?? version.id;
    const target = targetId === version.id ? version : getVersion(targetId);
    return {
      pluginId: member.pluginId,
      versionId: target.id,
      enabled: member.enabled,
      role: member.role,
      code: target.code,
      lockHash: target.bundle?.lockHash ?? null,
    };
  });
  return hash(entries);
}
