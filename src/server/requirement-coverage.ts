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
    };
  });
}
export function parseBrowserCases(value: unknown): BrowserCase[] {
  const cases = array(value ?? [], 30).map((item) => {
    const c = record(item);
    if (
      Object.keys(c).some((key) => !["id", "task", "steps"].includes(key)) ||
      !["existing", "new"].includes(String(c.task))
    )
      throw new Error("browser/1 案例结构无效");
    const steps = array(c.steps, 40).map((item) => {
      const s = record(item);
      const fields: Record<string, string[]> = {
        open: [],
        refresh: [],
        restart: [],
        edit: ["title", "description"],
        action: ["member", "action", "input"],
        field: ["member", "contribution", "field", "value"],
        "action-visible": ["member", "contribution", "action", "visible"],
        error: ["text"],
        task: ["title", "description"],
      };
      const kind = boundedText(s.kind);
      if (
        !fields[kind] ||
        Object.keys(s).some(
          (key) => key !== "kind" && !fields[kind].includes(key),
        )
      )
        throw new Error("browser/1 不支持脚本、选择器、网址或未知步骤");
      for (const key of fields[kind]) {
        if ((kind === "edit" || key === "input") && s[key] === undefined)
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
    return { id, task: c.task as BrowserCase["task"], steps };
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
    reviewedIds: { type: "array", items: { type: "string" } },
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "sourceRevision", "sourceQuote", "detail"],
        properties: {
          kind: {
            type: "string",
            enum: ["omission", "extra-constraint", "conflict", "unverifiable"],
          },
          sourceRevision: { type: "string" },
          sourceQuote: { type: "string" },
          detail: { type: "string" },
        },
      },
    },
  },
};
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
    const i = record(item);
    if (
      !["omission", "extra-constraint", "conflict", "unverifiable"].includes(
        String(i.kind),
      )
    )
      throw new Error("独立复核类型无效");
    const issue = {
      kind: i.kind as RequirementReview["issues"][number]["kind"],
      sourceRevision: boundedText(i.sourceRevision),
      sourceQuote: boundedText(i.sourceQuote),
      detail: boundedText(i.detail),
    };
    if (
      !sources.some(
        (s) =>
          s.id === issue.sourceRevision && s.text.includes(issue.sourceQuote),
      )
    )
      throw new Error("独立复核来源引用无效");
    return issue;
  });
  return { reviewedIds, issues };
}
export function freezeRequirements(
  plan: InvestigatedPlan,
  sources: RequirementGate["sources"],
  requestHash: string,
  review: RequirementReview,
  supported: string[],
): RequirementGate {
  const body = {
    gateVersion: hash(
      readFileSync(resolve("src/server/requirement-coverage.ts"), "utf8"),
    ),
    sources,
    requestHash,
    definitionHash: hash(requirementDefinition(plan)),
    review,
    coverage: coverage(plan, sources, supported),
  };
  return { ...body, seal: hash(body) };
}
export function gateFailure(
  plan: InvestigatedPlan,
  trusted: RequirementGate | undefined,
  requestHash?: string,
) {
  const g = plan.requirementGate;
  if (!g || !trusted || !plan.requirements?.length)
    return "缺少需求完整性门禁证据，请重新规划";
  const { seal, ...body } = g;
  if (
    g.gateVersion !==
      hash(
        readFileSync(resolve("src/server/requirement-coverage.ts"), "utf8"),
      ) ||
    hash(g) !== hash(trusted) ||
    seal !== hash(body) ||
    g.definitionHash !== hash(requirementDefinition(plan)) ||
    (requestHash && requestHash !== g.requestHash)
  )
    return "冻结需求、验收映射、修订或复核摘要已变化，请重新规划";
  if (g.review.issues.length || g.coverage.some((c) => c.reasons.length))
    return "需求完整性复核或覆盖未通过";
}

export function candidateEvidenceHash(
  candidate: Pick<CandidateAttempt, "id" | "versionId" | "sourceHash">,
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
    cases: plan.cases,
    rules: plan.workflowRules,
    members: acceptance.members,
    workspaceChecks: acceptance.workspaceChecks,
    requirementSeal: plan.requirementGate?.seal,
    browser: acceptance.browser,
  });
}
