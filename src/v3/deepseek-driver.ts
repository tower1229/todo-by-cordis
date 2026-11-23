import { DeepSeek } from "../evolution/deepseek.js";
import type { Driver } from "../evolution/driver.js";
import {
  createDeepSeekModelDriver as adaptDriverToModelDriver,
  type ModelDriver,
  type ModelDriverReply,
  type ModelDriverRequest,
} from "./evolution-loop.js";

export interface DeepSeekModelDriverOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly http?: typeof fetch;
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

/**
 * Adapts the retained DeepSeek streaming HTTP driver to the V3 EvolutionLoop ModelDriver contract,
 * delegating message-history & protocolErrors normalization to the single canonical adapter in
 * `evolution-loop.ts` so production and acceptance runs never push raw HTTP envelopes into history.
 */
export function createDeepSeekModelDriver(
  options: DeepSeekModelDriverOptions,
): ModelDriver {
  const inner = new DeepSeek(
    options.apiKey,
    options.http ?? fetch,
    options.endpoint ?? "https://api.deepseek.com/chat/completions",
  );

  let lastRawUsage: unknown;
  const capturingInner: Driver = {
    async generate(request, signal, onTransport) {
      const res = await inner.generate(request, signal, onTransport);
      lastRawUsage = res.usage;
      return res;
    },
  };
  const adapted = adaptDriverToModelDriver(capturingInner);

  return {
    async generate(
      request: ModelDriverRequest,
      signal: AbortSignal,
    ): Promise<ModelDriverReply> {
      const startedAt = Date.now();
      lastRawUsage = undefined;
      try {
        const reply = await adapted.generate(request, signal);
        options.onRecord?.({
          timestamp: new Date().toISOString(),
          durationMs: Date.now() - startedAt,
          request,
          reply,
          rawUsage: lastRawUsage,
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
