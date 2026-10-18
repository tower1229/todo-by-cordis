import type { ModelPhase } from "./budget.js";
import { hash } from "../release/storage.js";

export type ModelOutputPolicy = {
  version: 3;
  phase: ModelPhase | "standalone";
  maxTokens: 65536 | 131072;
  tokenScope: "reasoning-and-answer";
  truncation: "block";
  hash: string;
} & (
  | { thinking: "enabled"; reasoningEffort: "max" }
  | { thinking: "disabled"; reasoningEffort: "none" }
);

// max_tokens covers reasoning and the final answer. Use the documented max-effort
// default (128K) for review/generation and 64K for smaller intake/planning turns.
// The shared run deadline remains authoritative; a larger cap does not extend it.
// https://api-docs.deepseek.com/api/create-chat-completion/
const outputPolicies = {
  admission: { thinking: "enabled", reasoningEffort: "max", maxTokens: 65536 },
  planning: { thinking: "enabled", reasoningEffort: "max", maxTokens: 65536 },
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
    version: 3 as const,
    phase,
    tokenScope: "reasoning-and-answer" as const,
    ...outputPolicies[phase],
    truncation: "block" as const,
  };
  return { ...body, hash: hash(body) };
}
