import type { ReviewLedger } from "../shared/change-spec.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CandidateAttempt,
  InvestigatedPlan,
  Requirement,
  RequirementGate,
  RequirementReview,
} from "../shared/assistant.js";
import { hash } from "../release/storage.js";
import type { BrowserCase } from "../shared/browser-cases.js";
import { browserSteps } from "../shared/browser-contract.js";
import { specificationFailure } from "../evolution/specification.js";
import { obligationFailure } from "../evolution/acceptance-obligations.js";
import { businessChoices, technicalFacts } from "../evolution/technical-facts.js";
import { fieldReviewSchema, parseFieldDecisions } from "../evolution/field-review.js";

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("需求定义结构无效");
  return value as Record<string, unknown>;
}
export function boundedText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 10000)
    throw new Error("需求定义文本无效");
  return value;
}
function array(value: unknown, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max)
    throw new Error("需求定义列表无效");
  return value;
}
export function parseRequirements(value: unknown): Requirement[] {
  return array(value ?? []).map((item) => {
    const r = record(item);
    if (
      !["behavior", "interface", "compatibility", "constraint"].includes(
        String(r.type),
      )
    )
      throw new Error("需求类型无效");
    return {
      id: boundedText(r.id),
      description: boundedText(r.description),
      sourceRevision: boundedText(r.sourceRevision),
      sourceQuote: boundedText(r.sourceQuote),
      type: r.type as Requirement["type"],
      checks: array(r.checks).map((item) => {
        const c = record(item);
        return {
          checker: boundedText(c.checker),
          caseId: boundedText(c.caseId),
        };
      }),
      ...(r.obligations === undefined
        ? {}
        : {
            obligations: structuredClone(
              r.obligations,
            ) as Requirement["obligations"],
          }),
    };
  });
}
export function parseBrowserCases(value: unknown): BrowserCase[] {
  const cases = array(value ?? [], 30).map((item) => {
    const c = record(item);
    if (
      Object.keys(c).some(
        (key) =>
          !["id", "task", "steps", "prepare", "obligationId", "classification"].includes(key),
      ) ||
      !["existing", "new"].includes(String(c.task)) ||
      (c.classification !== undefined && !["frozen-business", "system-protection"].includes(String(c.classification)))
    )
      throw new Error("browser/1 案例结构无效");
    const steps = array(c.steps, 40).map((item) => {
      const s = record(item);
      const kind = boundedText(s.kind);
      const definition = browserSteps.find(d => d.properties.kind.enum[0] === kind);
      const fields = definition ? Object.keys(definition.properties).filter(k => k !== 'kind') : [];
      if (
        !definition ||
        Object.keys(s).some(
          (key) => key !== "kind" && !fields.includes(key),
        )
      )
        throw new Error("browser/1 不支持脚本、选择器、网址或未知步骤");
      for (const key of fields) {
        if (!definition.required.includes(key) && s[key] === undefined)
          continue;
        if (key === "visible") {
          if (typeof s[key] !== "boolean")
            throw new Error("browser/1 visible 无效");
        } else if (key === "input") {
          for (const [k, v] of Object.entries(record(s[key]))) {
            if (
              !/^[\w.-]{1,100}$/.test(k) ||
              typeof v !== "string" ||
              v.length > 10000
            )
              throw new Error("browser/1 表单输入无效");
          }
        } else if (
          typeof s[key] !== "string" ||
          (s[key] as string).length > 10000
        )
          throw new Error("browser/1 步骤文本无效");
        if (
          ["member", "contribution", "field", "action"].includes(key) &&
          !/^[\w.-]{1,100}$/.test(String(s[key]))
        )
          throw new Error("browser/1 必须使用稳定业务 ID");
      }
      return s as unknown as BrowserCase["steps"][number];
    });
    if (!steps.length) throw new Error("browser/1 案例没有步骤");
    const id = boundedText(c.id);
    if (!/^[\w.-]{1,100}$/.test(id))
      throw new Error("browser/1 案例必须使用非宿主保留的稳定 ID");
    let prepare: BrowserCase["prepare"];
    if (c.prepare !== undefined) {
      const p = record(c.prepare);
      const expected = record(p.expected);
      const actions = array(p.actions, 8);
      if (
        c.task !== "existing" ||
        !actions.length ||
        Object.keys(p).some(
          (k) => !["actions", "expected", "sourceHash", "baseVersion"].includes(k),
        ) ||
        !/^[a-f0-9]{64}$/.test(String(p.sourceHash)) ||
        !/^[a-f0-9]{64}$/.test(String(p.baseVersion)) ||
        typeof expected.state !== "string" ||
        Object.values(record(expected.fields)).some(
          (v) => typeof v !== "string",
        )
      )
        throw new Error("browser/1 历史准备无效");
      const parsed = parseBrowserCases([
        { id: "preparation", task: "new", steps: actions },
      ])[0].steps;
      if (parsed.some((s) => s.kind !== "action"))
        throw new Error("browser/1 历史准备只能重放真实动作");
      prepare = {
        actions: parsed as NonNullable<BrowserCase["prepare"]>["actions"],
        expected: expected as NonNullable<BrowserCase["prepare"]>["expected"],
        sourceHash: String(p.sourceHash),
        baseVersion: String(p.baseVersion),
      };
    }
    return {
      id,
      task: c.task as BrowserCase["task"],
      steps,
      ...(prepare ? { prepare } : {}),
      ...(c.obligationId === undefined
        ? {}
        : { obligationId: boundedText(c.obligationId) }),
      ...(c.classification === undefined ? {} : {classification: c.classification as BrowserCase["classification"]}),
    };
  });
  if (new Set(cases.map((c) => c.id)).size !== cases.length)
    throw new Error("browser/1 案例 ID 重复");
  return cases;
}
export function caseCatalog(
  plan: Pick<
    InvestigatedPlan,
    "cases" | "memberCases" | "browserCases" | "extensions"
  >,
) {
  const counts = new Map<string, number>();
  return [
    ...plan.cases.map((c) => {
      const index = (counts.get(c.checker) ?? 0) + 1;
      counts.set(c.checker, index);
      return {
        checker: c.checker,
        caseId: `${c.checker}:${index}`,
        definition: c,
      };
    }),
    ...(plan.memberCases ?? []).map((c) => ({
      checker: "workspace/1",
      caseId: `member:${c.member}:${c.name}`,
      definition: c,
    })),
    ...(plan.extensions?.cases ?? []).map((c) => ({
      checker: "business-actions/1",
      caseId: `action:${c.name}`,
      definition: c,
    })),
    ...(plan.browserCases ?? []).map((c) => ({
      checker: "browser/1",
      caseId: c.id,
      definition: c,
    })),
  ];
}
export function requirementDefinition(plan: InvestigatedPlan) {
  return {
    requestAdmission: plan.requestAdmission,
    questionAdjudications: plan.questionAdjudications ?? [],
    changeSpec: plan.changeSpec,
    summary: plan.summary,
    changes: plan.changes,
    outcome: plan.outcome,
    dataImpact: plan.dataImpact,
    acceptanceChanges: plan.acceptanceChanges ?? [],
    requirements: plan.requirements,
    browserCases: plan.browserCases ?? [],
    cases: plan.cases,
    memberCases: plan.memberCases ?? [],
    extensions: plan.extensions,
    workflowRules: plan.workflowRules,
    excluded: plan.excluded,
    compatibility: plan.compatibility,
  };
}
export function coverage(
  plan: InvestigatedPlan,
  sources: RequirementGate["sources"],
  supported: string[],
) {
  const catalog = caseCatalog(plan);
  const ids = (plan.requirements ?? []).map((r) => r.id);
  return (plan.requirements ?? []).map((r) => {
    const reasons: string[] = [];
    const fieldObligations = (plan.requirements ?? []).flatMap(r => r.obligations ?? []).filter(o => o.kind === "field" || o.kind === "history");
    reasons.push(...obligationFailure(r, plan.browserCases ?? []));
    if (ids.filter((id) => id === r.id).length !== 1)
      reasons.push("需求 ID 重复");
    if (
      !sources.some(
        (s) => s.id === r.sourceRevision && s.text.includes(r.sourceQuote),
      )
    )
      reasons.push("需求来源修订或原文引用不存在");
    if (!r.checks.length) reasons.push("需求缺少验收映射");
    for (const c of r.checks) {
      if (!supported.includes(c.checker))
        reasons.push(`检查器不支持：${c.checker}`);
      if (
        !catalog.some(
          (item) => item.checker === c.checker && item.caseId === c.caseId,
        )
      )
        reasons.push(`案例引用不存在：${c.caseId}`);
    }
    const uiChecks = r.checks.filter((c) => c.checker === "browser/1");
    for (const ref of uiChecks) {
      const c = plan.browserCases?.find((c) => c.id === ref.caseId);
      let operated = false;
      for (const s of c?.steps ?? []) {
        if (s.kind === "action") operated = true;
        if (
          s.kind === "field" &&
          !fieldObligations.some(
            (o) =>
              (o.kind === "field" || o.kind === "history") &&
              o.member === s.member &&
              o.field === s.field,
          )
        )
          reasons.push(
            `可见字段 ${s.member}:${s.field} 缺少初始、动作后及持久化义务，单个字段断言不能覆盖`,
          );
        if (s.kind === "field" && !operated) {
          const obligation = fieldObligations.find(
            (o) =>
              (o.kind === "field" || o.kind === "history") &&
              o.member === s.member &&
              o.field === s.field,
          );
          if (obligation?.kind === "history" && !c?.prepare) reasons.push(`字段 ${s.field} 历史状态未准备，existing 不是历史数据`);
          if (obligation?.kind === "field") {
            const expected = c?.prepare
              ? { kind: "visible", value: c.prepare.expected.fields[s.field] }
              : obligation.initial;
            if (
              (expected.kind === "absent") !== (s.visible === false) ||
              (expected.kind === "visible" && expected.value !== s.value)
            )
              reasons.push(`字段 ${s.field} 初始状态未准备或与验收义务不一致`);
          }
        }
      }
    }
    if (
      r.type === "interface" &&
      (!uiChecks.length ||
        uiChecks.some(
          (ref) =>
            !plan.browserCases
              ?.find((c) => c.id === ref.caseId)
              ?.steps.some((s) =>
                ["field", "action-visible", "error", "task"].includes(s.kind),
              ),
        ))
    )
      reasons.push(
        "界面要求必须映射 browser/1 可见断言，后端动作不能替代界面验收",
      );
    return { requirementId: r.id, reasons };
  });
}
export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["reviewedIds", "issues"],
  properties: {
    resolutions: {type: "array", items: {type: "object", additionalProperties: false,
      required: ["issueId", "sourceRevision", "sourceQuote", "reason"], properties: {
        issueId: {type: "string"}, sourceRevision: {type: "string"}, sourceQuote: {type: "string"}, reason: {type: "string"}
      }}},
    reviewedIds: { type: "array", items: { type: "string" } },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "sourceRevision", "sourceQuote", "detail", "target", "stance"],
        properties: {
          kind: {
            type: "string",
            enum: ["omission", "extra-constraint", "conflict", "unverifiable"],
          },
          sourceRevision: { type: "string" },
          sourceQuote: { type: "string" },
          detail: { type: "string" },
          target: {
            type: "object",
            additionalProperties: false,
            required: ["subject", "aspect"],
            properties: {
              subject: { type: "string" },
              aspect: {
                type: "string",
                enum: [
                  "availability",
                  "input",
                  "visibility",
                  "persistence",
                  "compatibility",
                  "meaning",
                  "coverage",
                ],
              },
            },
          },
          stance: {
            type: "string",
            enum: ["required", "forbidden", "undetermined"],
          },
          clarification: { type: "string" },
          clarificationChoice: {type: "string", description: "仅从 businessChoices 选择必要业务问题；实际问题由宿主生成，clarification 仅作复核原文留证。技术问题使用 technicalFacts。"},
          technical: {
            type: "object",
            additionalProperties: false,
            required: ["factId", "property", "expected"],
            properties: {
              factId: { type: "string" },
              property: { type: "string" },
              expected: { type: "string" },
            },
          },
        },
      },
    },
  },
};
/** Closed catalogs remove free-form identity construction from the independent reviewer. */
export function boundReviewSchema(plan: InvestigatedPlan, sources: RequirementGate["sources"], ledger?: ReviewLedger): Record<string, unknown> {
  const schema = structuredClone(reviewSchema);
  const ids = (plan.requirements ?? []).map((r) => r.id);
  const sourceIds = [...new Set(sources.map((s) => s.id))];
  Object.assign(schema.properties.reviewedIds, {
    uniqueItems: true,
    minItems: ids.length,
    maxItems: ids.length,
  });
  Object.assign(schema.properties.reviewedIds.items, { enum: ids });
  Object.assign(schema.properties.issues.items.properties.sourceRevision, {
    enum: sourceIds,
  });
  const facts = technicalFacts(plan);
  const choices = businessChoices(plan);
  Object.assign(schema.properties.issues.items.properties.clarificationChoice, {enum: choices.length ? choices.map(c => c.id) : ["unavailable"]});
  Object.assign(
    schema.properties.issues.items.properties.target.properties.subject,
    { enum: [...ids, ...sourceIds] },
  );
  Object.assign(
    schema.properties.issues.items.properties.technical.properties.factId,
    { enum: facts.map((f) => f.id) },
  );
  Object.assign(
    schema.properties.issues.items.properties.technical.properties.property,
    { enum: [...new Set(facts.flatMap((f) => Object.keys(f.properties)))] },
  );
  Object.assign(schema.properties.resolutions.items.properties.sourceRevision, {
    enum: sourceIds,
  });
  const findings = ledger?.findings.map((f) => f.id) ?? [];
  if (findings.length)
    Object.assign(schema.properties.resolutions.items.properties.issueId, {
      enum: findings,
    });
  else Object.assign(schema.properties.resolutions, { maxItems: 0 });
  const properties = schema.properties.issues.items.properties;
  return {...schema, required: [...schema.required, "fieldDecisions"], properties: {...schema.properties, fieldDecisions: fieldReviewSchema(plan), issues: {...schema.properties.issues, items: {anyOf: [
    {...schema.properties.issues.items, properties: Object.fromEntries(Object.entries(properties).filter(([key]) => !["technical", "clarification"].includes(key)))},
    {type: "object", additionalProperties: false, required: ["kind", "sourceRevision", "sourceQuote", "detail", "technical"],
      properties: Object.fromEntries(Object.entries(properties).filter(([key]) => ["kind", "sourceRevision", "sourceQuote", "detail", "technical"].includes(key)))},
  ]}}}};
}

