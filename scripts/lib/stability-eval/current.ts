import { modelPolicy } from "../../../src/evolution/model-policy.js";
import {
  STABILITY_EVAL_MANIFEST,
  type StabilityEvalManifest,
  type StabilityScenario,
} from "./manifest.js";
import { postchangeManifest } from "./postchange.js";

/** Current experiment, separate from the immutable historical comparison requests. */
export function currentManifest(productCommit: string): StabilityEvalManifest {
  const previous = postchangeManifest(productCommit);
  const scenarios = previous.scenarios
    .filter((s) => s.id !== "temporarily-unavailable-dependency")
    .map((s) => structuredClone(s));
  for (const scenario of scenarios) {
    const sources = [scenario.request];
    switch (scenario.id) {
      case "tags-add":
        scenario.oracle = { kind: "tags", normalization: "trim", sources };
        break;
      case "member-upgrade-tags":
        scenario.oracle = { kind: "tags", normalization: "lowercase", sources };
        break;
      case "counter-add":
        scenario.baseline = "dual";
        scenario.oracle = { kind: "counter", sources };
        break;
      case "rule-revision-reflection":
        scenario.oracle = {
          kind: "reflection",
          minLength: 1,
          maxLength: 5000,
          sources,
        };
        break;
      case "due-auto-expire":
        scenario.request += "过期标记的保存值为 true，任务详情显示保存值。修改或清除截止时清除原过期标记；允许设置过去时间，未完成任务在宿主在线时自动补标过期；已经过期再完成时保留过期标记；提前完成后重新打开时截止已过则自动标记过期。未设置截止或尚未到点时不要求额外的默认保存值或初始显示。";
        scenario.oracle = {
          kind: "due",
          expiredValue: "true",
          lifecyclePolicy: "reset-on-edit-preserve-on-complete",
          sources: [scenario.request],
        };
        break;
      case "missing-capability-push":
        scenario.oracle = {
          kind: "block",
          reason: "offline-delivery",
          sources,
        };
        break;
    }
  }
  scenarios.push({
    id: "clarification-reflection",
    category: "rule-revision",
    request:
      "请改进完成流程，在完成前填写复盘。复盘是否必填尚未决定，请先集中问我这一项；其他行为沿用现有工作流。",
    clarification: {
      question: "复盘是否必填",
      sourceQuote: "复盘是否必填尚未决定",
      choice: {kind:"field-required"},
      answer:
        "复盘必填，去掉首尾空格后至少1个、最多5000个Unicode码点，重新打开保留复盘；已有与新增任务均适用，其他字段和行为不变。",
    },
    expectedOutcomeClass: "full-path-success",
    scoringNote: "同一运行、同一预算内完成必要澄清及完整浏览器路径。",
    requiresExperience: true,
    requiresApply: true,
    requiresRecoveryEntry: true,
    oracle: {
      kind: "reflection",
      minLength: 1,
      maxLength: 5000,
      sources: [
        "复盘必填，去掉首尾空格后至少1个、最多5000个Unicode码点，重新打开保留复盘",
      ],
    },
  });
  scenarios.push({
    id: "unsupported-blank-presentation",
    category: "missing-capability",
    request:
      "请新增独立的评审备注插件：通过填写评审备注动作输入文本，保存时去掉首尾空格，拒绝空白。任务详情显示备注，尚未填写时显示空白；其他行为不变。",
    expectedOutcomeClass: "accurate-block",
    scoringNote:
      "当前渲染契约无法显示空白；必须以精确来源与技术事实阻塞，不接受笼统失败。",
    requiresExperience: false,
    requiresApply: false,
    requiresRecoveryEntry: true,
    oracle: {
      kind: "block",
      reason: "blank-presentation",
      sources: ["尚未填写时显示空白"],
    },
  });
  return {
    ...previous,
    evaluation: "current/6",
    title: "当前版本稳定性发现批次",
    scenarios,
    model: {
      ...previous.model,
      outputPolicies: {
        admission: modelPolicy("admission"),
        planning: modelPolicy("planning"),
        review: modelPolicy("review"),
        generation: modelPolicy("generation"),
      },
    },
    runs: {
      independentRunsPerScenario: 3,
      note: "预注册24个独立运行；全部成功、失败与未执行项入报告，不补跑成功样本。",
    },
    scoring: {
      ...STABILITY_EVAL_MANIFEST.scoring,
      failureClasses: [...previous.scoring.failureClasses, "unknown"],
      metrics: [
        ...previous.scoring.metrics,
        "positive-success-rate",
        "correct-blocking-rate",
        "false-blocking-rate",
        "false-acceptance-rate",
        "candidate-oracle-mismatch-rate",
      ],
      denominators:
        "正向成功和错误阻塞以全部已运行正向场景计；正确阻塞和边界错误放行以全部已运行边界场景计；候选独立判定不一致率以实际完成独立判定的宿主通过候选计。预注册总数及未执行项另列，缺失运行不能达标。传输失败保留在端到端分母中。",
    },
  };
}
