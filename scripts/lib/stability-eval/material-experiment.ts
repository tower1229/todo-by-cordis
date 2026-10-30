import { hash } from "../../../src/release/storage.js";
import type { ModelReply } from "../../../src/evolution/driver.js";
import type { AssistantEvent } from "../../../src/shared/assistant.js";
import type { EvolutionDomain } from "../../../src/server/evolution-domain.js";
import {
  assertManifestFrozen,
  freezeManifest,
  type FrozenManifest,
} from "./manifest.js";
import { currentManifest } from "./current.js";
import { v1Requests } from "../v1-scenario.js";

/** The supplied published tag baseline must not be replaced by the generic dual fixture. */
export function materialExperimentManifest(commit: string) {
  const template = currentManifest(commit);
  const { baseline: _baseline, ...counter } = template.scenarios.find(
    (s) => s.id === "counter-add",
  )!;
  return freezeManifest({
    ...template,
    title: "资料原文与视图完整流程ABBA零付费准备",
    scenarios: [
      {
        ...counter,
        request: v1Requests[1],
        oracle: { kind: "counter", sources: [v1Requests[1]] },
        requiresExperience: true,
        requiresApply: true,
        requiresRecoveryEntry: true,
      },
    ],
    runs: {
      independentRunsPerScenario: 4,
      note: "固定ABBA；失败即停批，不重跑，不清零；第二对付费须另行决定",
    },
  });
}

type Call = {
  phase?: string;
  startedAt?: string;
  endedAt?: string;
  usage?: unknown;
  response?: unknown;
  transport?: ModelReply["transport"];
};
const row = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
const count = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
const interval = (a?: string, b?: string) =>
  a && b && Number.isFinite(Date.parse(a)) && Date.parse(b) >= Date.parse(a)
    ? Date.parse(b) - Date.parse(a)
    : undefined;

