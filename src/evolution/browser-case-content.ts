import { hash } from "../release/storage.js";
import type { BrowserCase } from "../shared/browser-cases.js";

/** Assertion identity for a case key. Provenance (id / obligationId) is not part of it. */
export function browserCaseAssertionHash(
  c: Pick<BrowserCase, "task" | "steps" | "prepare" | "classification">,
) {
  return hash({
    task: c.task,
    steps: c.steps,
    prepare: c.prepare,
    classification: c.classification,
  });
}

/** Content identity for collapsing leftover duplicate IDs. Provenance is not part of it. */
export function browserCaseContentHash(
  c: Pick<BrowserCase, "task" | "steps" | "prepare" | "classification">,
) {
  return browserCaseAssertionHash(c);
}

/** Generate-side quota: current host snapshot of UI identity or action visibility replaces extras. */
export function browserCaseQuotaKey(
  c: Pick<BrowserCase, "id" | "task" | "steps">,
) {
  if (c.steps.some((s) => s.kind === "ui-identity")) return `ui-identity:${c.task}`;
  const visible = [...c.steps]
    .reverse()
    .find((s) => s.kind === "action-visible");
  if (visible?.kind === "action-visible")
    return `action-visible:${hash({
      action: visible.action,
      visible: visible.visible,
      member: visible.member,
      contribution: visible.contribution,
    }).slice(0, 24)}:${c.task}`;
  return c.id;
}

export function isHostSnapshotQuota(key: string) {
  return key.startsWith("ui-identity:") || key.startsWith("action-visible:");
}

export function canSupersedeBrowserCase(
  existing: BrowserCase,
  next: BrowserCase,
  obligationKind: string,
) {
  if (
    obligationKind === "workflow-input" &&
    existing.classification === "system-protection"
  )
    return true;
  const quota = browserCaseQuotaKey(next);
  return (
    browserCaseQuotaKey(existing) === quota && isHostSnapshotQuota(quota)
  );
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

export function mergeBrowserCaseAliases(
  first: Map<string, string>,
  second: Map<string, string>,
) {
  const aliases = new Map(first);
  for (const [from, to] of second) aliases.set(from, aliases.get(to) ?? to);
  for (const [from, to] of aliases) aliases.set(from, aliases.get(to) ?? to);
  return aliases;
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

export function danglingBrowserChecks(
  requirements: { checks: { checker: string; caseId: string }[] }[],
  browserCases: { id: string }[],
) {
  return requirements.flatMap((r) =>
    r.checks.filter(
      (c) =>
        c.checker === "browser/1" &&
        !browserCases.some((b) => b.id === c.caseId),
    ),
  );
}

export function executedBrowserCase(c: BrowserCase, browsers: BrowserCase[]) {
  return (
    browsers.find((b) => b.id === c.id) ??
    browsers.find((b) => browserCaseContentHash(b) === browserCaseContentHash(c))
  );
}
