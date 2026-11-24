import { randomUUID } from "node:crypto";
import {
  ModelTransportError,
  type ModelDriver,
  type ModelDriverReply,
  type ModelDriverRequest,
  type ModelTransportMeta,
  type ModelUsageSummary,
} from "./types.js";
import { configureModelNetwork } from "./network.js";
import { defaultModelOutputPolicy, hashPolicyValue } from "./policy.js";
import { parseToolArguments, schemaProblems } from "./protocol.js";
import { transportFailure } from "./transport-failure.js";

export const DEEPSEEK_MODEL = "deepseek-flash";
const DEFAULT_DEEPSEEK_ENDPOINT = "https://api.deepseek.com/chat/completions";

type Row = Record<string, unknown>;
const asRow = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};

export interface DeepSeekCallRecord {
  readonly timestamp: string;
  readonly durationMs: number;
  readonly request: ModelDriverRequest;
  readonly reply?: ModelDriverReply;
  readonly rawUsage?: unknown;
  readonly error?: string;
}

export interface DeepSeekDriverOptions {
  readonly apiKey: string;
  readonly endpoint?: string;
  readonly http?: typeof fetch;
  readonly onRecord?: (record: DeepSeekCallRecord) => void;
}

function encodeHistoryMessages(history: readonly unknown[]): Row[] {
  return history.flatMap((value) => {
    const v = asRow(value);
    if (!Array.isArray(v.parts)) return [v];
    return v.parts.map((part) => {
      const p = asRow(part);
      if (p.functionResponse) {
        const receipt = asRow(p.functionResponse);
        return {
          role: "tool",
          tool_call_id: receipt.id,
          content: JSON.stringify(receipt.response),
        };
      }
      if (typeof p.text !== "string") {
        throw new Error("宿主模型历史包含不支持的消息");
      }
      return { role: "user", content: p.text };
    });
  });
}

function normalizeUsage(rawUsage: unknown): ModelUsageSummary {
  const usageObj =
    rawUsage && typeof rawUsage === "object" ? (rawUsage as Row) : null;
  const promptTokens =
    typeof usageObj?.promptTokens === "number"
      ? usageObj.promptTokens
      : typeof usageObj?.prompt_tokens === "number"
        ? usageObj.prompt_tokens
        : undefined;
  const completionTokens =
    typeof usageObj?.completionTokens === "number"
      ? usageObj.completionTokens
      : typeof usageObj?.completion_tokens === "number"
        ? usageObj.completion_tokens
        : undefined;
  const totalTokens =
    typeof usageObj?.totalTokens === "number"
      ? usageObj.totalTokens
      : typeof usageObj?.total_tokens === "number"
        ? usageObj.total_tokens
        : undefined;
  const unknown =
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined;
  return { promptTokens, completionTokens, totalTokens, unknown };
}

/**
 * Single canonical DeepSeek streaming-safe HTTP driver implementing ModelDriver.
 * Preserves assistant `reasoning_content` across multi-turn tool calls, enforces
 * proxy/credential isolation, and normalizes usage & protocolErrors without extra wrappers.
 */
export class DeepSeekDriver implements ModelDriver {
  private readonly apiKey: string;
  private readonly http: typeof fetch;
  private readonly endpoint: string;
  private readonly onRecord?: (record: DeepSeekCallRecord) => void;

  constructor(options: DeepSeekDriverOptions) {
    this.apiKey = options.apiKey;
    this.http = options.http ?? fetch;
    this.endpoint = options.endpoint ?? DEFAULT_DEEPSEEK_ENDPOINT;
    this.onRecord = options.onRecord;
  }

