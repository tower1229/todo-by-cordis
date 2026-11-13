import { hash } from "../release/storage.js";
import type { BrowserCase } from "../shared/browser-cases.js";
import {
  actionVisibleArrivalState,
  obligationCases,
  type AcceptanceObligation,
} from "../shared/acceptance-obligations.js";

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
    // Contribution is host binding detail, not a second visibility fact. Omitting it
    // collapses obligation copies that only differ on whether contribution was set.
    // Arrival state keeps open vs done from superseding each other.
    return `action-visible:${hash({
      action: visible.action,
      visible: visible.visible,
      member: visible.member,
      state: actionVisibleArrivalState(c.steps),
    }).slice(0, 24)}:${c.task}`;
  return c.id;
}

/** visible:true presence is already asserted when ui-identity lists the action. */
export function actionVisibleCoveredByUiIdentity(
  c: Pick<BrowserCase, "task" | "steps">,
  browsers: Pick<BrowserCase, "task" | "steps" | "id">[],
) {
  const visible = [...c.steps]
    .reverse()
    .find((s) => s.kind === "action-visible");
  if (visible?.kind !== "action-visible" || visible.visible !== true)
    return undefined;
  const cover = browsers.find(
    (b) =>
      b.task === c.task &&
      b.steps.some(
        (s) =>
          s.kind === "ui-identity" &&
          s.contributions.some(
            (item) =>
              item.member === visible.member &&
              item.actions.includes(visible.action),
          ),
      ),
  );
  return cover?.id;
}

/**
 * Field assertion surface ignores contribution (host binding detail).
 * Ops besides refresh/restart stay in the key so after-action paths
 * do not collapse onto initial-host snapshots.
 */
export function browserCaseFieldSurfaceKey(
  c: Pick<BrowserCase, "task" | "steps">,
) {
  const fields = c.steps
    .filter(
      (s): s is Extract<BrowserCase["steps"][number], { kind: "field" }> =>
        s.kind === "field",
    )
    .map(({ member, field, value, visible }) => ({
      member,
      field,
      value,
      visible,
    }));
  if (!fields.length) return undefined;
  const ops = c.steps
    .filter(
      (s) =>
        s.kind !== "field" && s.kind !== "refresh" && s.kind !== "restart",
    )
    .map((s) => {
      if (s.kind === "action" || s.kind === "case-action")
        return {
          kind: s.kind,
          member: s.member,
          action: s.action,
          input: s.input,
        };
      if (s.kind === "error") return { kind: "error", text: s.text };
      return s;
    });
  return `field-surface:${c.task}:${hash({ fields, ops })}`;
}

/** Current-surface field case already asserts the same contribution-free surface. */
export function fieldSurfaceCoveredBy(
  c: Pick<BrowserCase, "task" | "steps" | "id">,
  browsers: Pick<BrowserCase, "task" | "steps" | "id">[],
) {
  const key = browserCaseFieldSurfaceKey(c);
  if (!key) return undefined;
  return browsers.find(
    (b) => b.id !== c.id && browserCaseFieldSurfaceKey(b) === key,
  )?.id;
}

/** Cases that become obsolete when a member is disabled (actions/UI gone; keep history only). */
export function obsoleteDisabledMemberCase(
  c: Pick<BrowserCase, "id" | "steps">,
  disabledMember: string,
) {
  if (c.id.includes("-historical-")) return false;
  return c.steps.some(
    (s) =>
      (s.kind === "field" && s.member === disabledMember) ||
      (s.kind === "action" && s.member === disabledMember) ||
      (s.kind === "case-action" && s.member === disabledMember) ||
      (s.kind === "action-visible" &&
        s.member === disabledMember &&
        s.visible === true) ||
      (s.kind === "ui-identity" &&
        s.contributions.some((item) => item.member === disabledMember)),
  );
}

export type BrowserCaseRetentionRole =
  | "current-surface"
  | "retention-only"
  | "obsolete";

export type AcceptanceCaseSurface = {
  disabledMember?: string;
  currentCases: Pick<BrowserCase, "id" | "task" | "steps">[];
  obligationIds: ReadonlySet<string>;
};

/**
 * Classify an inherited case against the current acceptance surface.
 * obsolete / covered retention-only must not re-occupy an independent quota slot.
 */
export function classifyBrowserCaseAgainstSurface(
  c: Pick<BrowserCase, "id" | "task" | "steps" | "obligationId">,
  surface: AcceptanceCaseSurface,
): { role: BrowserCaseRetentionRole; coveredBy?: string } {
  if (c.id.includes("-historical-")) return { role: "retention-only" };

  if (
    surface.disabledMember &&
    obsoleteDisabledMemberCase(c, surface.disabledMember)
  )
    return { role: "obsolete" };

  const uiCover = actionVisibleCoveredByUiIdentity(c, surface.currentCases);
  if (uiCover) return { role: "retention-only", coveredBy: uiCover };

  const fieldCover = fieldSurfaceCoveredBy(c, surface.currentCases);
  if (fieldCover) return { role: "obsolete", coveredBy: fieldCover };

  // Only drop orphans once the current plan has a non-empty obligation surface;
  // empty ids means the caller has not established current obligations yet.
  if (
    c.obligationId &&
    surface.obligationIds.size > 0 &&
    !surface.obligationIds.has(c.obligationId)
  )
    return { role: "obsolete" };

  return { role: "current-surface" };
}

/**
 * Emit obligation browser cases for the current acceptance surface.
 * Disabled members keep history retention only; visible:true action assertions drop.
 */
export function obligationCasesForAcceptanceSurface(
  obligation: AcceptanceObligation,
  surface: Pick<AcceptanceCaseSurface, "disabledMember">,
) {
  const cases = obligationCases(obligation);
  const disabledMember = surface.disabledMember;
  if (!disabledMember) return cases;
  if (obligation.kind === "field" && obligation.member === disabledMember)
    return cases.filter((c) => c.id.includes("-historical-"));
  if (
    obligation.kind === "assertion" &&
    obligation.expected.kind === "action-visible" &&
    obligation.expected.member === disabledMember &&
    obligation.expected.visible === true
  )
    return [];
  return cases;
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
