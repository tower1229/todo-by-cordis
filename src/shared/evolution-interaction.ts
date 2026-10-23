export type ResourceAmounts = {
  calls: number;
  candidates: number;
  milliseconds: number;
};
export type BudgetGrant = {
  operationId: string;
  pauseRevision: number;
  amounts: ResourceAmounts;
  at: string;
};
export type BudgetPause = {
  revision: number;
  resource: keyof ResourceAmounts;
  resume: "plan" | "execute";
  phase: string;
  minimum: ResourceAmounts;
  suggested: ResourceAmounts;
  message: string;
};
export type ClarificationQuestion = {
  id: string;
  title: string;
  explanation: string;
  sourceRevision: string;
  sourceQuote: string;
  options: { id: string; label: string }[];
  recommendedOptionId?: string;
};
export type ClarificationAnswer = {
  questionId: string;
  optionId?: string;
  text?: string;
};
export type AnsweredQuestion = {
  questionId: string;
  question: string;
  answer: string;
  sourceRevision: string;
};
export type DefaultDecision = {
  id: string;
  scope: string;
  behavior: string;
  basis: string;
  impact: string;
};
export type DefaultReview = {
  id: string;
  verdict: "safe-default" | "requires-choice" | "conflict";
  detail: string;
  targets: string[];
};
