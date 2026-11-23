import { createHash } from "node:crypto";
import type { ModelPhase } from "./budget.js";

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

export type ModelOutputPolicy = {
  version: 4;
  phase: ModelPhase | "standalone";
  maxTokens: 65536 | 131072;
  tokenScope: "reasoning-and-answer";
  truncation: "block";
  hash: string;
} & (
  | { thinking: "enabled"; reasoningEffort: "max" | "high" }
  | { thinking: "disabled"; reasoningEffort: "none" }
);

// max_tokens covers reasoning and the final answer. Use the documented max-effort
// allowance (128K) for planning/review/generation and 64K for source intake.
// The shared run deadline remains authoritative; a larger cap does not extend it.
// https://api-docs.deepseek.com/api/create-chat-completion/
const outputPolicies = {
  admission: { thinking: "enabled", reasoningEffort: "max", maxTokens: 65536 },
  planning: { thinking: "enabled", reasoningEffort: "max", maxTokens: 131072 },
  review: { thinking: "enabled", reasoningEffort: "max", maxTokens: 131072 },
  generation: {
    thinking: "enabled",
    reasoningEffort: "max",
    maxTokens: 131072,
  },
  standalone: { thinking: "enabled", reasoningEffort: "max", maxTokens: 65536 },
} as const;
/** A host execution policy, independent of tool catalogs and model-authored arguments. */
export function modelPolicy(
  phase: ModelPhase | "standalone" = "standalone",
): ModelOutputPolicy {
  const body = {
    version: 4 as const,
    phase,
    tokenScope: "reasoning-and-answer" as const,
    ...outputPolicies[phase],
    truncation: "block" as const,
  };
  return { ...body, hash: hash(body) };
}