/** Totals count repeated requests. Unknown usage is a gap, never zero or an estimate. */
export function measureFlow(input: {
  durationMs: number;
  activeMilliseconds?: number;
  browserJourneyMs: number;
  calls: Call[];
  events: AssistantEvent[];
  independentBrowserMs?: number;
}) {
  let prompt = 0,
    completion = 0,
    cached = 0,
    uncached = 0,
    bytes = 0;
  let missingUsage = 0,
    missingCache = 0,
    missingBytes = 0,
    missingTiming = 0;
  const modelByPhase: Record<string, number> = {};
  const proposedToolCalls: Record<string, number> = {};
  for (const call of input.calls) {
    const usage = row(call.usage),
      details = row(usage.prompt_tokens_details);
    const p = count(
      usage.prompt_tokens ?? usage.promptTokens ?? usage.promptTokenCount,
    );
    const c = count(usage.completion_tokens ?? usage.completionTokens);
    const hit = count(usage.prompt_cache_hit_tokens ?? details.cached_tokens);
    const miss =
      count(usage.prompt_cache_miss_tokens) ??
      (p !== undefined && hit !== undefined && hit <= p ? p - hit : undefined);
    if (p === undefined || c === undefined) missingUsage++;
    prompt += p ?? 0;
    completion += c ?? 0;
    if (hit === undefined || miss === undefined) missingCache++;
    cached += hit ?? 0;
    uncached += miss ?? 0;
    const body = count(call.transport?.http?.requestBodyBytes);
    if (body === undefined) missingBytes++;
    else bytes += body;
    const ms = interval(call.startedAt, call.endedAt);
    if (ms === undefined) missingTiming++;
    else
      modelByPhase[call.phase ?? "unknown"] =
        (modelByPhase[call.phase ?? "unknown"] ?? 0) + ms;
    const choices = row(call.response).choices;
    for (const choice of Array.isArray(choices) ? choices : []) {
      const tools = row(row(choice).message).tool_calls;
      for (const tool of Array.isArray(tools) ? tools : []) {
        const name = row(row(tool).function).name;
        if (typeof name === "string")
          proposedToolCalls[name] = (proposedToolCalls[name] ?? 0) + 1;
      }
    }
  }
  const nativeChecks: Record<string, number> = {};
  let incompleteSteps = 0;
  const events = [...input.events].sort((a, b) => a.sequence - b.sequence);
  for (const start of events.filter(
    (e) =>
      e.status === "started" &&
      ["build_candidate", "validate_candidate", "browser/1"].includes(
        e.tool ?? "",
      ),
  )) {
    const end = events.find(
      (e) =>
        e.stepId === start.stepId &&
        e.sequence > start.sequence &&
        e.status !== "started",
    );
    const ms = interval(start.at, end?.at);
    if (ms === undefined) incompleteSteps++;
    else nativeChecks[start.tool!] = (nativeChecks[start.tool!] ?? 0) + ms;
  }
  return {
    version: "material-flow/1" as const,
    calls: input.calls.length,
    proposedToolCalls,
    input: {
      requestBodyBytes: missingBytes ? null : bytes,
      knownRequestBodyBytes: bytes,
      callsMissingRequestBytes: missingBytes,
      promptTokens: missingUsage ? null : prompt,
      completionTokens: missingUsage ? null : completion,
      knownPromptTokens: prompt,
      knownCompletionTokens: completion,
      callsMissingUsage: missingUsage,
      cachedTokens: missingCache ? null : cached,
      uncachedTokens: missingCache ? null : uncached,
      callsMissingCacheUsage: missingCache,
    },
    timing: {
      wallTotalMs: input.durationMs,
      hostActiveMs: input.activeMilliseconds ?? null,
      userWaitMs: 0,
      userWaitScope: "automated-browser-no-human-wait",
      browserJourneyMs: input.browserJourneyMs,
      modelByPhase,
      callsMissingTiming: missingTiming,
      nativeChecks,
      incompleteSteps,
      independentBrowserMs: input.independentBrowserMs ?? null,
      overlap:
        "browserJourney includes model/checks; intervals must not be added",
    },
  };
}
export type FlowMeasurement = ReturnType<typeof measureFlow>;
export type MaterialTrial = {
  trialId: string;
  pair: 1 | 2;
  arm: "raw" | "view";
  sequence: number;
};
export function freezeMaterialExperiment(input: {
  manifest: FrozenManifest;
  baselineHash: string;
  sourceHash: string;
  preflightHash: string;
  baselineDirectory: string;
  baseCumulative: number;
  globalLimit: number;
}) {
  assertManifestFrozen(input.manifest);
  if (
    input.manifest.budget.calls !== 12 ||
    input.manifest.budget.candidates !== 3 ||
    input.manifest.budget.milliseconds !== 600000
  )
    throw new Error("实验资源必须保持12调用/3候选/10分钟");
  if (input.baseCumulative + 48 > input.globalLimit)
    throw new Error("实验超过全局授权余额");
  const body = {
    schema: "cordis.material-experiment/1" as const,
    ...input,
    trials: [
      { trialId: "p1-raw", pair: 1, arm: "raw", sequence: 1 },
      { trialId: "p1-view", pair: 1, arm: "view", sequence: 2 },
      { trialId: "p2-view", pair: 2, arm: "view", sequence: 3 },
      { trialId: "p2-raw", pair: 2, arm: "raw", sequence: 4 },
    ] as MaterialTrial[],
    firstPairMaximum: 24,
    maximumCalls: 48,
    continuation: {
      minimumInputReduction: 0.1,
      minimumWallTimeReduction: 0.1,
      bothPairsSameDirection: true,
    },
    stop: {
      onFailure: true,
      onBudgetPause: true,
      onIdentityDrift: true,
      onUnknownUsage: true,
      externalRetries: 0,
      automaticGrants: false,
      handEditCandidates: false,
    },
    semantics: {
      failureRate:
        "failed/started with started/4 coverage and unrun separately",
      efficiency: "completion and initial efficiency target scored separately",
      stub: "functional rehearsal only; no real-model benefit claim",
    },
  };
  return { ...body, frozen: true as const, contentHash: hash(body) };
}
export type MaterialExperiment = ReturnType<typeof freezeMaterialExperiment>;
export function assertMaterialExperiment(value: MaterialExperiment) {
  const { contentHash, frozen, ...body } = value;
  if (frozen !== true || hash(body) !== contentHash)
    throw new Error("实验冻结身份不一致");
  const expected = freezeMaterialExperiment({
    manifest: value.manifest,
    baselineHash: value.baselineHash,
    sourceHash: value.sourceHash,
    preflightHash: value.preflightHash,
    baselineDirectory: value.baselineDirectory,
    baseCumulative: value.baseCumulative,
    globalLimit: value.globalLimit,
  });
  if (expected.contentHash !== contentHash)
    throw new Error("实验分组、预算或停止条件被修改");
}

