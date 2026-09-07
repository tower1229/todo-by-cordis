import { GoogleGenAI, type Content } from "@google/genai";
import type { Driver, ModelRequest } from "./driver.js";
export class Gemini implements Driver {
  private client: GoogleGenAI;
  constructor(private key: string) {
    this.client = new GoogleGenAI({ apiKey: key });
  }
  async generate(request: ModelRequest, signal: AbortSignal) {
    const history = [...request.history] as Content[];
    if (request.message)
      history.push({ role: "user", parts: [{ text: request.message }] });
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
                responseJsonSchema: request.schema,
              }
            : {}),
          ...(request.tools
            ? { tools: [{ functionDeclarations: request.tools }] }
            : {}),
        },
      })
      .catch((error: unknown) => {
        throw new Error(
          (error instanceof Error
            ? error.message
            : "Gemini 请求失败"
          ).replaceAll(this.key, "[redacted]"),
        );
      });
    const content = response.candidates?.[0]?.content;
    if (!content) throw new Error("模型未返回内容");
    // Keep the complete Content, including thought signatures, without reconstructing parts.
    history.push(content);
    return {
      text:
        content.parts
          ?.filter((part) => !part.thought && part.text)
          .map((part) => part.text)
          .join("") ?? "",
      history,
      calls: (response.functionCalls ?? []).map((call) => ({
        id: call.id,
        name: call.name ?? "",
        args: call.args ?? {},
      })),
      usage: response.usageMetadata ?? null,
      raw: response,
    };
  }
}
