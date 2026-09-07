import { createHash } from "node:crypto";
export function hash(value: unknown): string {
  function canonical(input: unknown): string {
    if (input === undefined) return "null";
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (input && typeof input === "object")
      return `{${Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",")}}`;
    return JSON.stringify(input);
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

// Preserve the original operation digest so old database retries remain valid.
export function operationHash(value: unknown): string {
  const canonical = (input: unknown): string | undefined => {
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (input && typeof input === "object") {
      const record = input as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(record[k])}`)
        .join(",")}}`;
    }
    return JSON.stringify(input);
  };
  return createHash("sha256")
    .update(canonical(value) ?? "undefined")
    .digest("hex");
}
