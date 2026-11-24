import { parseExpression } from "@babel/parser";

type Schema = Record<string, unknown>;
const record = (v: unknown): v is Schema =>
  !!v && typeof v === "object" && !Array.isArray(v);
const schemas = (v: unknown): Schema[] =>
  Array.isArray(v) ? v.filter(record) : [];

export class ModelProtocolError extends Error {}

/** JSON syntax is checked first; the AST is data only and is never evaluated. */
export function parseToolArguments(text: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const posMatch = /position\s+(\d+)/i.exec(message);
    const pos = posMatch ? Number(posMatch[1]) : text.length;
    const start = Math.max(0, pos - 60);
    const end = Math.min(text.length, pos + 60);
    const snippet = text.slice(start, end);
    throw new ModelProtocolError(`${message} (near: ${JSON.stringify(snippet)})`);
  }
  const visit = (node: unknown) => {
    if (!record(node)) return;
    if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
      const keys = new Set<string>();
      for (const prop of node.properties) {
        const property = record(prop) ? prop : {};
        const key = record(property.key) ? property.key.value : undefined;
        if (typeof key !== "string" || keys.has(key)) {
          throw new ModelProtocolError("工具 JSON 属性重复或无效");
        }
        keys.add(key);
      }
    }
    for (const child of Object.values(node)) {
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
    }
  };
  visit(parseExpression(text));
  return value;
}

/** Validate tool call arguments against their declared JSON Schema. */
export function schemaProblems(
  value: unknown,
  schema: Schema,
  path = "$o",
): string[] {
  if (Array.isArray(schema.type)) {
    const matched = schema.type.find(
      (type) => !schemaProblems(value, { type }, path).length,
    );
    return matched === undefined
      ? [`${path}: 类型不符合声明分支`]
      : schemaProblems(value, { ...schema, type: matched }, path);
  }
  if (schema.type === "null") {
    return value === null ? [] : [`${path}: 应为 null`];
  }
  const union = schemas(schema.anyOf);
  if (union.length && !union.some((s) => !schemaProblems(value, s, path).length)) {
    const closest = union
      .map((s) => schemaProblems(value, s, path))
      .sort((a, b) => a.length - b.length)[0];
    return [`${path}: 不符合任何契约分支`, ...closest].slice(0, 20);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))
  ) {
    return [`${path}: 不在允许值中`];
  }
  const type = schema.type;
  if (type === "object") {
    if (!record(value)) return [`${path}: 应为对象`];
    const props = record(schema.properties) ? schema.properties : {};
    const errors = ((schema.required as string[] | undefined) ?? [])
      .filter((k) => !Object.hasOwn(value, k))
      .map((k) => `${path}.${k}: 缺少必填字段`);
    for (const [k, v] of Object.entries(value)) {
      if (record(props[k])) {
        errors.push(...schemaProblems(v, props[k], `${path}.${k}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${k}: 未授权字段`);
      } else if (record(schema.additionalProperties)) {
        errors.push(
          ...schemaProblems(v, schema.additionalProperties, `${path}.${k}`),
        );
      }
    }
    return errors.slice(0, 20);
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [`${path}: 应为数组`];
    if (
      (typeof schema.minItems === "number" && value.length < schema.minItems) ||
      (typeof schema.maxItems === "number" && value.length > schema.maxItems)
    ) {
      return [`${path}: 数组长度不符合契约`];
    }
    return record(schema.items)
      ? value
          .flatMap((v, i) =>
            schemaProblems(v, schema.items as Schema, `${path}[${i}]`),
          )
          .slice(0, 20)
      : [];
  }
  if (
    (type === "string" && typeof value !== "string") ||
    (type === "boolean" && typeof value !== "boolean") ||
    (type === "integer" && !Number.isInteger(value)) ||
    (type === "number" && typeof value !== "number")
  ) {
    return [`${path}: 类型应为 ${String(type)}`];
  }
  if (
    typeof value === "number" &&
    ((typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum))
  ) {
    return [`${path}: 数值越界`];
  }
  if (
    typeof value === "string" &&
    ((typeof schema.minLength === "number" && value.length < schema.minLength) ||
      (typeof schema.maxLength === "number" && value.length > schema.maxLength) ||
      (typeof schema.pattern === "string" &&
        !new RegExp(schema.pattern).test(value)))
  ) {
    return [`${path}: 文本不符合契约`];
  }
  return [];
}
