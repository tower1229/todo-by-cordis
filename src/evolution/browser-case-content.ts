import { hash } from "../release/storage.js";
import type { BrowserCase } from "../shared/browser-cases.js";

/** Content identity for collapsing duplicate browser cases.
 * Historical cases keep obligationId so history vs field stay distinct.
 * Other cases omit it so same-field projections can share one case. */
export function browserCaseContentHash(
  c: Pick<
    BrowserCase,
    "task" | "steps" | "prepare" | "classification" | "obligationId"
  >,
) {
  return hash({
    task: c.task,
    steps: c.steps,
    prepare: c.prepare,
    classification: c.classification,
    ...(c.prepare ? { obligationId: c.obligationId } : {}),
  });
}

export function dedupeBrowserCases<T extends BrowserCase>(cases: T[]) {
  const aliases = new Map<string, string>();
  const kept = cases.filter((c, index, all) => {
    const first = all.findIndex(
      (other) => browserCaseContentHash(other) === browserCaseContentHash(c),
    );
    if (first === index) return true;
    if (all[first].id !== c.id) aliases.set(c.id, all[first].id);
    return false;
  });
  return { cases: kept, aliases };
}

export function remapBrowserChecks<T extends { checker: string; caseId: string }>(
  checks: T[],
  aliases: Map<string, string>,
) {
  if (!aliases.size) return checks;
  return checks
    .map((c) =>
      c.checker === "browser/1" && aliases.has(c.caseId)
        ? { ...c, caseId: aliases.get(c.caseId)! }
        : c,
    )
    .filter(
      (c, index, all) =>
        all.findIndex((other) => hash(other) === hash(c)) === index,
    );
}

export function executedBrowserCase(c: BrowserCase, browsers: BrowserCase[]) {
  return (
    browsers.find((b) => b.id === c.id) ??
    browsers.find((b) => browserCaseContentHash(b) === browserCaseContentHash(c))
  );
}
