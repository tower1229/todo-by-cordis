import type { Driver, ModelReply, ModelRequest } from "./driver.js";
import { ModelTransportError } from "./driver.js";
import {
  responseSchema,
  responsePayload,
  schemaProblems,
  parseToolArguments,
} from "./model-protocol.js";
import { hash } from "../release/storage.js";
import { configureModelNetwork } from "./model-network.js";
import { transportFailure } from "./transport-failure.js";
import { modelPolicy, type ModelOutputPolicy } from "./model-policy.js";

export const DEEPSEEK_MODEL = "deepseek-flash";
type Row = Record<string, unknown>;
const row = (v: unknown): Row =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {};

/** Host tool receipts use a provider independent parts envelope. Only this boundary encodes HTTP messages. */
function messages(history: unknown[]): Row[] {
  return history.flatMap((value) => {
    const v = row(value);
    if (!Array.isArray(v.parts)) return [v];
    return v.parts.map((part) => {
      const p = row(part);
      if (p.functionResponse) {
        const receipt = row(p.functionResponse);
        return {
          role: "tool",
          tool_call_id: receipt.id,
          content: JSON.stringify(receipt.response),
        };
      }
      if (typeof p.text !== "string")
        throw new Error("宿主模型历史包含不支持的消息");
      return { role: "user", content: p.text };
    });
  });
}

export class DeepSeek implements Driver {
  constructor(
    private key: string,
    private http: typeof fetch = fetch,
    private endpoint = "https://api.deepseek.com/chat/completions",
    private policy: (
      phase: ModelRequest["phase"],
    ) => ModelOutputPolicy = modelPolicy,
  ) {}

