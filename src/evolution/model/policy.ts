import { createHash } from "node:crypto";

export function hashPolicyValue(value: unknown): string {
  function canonical(input: unknown): string {
    if (input === undefined) return "null";
    if (Array.isArray(input)) return `[${input.map(canonical).join(",")}]`;
    if (input && typeof input === "object") {
      return `{${Object.entries(input)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
        .join(",")}}`;
    }
    return JSON.stringify(input);
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

export interface ModelOutputPolicy {
  readonly version: 4;
  readonly maxTokens: 131072;
  readonly tokenScope: "reasoning-and-answer";
  readonly truncation: "block";
  readonly thinking: "enabled";
  readonly reasoningEffort: "max";
  readonly hash: string;
}

/** Host-owned output policy; cannot be overridden by model-authored tool calls. */
export function defaultModelOutputPolicy(): ModelOutputPolicy {
  const body = {
    version: 4 as const,
    tokenScope: "reasoning-and-answer" as const,
    thinking: "enabled" as const,
    reasoningEffort: "max" as const,
    maxTokens: 131072 as const,
    truncation: "block" as const,
  };
  return { ...body, hash: hashPolicyValue(body) };
}
