import type { InvestigatedPlan } from "../shared/assistant.js";
import { hash } from "../release/storage.js";
import { ProtectedCandidateError } from "../release/business-bundle.js";

type Artifact = {
  source: string;
  files?: Record<string, string>;
  members: Record<string, string>;
};

export function candidateArtifact(source: string): Artifact {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { source, members: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { source, members: {} };
  const v = value as Record<string, unknown>;
  const files = Array.isArray(v.files)
    ? Object.fromEntries(
        v.files
          .map((item) => {
            const f = item as { path: string; content: string };
            return [f.path, f.content];
          })
          .filter(([path]) => path !== "business/contract.ts"),
      )
    : undefined;
  const members = Array.isArray(v.members)
    ? Object.fromEntries(
        v.members.map((item) => {
          const m = item as { pluginId: string; source: string };
          return [m.pluginId, m.source];
        }),
      )
    : {};
  return {
    source: typeof v.source === "string" ? v.source : source,
    files,
    members,
  };
}

export function deltaBasis(source: string) {
  const artifact = candidateArtifact(source);
  return {
    files: Object.entries(
      artifact.files ?? { "active-source": artifact.source },
    ).map(([path, content]) => ({ path, hash: hash(content) })),
    members: Object.entries(artifact.members).map(([pluginId, content]) => ({
      pluginId,
      hash: hash(content),
    })),
  };
}

export const candidateDeltaSchema = {
  type: "object",
  additionalProperties: false,
  required: ["files", "members"],
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "content"],
        properties: {
          path: { type: "string" },
          content: { type: ["string", "null"] },
        },
      },
    },
    members: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["pluginId", "source"],
        properties: {
          pluginId: { type: "string" },
          source: {
            type: "string",
            description:
              "Complete self-contained auxiliary module; no imports or re-exports, including type imports. No contract injection.",
          },
        },
      },
    },
  },
};

/** Model file/member choices are bounded by the compiled authorization, excluding host projections. */
export function boundCandidateSchema(plan: InvestigatedPlan) {
  const schema = structuredClone(candidateDeltaSchema);
  const paths = plan.writableScope.filter(
    (path) =>
      ![
        "business/view.ts",
        "business/config.json",
        "business/compatibility.json",
      ].includes(path),
  );
  const members = [
    ...(plan.memberAdditions ?? []),
    ...(plan.memberUpgrades ?? []),
  ].map((m) => m.pluginId);
  if (paths.length)
    Object.assign(schema.properties.files.items.properties.path, {
      enum: paths,
    });
  else Object.assign(schema.properties.files, { maxItems: 0 });
  if (members.length)
    Object.assign(schema.properties.members.items.properties.pluginId, {
      enum: members,
    });
  else Object.assign(schema.properties.members, { maxItems: 0 });
  return schema;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("差异候选结构无效");
  return value as Record<string, unknown>;
}