  async generate(
    request: ModelRequest,
    signal: AbortSignal,
    onTransport?: (transport: NonNullable<ModelReply["transport"]>) => void,
  ): Promise<ModelReply> {
    const history = messages(request.history);
    if (request.message)
      history.push({ role: "user", content: request.message });
    const schema = request.schema ? responseSchema(request.schema) : undefined;
    const tools = request.tools?.length
      ? request.tools.map((t) => ({
          type: "function",
          function: {
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          },
        }))
      : undefined;
    const policy = this.policy(request.phase);
    const expectedPolicy = modelPolicy(request.phase);
    const { hash: digest, ...policyBody } = policy;
    if (
      digest !== hash(policyBody) ||
      policy.phase !== (request.phase ?? "standalone") ||
      policy.version !== expectedPolicy.version ||
      policy.maxTokens !== expectedPolicy.maxTokens ||
      policy.tokenScope !== "reasoning-and-answer" ||
      policy.truncation !== "block" ||
      !(
        (policy.thinking === "enabled" && policy.reasoningEffort === "max") ||
        (policy.thinking === "disabled" && policy.reasoningEffort === "none")
      )
    )
      throw new Error("宿主模型输出策略无效");
    // Thinking cannot force provider tool choice; the host still requires valid calls.
    const functionMode = tools
      ? policy.thinking === "enabled"
        ? "auto"
        : "required"
      : undefined;
    const transport: NonNullable<ModelReply["transport"]> = {
      profile: "deepseek-chat/6",
      outputPolicy: policy,
      requestedModel: DEEPSEEK_MODEL,
      ...(schema ? { schemaHash: hash(schema) } : {}),
      ...(tools ? { toolsHash: hash(tools), functionMode } : {}),
      http: { stage: "request", bodyBytes: 0, whitespaceBytes: 0 },
    };
    const started = performance.now();
    const publish = () => onTransport?.(structuredClone(transport));
    let httpStatus: number | undefined;
    let response: Row;
    try {
      if (
        this.http === fetch &&
        this.endpoint.startsWith("https://api.deepseek.com/")
      )
        transport.network = configureModelNetwork();
      publish();
      const body = {
        model: DEEPSEEK_MODEL,
        messages: [
          {
            role: "system",
            content:
              request.instruction +
              (schema
                ? "\nReturn only a JSON object matching this exact JSON Schema: " +
                  JSON.stringify(schema)
                : ""),
          },
          ...history,
        ],
        stream: false,
        max_tokens: policy.maxTokens,
        thinking: { type: policy.thinking },
        reasoning_effort: policy.reasoningEffort,
        ...(tools ? { tools, tool_choice: functionMode } : {}),
        ...(schema ? { response_format: { type: "json_object" } } : {}),
      };
      const result = await this.http(this.endpoint, {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: "Bearer " + this.key,
        },
        body: JSON.stringify(body),
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
      publish();
      // A 200 response may precede inference by minutes. Keep-alive whitespace is
      // transport evidence only; it must never count as a completed model reply.
      const decoder = new TextDecoder();
      let content = "";
      if (!result.body) throw new Error("DeepSeek 响应没有正文流");
      for await (const chunk of result.body) {
        const elapsed = Math.round(performance.now() - started);
        progress.firstByteMs ??= elapsed;
        progress.bodyBytes += chunk.byteLength;
        const text = decoder.decode(chunk, { stream: true });
        if (progress.firstContentMs === undefined) {
          if (chunk.some((byte) => byte !== 32 && (byte < 9 || byte > 13)))
            progress.firstContentMs = elapsed;
          else progress.whitespaceBytes += chunk.byteLength;
        }
        content += text;
        publish();
      }
      content += decoder.decode();
      progress.stage = "complete";
      publish();
      if (!result.ok) {
        const error = Object.assign(
          new Error(
            `DeepSeek HTTP ${result.status}: ${content.slice(0, 2000)}`,
          ),
          { status: result.status },
        );
        throw error;
      }
      response = row(JSON.parse(content));
    } catch (error) {
      const status =
        typeof row(error).status === "number"
          ? (row(error).status as number)
          : httpStatus;
      const failure = transportFailure(
        error,
        this.key,
        performance.now() - started,
        signal,
        status,
      );
      const code = failure.causes.find((c) => c.code)?.code;
      throw new ModelTransportError(
        (code ? `[${failure.kind}/${code}] ` : "") +
          (failure.causes[0]?.message ?? "DeepSeek 请求失败"),
        { ...transport, failure },
        status,
      );
    }
    const choice = row(
      Array.isArray(response.choices) ? response.choices[0] : undefined,
    );
    const message = row(choice.message);
    // Preserve complete assistant content and reasoning for subsequent tool exchanges.
    if (
      typeof message.content === "string" ||
      Array.isArray(message.tool_calls)
    )
      history.push(message);
    const text = typeof message.content === "string" ? message.content : "";
    const payload = schema ? responsePayload(text) : { text };
    const protocolErrors: string[] = [];
    if (
      [
        "length",
        "content_filter",
        "insufficient_system_resource",
        "aborted",
      ].includes(String(choice.finish_reason))
    )
      protocolErrors.push("供应商返回未完成的响应：" + choice.finish_reason);
    const calls = (
      Array.isArray(message.tool_calls) ? message.tool_calls : []
    ).map((value) => {
      const call = row(value),
        fn = row(call.function);
      let args: Row = {};
      try {
        const decoded: unknown = parseToolArguments(String(fn.arguments));
        if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
          throw new Error("工具参数不是对象");
        const schema = request.tools?.find(
          (t) => t.name === fn.name,
        )?.parameters;
        if (schema) {
          const problems = schemaProblems(decoded, schema);
          if (problems.length) throw new Error(problems.join("；"));
        }
        args = row(decoded);
      } catch (error) {
        protocolErrors.push(
          "工具参数不符合 JSON 业务契约：" +
            String(fn.name) +
            "：" +
            (error instanceof Error ? error.message : "解码失败"),
        );
      }
      if (typeof call.id !== "string" || !call.id)
        protocolErrors.push("工具调用缺少回执 ID");
      return {
        id: typeof call.id === "string" ? call.id : undefined,
        name: String(fn.name ?? ""),
        args,
      };
    });
    return {
      ...payload,
      history,
      calls,
      ...(protocolErrors.length ? { protocolErrors } : {}),
      usage: response.usage ?? null,
      raw: response,
      transport: {
        ...transport,
        ...("envelopeValid" in payload
          ? { envelopeValid: payload.envelopeValid }
          : {}),
        finishReason: String(choice.finish_reason ?? ""),
        actualModel:
          typeof response.model === "string" ? response.model : undefined,
      },
    };
  }
}