export function parseReview(
  text: string,
  plan: InvestigatedPlan,
  sources: RequirementGate["sources"],
): RequirementReview {
  const v = record(JSON.parse(text));
  const reviewedIds = array(v.reviewedIds).map(boundedText);
  if (
    hash([...reviewedIds].sort()) !==
    hash((plan.requirements ?? []).map((r) => r.id).sort())
  )
    throw new Error("独立复核未逐项覆盖需求清单");
  const issues = array(v.issues).map((item) => {
    const wire = record(item);
    let i = wire;
    if (wire.technical !== undefined) {
      if (Object.keys(wire).some(k => !["kind", "sourceRevision", "sourceQuote", "detail", "technical"].includes(k))) throw new Error("技术复核的目标和立场由宿主绑定，不得手工维护");
      const claim = record(wire.technical);
      i = {...wire, target: {subject: boundedText(claim.factId), aspect: "meaning"}, stance: "required"};
    } else if (wire.clarification !== undefined) throw new Error("自由文本及技术问题不能直接提问，请绑定宿主业务选项");
    if (
      !["omission", "extra-constraint", "conflict", "unverifiable"].includes(
        String(i.kind),
      )
    )
      throw new Error("独立复核类型无效");
    const issue: RequirementReview["issues"][number] = {
      kind: i.kind as RequirementReview["issues"][number]["kind"],
      sourceRevision: boundedText(i.sourceRevision),
      sourceQuote: boundedText(i.sourceQuote),
      detail: boundedText(i.detail),
    };
    if (i.target === undefined || i.stance === undefined) throw new Error("独立复核缺少结构化目标或立场");
    if (i.target !== undefined) {
      const t = record(i.target);
      if (!["availability", "input", "visibility", "persistence", "compatibility", "meaning", "coverage"].includes(String(t.aspect)))
        throw new Error("独立复核目标无效");
      const subject = boundedText(t.subject);
      if (
        !(plan.requirements ?? []).some((r) => r.id === subject) &&
        !sources.some((s) => s.id === subject) &&
        !technicalFacts(plan).some((f) => f.id === subject)
      )
        throw new Error("独立复核目标不属于宿主需求或来源目录");
      issue.target = {subject, aspect: t.aspect as NonNullable<typeof issue.target>["aspect"]};
    }
    if (i.stance !== undefined) {
      if (!["required", "forbidden", "undetermined"].includes(String(i.stance))) throw new Error("独立复核立场无效");
      issue.stance = i.stance as NonNullable<typeof issue.stance>;
    }
    if (i.clarification !== undefined)
      issue.clarification = boundedText(i.clarification);
    if (i.clarificationChoice !== undefined) issue.clarificationChoice = boundedText(i.clarificationChoice);
    if (i.technical !== undefined) {
      const t = record(i.technical);
      issue.technical = {
        factId: boundedText(t.factId),
        property: boundedText(t.property),
        expected: boundedText(t.expected),
      };
    }
    if (
      !sources.some(
        (s) =>
          s.id === issue.sourceRevision && s.text.includes(issue.sourceQuote),
      )
    )
      throw new Error("独立复核来源引用无效");
    return issue;
  });
  const resolutions = v.resolutions === undefined ? [] : array(v.resolutions).map(item => {
    const r = record(item);
    const resolution = {issueId: boundedText(r.issueId), sourceRevision: boundedText(r.sourceRevision), sourceQuote: boundedText(r.sourceQuote), reason: boundedText(r.reason)};
    if (!sources.some(s => s.id === resolution.sourceRevision && s.text.includes(resolution.sourceQuote)))
      throw new Error("复核问题消解缺少有效来源引用");
    return resolution;
  });
  const fields = parseFieldDecisions(v.fieldDecisions, plan, sources);
  return { reviewedIds, issues: [...issues, ...fields.issues], resolutions, fieldDecisions: fields.decisions };
}
function gateVersion() {
  return hash(
    [
      "src/server/requirement-coverage.ts",
      "src/evolution/specification.ts",
      "src/evolution/references.ts",
      "src/evolution/candidate-delta.ts",
      "src/evolution/review.ts",
      "src/shared/browser-contract.ts",
      "src/evolution/acceptance-obligations.ts",
      "src/shared/acceptance-obligations.ts",
      "src/evolution/technical-facts.ts",
      "src/shared/checker-semantics.ts",
      "src/shared/field-presentation.ts",
      "src/evolution/field-review.ts",
      "src/evolution/clarification-review.ts",
      "src/evolution/request-admission.ts",
      "src/evolution/model-protocol.ts",
    ].map((path) => ({ path, content: readFileSync(resolve(path), "utf8") })),
  );
}
export function freezeRequirements(
  plan: InvestigatedPlan,
  sources: RequirementGate["sources"],
  requestHash: string,
  review: RequirementReview,
  supported: string[],
  reviewLedger?: ReviewLedger,
): RequirementGate {
  const body = {
    gateVersion: gateVersion(),
    sources,
    requestHash,
    definitionHash: hash(requirementDefinition(plan)),
    review,
    reviewLedger: structuredClone(reviewLedger ?? {version: 2 as const, findings: [], attempts: []}),
    coverage: coverage(plan, sources, supported),
  };
  return { ...body, seal: hash(body) };
}
export function gateFailure(
  plan: InvestigatedPlan,
  trusted: RequirementGate | undefined,
  requestHash?: string,
  reviewLedger?: ReviewLedger,
) {
  const g = plan.requirementGate;
  if (!g || !trusted || !plan.requirements?.length)
    return "缺少需求完整性门禁证据，请重新规划";
  const specFailure = specificationFailure(plan);
  if (specFailure) return specFailure;
  if (
    coverage(
      plan,
      g.sources,
      plan.binding?.checkers.map((c) => c.id) ?? [],
    ).some((c) => c.reasons.length)
  )
    return "可执行验收义务或需求覆盖不一致，请重新规划";
  const { seal, ...body } = g;
  if (
    g.gateVersion !==
      gateVersion() ||
    hash(g) !== hash(trusted) ||
    seal !== hash(body) ||
    g.definitionHash !== hash(requirementDefinition(plan)) ||
    (requestHash && requestHash !== g.requestHash) ||
    hash(g.reviewLedger) !== hash(reviewLedger ?? {version: 2 as const, findings: [], attempts: []})
  )
    return "冻结需求、验收映射、修订或复核摘要已变化，请重新规划";
  if (g.review.issues.length || g.coverage.some((c) => c.reasons.length) || g.reviewLedger?.findings.some(f => f.status !== "resolved"))
    return "需求完整性复核或覆盖未通过";
}

export function candidateEvidenceHash(
  candidate: Pick<CandidateAttempt, "id" | "versionId" | "sourceHash" | "delta">,
  plan: InvestigatedPlan,
  acceptance: {
    members?: unknown;
    workspaceChecks: string[];
    browser?: import("../shared/browser-cases.js").BrowserEvidence;
  },
) {
  return hash({
    candidateId: candidate.id,
    versionId: candidate.versionId,
    sourceHash: candidate.sourceHash,
    delta: candidate.delta,
    cases: plan.cases,
    rules: plan.workflowRules,
    members: acceptance.members,
    workspaceChecks: acceptance.workspaceChecks,
    requirementSeal: plan.requirementGate?.seal,
    browser: acceptance.browser,
  });
}
