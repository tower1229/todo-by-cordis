import type { AssistantSnapshot } from "../../../src/shared/assistant.js";
import {
  admissionQuestionState,
  admissionResolved,
  questionReviewKey,
} from "../../../src/evolution/request-admission.js";
import type { StabilityScenario } from "./manifest.js";
import { hash } from "../../../src/release/storage.js";

type AwaitingRun = Pick<
  NonNullable<AssistantSnapshot["run"]>,
  "id" | "status" | "requestAdmissions" | "clarificationReviews"
> & { question?: string };

/** Answers only the predeclared unknown source item; wording is not its identity. */
export function frozenClarificationAnswer(
  scenario: StabilityScenario,
  run: AwaitingRun | null,
) {
  const expected = scenario.clarification;
  if (
    !expected?.sourceQuote?.trim() ||
    !scenario.request.includes(expected.sourceQuote) ||
    !run ||
    run.status !== "awaiting-input" ||
    !run.question?.trim()
  )
    throw new Error("评测没有当前来源未决项的冻结答案");
  const admission = [...(run.requestAdmissions ?? [])]
    .reverse()
    .find(
      (a) =>
        admissionResolved(a) &&
        a.sources.some(
          (s) => s.id === `${run.id}:1` && s.text === scenario.request,
        ),
    );
  if (!admission) throw new Error("冻结澄清缺少有效的来源预检");
  const reviews = run.clarificationReviews ?? [];
  const state = admissionQuestionState(
    admission,
    admission.sources,
    admission.factsSnapshot,
    reviews,
  );
  if (
    state.pending.length ||
    state.blockers.length ||
    state.questions.length !== 1 ||
    state.questions[0] !== run.question
  )
    throw new Error("冻结答案只适用于一个经过独立审查的来源未决项");
  const key = questionReviewKey(
    run.question,
    admission.sources,
    admission.factsSnapshot,
  );
  const item = admission.questions.find((q) => q.question === run.question);
  if (
    !expected.choice ||
    !item?.choice ||
    item.sourceRevision !== `${run.id}:1` ||
    !item.sourceQuote.includes(expected.sourceQuote) ||
    hash(expected.choice) !==
      hash({ kind: item.choice.kind, subjectQuote: item.choice.subjectQuote })
  )
    throw new Error("冻结答案只适用于宿主生成的结构化未决项，不能回答自由问题");
  const review = reviews.find(
    (r) => !r.choice && r.key === key && r.question === run.question,
  );
  const source = admission.sources.find(
    (s) => s.id === review?.decision.sourceRevision,
  );
  if (
    !review ||
    review.decision.kind !== "business-ambiguity" ||
    source?.id !== `${run.id}:1` ||
    !source.text.includes(review.decision.sourceQuote) ||
    !review.decision.sourceQuote.includes(expected.sourceQuote)
  )
    throw new Error("澄清审查没有绑定冻结答案对应的来源未决项");
  return {
    answer: expected.answer,
    binding: {
      sourceRevision: source.id,
      sourceQuote: expected.sourceQuote,
      auditKey: key,
      choiceId: item.choice.id,
      choiceHash: hash(item.choice),
    },
  };
}

export type FrozenClarificationReceipt = {
  runId: string;
  question: string;
  answer: string;
  binding?: ReturnType<typeof frozenClarificationAnswer>["binding"];
};

/** Replays the original source context after the run has answered and finished. */
export function frozenClarificationReceiptMatches(
  scenario: StabilityScenario,
  run: AwaitingRun | null,
  receipt: FrozenClarificationReceipt | undefined,
) {
  if (!run || !receipt?.binding || receipt.runId !== run.id) return false;
  try {
    const expected = frozenClarificationAnswer(scenario, {
      ...run,
      status: "awaiting-input",
      question: receipt.question,
      requestAdmissions: run.requestAdmissions?.filter(
        (a) =>
          a.sources.length === 1 &&
          a.sources[0].id === receipt.binding!.sourceRevision,
      ),
    });
    return (
      receipt.answer === expected.answer &&
      receipt.binding.sourceRevision === expected.binding.sourceRevision &&
      receipt.binding.sourceQuote === expected.binding.sourceQuote &&
      receipt.binding.auditKey === expected.binding.auditKey &&
      receipt.binding.choiceId === expected.binding.choiceId &&
      receipt.binding.choiceHash === expected.binding.choiceHash
    );
  } catch {
    return false;
  }
}
