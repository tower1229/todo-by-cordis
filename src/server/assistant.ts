import { AppError } from "../shared/contracts.js";
import type {
  AssistantCommand,
  AssistantSnapshot,
} from "../shared/assistant.js";

// Public assistant boundary. Commands persist revisions and operation receipts.
export type AssistantService = {
  observe(runId?: string, afterSequence?: number): Promise<AssistantSnapshot>;
  command(command: AssistantCommand): Promise<AssistantSnapshot>;
};

function parseAnswer(input: Record<string, unknown>) {
  if (input.answers === undefined && input.questionRevision === undefined) return {};
  if (!Number.isSafeInteger(input.questionRevision) || Number(input.questionRevision) < 1 || !Array.isArray(input.answers) || input.answers.length > 20) throw new AppError("INVALID_INPUT", "回答格式无效");
  const answers = input.answers.map((item: unknown) => {
    if (!item || typeof item !== "object") throw new AppError("INVALID_INPUT", "回答格式无效");
    const a = item as Record<string, unknown>;
    if (typeof a.questionId !== "string" || a.questionId.length > 100 || (a.optionId !== undefined && (typeof a.optionId !== "string" || a.optionId.length > 120)) || (a.text !== undefined && (typeof a.text !== "string" || a.text.length > 5000))) throw new AppError("INVALID_INPUT", "回答格式无效");
    return { questionId: a.questionId, ...(typeof a.optionId === "string" ? {optionId:a.optionId}:{}), ...(typeof a.text === "string" ? {text:a.text}:{}) };
  });
  return { questionRevision: Number(input.questionRevision), answers };
}

export function parseAssistantCommand(value: unknown): AssistantCommand {
  const invalid = () => new AppError("INVALID_INPUT", "AI 请求格式无效");
  if (!value || typeof value !== "object") throw invalid();
  const input = value as Record<string, unknown>;
  const id = (value: unknown): value is string =>
    typeof value === "string" && value.length > 0 && value.length <= 100;
  if (!id(input.operationId)) throw invalid();
  if (
    input.intent !== undefined &&
    input.intent !== "improve" &&
    input.intent !== "repair"
  )
    throw invalid();
  const intent = input.intent as "improve" | "repair" | undefined;
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
        ...(input.type === "answer" ? parseAnswer(input) : {}),
      };
    }
    return {
      type: "request",
      ...(intent ? { intent } : {}),
      operationId: input.operationId,
      text: input.text.trim(),
      ...(input.runId ? { runId: input.runId as string } : {}),
    };
  }
  if (!id(input.runId)) throw invalid();
  if (input.type === "resume-budget") {
    const amounts = input.amounts as Record<string, unknown> | undefined;
    if (!Number.isSafeInteger(input.pauseRevision) || Number(input.pauseRevision) < 1 || !amounts || ["calls", "candidates", "milliseconds"].some(k => !Number.isSafeInteger(amounts[k]) || Number(amounts[k]) < 0)) throw invalid();
    return { type: "resume-budget", operationId: input.operationId, runId: input.runId, pauseRevision: Number(input.pauseRevision), amounts: { calls: Number(amounts.calls), candidates: Number(amounts.candidates), milliseconds: Number(amounts.milliseconds) } };
  }
  if (input.type === "continue") {
    if (
      !id(input.baseVersion) ||
      typeof input.text !== "string" ||
      !input.text.trim() ||
      input.text.length > 5000
    )
      throw invalid();
    return {
      ...(intent ? { intent } : {}),
      type: "continue",
      operationId: input.operationId,
      runId: input.runId,
      baseVersion: input.baseVersion,
      text: input.text.trim(),
    };
  }
  if (
    input.type === "confirm-acceptance" &&
    id(input.planId) &&
    id(input.revisionId)
  )
    return {
      type: "confirm-acceptance",
      operationId: input.operationId,
      runId: input.runId,
      planId: input.planId,
      revisionId: input.revisionId,
    };
  if (input.type === "cancel")
    return {
      type: "cancel",
      operationId: input.operationId,
      runId: input.runId,
    };
  if (input.type === "start" && id(input.planId))
    return {
      type: "start",
      operationId: input.operationId,
      runId: input.runId,
      planId: input.planId,
    };
  if (input.type === "experience" && id(input.candidateId))
    return {
      type: "experience",
      operationId: input.operationId,
      runId: input.runId,
      candidateId: input.candidateId,
    };
  if (
    input.type === "apply" &&
    id(input.candidateId) &&
    id(input.evidenceHash) &&
    typeof input.compositionRevision === "number" &&
    Number.isSafeInteger(input.compositionRevision) &&
    input.compositionRevision > 0
  )
    return {
      type: "apply",
      operationId: input.operationId,
      runId: input.runId,
      candidateId: input.candidateId,
      evidenceHash: input.evidenceHash,
      compositionRevision: input.compositionRevision,
    };
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
