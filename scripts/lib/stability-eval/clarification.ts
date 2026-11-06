import type { AssistantSnapshot } from "../../../src/shared/assistant.js";
import {
  admissionQuestionState,
  admissionResolved,
  questionReviewKey,
} from "../../../src/evolution/request-admission.js";
import type { StabilityScenario } from "./manifest.js";
import { hash } from "../../../src/release/storage.js";
import { sourceItems, admissionChoiceProof } from "../../../src/evolution/source-items.js";
import { semanticChoiceTargets, semanticChoiceProof, technicalFacts } from "../../../src/evolution/technical-facts.js";
import { bindFieldReference, fieldTargets } from "../../../src/evolution/field-identity.js";
import { effectReviewResolved, sourceReviewFailure } from "../../../src/evolution/capability-admission.js";
import { clarificationBlockers } from "../../../src/evolution/clarification-review.js";
import { reviewDefinitionHash } from "../../../src/evolution/review.js";
import { specificationFailure } from "../../../src/evolution/specification.js";

type AwaitingRun = Pick<
  NonNullable<AssistantSnapshot["run"]>,
  "id" | "status" | "requestAdmissions" | "clarificationReviews"
> & Partial<Pick<NonNullable<AssistantSnapshot["run"]>, "plans" | "revisions" | "reviewLedger">>
  & { question?: string };

/** Replay the existing normal-plan choice proof; a quoted free question is insufficient. */
function plannedClarificationAnswer(scenario: StabilityScenario, run: AwaitingRun) {
  const expected = scenario.clarification!;
  const quote = expected.sourceQuote;
  if (!quote?.trim()) throw new Error("冻结澄清缺少原始来源条目");
  if (!run.plans?.length || !run.clarificationReviews?.some(r => r.choice))
    throw new Error("冻结澄清缺少有效的来源预检或结构化规划选择");
  const choice = expected.choice;
  // Workflow text rules describe complete's action input, never task presence or another action.
  if (choice?.kind !== "field-required" || choice.scope !== "action-input" || choice.action !== "complete")
    throw new Error("结构化未决项没有绑定冻结答案的动作输入作用域");
  const matches = new Map<string, {
    sourceRevision:string; sourceQuote:string; sourceItemId:string;
    auditKey:string; choiceId:string; choiceHash:string;
  }>();
  for (const plan of run.plans) {
    if (specificationFailure(plan)) continue;
    const sources = (run.revisions ?? []).filter(r => r.revision <= plan.requestRevision)
      .map(r => ({id:`${run.id}:${r.revision}`,text:r.text}));
    const source = sources.find(s => s.id === `${run.id}:1` && s.text === scenario.request);
    const items = sourceItems(sources).filter(item => item.sourceRevision === source?.id && item.text === quote);
    if (!source || items.length !== 1) continue;
    const facts = technicalFacts(plan);
    const catalog = fieldTargets(facts);
    let field: ReturnType<typeof bindFieldReference>;
    try { field = bindFieldReference(choice.field,catalog); } catch { continue; }
    const rules = plan.workflowRules.filter(rule => choice.field.kind === "new"
      ? rule.label === choice.field.name
      : field.target?.member === "workflow" && rule.key === field.field);
    if (rules.length !== 1) continue;
    for (const target of semanticChoiceTargets(plan).filter(t => t.aspect === "required" && t.subject === `workflow:${rules[0].key}`)) {
      const proof = semanticChoiceProof(plan,target.id).proof;
      const key = questionReviewKey(target.question,sources,facts);
      const audits = run.clarificationReviews.filter(r =>
        r.question === run.question && r.question === target.question && r.key === key &&
        !r.admissionChoice && hash(r.choice) === hash(proof) &&
        r.decision.kind === "business-ambiguity" &&
        r.decision.sourceRevision === source.id && r.decision.sourceQuote === quote &&
        effectReviewResolved(r.decision.effects,sources,facts) && !clarificationBlockers(r.decision).length &&
        plan.questionAdjudications?.some(saved => hash(saved) === hash(r)));
      const reviewed = run.reviewLedger?.attempts.some(attempt =>
        attempt.revision === plan.requestRevision && attempt.definitionHash === reviewDefinitionHash(plan) &&
        !sourceReviewFailure(attempt.review.sourceReview,sources,facts) &&
        attempt.review.unresolvedChoices?.some(c => c.targetId === target.id &&
          c.sourceRevision === source.id && c.sourceQuote === quote));
      if (audits.length !== 1 || !reviewed) continue;
      const binding = {sourceRevision:source.id,sourceQuote:quote,
        sourceItemId:items[0].id,auditKey:key,choiceId:proof.id,choiceHash:proof.hash};
      matches.set(hash(binding),binding);
    }
  }
  if (matches.size !== 1) throw new Error("冻结澄清缺少唯一的结构化选择、原始来源或独立审查证明");
  return {answer:expected.answer,binding:[...matches.values()][0]};
}

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
  if (!admission) return plannedClarificationAnswer(scenario,run);
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
  const expectedItems = sourceItems(admission.sources).filter(
    (sourceItem) => sourceItem.sourceRevision === `${run.id}:1` && sourceItem.text === expected.sourceQuote,
  );
  if (
    !expected.choice ||
    !item?.choice
  )
    throw new Error("冻结答案只适用于宿主生成的结构化未决项，不能回答自由问题");
  if (
    expectedItems.length !== 1 ||
    item.choice.sourceItem.id !== expectedItems[0].id ||
    item.sourceRevision !== `${run.id}:1` ||
    hash(expected.choice) !== hash((({ id: _id, sourceItem: _item, ...choice }) => choice)(item.choice))
  )
    throw new Error("结构化未决项没有绑定唯一的冻结来源条目");
  const review = reviews.find(
    (r) => !r.choice && r.key === key && r.question === run.question &&
      hash(r.admissionChoice) === hash(admissionChoiceProof(item)),
  );
  const source = admission.sources.find(
    (s) => s.id === review?.decision.sourceRevision,
  );
  if (
    !review ||
    review.decision.kind !== "business-ambiguity" ||
    source?.id !== `${run.id}:1` ||
    !source.text.includes(review.decision.sourceQuote) ||
    review.decision.sourceQuote !== expected.sourceQuote
  )
    throw new Error("澄清审查没有绑定冻结答案对应的来源未决项");
  return {
    answer: expected.answer,
    binding: {
      sourceRevision: source.id,
      sourceQuote: expected.sourceQuote,
      sourceItemId: expectedItems[0].id,
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
      receipt.binding.sourceItemId === expected.binding.sourceItemId &&
      receipt.binding.auditKey === expected.binding.auditKey &&
      receipt.binding.choiceId === expected.binding.choiceId &&
      receipt.binding.choiceHash === expected.binding.choiceHash
    );
  } catch {
    return false;
  }
}