/** Raw arm uses the existing native raw path; no view is relabelled as source. */
export function configureMaterialArm(
  domain: EvolutionDomain,
  arm: MaterialTrial["arm"],
) {
  if (arm === "view") return;
  const read = domain.read.bind(domain);
  domain.read = (name, args, context, delivered) => {
    const result = read(name, args, context, delivered);
    if (!("ref" in result) || !result.documents) return result;
    return {
      ...result,
      documents: result.documents.map((doc) => {
        if (!doc.source) return doc;
        const source = context.files[doc.source.ref];
        if (!source || source.hash !== doc.source.hash)
          throw new Error("原文分组来源已变化");
        const reused = (delivered ?? []).some(
          (m) =>
            !m.source && m.ref === doc.source!.ref && m.hash === source.hash,
        );
        return {
          ref: doc.source.ref,
          hash: source.hash,
          content: reused ? null : source.content,
          ...(reused ? { reused: true } : {}),
        };
      }),
    };
  };
}
export type MaterialResult = {
  trialId: string;
  arm: MaterialTrial["arm"];
  evidenceKind: "model-stub" | "real-model";
  passed: boolean;
  metrics: FlowMeasurement | null;
};
export function evaluateMaterialPair(
  experiment: MaterialExperiment,
  results: MaterialResult[],
) {
  assertMaterialExperiment(experiment);
  const ids = new Set(results.map((r) => r.trialId));
  if (
    ids.size !== results.length ||
    results.some(
      (r) =>
        !experiment.trials.some(
          (t) => t.trialId === r.trialId && t.arm === r.arm,
        ),
    )
  )
    throw new Error("实验运行重复或分组身份不符");
  if (
    results.some((r, index) => experiment.trials[index]?.trialId !== r.trialId)
  )
    throw new Error("实验必须按冻结ABBA顺序执行，不能跳过或替换运行");
  const coverage = {
    planned: 4,
    started: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    unrun: experiment.trials
      .filter((t) => !ids.has(t.trialId))
      .map((t) => t.trialId),
  };
  if (!results.length) return { decision: "incomplete", coverage };
  if (results.some((r) => !r.passed))
    return { decision: "stop-failure", coverage };
  if (results.some((r) => r.evidenceKind !== "real-model"))
    return { decision: "stub-only", coverage };
  if (results.some((r) => !r.metrics || r.metrics.input.promptTokens === null))
    return { decision: "stop-unknown-usage", coverage };
  if (results.some((r) => r.metrics!.input.requestBodyBytes === null))
    return { decision: "stop-missing-measurement", coverage };
  const pairs = ([1, 2] as const).flatMap((pair) => {
    const members = experiment.trials
      .filter((t) => t.pair === pair)
      .map((t) => results.find((r) => r.trialId === t.trialId));
    const a = members.find((r) => r?.arm === "raw"),
      b = members.find((r) => r?.arm === "view");
    if (!a || !b) return [];
    const reduction = (old: number, current: number) =>
      old > 0 ? 1 - current / old : null;
    return [
      {
        pair,
        inputReduction: reduction(
          a.metrics!.input.promptTokens!,
          b.metrics!.input.promptTokens!,
        ),
        wallTimeReduction: reduction(
          a.metrics!.timing.wallTotalMs,
          b.metrics!.timing.wallTotalMs,
        ),
      },
    ];
  });
  const meets =
    pairs.length > 0 &&
    pairs.every(
      (p) =>
        p.inputReduction !== null &&
        p.inputReduction >= experiment.continuation.minimumInputReduction &&
        p.wallTimeReduction !== null &&
        p.wallTimeReduction >= experiment.continuation.minimumWallTimeReduction,
    );
  return {
    decision: meets
      ? pairs.length === 2
        ? "pilot-benefit-only"
        : "first-pair-eligible-for-confirmation"
      : pairs.length
        ? "stop-no-benefit"
        : "incomplete",
    coverage,
    pairs,
    failureRateClaim:
      "small pilot cannot establish lower population failure rate",
  };
}
