import type { MemberAcceptanceCase } from "../shared/acceptance-cases.js";

/** Host-owned coverage model shared by planning blockers and later candidate checks. */
export type AffectedAcceptanceTarget = {
  pluginId: string;
  kind: "addition" | "upgrade";
  /** Required actions that must have commit+reject frozen cases. */
  actions: string[];
  caseNames: string[];
};

export type AffectedAcceptance = {
  targets: AffectedAcceptanceTarget[];
  /** Business-language lines for plan confirmation; not JSON dumps. */
  coverageSummary: string[];
  complete: boolean;
  gaps: string[];
};

function actionPairs(
  cases: MemberAcceptanceCase[],
  pluginId: string,
): Map<string, { commit: boolean; reject: boolean; names: string[] }> {
  const pairs = new Map<
    string,
    { commit: boolean; reject: boolean; names: string[] }
  >();
  for (const c of cases) {
    if (c.member !== pluginId) continue;
    const pair = pairs.get(c.action) ?? {
      commit: false,
      reject: false,
      names: [],
    };
    if (c.expected.kind === "commit") pair.commit = true;
    else pair.reject = true;
    pair.names.push(c.name);
    pairs.set(c.action, pair);
  }
  return pairs;
}

function actionsOf(cases: MemberAcceptanceCase[], pluginId: string): string[] {
  return [...actionPairs(cases, pluginId).keys()];
}

function coveredPairNames(
  pairs: Map<string, { commit: boolean; reject: boolean; names: string[] }>,
  actions: string[],
): { covered: string[]; caseNames: string[]; missing: string[] } {
  const covered: string[] = [];
  const caseNames: string[] = [];
  const missing: string[] = [];
  for (const action of actions) {
    const pair = pairs.get(action);
    if (pair?.commit && pair.reject) {
      covered.push(action);
      caseNames.push(...pair.names);
    } else missing.push(action);
  }
  return { covered, caseNames, missing };
}

/**
 * Derive affected members/actions and whether frozen cases cover them.
 *
 * Settled semantics (#30 / #31):
 * - Omit/empty memberCases = as-is (no rule revision); upgrades must inherit
 *   historical commit+reject pairs for that member.
 * - Submitting memberCases without pairs for upgraded member A = wrong binding.
 * - Additions: required actions = actions appearing in submitted cases (must be
 *   non-empty and fully paired).
 * - Upgrades: required = historical actions ∪ submitted actions for that member;
 *   each required action must be paired in merged cases.
 * - Revising existing case bodies still requires acceptanceReason separately.
 */
export function evaluateAffectedAcceptance(input: {
  additions: { pluginId: string }[];
  upgrades: { pluginId: string }[];
  /** Explicitly submitted this plan; "omit" means inherit-only (as-is). */
  submitted: MemberAcceptanceCase[] | "omit";
  previous: MemberAcceptanceCase[] | undefined;
  /** Merged cases after inherit; coverage is checked against this set. */
  merged?: MemberAcceptanceCase[];
  /** Extension case names included in the user-visible coverage summary. */
  extensionCaseNames?: string[];
}): AffectedAcceptance {
  const gaps: string[] = [];
  const targets: AffectedAcceptanceTarget[] = [];
  const submitted =
    input.submitted === "omit" ? ([] as MemberAcceptanceCase[]) : input.submitted;
  const omitted = input.submitted === "omit";
  const merged = input.merged ?? [];
  const previous = input.previous ?? [];

  for (const addition of input.additions) {
    const required = actionsOf(submitted, addition.pluginId);
    const mergedPairs = actionPairs(merged, addition.pluginId);
    const { covered, caseNames, missing } = coveredPairNames(
      mergedPairs,
      required,
    );
    targets.push({
      pluginId: addition.pluginId,
      kind: "addition",
      actions: covered,
      caseNames,
    });
    if (!required.length)
      gaps.push(
        `新增辅助成员 ${addition.pluginId} 缺少冻结业务案例覆盖，不能把无验收动作当作自动通过`,
      );
    else if (missing.length)
      gaps.push(
        `新增辅助成员 ${addition.pluginId} 的动作未被冻结案例成对覆盖：${missing.join("、")}`,
      );
  }

  for (const upgrade of input.upgrades) {
    const historical = actionsOf(previous, upgrade.pluginId);
    const submittedActions = actionsOf(submitted, upgrade.pluginId);

    if (!omitted && !submittedActions.length) {
      targets.push({
        pluginId: upgrade.pluginId,
        kind: "upgrade",
        actions: [],
        caseNames: [],
      });
      gaps.push(
        `升级成员 ${upgrade.pluginId} 的变更动作未被本次提交的冻结案例覆盖`,
      );
      continue;
    }

    if (omitted && !historical.length) {
      targets.push({
        pluginId: upgrade.pluginId,
        kind: "upgrade",
        actions: [],
        caseNames: [],
      });
      gaps.push(
        `升级成员 ${upgrade.pluginId} 缺少可继承或新提交的冻结业务案例，尚无可靠检查器覆盖`,
      );
      continue;
    }

    const required = [
      ...new Set(omitted ? historical : [...historical, ...submittedActions]),
    ];
    const mergedPairs = actionPairs(merged, upgrade.pluginId);
    const { covered, caseNames, missing } = coveredPairNames(
      mergedPairs,
      required,
    );
    targets.push({
      pluginId: upgrade.pluginId,
      kind: "upgrade",
      actions: covered,
      caseNames,
    });
    if (missing.length)
      gaps.push(
        `升级成员 ${upgrade.pluginId} 的受影响动作缺少成对冻结案例：${missing.join("、")}`,
      );
  }

  const coverageSummary = [
    ...new Set([
      ...(input.extensionCaseNames ?? []),
      ...merged.map((c) => c.name),
      ...targets.flatMap((t) => t.caseNames),
    ]),
  ];

  return {
    targets,
    coverageSummary,
    complete: gaps.length === 0,
    gaps,
  };
}

/**
 * Commands registered by a candidate member that are outside plan authorization.
 * - addition: any registered command not in authorized actions
 * - upgrade: only newly introduced commands (registered − prior) must be authorized
 */
export function unauthorizedMemberCommands(input: {
  registered: string[];
  authorized: string[];
  prior?: string[];
}): string[] {
  const authorized = new Set(input.authorized);
  const prior = new Set(input.prior ?? []);
  const candidates =
    input.prior === undefined
      ? input.registered
      : input.registered.filter((id) => !prior.has(id));
  return candidates.filter((id) => !authorized.has(id)).sort();
}
