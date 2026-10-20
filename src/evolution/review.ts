import type { RequirementReview, InvestigatedPlan } from "../shared/assistant.js";
import type { ReviewLedger } from "../shared/change-spec.js";
import { hash } from "../release/storage.js";
import { technicalFacts } from "./technical-facts.js";

/** Progress is evidence for this claim, never an unrelated edit to the whole plan. */
export function reviewEvidence(plan:InvestigatedPlan,sources:{id:string;text:string}[],issue:RequirementReview["issues"][number]) {
  const subject=issue.target?.subject;
  const requirement=plan.requirements?.find(r=>r.id===subject);
  const fact=technicalFacts(plan).find(f=>f.id===subject);
  return hash({source:sources.find(s=>s.id===issue.sourceRevision),target:issue.target,baseVersion:plan.baseVersion,
    ...(fact?{fact}:requirement?{requirement,workflowRules:plan.workflowRules,cases:plan.cases,memberCases:plan.memberCases,extensions:plan.extensions}:{requirements:plan.requirements,workflowRules:plan.workflowRules})});
}

/** The host tracks claims; it never decides which contradictory business claim is true. */
export function recordReview(
  ledger: ReviewLedger,
  review: RequirementReview,
  revision: number,
  definitionHash: string,
  evidenceFor?: (issue:RequirementReview["issues"][number])=>string,
) {
  const blockers: string[] = [];
  const previousAttempts = structuredClone(ledger.findings);
  for (const resolution of review.resolutions ?? []) {
    const finding = ledger.findings.find((f) => f.id === resolution.issueId);
    if (!finding)
      throw new Error("复核引用了不存在的问题：" + resolution.issueId);
    if (finding.status === "conflicting" && revision <= finding.revision)
      blockers.push("复核立场冲突须由新的需求澄清消解：" + finding.id);
    else finding.status = "resolved";
  }
  for (const issue of review.issues) {
    const evidenceHash=evidenceFor?.(issue);
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
    const repeated = previousAttempts.filter(f => f.key === key).find(
      (f) =>
        (evidenceHash && f.evidenceHash ? f.evidenceHash === evidenceHash : f.definitionHash === definitionHash) &&
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
        ...(evidenceHash?{evidenceHash}:{}),
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
        b.includes("相反立场") || b.includes("重复") || b.includes("冲突须"),
    ),
  };
}
