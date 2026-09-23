import { createHash } from "node:crypto";

/** Outcome class expected for scoring; due-date records current host blocker, not a hand-built success. */
export const outcomeClasses = [
  "full-path-success",
  "accurate-block",
  "current-blocker",
] as const;
export type OutcomeClass = (typeof outcomeClasses)[number];

export type StabilityScenario = {
  id: string;
  category:
    | "tags"
    | "counter"
    | "due"
    | "member-upgrade"
    | "rule-revision"
    | "missing-capability"
    | "temporarily-unavailable";
  /** Exact user request text frozen before any run. */
  request: string;
  expectedOutcomeClass: OutcomeClass;
  /** Brief note for scorers; not fed to the model as an implementation. */
  scoringNote: string;
  /** Whether browser should reach experience/apply when the path succeeds. */
  requiresExperience: boolean;
  requiresApply: boolean;
  requiresRecoveryEntry: boolean;
};

export type StabilityEvalManifest = {
  schema: "cordis.stability-eval-manifest/1";
  issue: number;
  parentIssue: number;
  title: string;
  /**
   * Frozen product-tree commit for the pre-change baseline.
   * Harness (scripts/tests/docs) may advance; `src/` must match this commit.
   */
  productCommit: string;
  /** @deprecated Prefer productCommit; kept equal for frozen-hash continuity. */
  sourceCommit: string;
  model: {
    stubKind: "model-stub";
    realModelId: string;
    realModelAuthorizationFlag: "--authorize-real-model";
  };
  budget: {
    calls: number;
    candidates: number;
    milliseconds: number;
  };
  runs: {
    independentRunsPerScenario: number;
    note: string;
  };
  retry: {
    externalRetries: number;
    resetBudgetOnFailure: boolean;
    handEditCandidates: false;
    supplyCorrectImplementationToModel: false;
  };
  scoring: {
    metrics: readonly string[];
    denominators: string;
    failureClasses: readonly string[];
  };
  scenarios: readonly StabilityScenario[];
};

export type FrozenManifest = StabilityEvalManifest & {
  frozen: true;
  frozenAt: string;
  contentHash: string;
  /** Runtime HEAD when the archive was produced (harness may differ from productCommit). */
  harnessCommit?: string;
};

/** Pre-modification product commit referenced by issue #36 / #37. */
export const BASELINE_PRODUCT_COMMIT =
  "8200f8a2957045ed232d0254a9efc627672b6fb3";
/** @deprecated Use BASELINE_PRODUCT_COMMIT. */
export const BASELINE_SOURCE_COMMIT = BASELINE_PRODUCT_COMMIT;

