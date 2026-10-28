import type { InvestigatedPlan, RequirementGate } from "../shared/assistant.js";
import type { ReviewLedger } from "../shared/change-spec.js";
import { hash } from "../release/storage.js";
import { caseCatalog } from "../server/requirement-coverage.js";
import { browserTaskAssertionDescription } from "../shared/browser-contract.js";
import { browserErrorAssertionDescription } from "../server/planning.js";
import { businessChoices, technicalReviewTargets } from "./technical-facts.js";
import { fieldReviewTargets } from "./field-review.js";
import { errorReviewTargets, feedbackConflicts } from "./error-review.js";
import { specificationFailure } from "./specification.js";
import { designTargets } from "./contract-authority.js";

/** Keep every historic finding, with repeated issue bodies represented by content references. */
function reviewHistory(ledger?: ReviewLedger) {
  if (!ledger) return undefined;
  const issues: Record<string, ReviewLedger["findings"][number]["issue"]> = {};
  const remember = (issue: ReviewLedger["findings"][number]["issue"]) => {
    const ref = hash(issue);
    issues[ref] = structuredClone(issue);
    return ref;
  };
  return {
    version: ledger.version,
    findings: ledger.findings.map(({ issue, ...finding }) => ({
      ...finding,
      issueRef: remember(issue),
    })),
    attempts: ledger.attempts.map(({ review, ...attempt }) => {
      const { issues: claims, ...result } = review;
      return {
        ...attempt,
        review: { ...result, issueRefs: claims.map(remember) },
      };
    }),
    issues,
  };
}

/** One projection from the frozen authority, not a second independently maintained specification. */
export function requirementReviewInput(
  plan: InvestigatedPlan,
  sources: RequirementGate["sources"],
  ledger?: ReviewLedger,
) {
  const failure = specificationFailure(plan);
  if (failure) throw new Error(failure);
  const spec = plan.changeSpec!;
  const sourceTargets = <
    T extends {
      sources: { requirementId: string; revision: string; quote: string }[];
    },
  >(
    targets: T[],
  ) =>
    targets.map(({ sources: refs, ...target }) => ({
      ...target,
      sources: refs.map(({ requirementId, revision }) => {
        const source = sources.findIndex((s) => s.id === revision) + 1;
        if (!source) throw new Error("复核投影缺少来源修订：" + revision);
        return { requirementId, source };
      }),
    }));
  const technicalTargets = technicalReviewTargets(plan);
  return structuredClone({
    kind: "requirement-review/2",
    specification: {
      version: spec.version,
      runId: spec.runId,
      requestRevision: spec.requestRevision,
      baseVersion: spec.baseVersion,
      compositionRevision: spec.compositionRevision,
      definitionHash: hash(spec.definition),
      specificationHash: hash(spec),
    },
    sources,
    answeredQuestions: plan.answeredQuestions ?? [],
    answerPolicy: "question是宿主问题记录而不是用户新增声明；answer才是对应sourceRevision的用户回答。不能把问题中的假设或备选项当成用户要求。",
    defaults: plan.defaults ?? [],
    defaultPolicy: "优先遵循明确要求及既有规则；仅低影响、可逆且有惯例支持的细节可为 safe-default。改变业务目的、外部副作用、数据损失、权限放宽必须 requires-choice，冲突为 conflict。capabilityChanges/requiredCapabilities 是统一规格中执行和验收必须满足的接口要求，不是用户原话；默认不能取消这些要求，与之冲突须为 conflict。逐项复核并绑定其覆盖的业务选择 targetId，不能以默认免除独立验收。",
    capabilityChanges: spec.definition.capabilityChanges,
    requiredCapabilities: spec.definition.requiredCapabilities ?? [],
    requirementOrigins: spec.requirementOrigins,
    validationOrigins: spec.validationOrigins,
    baseline: {
      fields: spec.definition.binding?.fieldIdentities ?? [],
      actions: spec.definition.binding?.actionAvailability?.actions.map(({member,contribution,action,from})=>({member,contribution,action,from})) ?? [],
    },
    hostInvariants: spec.invariants,
    contractAuthority: spec.authority,
    designTargets: designTargets(plan).map((target, index) => ({ target: index + 1, ...target })),
    hostFacts: spec.hostFacts,
    hostRules: spec.hostRules.map(
      ({ factId, property, value: _value, ...rule }) => ({
        ...rule,
        technicalTarget: technicalTargets.find(
          (t) => t.factId === factId && t.property === property,
        )!.target,
      }),
    ),
    reviewLedger: reviewHistory(ledger),
    // Descriptions and obligations live only here; targets are identities, not repeated descriptions.
    reviewTargets: [
      ...(plan.requirements ?? []).map((r) => r.id),
      ...sources.map((s) => s.id),
    ],
    requirements: plan.requirements,
    requestAdmission: plan.requestAdmission
      ? {
          contract: plan.requestAdmission.contract,
          key: plan.requestAdmission.key,
          receiptHash: hash(plan.requestAdmission),
          baseVersion: plan.requestAdmission.baseVersion,
          sourceHash: plan.requestAdmission.sourceHash,
          factsHash: plan.requestAdmission.factsHash,
          claims: plan.requestAdmission.claims,
          semanticReview: plan.requestAdmission.semanticReview,
          technicalChecks: plan.requestAdmission.technicalChecks,
          capabilityChecks: plan.requestAdmission.capabilityChecks,
          initialStates: plan.requestAdmission.initialStates,
          blockers: plan.requestAdmission.blockers,
        }
      : undefined,
    questionAdjudications: plan.questionAdjudications ?? [],
    technicalTargets,
    businessChoices: businessChoices(plan),
    semanticState: plan.semanticState,
    fieldReviewTargets: sourceTargets(fieldReviewTargets(plan, sources)),
    errorReviewTargets: sourceTargets(errorReviewTargets(plan, sources)).map(
      ({ planned: _planned, ...target }) => target,
    ),
    compilerConflicts: feedbackConflicts(plan),
    acceptance: caseCatalog(plan),
    checkerSemantics: {
      "workflow/1": {
        rules: spec.hostRules.map((rule) => rule.id),
        origin: "host",
      },
      "browser/1": {
        error: browserErrorAssertionDescription,
        task: browserTaskAssertionDescription,
      },
    },
    workflowRules: plan.workflowRules,
    summary: plan.summary,
    changes: plan.changes,
    outcome: plan.outcome,
    dataImpact: plan.dataImpact,
    excluded: plan.excluded,
    compatibility: plan.compatibility,
  });
}
