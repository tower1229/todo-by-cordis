import { hash } from "../release/storage.js";
import { AppError } from "../shared/contracts.js";
import type { InvestigationDocument } from "./planning.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;

/** One model-facing business definition. The original audit snapshot stays in the material store. */
export function planningView(document: InvestigationDocument, baseVersion: string): InvestigationDocument | undefined {
  if (document.ref !== "active-acceptance") return;
  if (hash(document.content) !== document.hash)
    throw new AppError("PLAN_STALE", "调查原文摘要已变化，请重新规划", 409);
  if (typeof document.content !== "string") return;
  let evidence: Row | undefined;
  try { evidence = row(JSON.parse(document.content)); } catch { return; }
  const spec = row(evidence?.changeSpec), definition = row(spec?.definition), gate = row(evidence?.requirementGate);
  if (evidence?.passed !== true || spec?.version !== "change/3" || !definition || !gate || typeof gate.seal !== "string") return;
  const { seal, ...body } = gate;
  if (seal !== hash(body)) return;
  const review = row(gate.review), ledger = row(gate.reviewLedger);
  if (!review || !Array.isArray(review.issues) || review.issues.length ||
      !Array.isArray(review.unresolvedChoices) || review.unresolvedChoices.length ||
      !Array.isArray(gate.coverage) || gate.coverage.some(value => !Array.isArray(row(value)?.reasons) || (row(value)!.reasons as unknown[]).length) ||
      !ledger || !Array.isArray(ledger.findings) || ledger.findings.some(value => row(value)?.status !== "resolved")) return;
  const aliases: Record<string, string> = {requirements:"requirements",browserCases:"browserCases",memberCases:"memberCases",rules:"workflowRules"};
  for (const [key, target] of Object.entries(aliases))
    if (Object.hasOwn(evidence, key) && hash(evidence[key]) !== hash(definition[target])) return;
  const audit = new Set(["changeSpec","requirementGate","browser","workspaceCases","checks","systemChecks",...Object.keys(aliases)]);
  const source = {ref:document.ref,hash:document.hash};
  const content = {
    version: "planning-baseline/1", baseVersion, source,
    specification: {version:spec.version,definitionHash:hash(definition),specificationHash:hash(spec)},
    definition: structuredClone(definition), requirementGate: structuredClone(gate),
    context: Object.fromEntries(Object.entries(evidence).filter(([key])=>!audit.has(key))),
  };
  return {ref:"model-view/active-acceptance",hash:hash(content),source,content};
}