export const STABILITY_EVAL_MANIFEST: StabilityEvalManifest = {
  schema: "cordis.stability-eval-manifest/1",
  issue: 37,
  parentIssue: 36,
  title: "改造前浏览器稳定性评估冻结清单",
  productCommit: BASELINE_PRODUCT_COMMIT,
  sourceCommit: BASELINE_PRODUCT_COMMIT,
  model: {
    stubKind: "model-stub",
    realModelId: "gemini-3.1-pro-preview",
    realModelAuthorizationFlag: "--authorize-real-model",
  },
  budget: {
    calls: 12,
    candidates: 3,
    milliseconds: 600_000,
  },
  runs: {
    independentRunsPerScenario: 1,
    note: "每个场景独立合成工作区；全部预先安排的成功与失败均入报告，不得只保留成功轮次。",
  },
  retry: {
    externalRetries: 0,
    resetBudgetOnFailure: false,
    handEditCandidates: false,
    supplyCorrectImplementationToModel: false,
  },
  scoring: {
    metrics: [
      "capability-selection-accuracy",
      "error-blocking-accuracy",
      "first-plan-pass-rate",
      "first-candidate-pass-rate",
      "full-path-success-rate",
      "in-budget-repair-rate",
      "duration-ms",
      "cost-usage",
    ],
    denominators:
      "每个指标列出分子与分母；分母为进入该判定条件的场景运行次数。",
    failureClasses: [
      "model-understanding-or-generation",
      "documentation-gap",
      "host-defect",
      "tool-protocol",
      "transport",
    ],
  },
  scenarios: [
    {
      id: "tags-add",
      category: "tags",
      request:
        "请增加标签插件：给任务设置一个文本标签，保存时去掉首尾空格，拒绝空白标签，保留大小写；其他行为不变。",
      expectedOutcomeClass: "full-path-success",
      scoringNote: "完整浏览器路径：方案确认、体验、独立应用。",
      requiresExperience: true,
      requiresApply: true,
      requiresRecoveryEntry: true,
    },
    {
      id: "counter-add",
      category: "counter",
      request:
        "请增加独立的计数插件：未完成任务可以将计数加一，初始为零，已完成任务不能增加。其他行为不变。",
      expectedOutcomeClass: "full-path-success",
      scoringNote: "完整浏览器路径；不依赖标签成员。",
      requiresExperience: true,
      requiresApply: true,
      requiresRecoveryEntry: true,
    },
    {
      id: "due-auto-expire",
      category: "due",
      request:
        "请给任务增加可选截止时间：到点仍未完成则自动标记过期；已完成任务不误标；可修改或清除截止时间。",
      expectedOutcomeClass: "current-blocker",
      scoringNote:
        "记录改造前现有阻塞（提示词仍将定时需求导向澄清/维护者能力），不为基线手工补实现截止时间业务。",
      requiresExperience: false,
      requiresApply: false,
      requiresRecoveryEntry: true,
    },
    {
      id: "member-upgrade-tags",
      category: "member-upgrade",
      request:
        "请升级标签插件：保存标签时统一为小写，仍去掉首尾空格、拒绝空白。其他成员与任务行为保持不变。",
      expectedOutcomeClass: "full-path-success",
      scoringNote: "基线组合已含 tags 辅助成员；升级后体验与独立应用。",
      requiresExperience: true,
      requiresApply: true,
      requiresRecoveryEntry: true,
    },
    {
      id: "rule-revision-reflection",
      category: "rule-revision",
      request:
        "请改进完成流程：完成前必须填写复盘，去掉首尾空格后至少一个字，最多五千字；重新打开保留复盘。",
      expectedOutcomeClass: "full-path-success",
      scoringNote: "规则修订须浏览器确认 acceptance 变更后再开始执行。",
      requiresExperience: true,
      requiresApply: true,
      requiresRecoveryEntry: true,
    },
    {
      id: "missing-capability-push",
      category: "missing-capability",
      request:
        "请在任务到期时向外部推送通知（邮件或短信），并在离线时仍保证送达。",
      expectedOutcomeClass: "accurate-block",
      scoringNote: "确实缺失的外部推送能力应准确阻塞，不得产出看似可执行方案。",
      requiresExperience: false,
      requiresApply: false,
      requiresRecoveryEntry: true,
    },
    {
      id: "temporarily-unavailable-dependency",
      category: "temporarily-unavailable",
      request:
        "请增加依赖缺失环境下的可选提醒时间字段（仅记录时间，不做推送）；若环境依赖不可用须如实说明。",
      expectedOutcomeClass: "accurate-block",
      scoringNote:
        "计划声明 dependencies（如 uninstalled-notifier）时，宿主对照 environment 判依赖不可用并以 investigation 阻塞；与确实缺失外部推送区分。",
      requiresExperience: false,
      requiresApply: false,
      requiresRecoveryEntry: true,
    },
  ],
};

const hashable = (manifest: StabilityEvalManifest) => ({
  schema: manifest.schema,
  issue: manifest.issue,
  parentIssue: manifest.parentIssue,
  productCommit: manifest.productCommit,
  sourceCommit: manifest.sourceCommit,
  model: manifest.model,
  budget: manifest.budget,
  runs: manifest.runs,
  retry: manifest.retry,
  scoring: manifest.scoring,
  scenarios: manifest.scenarios,
});

export function manifestContentHash(
  manifest: StabilityEvalManifest | FrozenManifest,
): string {
  return createHash("sha256")
    .update(JSON.stringify(hashable(manifest)))
    .digest("hex");
}

export function freezeManifest(
  manifest: StabilityEvalManifest,
  frozenAt = new Date().toISOString(),
): FrozenManifest {
  return {
    ...manifest,
    frozen: true,
    frozenAt,
    contentHash: manifestContentHash(manifest),
  };
}

export function assertManifestFrozen(manifest: FrozenManifest): void {
  if (!manifest.frozen)
    throw new Error("评估清单尚未冻结，禁止开始运行");
  const expected = manifestContentHash(manifest);
  if (expected !== manifest.contentHash)
    throw new Error(
      "评估清单 contentHash 与正文不一致：禁止在执行后选择性修改需求、预算、评分或重试规则",
    );
}
