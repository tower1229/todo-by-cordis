import {
  STABILITY_EVAL_MANIFEST,
  type StabilityEvalManifest,
} from "./manifest.js";

/** Keep the historical requests and budgets; change only the expected due outcome. */
export function postchangeManifest(
  productCommit: string,
): StabilityEvalManifest {
  if (!/^[0-9a-f]{40}$/.test(productCommit))
    throw new Error("后测必须绑定固定的 40 位产品提交");
  return {
    ...STABILITY_EVAL_MANIFEST,
    issue: 46,
    title: "改造后浏览器稳定性评估冻结清单",
    productCommit,
    sourceCommit: productCommit,
    scenarios: STABILITY_EVAL_MANIFEST.scenarios.map((scenario) =>
      scenario.id === "due-auto-expire"
        ? {
            ...scenario,
            expectedOutcomeClass: "full-path-success" as const,
            scoringNote:
              "改造后须由真实模型生成并经浏览器完成截止、编辑取消、启停、重启和撤回；受控时钟与真实计时分开记录。",
            requiresExperience: true,
            requiresApply: true,
          }
        : scenario,
    ),
  };
}
