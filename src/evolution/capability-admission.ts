import { executableMemberInterfaces } from "../server/extensions/registry.js";
import type { Investigation } from "../server/planning.js";
import { hash } from "../release/storage.js";
import type { TechnicalFact } from "./technical-facts.js";
import { schemaProblems } from "./model-protocol.js";

/** Effects that require protected host services, rather than more business code. */
const hostEffects = {
  "external-delivery": ["notification.deliver", "notification.send"],
  "offline-delivery": ["offline.delivery"],
  "online-schedule": ["schedule.runtime"],
} as const;
export type HostEffect = keyof typeof hostEffects;
export const hostEffectIds = Object.keys(hostEffects) as HostEffect[];
export const capabilityFactId = (effect: HostEffect) =>
  `host-fact:effect:${effect}`;
type Source = { id: string; text: string };
type EffectIntent =
  | { effect: HostEffect; verdict: "not-requested" }
  | {
      effect: HostEffect;
      verdict: "required" | "uncertain";
      source: number;
      sourceQuote: string;
    };
export type EffectReview = {
  intents: EffectIntent[];
  sourceHash: string;
  factsHash: string;
  checks: {
    effect: HostEffect;
    verdict: "required" | "uncertain";
    sourceRevision: string;
    sourceQuote: string;
    factId: string;
    factHash: string;
    outcome: "supported" | "unsupported" | "deferred";
  }[];
};
const effect = { type: "string", enum: hostEffectIds };
export const effectReviewSchema = {
  type: "array",
  minItems: hostEffectIds.length,
  maxItems: hostEffectIds.length,
  items: {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["effect", "verdict"],
        properties: {
          effect,
          verdict: { type: "string", enum: ["not-requested"] },
        },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["effect", "verdict", "source", "sourceQuote"],
        properties: {
          effect,
          verdict: { type: "string", enum: ["required", "uncertain"] },
          source: { type: "integer", minimum: 1 },
          sourceQuote: { type: "string", minLength: 1 },
        },
      },
    ],
  },
};
/** Independent source interpretation is checked against the entire closed catalog. */
export function parseEffectReview(
  value: unknown,
  sources: Source[],
  facts: TechnicalFact[],
): EffectReview {
  const problems = schemaProblems(value, effectReviewSchema);
  if (problems.length)
    throw new Error("需求能力复核缺少完整矩阵：" + problems.join("；"));
  const raw = value as EffectIntent[];
  if (new Set(raw.map((v) => v.effect)).size !== hostEffectIds.length)
    throw new Error("需求能力矩阵遗漏或重复");
  const intents = hostEffectIds.map(
    (effect) => raw.find((v) => v.effect === effect)!,
  );
  const boundFacts = hostEffectIds.map((effect) => {
    const fact = facts.find((f) => f.id === capabilityFactId(effect));
    if (
      !fact ||
      !["supported", "unsupported", "deferred"].includes(
        fact.properties.availability,
      )
    )
      throw new Error("需求能力矩阵缺少可信事实");
    return fact;
  });
  const checks: EffectReview["checks"] = intents.flatMap((v) => {
    if (v.verdict === "not-requested") return [];
    const source = sources[v.source - 1],
      fact = boundFacts.find((f) => f.id === capabilityFactId(v.effect))!;
    if (
      !source ||
      !v.sourceQuote.trim() ||
      !source.text.includes(v.sourceQuote)
    )
      throw new Error("需求能力复核来源无效");
    return [
      {
        effect: v.effect,
        verdict: v.verdict,
        sourceRevision: source.id,
        sourceQuote: v.sourceQuote,
        factId: fact.id,
        factHash: fact.evidenceHash,
        outcome: fact.properties
          .availability as EffectReview["checks"][number]["outcome"],
      },
    ];
  });
  return {
    intents,
    sourceHash: hash(sources),
    factsHash: hash(boundFacts),
    checks,
  };
}
export function effectReviewResolved(
  review: EffectReview | undefined,
  sources: Source[],
  facts: TechnicalFact[],
): boolean {
  try {
    return (
      !!review &&
      hash(review) === hash(parseEffectReview(review.intents, sources, facts))
    );
  } catch {
    return false;
  }
}
export function effectBlockers(review: EffectReview | undefined): string[] {
  return (review?.checks ?? []).flatMap((c) =>
    c.verdict === "uncertain"
      ? [`需求能力来源尚未裁决：${c.sourceQuote}`]
      : c.outcome === "unsupported"
        ? [
            `需求原文 ${JSON.stringify(c.sourceQuote)} 需要 ${c.effect}，宿主能力及检查器不支持，须维护者扩展；不能先询问降级或渠道`,
          ]
        : [],
  );
}

/** The live catalog and executable interface whitelist are the authority, never model claims. */
export function capabilityFacts(
  capabilities?: Investigation["capabilities"],
): TechnicalFact[] {
  return hostEffectIds.map((effect) => {
    const interfaces: readonly string[] = hostEffects[effect];
    const providers = (capabilities ?? []).filter((c) =>
      interfaces.includes(c.interfaceId),
    );
    const supported = providers.some(
      (c) => c.ready && c.authorized && c.checkerCoverage.length > 0,
    );
    const extensible = executableMemberInterfaces.some((id) =>
      interfaces.includes(id),
    );
    const availability = supported
      ? "supported"
      : extensible ||
          (capabilities === undefined && effect === "online-schedule")
        ? "deferred"
        : "unsupported";
    const properties = {
      effect,
      availability,
      boundary: "protected-host-service",
      interfaces: interfaces.join(","),
    };
    return {
      id: capabilityFactId(effect),
      properties,
      evidenceHash: hash({ properties, providers, executableMemberInterfaces }),
    };
  });
}
