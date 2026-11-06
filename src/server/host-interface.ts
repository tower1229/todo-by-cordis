import { parse } from "@babel/parser";
import { hash } from "../release/storage.js";
import { AppError } from "../shared/contracts.js";
import type { InvestigationDocument } from "./planning.js";

const consumerMethods = new Set(["command", "composition", "read", "query"]);
let cached: { sourceHash: string; declaration?: string } | undefined;

/** Shared identity lives on the existing member row; capability-specific state stays on each capability. */
export function compactCapabilityInventory<
  M extends { pluginId: string; versionId: string },
  C extends { providerId: string; providerVersion: string; artifactVersion: string; source?: string; contract?: string; acceptance?: string },
>(members: M[], capabilities: C[]) {
  if (members.some(member => Object.hasOwn(member, "materials"))) return {members, capabilities};
  const projectedMembers = members.map(member => {
    const rows = capabilities.filter(row => row.providerId === member.pluginId);
    const materials = Object.fromEntries((["source", "contract", "acceptance"] as const).flatMap(key => {
      const value = rows[0]?.[key];
      return typeof value === "string" && rows.every(row => row[key] === value) ? [[key, value]] : [];
    }));
    return {...member, ...(Object.keys(materials).length ? {materials} : {})};
  });
  const projectedCapabilities = capabilities.map(row => {
    const member = projectedMembers.find(member => member.pluginId === row.providerId);
    return Object.fromEntries(Object.entries(row).filter(([key, value]) => {
      if (!member) return true;
      if (key === "providerVersion" || key === "artifactVersion") return value !== member.versionId;
      return !["source", "contract", "acceptance"].includes(key) || member.materials?.[key] !== value || value === undefined;
    }));
  });
  return {members: projectedMembers, capabilities: projectedCapabilities};
}

/** Preserve explicit source types; unsupported inference falls back to the complete source. */
function declarationOf(source: string): string | undefined {
  const ast = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const declarations: string[] = [];
  for (const statement of ast.program.body) {
    if (statement.type !== "ExportNamedDeclaration" || statement.declaration?.type !== "ClassDeclaration" || statement.declaration.id?.name !== "Workspace") continue;
    for (const method of statement.declaration.body.body) {
      if (method.type !== "ClassMethod" || method.kind !== "method" || method.key.type !== "Identifier" || !consumerMethods.has(method.key.name)) continue;
      if (method.static || method.accessibility === "private" || method.accessibility === "protected" || method.returnType?.type !== "TSTypeAnnotation") return;
      const parameters: string[] = [];
      for (const parameter of method.params) {
        if (parameter.type === "Identifier" && parameter.typeAnnotation?.type === "TSTypeAnnotation") {
          parameters.push(source.slice(parameter.start!, parameter.end!));
        } else if (parameter.type === "AssignmentPattern" && parameter.left.type === "Identifier") {
          const type = parameter.left.typeAnnotation?.type === "TSTypeAnnotation"
            ? source.slice(parameter.left.typeAnnotation.typeAnnotation.start!, parameter.left.typeAnnotation.typeAnnotation.end!)
            : parameter.right.type === "StringLiteral" ? "string" : parameter.right.type === "NumericLiteral" ? "number" : parameter.right.type === "BooleanLiteral" ? "boolean" : undefined;
          if (!type) return;
          parameters.push(`${parameter.left.name}?: ${type}`);
        } else return;
      }
      const generics = method.typeParameters ? source.slice(method.typeParameters.start!, method.typeParameters.end!) : "";
      const result = method.returnType.typeAnnotation;
      declarations.push(`${method.key.name}${generics}(${parameters.join(", ")}): ${source.slice(result.start!, result.end!)};`);
    }
  }
  return declarations.length === consumerMethods.size ? declarations.join("\n") : undefined;
}

/** Exact host signatures describe the consumer; they grant no candidate access to it. */
export function workspaceInterface(document: InvestigationDocument, baseVersion: string): InvestigationDocument | undefined {
  if (document.ref !== "src/server/workspace.ts") return;
  if (typeof document.content !== "string" || hash(document.content) !== document.hash)
    throw new AppError("PLAN_STALE", "宿主接口来源已变化，请重新调查", 409);
  if (cached?.sourceHash !== document.hash) {
    let declaration: string | undefined;
    try { declaration = declarationOf(document.content); } catch { /* Complete source remains authoritative. */ }
    cached = { sourceHash: document.hash, declaration };
  }
  if (!cached.declaration) return;
  const source = { ref: document.ref, hash: document.hash };
  const content = {
    version: "host-consumer-interface/1", baseVersion, source,
    declaration: cached.declaration,
    businessContract: "src/server/business/contracts.ts",
    scope: "只读宿主消费方接口。业务候选只能使用注入的业务契约，不得导入 Workspace 或调用其方法。完整宿主实现按 source.ref 补读；贡献、生命周期和验证限制见活动能力契约及精确指南。",
  };
  return { ref: "model-view/" + document.ref, hash: hash(content), source, content };
}
