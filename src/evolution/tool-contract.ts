import { schemaProblems, ModelProtocolError } from "./model-protocol.js";

type Schema = Record<string, unknown>;
type Contract = {
  schema: Schema;
  encode(value: unknown): unknown;
  decode(value: unknown): unknown;
};
const record = (value: unknown): value is Schema =>
  !!value && typeof value === "object" && !Array.isArray(value);
const object = (properties: Schema): Schema => ({
  type: "object",
  properties,
  required: Object.keys(properties),
  additionalProperties: false,
});
const tag = (kind: string) => ({ type: "string", enum: [kind] });
const fail = (detail: string): never => {
  throw new ModelProtocolError("严格工具契约：" + detail);
};
function validate(value: unknown, schema: Schema) {
  const errors = schemaProblems(value, schema);
  if (schema.type === "null" && value !== null) errors.push("应为 null");
  if (errors.length) fail(errors.join("；"));
}

/** A lossless transport codec, not a relaxed business schema. DeepSeek strict
 * requires closed objects and all properties required. Optional presence and
 * dictionaries are encoded explicitly; the original contract remains authoritative.
 */
export function compileToolContract(original: Schema): Contract {
  const build = (source: Schema): Contract => {
    const node = compile(source);
    if (typeof source.description === "string")
      node.schema = { ...node.schema, description: source.description };
    return node;
  };
  const compile = (source: Schema): Contract => {
    const variants = Array.isArray(source.anyOf)
      ? source.anyOf
      : Array.isArray(source.type)
        ? source.type.map((type) => ({ ...source, type }))
        : undefined;
    if (variants) {
      const branches = variants.map((value) => {
        if (!record(value)) return fail("不支持的分支");
        return { original: value, node: build(value) };
      });
      return {
        schema: { anyOf: branches.map((b) => b.node.schema) },
        encode(value) {
          for (const b of branches) {
            try {
              validate(value, b.original);
              return b.node.encode(value);
            } catch {
              /* Try the next declared branch only. */
            }
          }
          return fail("值不符合任何声明分支");
        },
        decode(value) {
          const decoded: unknown[] = [];
          for (const b of branches) {
            try {
              validate(value, b.node.schema);
              const result = b.node.decode(value);
              validate(result, b.original);
              decoded.push(result);
            } catch {
              /* Not this branch. */
            }
          }
          if (
            !decoded.length ||
            new Set(decoded.map((v) => JSON.stringify(v))).size !== 1
          )
            return fail("分支不匹配或解码不唯一");
          return decoded[0];
        },
      };
    }
    if (source.type === "null")
      return {
        schema: object({ kind: tag("null") }),
        encode(value) {
          if (value !== null) return fail("应为 null");
          return { kind: "null" };
        },
        decode() {
          return null;
        },
      };
    if (source.type === "array") {
      if (source.maxItems === 0)
        return {
          schema: {
            ...object({}),
            description: "Empty array: the host authorizes no entries.",
          },
          encode() {
            return {};
          },
          decode() {
            return [];
          },
        };
      if (!record(source.items)) return fail("不支持无元素定义的数组");
      const child = build(source.items);
      return {
        schema: { type: "array", items: child.schema },
        encode(value) {
          if (!Array.isArray(value)) return fail("应为数组");
          return value.map(child.encode);
        },
        decode(value) {
          if (!Array.isArray(value)) return fail("应为数组");
          return value.map(child.decode);
        },
      };
    }
    if (source.type === "object") {
      const props = record(source.properties) ? source.properties : {};
      if (record(source.additionalProperties)) {
        if (Object.keys(props).length)
          return fail("不支持混合固定属性与字典的对象");
        const child = build(source.additionalProperties);
        return {
          schema: {
            type: "array",
            description:
              "Dictionary entries. Each business key occurs exactly once; an empty list is an empty dictionary.",
            items: object({ key: { type: "string" }, value: child.schema }),
          },
          encode(value) {
            if (!record(value)) return fail("字典应为对象");
            return Object.entries(value).map(([key, value]) => ({
              key,
              value: child.encode(value),
            }));
          },
          decode(value) {
            if (!Array.isArray(value)) return fail("字典传输应为键值数组");
            const entries = value.map((item) => {
              if (!record(item) || typeof item.key !== "string")
                return fail("字典项无效");
              return [item.key, child.decode(item.value)] as const;
            });
            if (new Set(entries.map(([key]) => key)).size !== entries.length)
              return fail("字典键重复");
            return Object.fromEntries(entries);
          },
        };
      }
      if (source.additionalProperties !== false)
        return fail("不支持未定义的开放对象");
      const required = new Set(
        Array.isArray(source.required) ? source.required : [],
      );
      const children = Object.entries(props).map(([key, value]) => {
        if (!record(value)) return fail("属性定义无效");
        const node = build(value);
        const optional = !required.has(key);
        return {
          key,
          node,
          optional,
          wire: optional
            ? {
                anyOf: [
                  object({ kind: tag("omit") }),
                  object({ kind: tag("value"), value: node.schema }),
                ],
                description:
                  "Optional property: omit explicitly, or provide the exact value. Omission has no business default.",
              }
            : node.schema,
        };
      });
      return {
        schema: object(
          Object.fromEntries(children.map((c) => [c.key, c.wire])),
        ),
        encode(value) {
          if (!record(value)) return fail("应为对象");
          return Object.fromEntries(
            children.map((c) => [
              c.key,
              c.optional
                ? Object.hasOwn(value, c.key)
                  ? { kind: "value", value: c.node.encode(value[c.key]) }
                  : { kind: "omit" }
                : c.node.encode(value[c.key]),
            ]),
          );
        },
        decode(value) {
          if (!record(value)) return fail("应为对象");
          return Object.fromEntries(
            children.flatMap((c) => {
              const v = value[c.key];
              if (!c.optional) return [[c.key, c.node.decode(v)]];
              if (!record(v)) return fail("可选属性缺少存在标记");
              return v.kind === "omit" ? [] : [[c.key, c.node.decode(v.value)]];
            }),
          );
        },
      };
    }
    if (
      !["string", "boolean", "integer", "number"].includes(String(source.type))
    )
      return fail("不支持的类型：" + JSON.stringify(source.type));
    const schema = Object.fromEntries(
      Object.entries(source).filter(([key]) =>
        [
          "type",
          "enum",
          "description",
          "pattern",
          "format",
          "minimum",
          "maximum",
          "multipleOf",
        ].includes(key),
      ),
    );
    return { schema, encode: (value) => value, decode: (value) => value };
  };
  const node = build(original);
  return {
    schema: node.schema,
    encode(value) {
      validate(value, original);
      const encoded = node.encode(value);
      validate(encoded, node.schema);
      return encoded;
    },
    decode(value) {
      validate(value, node.schema);
      const decoded = node.decode(value);
      validate(decoded, original);
      return decoded;
    },
  };
}
