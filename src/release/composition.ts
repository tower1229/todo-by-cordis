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
