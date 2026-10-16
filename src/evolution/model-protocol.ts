import { parseExpression } from "@babel/parser";
import type { ModelReply, ModelRequest } from "./driver.js";

type Schema = Record<string, unknown>;
const record = (v: unknown): v is Schema =>
  !!v && typeof v === "object" && !Array.isArray(v);
const schemas = (v: unknown): Schema[] =>
  Array.isArray(v) ? v.filter(record) : [];
/** JSON syntax is checked first; the AST is data only and is never evaluated. */
export function parseToolArguments(text: string): unknown {
  const value: unknown = JSON.parse(text);
  const visit = (node: unknown) => {
    if (!record(node)) return;
    if (node.type === "ObjectExpression" && Array.isArray(node.properties)) {
      const keys = new Set<string>();
      for (const value of node.properties) {
        const property = record(value) ? value : {};
        const key = record(property.key) ? property.key.value : undefined;
        if (typeof key !== "string" || keys.has(key))
          throw new ModelProtocolError("工具 JSON 属性重复或无效");
        keys.add(key);
      }
    }
    for (const child of Object.values(node))
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === "object") visit(child);
  };
  visit(parseExpression(text));
  return value;
}
/** A mandatory envelope prevents an object union at the JSON document root. */
export function responseSchema(schema: Schema): Schema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["result"],
    properties: { result: schema },
  };
}
export function responsePayload(text: string): {
  text: string;
  envelopeValid: boolean;
} {
  try {
    const v: unknown = JSON.parse(text);
    if (record(v) && Object.keys(v).length === 1 && Object.hasOwn(v, "result"))
      return { text: JSON.stringify(v.result), envelopeValid: true };
  } catch {
    /* Invalid output is archived and rejected by the host protocol validator. */
  }
  return { text, envelopeValid: false };
}

/** Validate the exact source schema, including union-specific forbidden fields. */
export function schemaProblems(
  value: unknown,
  schema: Schema,
  path = "$o",
): string[] {
  if (Array.isArray(schema.type)) {
    const type = schema.type.find(type => !schemaProblems(value, { type }, path).length);
    // Preserve nested business diagnostics for a nullable collection of the correct type.
    return type === undefined ? [`${path}: 类型不符合声明分支`]
      : schemaProblems(value, { ...schema, type }, path);
  }
  if (schema.type === "null")
    return value === null ? [] : [`${path}: 应为 null`];
  const union = schemas(schema.anyOf);
  if (
    union.length &&
    !union.some((s) => !schemaProblems(value, s, path).length)
  ) {
    const matching = record(value)
      ? union.filter(
          (s) =>
            record(s.properties) &&
            record(s.properties.kind) &&
            Array.isArray(s.properties.kind.enum) &&
            s.properties.kind.enum.includes(value.kind),
        )
      : [];
    const branches = matching.length ? matching : union;
    const closest = branches
      .map((s) => schemaProblems(value, s, path))
      .sort((a, b) => a.length - b.length)[0];
    return [`${path}: 不符合任何契约分支`, ...closest].slice(0, 20);
  }
  if (
    Array.isArray(schema.enum) &&
    !schema.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))
  )
    return [`${path}: 不在允许值中`];
  const type = schema.type;
  if (type === "object") {
    if (!record(value)) return [`${path}: 应为对象`];
    const props = record(schema.properties) ? schema.properties : {};
    const errors = ((schema.required as string[] | undefined) ?? [])
      .filter((k) => !Object.hasOwn(value, k))
      .map((k) => `${path}.${k}: 缺少必填字段`);
    for (const [k, v] of Object.entries(value)) {
      if (record(props[k]))
        errors.push(...schemaProblems(v, props[k], `${path}.${k}`));
      else if (schema.additionalProperties === false)
        errors.push(`${path}.${k}: 未授权字段`);
      else if (record(schema.additionalProperties))
        errors.push(
          ...schemaProblems(v, schema.additionalProperties, `${path}.${k}`),
        );
    }
    return errors.slice(0, 20);
  }
  if (type === "array") {
    if (!Array.isArray(value)) return [`${path}: 应为数组`];
    if (
      (typeof schema.minItems === "number" && value.length < schema.minItems) ||
      (typeof schema.maxItems === "number" && value.length > schema.maxItems)
    )
      return [`${path}: 数组长度不符合契约`];
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
  )
    return [`${path}: 类型应为 ${String(type)}`];
  if (
    typeof value === "number" &&
    ((typeof schema.minimum === "number" && value < schema.minimum) ||
      (typeof schema.maximum === "number" && value > schema.maximum))
  )
    return [`${path}: 数值越界`];
  if (
    typeof value === "string" &&
    ((typeof schema.minLength === "number" &&
      value.length < schema.minLength) ||
      (typeof schema.maxLength === "number" &&
        value.length > schema.maxLength) ||
      (typeof schema.pattern === "string" &&
        !new RegExp(schema.pattern).test(value)))
  )
    return [`${path}: 文本不符合契约`];
  return [];
}

export function replyProblems(
  request: ModelRequest,
  reply: ModelReply,
): string[] {
  if (reply.protocolErrors?.length) return reply.protocolErrors;
  if (request.schema) {
    if (reply.transport?.envelopeValid === false)
      return ["结构化输出缺少有效的宿主 result 信封"];
    if (reply.calls.length) return ["结构化复核禁止工具调用"];
    try {
      return schemaProblems(JSON.parse(reply.text), request.schema);
    } catch {
      return ["结构化输出不是有效 JSON"];
    }
  }
  if (request.tools?.length) {
    if (!reply.calls.length || reply.calls.length > 16)
      return ["工具响应必须包含1至16个调用"];
    return reply.calls
      .flatMap((call) => {
        const tool = request.tools!.find((t) => t.name === call.name);
        return !tool
          ? ["工具不在本阶段授权目录：" + call.name]
          : schemaProblems(call.args, tool.parameters, `tool:${call.name}`);
      })
      .slice(0, 20);
  }
  return [];
}

export class ModelProtocolError extends Error {}
