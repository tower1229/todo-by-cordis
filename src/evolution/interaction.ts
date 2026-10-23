import { hash } from "../release/storage.js";
import type {
  ClarificationQuestion,
  ClarificationAnswer,
  DefaultDecision,
  DefaultReview,
} from "../shared/evolution-interaction.js";
import { AppError } from "../shared/contracts.js";
import { schemaProblems } from "./model-protocol.js";

const text = { type: "string", minLength: 1, maxLength: 2000 };
export const defaultsSchema = {
  type: "array",
  maxItems: 20,
  items: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "behavior", "basis", "impact"],
    properties: { scope: text, behavior: text, basis: text, impact: text },
  },
};
export function compileDefaults(value: unknown): DefaultDecision[] {
  const raw = value ?? [];
  const problems = schemaProblems(raw, defaultsSchema);
  if (problems.length)
    throw new Error("默认处理格式无效：" + problems.join("；"));
  const decisions = (raw as Omit<DefaultDecision, "id">[]).map((d) => ({
    ...d,
    id: "default-" + hash(d).slice(0, 24),
  }));
  if (new Set(decisions.map((d) => d.scope)).size !== decisions.length)
    throw new Error("默认处理作用域重复");
  return decisions;
}
export function defaultReviewSchema(
  defaults: DefaultDecision[],
  targets: string[],
) {
  return {
    type: "array",
    minItems: defaults.length,
    maxItems: defaults.length,
    items: {
      type: "object",
      additionalProperties: false,
      required: ["id", "verdict", "detail", "targets"],
      properties: {
        id: {
          type: "string",
          enum: defaults.length ? defaults.map((d) => d.id) : ["unavailable"],
        },
        verdict: {
          type: "string",
          enum: ["safe-default", "requires-choice", "conflict"],
        },
        detail: text,
        targets: {
          type: "array",
          uniqueItems: true,
          items: {
            type: "string",
            enum: targets.length ? targets : ["unavailable"],
          },
        },
      },
    },
  };
}
export function parseDefaultReviews(
  value: unknown,
  defaults: DefaultDecision[],
  targets: string[],
): DefaultReview[] {
  const raw = value ?? [];
  const problems = schemaProblems(raw, defaultReviewSchema(defaults, targets));
  if (problems.length)
    throw new Error("默认处理缺少独立复核：" + problems.join("；"));
  const reviews = raw as DefaultReview[];
  if (new Set(reviews.map((r) => r.id)).size !== defaults.length)
    throw new Error("默认处理复核重复或遗漏");
  return reviews;
}
export function defaultAuthorizes(
  reviews: DefaultReview[] | undefined,
  target: string,
) {
  return (
    reviews?.some(
      (r) => r.verdict === "safe-default" && r.targets.includes(target),
    ) === true
  );
}
export function questionsFor(
  runId: string,
  revision: number,
  questions: string[],
  reviews: {
    question: string;
    decision: {
      sourceRevision: string;
      sourceQuote: string;
      detail: string;
      presentation?: {
        options: { label: string }[];
        recommended?: number;
        explanation: string;
      };
    };
  }[],
): ClarificationQuestion[] {
  return questions.map((title) => {
    const decision = [...reviews]
      .reverse()
      .find((r) => r.question === title)?.decision;
    if (!decision) throw new Error("问题缺少独立审查及来源绑定");
    const id =
      "question-" +
      hash({
        runId,
        revision,
        title,
        sourceRevision: decision.sourceRevision,
        sourceQuote: decision.sourceQuote,
      }).slice(0, 24);
    const options = (decision.presentation?.options ?? []).map((o, index) => ({
      id: `${id}:${index + 1}`,
      label: o.label,
    }));
    return {
      id,
      title,
      explanation: decision.presentation?.explanation ?? decision.detail,
      sourceRevision: decision.sourceRevision,
      sourceQuote: decision.sourceQuote,
      options,
      ...(decision.presentation?.recommended
        ? {
            recommendedOptionId:
              options[decision.presentation.recommended - 1]?.id,
          }
        : {}),
    };
  });
}
export function answerText(
  questions: ClarificationQuestion[],
  answers: ClarificationAnswer[],
): string {
  if (
    answers.length !== questions.length ||
    new Set(answers.map((a) => a.questionId)).size !== questions.length
  )
    throw new AppError("QUESTION_STALE", "请回答当前的全部问题", 409);
  return questions
    .map((q) => {
      const answer = answers.find((a) => a.questionId === q.id);
      const option = q.options.find((o) => o.id === answer?.optionId);
      if (
        !answer ||
        (answer.optionId && !option) ||
        (!option && !answer.text?.trim())
      )
        throw new AppError("QUESTION_STALE", "回答与当前问题不匹配", 409);
      return [option?.label, answer.text?.trim()].filter(Boolean).join("；");
    })
    .join("\n\n");
}
