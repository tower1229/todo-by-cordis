import {
  GoogleGenAI,
  FunctionCallingConfigMode,
  ApiError,
  type Content,
} from "@google/genai";
import type { Driver, ModelRequest } from "./driver.js";
import { ModelTransportError } from "./driver.js";
import {
  providerSchema,
  responseSchema,
  responsePayload,
} from "./model-protocol.js";
import { hash } from "../release/storage.js";
export class Gemini implements Driver {
  private client: { models: Pick<GoogleGenAI["models"], "generateContent"> };
  constructor(
    private key: string,
    client?: { models: Pick<GoogleGenAI["models"], "generateContent"> },
  ) {
    this.client = client ?? new GoogleGenAI({ apiKey: key });
  }
  async generate(request: ModelRequest, signal: AbortSignal) {
    const history = [...request.history] as Content[];
    if (request.message)
      history.push({ role: "user", parts: [{ text: request.message }] });
    const schema = request.schema ? responseSchema(request.schema) : undefined;
    const declarations = request.tools?.length
      ? request.tools.map(({ name, description, parameters }) => ({
          name,
          description,
          parametersJsonSchema: providerSchema(parameters),
        }))
      : undefined;
    const transport = {
      profile: "gemini-3.1-shape/2",
      ...(schema ? { schemaHash: hash(schema) } : {}),
      ...(declarations
        ? { toolsHash: hash(declarations), functionMode: "ANY" }
        : {}),
    };
    const response = await this.client.models
      .generateContent({
        model: "gemini-3.1-pro-preview",
        contents: history,
        config: {
          systemInstruction: request.instruction,
          abortSignal: signal,
          httpOptions: { retryOptions: { attempts: 1 } },
          ...(request.schema
            ? {
                responseMimeType: "application/json",
                responseJsonSchema: schema,
              }
            : {}),
          ...(declarations
            ? {
                tools: [{ functionDeclarations: declarations }],
                toolConfig: {
                  functionCallingConfig: {
                    mode: FunctionCallingConfigMode.ANY,
                    allowedFunctionNames: declarations.map((t) => t.name),
                  },
                },
              }
            : {}),
        },
      })
      .catch((error: unknown) => {
        throw new ModelTransportError(
          (error instanceof Error
            ? error.message
            : "Gemini 请求失败"
          ).replaceAll(this.key, "[redacted]"),
          transport,
          error instanceof ApiError ? error.status : undefined,
        );
      });
    const content = response.candidates?.[0]?.content;
    // Keep the complete Content, including thought signatures, without reconstructing parts.
    if (content?.parts?.length) history.push({ ...content, role: "model" });
    const text =
      content?.parts
        ?.filter((part) => !part.thought && part.text)
        .map((part) => part.text)
        .join("") ?? "";
    const payload: { text: string; envelopeValid?: boolean } = schema
      ? responsePayload(text)
      : { text };
    return {
      text: payload.text,
      history,
      calls: (response.functionCalls ?? []).map((call) => ({
        id: call.id,
        name: call.name ?? "",
        args: call.args ?? {},
      })),
      usage: response.usageMetadata ?? null,
      raw: response,
      transport: {
        ...transport,
        ...("envelopeValid" in payload
          ? { envelopeValid: payload.envelopeValid }
          : {}),
        finishReason: response.candidates?.[0]?.finishReason,
      },
    };
  }
}
