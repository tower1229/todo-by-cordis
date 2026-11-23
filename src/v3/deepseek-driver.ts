import { DeepSeek } from "../evolution/deepseek.js";
import type {
  ModelDriver,
  ModelDriverReply,
  ModelDriverRequest,
} from "./evolution-loop.js";

export interface DeepSeekModelDriverOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly onRecord?: (record: DeepSeekCallRecord) => void;
}

export interface DeepSeekCallRecord {
  readonly timestamp: string;
  readonly durationMs: number;
  readonly request: ModelDriverRequest;
  readonly reply?: ModelDriverReply;
  readonly rawUsage?: unknown;
  readonly error?: string;
}

function normalizeUsage(
  rawUsage: unknown,
): ModelDriverReply["usage"] | undefined {
  if (!rawUsage || typeof rawUsage !== "object") {
    return { unknown: true };
  }
  const u = rawUsage as Record<string, unknown>;
  const promptTokens =
    typeof u.prompt_tokens === "number"
      ? u.prompt_tokens
      : typeof u.promptTokens === "number"
        ? u.promptTokens
        : undefined;
  const completionTokens =
    typeof u.completion_tokens === "number"
      ? u.completion_tokens
      : typeof u.completionTokens === "number"
        ? u.completionTokens
        : undefined;
  const totalTokens =
    typeof u.total_tokens === "number"
      ? u.total_tokens
      : typeof u.totalTokens === "number"
        ? u.totalTokens
        : promptTokens !== undefined && completionTokens !== undefined
          ? promptTokens + completionTokens
          : undefined;
  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined
  ) {
    return { unknown: true };
  }
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/**
 * Adapts the retained DeepSeek streaming HTTP driver to the V3 EvolutionLoop ModelDriver contract.
 */
export function createDeepSeekModelDriver(
  options: DeepSeekModelDriverOptions,
): ModelDriver {
  const inner = new DeepSeek(
    options.apiKey,
    fetch,
    options.endpoint ?? "https://api.deepseek.com/chat/completions",
  );

  return {
    async generate(
      request: ModelDriverRequest,
      signal: AbortSignal,
    ): Promise<ModelDriverReply> {
      const startedAt = Date.now();
      try {
        const result = await inner.generate(
          {
            instruction: request.system,
            history: [...request.history],
            tools: request.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
            phase: "generation",
          },
          signal,
        );
        const reply: ModelDriverReply = {
          ...(result.text !== undefined ? { text: result.text } : {}),
          ...(result.calls.length > 0
            ? {
                calls: result.calls.map((call, idx) => ({
                  id: call.id ?? `call_${Date.now()}_${idx}`,
                  name: call.name,
                  args: call.args,
                })),
              }
            : {}),
          ...(result.protocolErrors !== undefined
            ? { protocolErrors: result.protocolErrors }
            : {}),
          raw: result.raw,
          usage: normalizeUsage(result.usage),
        };
        options.onRecord?.({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          request,
          reply,
          rawUsage: result.usage,
        });
        return reply;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        options.onRecord?.({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          request,
          error: message,
        });
        throw err;
      }
    },
  };
}

/**
 * Fallback driver used when DEEPSEEK_API_KEY is not configured.
 * Allows the V3 SupervisorShell and loaded plugins to run normally for daily usage
 * without making any paid network requests.
 */
export function createUnconfiguredModelDriver(): ModelDriver {
  return {
    async generate(): Promise<ModelDriverReply> {
      throw new Error(
        "未配置 DEEPSEEK_API_KEY：当前仅运行本地插件与应用壳，如需触发自迭代请先配置 DEEPSEEK_API_KEY。",
      );
    },
  };
}
