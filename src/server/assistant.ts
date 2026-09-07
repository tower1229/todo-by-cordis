import { AppError } from "../shared/contracts.js";
import type {
  AssistantCommand,
  AssistantSnapshot,
} from "../shared/assistant.js";

// Public planning boundary. Commands persist revisions and operation receipts.
// Legacy confirm is parsed only to return an explicit refusal, never execution.
export type AssistantService = {
  observe(runId?: string): Promise<AssistantSnapshot>;
  command(command: AssistantCommand): Promise<AssistantSnapshot>;
};

export function parseAssistantCommand(value: unknown): AssistantCommand {
  const invalid = () => new AppError("INVALID_INPUT", "AI 请求格式无效");
  if (!value || typeof value !== "object") throw invalid();
  const input = value as Record<string, unknown>;
  const id = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 100;
  if (!id(input.operationId)) throw invalid();
  if (
    input.type === "request" ||
    input.type === "answer" ||
    input.type === "revise"
  ) {
    if (
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 5000 ||
      (input.runId !== undefined && !id(input.runId))
    )
      throw invalid();
    if (input.type !== "request") {
      if (!id(input.runId)) throw invalid();
      return {
        type: input.type,
        operationId: input.operationId,
        text: input.text.trim(),
        runId: input.runId,
      };
    }
    return {
      type: "request",
      operationId: input.operationId,
      text: input.text.trim(),
      ...(input.runId ? { runId: input.runId as string } : {}),
    };
  }
  if (!id(input.runId)) throw invalid();
  if (input.type === "cancel")
    return {
      type: "cancel",
      operationId: input.operationId,
      runId: input.runId,
    };
  if (
    input.type === "confirm" &&
    id(input.planId) &&
    typeof input.compositionRevision === "number" &&
    Number.isSafeInteger(input.compositionRevision) &&
    input.compositionRevision > 0
  ) {
    return {
      type: "confirm",
      operationId: input.operationId,
      runId: input.runId,
      planId: input.planId,
      compositionRevision: input.compositionRevision,
    };
  }
  throw invalid();
}

export const unavailableAssistant: AssistantService = {
  async observe() {
    return { availability: "unconfigured", run: null };
  },
  async command() {
    throw new AppError("AI_UNAVAILABLE", "AI 尚未连接，需求已保留。", 503);
  },
};