  async generate(
    request: ModelDriverRequest,
    signal: AbortSignal,
  ): Promise<ModelDriverReply> {
    const startedWall = Date.now();
    const started = performance.now();
    const policy = defaultModelOutputPolicy();
    const tools = request.tools.length
      ? request.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }))
      : undefined;
    const functionMode = tools ? "auto" : undefined;

    const transport: ModelTransportMeta = {
      profile: "deepseek-chat/6",
      outputPolicy: policy,
      requestedModel: DEEPSEEK_MODEL,
      ...(tools ? { toolsHash: hashPolicyValue(tools), functionMode } : {}),
      http: { stage: "request", bodyBytes: 0, whitespaceBytes: 0 },
    };

    let httpStatus: number | undefined;
    let response: Row;

    try {
      if (
        this.http === fetch &&
        this.endpoint.startsWith("https://api.deepseek.com/")
      ) {
        transport.network = configureModelNetwork();
      }

      const historyMessages = encodeHistoryMessages(request.history);
      const body = {
        model: DEEPSEEK_MODEL,
        messages: [{ role: "system", content: request.system }, ...historyMessages],
        stream: false,
        max_tokens: policy.maxTokens,
        thinking: { type: policy.thinking },
        reasoning_effort: policy.reasoningEffort,
        ...(tools ? { tools, tool_choice: functionMode } : {}),
      };

      const requestBody = JSON.stringify(body);
      transport.http!.requestBodyBytes = Buffer.byteLength(requestBody, "utf8");

      const result = await this.http(this.endpoint, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + this.apiKey,
        },
        body: requestBody,
      });

      httpStatus = result.ok ? undefined : result.status;
      const progress = transport.http!;
      Object.assign(progress, {
        stage: "body",
        status: result.status,
        headersMs: Math.round(performance.now() - started),
        requestId:
          result.headers.get("x-ds-trace-id") ??
          result.headers.get("x-request-id") ??
          undefined,
      });

      // Keep-alive whitespace bytes are transport evidence only, never completed content.
      const decoder = new TextDecoder();
      let content = "";
      if (!result.body) throw new Error("DeepSeek 响应没有正文流");
      for await (const chunk of result.body) {
        const elapsed = Math.round(performance.now() - started);
        progress.firstByteMs ??= elapsed;
        progress.bodyBytes += chunk.byteLength;
        const text = decoder.decode(chunk, { stream: true });
        if (progress.firstContentMs === undefined) {
          if (chunk.some((byte) => byte !== 32 && (byte < 9 || byte > 13))) {
            progress.firstContentMs = elapsed;
          } else {
            progress.whitespaceBytes += chunk.byteLength;
          }
        }
        content += text;
      }
      content += decoder.decode();
      progress.stage = "complete";

      if (!result.ok) {
        throw Object.assign(
          new Error(`DeepSeek HTTP ${result.status}: ${content.slice(0, 2000)}`),
          { status: result.status },
        );
      }

      response = asRow(JSON.parse(content));
    } catch (error) {
      const status =
        typeof asRow(error).status === "number"
          ? (asRow(error).status as number)
          : httpStatus;
      const failure = transportFailure(
        error,
        this.apiKey,
        performance.now() - started,
        signal,
        status,
      );
      const code = failure.causes.find((c) => c.code)?.code;
      const transportErr = new ModelTransportError(
        (code ? `[${failure.kind}/${code}] ` : "") +
          (failure.causes[0]?.message ?? "DeepSeek 请求失败"),
        { ...transport, failure },
        status,
      );
      this.onRecord?.({
        timestamp: new Date().toISOString(),
        durationMs: Date.now() - startedWall,
        request,
        error: transportErr.message,
      });
      throw transportErr;
    }

    const choice = asRow(
      Array.isArray(response.choices) ? response.choices[0] : undefined,
    );
    const message = asRow(choice.message);
    const text = typeof message.content === "string" ? message.content : "";

    const protocolErrors: string[] = [];
    if (
      [
        "length",
        "content_filter",
        "insufficient_system_resource",
        "aborted",
      ].includes(String(choice.finish_reason))
    ) {
      protocolErrors.push("供应商返回未完成的响应：" + choice.finish_reason);
    }

    const rawToolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    const calls = rawToolCalls.map((value, idx) => {
      const call = asRow(value);
      const fn = asRow(call.function);
      let args: Row = {};
      try {
        const decoded: unknown = parseToolArguments(String(fn.arguments));
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
          throw new Error("工具参数不是对象");
        }
        args = asRow(decoded);
        const schema = request.tools.find((t) => t.name === fn.name)?.parameters;
        if (schema) {
          const problems = schemaProblems(decoded, schema);
          if (problems.length) throw new Error(problems.join("；"));
        }
      } catch (error) {
        protocolErrors.push(
          "工具参数不符合 JSON 业务契约：" +
            String(fn.name) +
            "：" +
            (error instanceof Error ? error.message : "解码失败"),
        );
      }
      const hasValidId = typeof call.id === "string" && call.id.length > 0;
      if (!hasValidId) {
        protocolErrors.push("工具调用缺少回执 ID");
      }
      return {
        id: hasValidId ? (call.id as string) : `call-${idx}-${randomUUID().slice(0, 8)}`,
        name: String(fn.name ?? ""),
        args,
        _missingId: !hasValidId,
      };
    });

    const missingCallId = calls.some((c) => c._missingId);
    const normalizedCalls = calls.map(({ id, name, args }) => ({
      id,
      name,
      args,
    }));

    // Preserve complete assistant message (including reasoning_content) when valid;
    // never push raw HTTP envelopes into conversation history.
    const hasAssistantMessage =
      message.role === "assistant" &&
      (typeof message.content === "string" || Array.isArray(message.tool_calls));
    const assistantMessage: Row =
      hasAssistantMessage && !missingCallId
        ? message
        : {
            role: "assistant",
            content: text,
            ...(!missingCallId && normalizedCalls.length > 0
              ? {
                  tool_calls: normalizedCalls.map((c) => ({
                    id: c.id,
                    type: "function",
                    function: {
                      name: c.name,
                      arguments: JSON.stringify(c.args ?? {}),
                    },
                  })),
                }
              : {}),
          };

    const rawUsage = response.usage ?? null;
    const reply: ModelDriverReply = {
      text,
      calls: normalizedCalls,
      ...(protocolErrors.length ? { protocolErrors } : {}),
      raw: assistantMessage,
      usage: normalizeUsage(rawUsage),
      rawUsage,
      transport: {
        ...transport,
        finishReason: String(choice.finish_reason ?? ""),
        actualModel:
          typeof response.model === "string" ? response.model : undefined,
      },
    };

    this.onRecord?.({
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedWall,
      request,
      reply,
      rawUsage,
    });

    return reply;
  }
}

export function createDeepSeekDriver(options: DeepSeekDriverOptions): ModelDriver {
  return new DeepSeekDriver(options);
}

/**
 * Fallback driver when DEEPSEEK_API_KEY is not configured.
 * Allows daily plugin & supervisor usage without making any paid network requests.
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