/** Reconstitute a full artifact; Release never sees a patch or trusts an inheritance claim. */
export function assembleCandidate(
  value: unknown,
  plan: InvestigatedPlan,
  baseline: string,
  previous?: { id: string; source: string },
  baseMembers: Record<string, string> = {},
) {
  const v = object(value);
  if (Object.keys(v).some((key) => !["files", "members"].includes(key)))
    throw new ProtectedCandidateError("候选不得提交验证报告或控制参数");
  // Identity and parent selection are host state, never model-authored claims.
  if (
    !plan.changeSpec ||
    !plan.requirementGate ||
    hash(baseline) !== plan.changeSpec.baseHash
  )
    throw new ProtectedCandidateError("差异候选的宿主基础摘要不匹配");
  const artifact = candidateArtifact(previous?.source ?? baseline);
  const files = { ...artifact.files };
  let source = artifact.source;
  const members = { ...baseMembers, ...artifact.members };
  if (!Array.isArray(v.files) || !Array.isArray(v.members))
    throw new Error("差异候选必须显式提供 files 和 members");
  const paths = new Set<string>();
  for (const item of v.files) {
    const f = object(item);
    if (
      Object.keys(f).some((key) => !["path", "content"].includes(key)) ||
      typeof f.path !== "string" ||
      paths.has(f.path)
    )
      throw new ProtectedCandidateError("差异文件身份无效或重复");
    paths.add(f.path);
    if (
      plan.changeSpec.workflowDefinition &&
      [
        "business/view.ts",
        "business/config.json",
        "business/compatibility.json",
      ].includes(f.path)
    )
      throw new ProtectedCandidateError("候选不得维护宿主派生产物：" + f.path);
    if (!plan.writableScope.includes(f.path))
      throw new ProtectedCandidateError("差异文件超出冻结范围：" + f.path);
    if (f.content !== null && typeof f.content !== "string")
      throw new Error("差异文件内容无效");
    if (f.path === "active-source") {
      if (f.content === null || artifact.files || v.files.length !== 1)
        throw new ProtectedCandidateError("旧单文件差异不能混合业务文件");
      source = f.content;
    } else if (f.content === null) delete files[f.path];
    else files[f.path] = f.content;
  }
  const allowed = [
    ...(plan.memberAdditions ?? []),
    ...(plan.memberUpgrades ?? []),
  ].map((m) => m.pluginId);
  const identities = new Set<string>();
  for (const item of v.members) {
    const m = object(item);
    if (
      Object.keys(m).some((key) => !["pluginId", "source"].includes(key)) ||
      typeof m.pluginId !== "string" ||
      !allowed.includes(m.pluginId) ||
      identities.has(m.pluginId)
    )
      throw new ProtectedCandidateError("差异成员超出冻结范围或重复");
    identities.add(m.pluginId);
    if (typeof m.source !== "string") throw new Error("差异成员内容无效");
    members[m.pluginId] = m.source;
  }
  if (allowed.some((id) => members[id] === undefined))
    throw new Error("新增或升级成员缺少完整源码");
  if (paths.has("business/entry.ts")) {
    const fields = plan.changeSpec.workflowDefinition?.fields;
    if (!fields) throw new ProtectedCandidateError("完整候选缺少宿主字段定义");
    for (const path of [
      "business/view.ts",
      "business/config.json",
      "business/compatibility.json",
    ]) {
      if (!plan.writableScope.includes(path))
        throw new ProtectedCandidateError("派生产物超出冻结范围：" + path);
      if (paths.has(path))
        throw new ProtectedCandidateError("候选不得维护宿主派生产物：" + path);
    }
    files["business/view.ts"] =
      `export default ${JSON.stringify({ title: plan.changeSpec.workflowDefinition!.name, fields: fields.map((f) => f.key) })};`;
    files["business/config.json"] ??= "{}";
    files["business/compatibility.json"] = '{"preserveUnknownFields":true}';
  }
  const workflow =
    Object.keys(files).length || artifact.files
      ? {
          files: Object.entries(files).map(([path, content]) => ({
            path,
            content,
          })),
        }
      : { source };
  if (allowed.length)
    return JSON.stringify({
      ...workflow,
      members: allowed.map((pluginId) => ({
        pluginId,
        source: members[pluginId],
      })),
    });
  return "files" in workflow ? JSON.stringify(workflow) : workflow.source;
}

/** Host-issued receipt includes generated files and the actual parent, never model summaries. */
export function candidateDifference(
  plan: InvestigatedPlan,
  baseline: string,
  source: string,
  previous?: { id: string; source: string },
  baseMembers: Record<string, string> = {},
) {
  const before = candidateArtifact(previous?.source ?? baseline);
  const after = candidateArtifact(source);
  const changes = (a: Record<string, string>, b: Record<string, string>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .filter((key) => a[key] !== b[key])
      .map((key) => ({
        key,
        before: a[key] === undefined ? null : hash(a[key]),
        after: b[key] === undefined ? null : hash(b[key]),
      }));
  return {
    baseVersion: plan.baseVersion!,
    baseHash: plan.changeSpec!.baseHash,
    requirementSeal: plan.requirementGate!.seal,
    ...(previous ? { parentCandidateId: previous.id } : {}),
    files: changes(
      before.files ?? { "active-source": before.source },
      after.files ?? { "active-source": after.source },
    ),
    members: changes(
      { ...baseMembers, ...before.members },
      { ...baseMembers, ...after.members },
    ),
  };
}
