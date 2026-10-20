import { hash } from "../release/storage.js";

type RepeatedText = { $text: { unit: string; count: number; hash: string } };
type ModelValue<T> = T extends string
  ? string | RepeatedText
  : T extends readonly unknown[]
    ? { [K in keyof T]: ModelValue<T[K]> }
    : T extends object
      ? { [K in keyof T]: ModelValue<T[K]> }
      : T;
export const modelInputEncoding = {
  version: "model-view/1",
  text: "$text expands exactly to unit repeated count times; hash binds the original string. This encoding is input-only; candidate files and tool arguments use actual contract values.",
};
/** Lossless presentation only. Never mutate acceptance definitions, evidence or hashes. */
export function modelInput<T>(value: T): ModelValue<T> {
  const visit = (v: unknown): unknown => {
    if (typeof v === "string" && v.length >= 256) {
      const chars = Array.from(v);
      if (chars.every((c) => c === chars[0]))
        return {
          $text: { unit: chars[0], count: chars.length, hash: hash(v) },
        };
    }
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, item]) => [k, visit(item)]),
      );
    return v;
  };
  return visit(value) as ModelValue<T>;
}
