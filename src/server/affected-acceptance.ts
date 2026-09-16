import type { MemberAcceptanceCase } from "../shared/acceptance-cases.js";

/** Host-owned coverage model shared by planning blockers and later candidate checks. */
export type AffectedAcceptanceTarget = {
  pluginId: string;
  kind: "addition" | "upgrade";
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

function coveredActions(
  pairs: Map<string, { commit: boolean; reject: boolean; names: string[] }>,
): { actions: string[]; caseNames: string[] } {
  const actions: string[] = [];
  const caseNames: string[] = [];
  for (const [action, pair] of pairs) {
    if (pair.commit && pair.reject) {
      actions.push(action);
      caseNames.push(...pair.names);
    }
  }
  return { actions, caseNames };
}

/**
 * Derive affected members/actions and whether frozen cases cover them.
 *
 * - Additions always require freshly submitted commit+reject pairs for that member.
 * - Upgrades with omitted memberCases may inherit historical pairs for that member.
 * - Upgrades that submit cases but bind them only to other members are gaps (wrong binding).
 * - Upgrades with neither submitted nor inheritable pairs are gaps (no reliable checker baseline).
 */
export function evaluateAffectedAcceptance(input: {
  additions: { pluginId: string }[];
  upgrades: { pluginId: string }[];
  /** Explicitly submitted this plan; "omit" means inherit-only. */
  submitted: MemberAcceptanceCase[] | "omit";
  previous: MemberAcceptanceCase[] | undefined;
  /** Merged cases after inherit; used for user-visible coverage summary. */
  merged?: MemberAcceptanceCase[];
}): AffectedAcceptance {
  const gaps: string[] = [];
  const targets: AffectedAcceptanceTarget[] = [];
  const submitted =
    input.submitted === "omit" ? ([] as MemberAcceptanceCase[]) : input.submitted;
  const omitted = input.submitted === "omit";

  for (const addition of input.additions) {
    const pairs = actionPairs(submitted, addition.pluginId);
    const { actions, caseNames } = coveredActions(pairs);
    targets.push({
      pluginId: addition.pluginId,
      kind: "addition",
      actions,
      caseNames,
    });
    if (!actions.length)
      gaps.push(
        `新增辅助成员 ${addition.pluginId} 缺少冻结业务案例覆盖，不能把无验收动作当作自动通过`,
      );
  }

  for (const upgrade of input.upgrades) {
    const submittedPairs = actionPairs(submitted, upgrade.pluginId);
    const submittedCoverage = coveredActions(submittedPairs);
    const inheritedPairs = actionPairs(input.previous ?? [], upgrade.pluginId);
    const inheritedCoverage = coveredActions(inheritedPairs);

    if (!omitted && !submittedCoverage.actions.length) {
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

    if (omitted && !inheritedCoverage.actions.length) {
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

    const coverage = omitted ? inheritedCoverage : submittedCoverage;
    targets.push({
      pluginId: upgrade.pluginId,
      kind: "upgrade",
      actions: coverage.actions,
      caseNames: coverage.caseNames,
    });
  }

  const coverageSummary = [
    ...new Set([
      ...(input.merged?.map((c) => c.name) ?? []),
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
