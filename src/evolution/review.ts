import type {
  RequirementReview,
  InvestigatedPlan,
} from "../shared/assistant.js";
import type { ReviewLedger } from "../shared/change-spec.js";
import { hash } from "../release/storage.js";
import { technicalFacts } from "./technical-facts.js";

/** Progress is evidence for this claim, never an unrelated edit to the whole plan. */
export function reviewEvidence(
  plan: InvestigatedPlan,
  sources: { id: string; text: string }[],
  issue: RequirementReview["issues"][number],
) {
  const subject = issue.target?.subject;
  const requirement = plan.requirements?.find((r) => r.id === subject);
  const fact = technicalFacts(plan).find((f) => f.id === subject);
  const scopedChoice =
    issue.clarificationChoice &&
    plan.requirements
      ?.flatMap((r) => r.obligations ?? [])
      .find(
        (o) =>
          issue.clarificationChoice ===
          `business-choice:action-availability:${o.id}`,
      );
  return hash({
    source: sources.find((s) => s.id === issue.sourceRevision),
    target: issue.target,
    baseVersion: plan.baseVersion,
    ...(scopedChoice
      ? {
          obligation: scopedChoice,
          availability: plan.binding?.actionAvailability,
        }
      : fact
        ? { fact }
        : requirement
          ? {
              requirement,
              workflowRules: requirement.checks.some(
                (c) => c.checker === "workflow/1",
              )
                ? plan.workflowRules
                : undefined,
              memberCases: plan.memberCases?.filter((c) =>
                requirement.checks.some(
                  (ref) => ref.caseId === `member:${c.member}:${c.name}`,
                ),
              ),
              extensions: plan.extensions?.cases.filter((c) =>
                requirement.checks.some(
                  (ref) => ref.caseId === `action:${c.name}`,
                ),
              ),
            }
          : {}),
  });
}

/** The host tracks claims; it never decides which contradictory business claim is true. */
export function recordReview(
  ledger: ReviewLedger,
  review: RequirementReview,
  revision: number,
  definitionHash: string,
  evidenceFor?: (issue: RequirementReview["issues"][number]) => string,
) {
  const blockers: string[] = [];
  const previousAttempts = structuredClone(ledger.findings);
  for (const resolution of review.resolutions ?? []) {
    const finding = ledger.findings.find((f) => f.id === resolution.issueId);
    if (!finding)
      throw new Error("复核引用了不存在的问题：" + resolution.issueId);
    const sourceChanged =
      revision > finding.revision &&
      resolution.sourceRevision !== finding.issue.sourceRevision;
    const evidenceChanged =
      evidenceFor && finding.evidenceHash
        ? evidenceFor(finding.issue) !== finding.evidenceHash
        : definitionHash !== finding.definitionHash;
    const authorized = review.designDecisions?.some(
      (d) =>
        d.targetId === finding.issue.clarificationChoice &&
        d.permission === "delegated",
    );
    const sourceDecision = finding.issue.sourceDecision;
    const oldInterpretation =
      sourceDecision &&
      ledger.attempts
        .flatMap((a) => a.review.fieldDecisions ?? [])
        .find(
          (d) =>
            d.obligationId === sourceDecision.obligationId &&
            hash(d) === sourceDecision.interpretationHash,
        );
    const newInterpretation =
      oldInterpretation?.initial.kind === "undetermined" &&
      review.fieldDecisions?.find(
        (d) =>
          d.obligationId === oldInterpretation.obligationId &&
          d.sourceRevision === oldInterpretation.sourceRevision &&
          d.initial.kind === "unspecified",
      );
    const sourceCorrected =
      !!newInterpretation &&
      !review.issues.some(
        (i) => i.sourceDecision?.obligationId === sourceDecision?.obligationId,
      );
    if (finding.status === "conflicting" && !sourceChanged)
      blockers.push("复核立场冲突须由新的需求澄清消解：" + finding.id);
    else if (
      !sourceChanged &&
      !evidenceChanged &&
      !authorized &&
      !sourceCorrected
    )
      blockers.push(
        "复核消解没有新的作用域规格、需求修订或设计授权证据：" + finding.id,
      );
    else {
      finding.status = "resolved";
      (review.resolutionEvidence ??= []).push({
        issueId: finding.id,
        kind: sourceChanged
          ? "source-revision"
          : authorized
            ? "design-authorization"
            : sourceCorrected
              ? "source-adjudication"
              : "specification-change",
        before: finding.evidenceHash ?? finding.definitionHash,
        after: hash({
          source: resolution.sourceRevision,
          ...(sourceCorrected ? { oldInterpretation, newInterpretation } : {}),
          evidence: evidenceFor?.(finding.issue) ?? definitionHash,
          ...(authorized
            ? {
                authorization: review.designDecisions?.find(
                  (d) => d.targetId === finding.issue.clarificationChoice,
                ),
              }
            : {}),
        }),
      });
    }
  }
  for (const issue of review.issues) {
    const evidenceHash = evidenceFor?.(issue);
    const key = hash({
      source: issue.sourceRevision,
      target: issue.target ?? { quote: issue.sourceQuote, kind: issue.kind },
    });
    const previous = ledger.findings.filter((f) => f.key === key);
    const opposite = previous.find(
      (f) =>
        (f.revision === revision || f.status !== "resolved") &&
        f.issue.stance &&
        issue.stance &&
        f.issue.stance !== "undetermined" &&
        issue.stance !== "undetermined" &&
        f.issue.stance !== issue.stance,
    );
    if (opposite) {
      opposite.status = "conflicting";
      blockers.push("独立复核对同一要求给出相反立场：" + opposite.id);
    }
    const repeated = previousAttempts
      .filter((f) => f.key === key)
      .find(
        (f) =>
          (evidenceHash && f.evidenceHash
            ? f.evidenceHash === evidenceHash
            : f.definitionHash === definitionHash) &&
          f.revision === revision &&
          f.issue.kind === issue.kind &&
          f.issue.stance === issue.stance,
      );
    if (repeated)
      blockers.push("复核问题重复且没有新的规格或需求证据：" + repeated.id);
    else {
      const id =
        "review-" +
        hash({ key, kind: issue.kind, stance: issue.stance }).slice(0, 20);
      const existing = ledger.findings.find((f) => f.id === id);
      const finding = {
        id,
        key,
        revision,
        definitionHash,
        ...(evidenceHash ? { evidenceHash } : {}),
        issue,
        status:
          opposite ||
          (existing?.status === "conflicting" && revision <= existing.revision)
            ? ("conflicting" as const)
            : ("open" as const),
      };
      // A changed specification advances the same finding; attempts retain
      // the original claims without creating duplicate resolution targets.
      if (existing) Object.assign(existing, finding);
      else ledger.findings.push(finding);
    }
  }
  ledger.attempts.push({ revision, definitionHash, review });
  if (!review.issues.length) {
    blockers.push(
      ...ledger.findings
        .filter((f) => f.status !== "resolved")
        .map((f) => "复核历史问题尚未有来源支持的消解：" + f.id),
    );
  }
  return {
    blockers,
    halt: blockers.some(
      (b) =>
        b.includes("相反立场") ||
        b.includes("重复") ||
        b.includes("冲突须") ||
        b.includes("没有新的作用域"),
    ),
  };
}
