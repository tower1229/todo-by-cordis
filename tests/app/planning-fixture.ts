import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import { parseAdmission } from "../../src/evolution/request-admission.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
/** Authored model-stub receipt for manually seeded lifecycle candidates; never real-model evidence. */
export function admissionReceiptFixture(
  baseVersion: string,
  sources: { id: string; text: string }[],
) {
  return parseAdmission(
    JSON.stringify({ presentations: [], questions: [], facts: [] }),
    baseVersion,
    sources,
    technicalFacts({ workflowRules: [], binding: undefined }),
  );
}
/** Legacy control-flow fixtures have no source-intake semantics; dedicated intake tests supply them. */
export function admissionFixture(request: ModelRequest) {
  if (
    !request.schema ||
    JSON.parse(request.message ?? "{}").kind !== "request-admission/1"
  )
    return;
  return {
    text: JSON.stringify({ presentations: [], questions: [], facts: [] }),
    history: [],
    calls: [],
    usage: { fixture: true },
    raw: { fixture: "request-admission" },
  };
}
/** Model-stub interpretation; real acceptance uses Gemini's independent source interpretation. */
export function fieldDecisionsFixture(input: {
  requirements?: { obligations?: AcceptanceObligation[] }[];
  fieldReviewTargets?: { obligationId: string; sources: { quote: string }[] }[];
}) {
  return (input.fieldReviewTargets ?? []).map((target, index) => {
    const o = input.requirements
      ?.flatMap((r) => r.obligations ?? [])
      .find((o) => o.id === target.obligationId);
    if (o?.kind !== "field") throw new Error("模型桩缺少字段解释目标");
    return {
      target: index + 1,
      source: 1,
      sourceQuote: target.sources[0].quote,
      initial: o.initialOrigin === "host" ? { kind: "unspecified" } : o.initial,
    };
  });
}
export const toolReply = (name: string, args: Record<string, unknown>) => ({
  text: "",
  history: [],
  calls: [{ name, args }],
  usage: null,
  raw: { fixture: true },
});
export class PlanningDriver implements Driver {
  requests: ModelRequest[] = [];
  private delivered = "";
  private sources: { id: string; text: string }[] = [];
  constructor(public finish: Record<string, unknown> = {}) {}
  async generate(request: ModelRequest) {
    this.requests.push(request);
    const admission = admissionFixture(request);
    if (admission) return admission;
    if (
      request.schema &&
      JSON.parse(request.message ?? "{}").kind === "clarification-review/1"
    ) {
      const input = JSON.parse(request.message!);
      return {
        text: JSON.stringify({
          kind: "business-ambiguity",
          source: input.sources.length,
          sourceQuote: input.sources.at(-1).text,
          detail: "模型桩确认必要业务歧义",
        }),
        history: [],
        calls: [],
        usage: { fixture: true },
        raw: { fixture: "clarification-review" },
      };
    }
    if (request.schema) {
      const input = JSON.parse(request.message ?? "{}") as {
        requirements: { id: string; obligations?: AcceptanceObligation[] }[];
        fieldReviewTargets?: {
          obligationId: string;
          sources: { quote: string }[];
        }[];
        reviewLedger?: {
          findings: {
            id: string;
            issue: { sourceRevision: string; sourceQuote: string };
          }[];
        };
      };
      return {
        text: JSON.stringify({
          reviewedIds: input.requirements.map((r) => r.id),
          issues: [],
          fieldDecisions: fieldDecisionsFixture(input),
          resolutions: (input.reviewLedger?.findings ?? []).map((f) => ({
            issueId: f.id,
            sourceRevision: f.issue.sourceRevision,
            sourceQuote: f.issue.sourceQuote,
            reason: "模型桩确认本次规格已修正历史问题",
          })),
        }),
        history: [],
        calls: [],
        usage: { fixture: true },
        raw: { fixture: "independent-review" },
      };
    }
    if (request.message) {
      const input = JSON.parse(request.message) as {
        sources?: { id: string; text: string }[];
      };
      if (input.sources) {
        this.sources = input.sources;
        this.delivered = request.message;
      }
    }
    const toolReply = (name: string, args: Record<string, unknown>) => ({
      text: "",
      history: request.history,
      calls: [{ name, args }],
      usage: null,
      raw: { fixture: true },
    });
    const rules = this.finish.workflowRules ?? [
      {
        key: "reflection",
        label: "复盘",
        required: true,
        minLength: 1,
        maxLength: 5000,
      },
    ];
    const content = JSON.stringify(request.history) + this.delivered;
    if (!content.includes("inspect_application"))
      return toolReply("inspect_application", {});
    if (!content.includes("active-source"))
      return {
        ...toolReply("read_source", { ref: "active-source" }),
        calls: [
          { name: "read_source", args: { ref: "active-source" } },
          { name: "read_source", args: { ref: "src/web/ActionForm.tsx" } },
          { name: "read_contract", args: { ref: "src/shared/contracts.ts" } },
          {
            name: "read_acceptance",
            args: { ref: "src/server/evolution-domain.ts" },
          },
          { name: "check_environment", args: {} },
          { name: "read_contract", args: { ref: "active-contract" } },
          { name: "read_acceptance", args: { ref: "active-acceptance" } },
          { name: "describe_verification", args: { rules } },
          ...((this.finish.writableScope ?? []) as string[])
            .filter((ref) => ref.startsWith("business/"))
            .map((ref) => ({ name: "read_source", args: { ref } })),
        ],
      };
    const messages = request.history as {
      parts: {
        functionResponse?: {
          response: {
            result: {
              ref?: string;
              hash?: string;
              content?: { cases: unknown[] };
            };
          };
        };
      }[];
    }[];
    const evidence = messages
      .flatMap((m) => m.parts ?? [])
      .flatMap((p) =>
        p.functionResponse?.response.result.ref
          ? [
              {
                ref: p.functionResponse.response.result.ref,
                hash: p.functionResponse.response.result.hash,
              },
            ]
          : [],
      );
    const args: Record<string, unknown> = {
      requirements: this.sources.slice(-1).map((s) => ({
        id: `request-${s.id}`,
        description: s.text,
        sourceRevision: s.id,
        sourceQuote: s.text,
        type: "behavior",
        checks: this.finish.memberEnabled
          ? [
              {
                checker: "host-member-enabled/1",
                caseId: "host-member-enabled/1:1",
              },
            ]
          : [{ checker: "workflow/1", caseId: "workflow/1:1" }],
      })),
      browserCases: [],
      summary: "完成任务前填写复盘",
      changes: ["完成前要求填写复盘"],
      outcome: "未填写复盘不能完成任务",
      dataImpact: "保留历史任务及未知字段",
      excluded: ["不修改其他动作"],
      capabilityChanges: [
        {
          capability: "workflow",
          provider: "active-source",
          consumers: ["src/web/ActionForm.tsx"],
          change: "增加复盘字段",
        },
      ],
      workflowRules: rules,
      acceptance: messages
        .flatMap((m) => m.parts ?? [])
        .find(
          (p) =>
            p.functionResponse?.response.result.ref ===
            "verification-definition",
        )?.functionResponse?.response.result.content?.cases,
      steps: [
        {
          id: "workflow",
          purpose: "调整完成行为",
          dependsOn: [],
          artifact: "工作流候选",
          evidence: "工作流验收报告",
        },
      ],
      writableScope: ["active-source"],
      compatibility: "保留未知字段",
      rollback: "撤回实现，保留当前任务数据",
      preview: "隔离合成任务表单",
      application: "用户另行确认后切换工作流",
      restartImpact: "重启业务子进程，短暂停写",
      dependencies: [],
      unresolved: [],
      evidence,
    };
    for (const key of [
      "evidence",
      "acceptance",
      "steps",
      "rollback",
      "preview",
      "application",
      "restartImpact",
    ])
      delete args[key];
    if (Array.isArray(this.finish.unresolved) && this.finish.unresolved.length)
      return toolReply("report_blocker", {
        reason: this.finish.unresolved.join("；"),
      });
    return toolReply(
      "propose_plan",
      referenceFixture({ ...args, ...this.finish }, this.sources),
    );
  }
}

/** Test-only migration of archived full-reference fixtures to the host-bound wire contract. */
export function referenceFixture(
  draft: Record<string, unknown>,
  sources: { id: string; text: string }[],
) {
  const copy = structuredClone(draft);
  if (!Object.hasOwn(copy, "workflowRules") && Array.isArray(copy.changes) && copy.changes.every(c => typeof c === "object" && c !== null && "target" in c)) return copy;
  if (Object.hasOwn(copy, "workflow") && Object.hasOwn(copy, "members"))
    return targetFixture(copy);
  if (Array.isArray(copy.unresolved) && !copy.unresolved.length)
    delete copy.unresolved;
  if (Array.isArray(copy.requirements))
    copy.requirements = copy.requirements.map((r: Record<string, unknown>) => {
      const { sourceRevision, ...rest } = r;
      return {
        ...rest,
        obligations: r.obligations ?? [{ kind: "backend" }],
        source:
          sourceRevision === undefined
            ? r.source
            : sources.findIndex((s) => s.id === sourceRevision) + 1,
        checks: (
          r.checks as {
            checker: string;
            caseId: string;
            kind?: string;
            index?: number;
          }[]
        ).map((c) => {
          if (
            c.kind !== undefined &&
            c.checker === undefined &&
            c.caseId === undefined
          )
            return c;
          if (
            c.checker === "workflow/1" ||
            c.checker === "host-member-enabled/1"
          )
            return {
              kind: c.checker === "workflow/1" ? "workflow" : "enabled",
              index: Number(c.caseId.split(":").at(-1)),
            };
          if (c.checker === "browser/1")
            return {
              kind: "browser",
              index:
                ((copy.browserCases as { id: string }[]) ?? []).findIndex(
                  (b) => b.id === c.caseId,
                ) + 1,
            };
          if (c.checker === "workspace/1")
            return {
              kind: "member",
              index:
                (
                  (copy.memberCases as { member: string; name: string }[]) ?? []
                ).findIndex(
                  (b) => `member:${b.member}:${b.name}` === c.caseId,
                ) + 1,
            };
          return { kind: "invalid", index: 0 };
        }),
      };
    });
  if (Array.isArray(copy.browserCases))
    copy.browserCases = copy.browserCases.map((c: Record<string, unknown>) => ({
      ...c,
      steps: (c.steps as Record<string, unknown>[]).map(
        ({ member: _member, contribution: _contribution, ...s }) =>
          s.kind === "task" ? { kind: "task" } : s,
      ),
    }));
  if (Array.isArray(copy.browserCases)) {
    // Preserve every old fixture assertion as a business obligation. Production
    // never accepts this legacy wire field; archived expectations remain intact.
    const cases = copy.browserCases as {
      id: string;
      task: string;
      steps: Record<string, unknown>[];
    }[];
    const requirements = (copy.requirements ?? []) as {
      checks: { kind: string; index?: number }[];
      obligations: Record<string, unknown>[];
    }[];
    const referenced = new Set(
      requirements.flatMap((r) =>
        r.checks.filter((c) => c.kind === "browser").map((c) => c.index),
      ),
    );
    for (const [rIndex, r] of requirements.entries()) {
      const selected = new Set(
        r.checks.filter((c) => c.kind === "browser").map((c) => c.index),
      );
      if (rIndex === 0)
        cases.forEach((_, i) => {
          if (!referenced.has(i + 1)) selected.add(i + 1);
        });
      for (const index of selected) {
        const c = cases[(index ?? 0) - 1];
        if (!c) continue;
        if (Object.keys(c).some((k) => !["id", "task", "steps"].includes(k)))
          throw new Error("旧夹具浏览器案例包含不能迁移的字段");
        const steps = structuredClone(c.steps);
        const last = steps.at(-1);
        const expected =
          last &&
          ["task", "error", "action-visible"].includes(String(last.kind))
            ? steps.pop()!
            : { kind: "task" };
        r.obligations.push({ kind: "assertion", steps, expected });
      }
      r.checks = r.checks.filter(
        (c) => c.kind !== "browser" || !cases[(c.index ?? 0) - 1],
      );
    }
    delete copy.browserCases;
  }
  return businessFixture(copy, sources);
}

/** Legacy test data is expressed as business facts; production accepts only this narrowed contract. */
function businessFixture(
  draft: Record<string, unknown>,
  sources: { id: string; text: string }[],
) {
  type Row = Record<string, unknown>;
  const rows = (value: unknown) => (Array.isArray(value) ? value : []) as Row[];
  const feature = (id: unknown) =>
    ({
      "command.register": "commands",
      "fields.register": "fields",
      "task.beforeCommit": "beforeCommit",
      lifecycle: "lifecycle",
      "diagnostics.annotate": "diagnostics",
      "ui.slot": "detail",
      "task.events": "events",
      "schedule.register": "schedules",
      "workflow.provide": "workflow",
      "schedule.runtime": "scheduler",
      "query.filter": "filter",
      "query.sort": "sort",
      "service.provide": "service",
    })[String(id)] ?? String(id);
  const cases = rows(draft.memberCases);
  const features = rows(draft.capabilityChanges);
  const affected = features
    .filter((f) => String(f.provider).startsWith("member:"))
    .map((f) => ({ pluginId: String(f.provider).slice(7) }))
    .filter(
      (m, i, all) =>
        all.findIndex((o) => o.pluginId === m.pluginId) === i &&
        ![...rows(draft.memberAdditions), ...rows(draft.memberUpgrades)].some(
          (o) => o.pluginId === m.pluginId,
        ),
    );
  const members: Row[] = [
    ...affected.map((m) => ({ operation: "upgrade", ...m })),
    ...rows(draft.memberAdditions).map((m) => ({ operation: "add", ...m })),
    ...rows(draft.memberUpgrades).map((m) => ({ operation: "upgrade", ...m })),
  ].map((m) => ({
    ...m,
    cases: cases
      .filter((c) => c.member === m.pluginId)
      .map(({ member: _member, ...c }) => c),
    features: features
      .filter((f) => f.provider === `member:${m.pluginId}`)
      .map((f) => feature(f.capability)),
  }));
  if (draft.memberEnabled) {
    const m = draft.memberEnabled as Row;
    members.push({
      operation: m.enabled ? "enable" : "disable",
      pluginId: m.pluginId,
    });
  }
  const scope = (draft.writableScope ?? []) as string[];
  const extensions = draft.extensions as
    | { actions?: unknown[]; fields?: unknown[]; cases?: unknown[] }
    | undefined;
  const workflow =
    scope.length || rows(draft.workflowRules).length
      ? {
          modules: scope
            .filter(
              (p) =>
                ![
                  "business/view.ts",
                  "business/config.json",
                  "business/compatibility.json",
                ].includes(p) &&
                !(p.startsWith("business/") && p.endsWith(".json")),
            )
            .map((p) =>
              p === "active-source"
                ? "workflow"
                : p.startsWith("business/") && p.endsWith(".ts")
                  ? p.slice(9, -3)
                  : p,
            ),
          data: scope
            .filter(
              (p) =>
                p.startsWith("business/") &&
                p.endsWith(".json") &&
                ![
                  "business/config.json",
                  "business/compatibility.json",
                ].includes(p),
            )
            .map((p) => p.slice(9, -5)),
          fields: draft.workflowRules ?? [],
          ...(extensions
            ? {
                actions: extensions.actions ?? [],
                actionFields: extensions.fields ?? [],
                cases: extensions.cases ?? [],
              }
            : {}),
        }
      : null;
  const requirements = rows(draft.requirements).map((r) => {
    const expectations: Row[] = [];
    const convert = (o: Row) => {
      if (o.kind === "backend") {
        expectations.push({ kind: "behavior" });
        return;
      }
      if (o.kind === "preserve-ui" || o.kind === "history") {
        expectations.push(o);
        return;
      }
      if (o.kind === "field") {
        const scenarios = rows(o.scenarios);
        const examples = scenarios.map((s) => {
          const action = rows(s.steps).find(
            (s) => s.kind === "action" && s.action === "complete",
          );
          const value = (action?.input as Row | undefined)?.[String(o.field)];
          return value ?? s.value;
        });
        expectations.push({
          kind: "field",
          field: o.field,
          initial: o.initial,
          ...(examples.length ? { examples } : {}),
        });
        return;
      }
      if (o.kind === "assertion") {
        let state = "open";
        let edit: Row = {};
        let lastAction: Row | undefined;
        for (const step of [...rows(o.steps), o.expected as Row]) {
          if (step.kind === "action") {
            lastAction = step;
            if (step.action === "complete") state = "done";
            if (step.action === "reopen") state = "open";
            continue;
          }
          if (step.kind === "edit") {
            const { kind: _kind, ...values } = step;
            edit = { ...edit, ...values };
            continue;
          }
          if (step.kind === "field") {
            const existing = expectations.find(
              (e) => e.kind === "field" && e.field === step.field,
            );
            if (existing) {
              const examples = (existing.examples ?? []) as unknown[];
              if (!examples.includes(step.value))
                existing.examples = [...examples, step.value];
            } else
              expectations.push({
                kind: "field",
                field: step.field,
                initial: { kind: "baseline" },
                examples: [step.value],
              });
            continue;
          }
          if (step.kind === "action-visible") {
            expectations.push({ ...step, state });
            continue;
          }
          if (step.kind === "error") {
            expectations.push({
              kind: "error",
              action: lastAction?.action,
              text: step.text,
            });
            continue;
          }
          if (step.kind === "task") {
            expectations.push({
              kind: Object.keys(edit).length ? "edit-task" : "task",
              ...edit,
            });
            continue;
          }
          if (!["open", "refresh", "restart"].includes(String(step.kind)))
            expectations.push({ kind: "unsupported", original: step });
        }
        return;
      }
      expectations.push(o);
    };
    rows(r.obligations).forEach(convert);
    const invalidChecks = rows(r.checks).filter((c) => {
      if (c.kind === "workflow" || c.kind === "enabled")
        return (
          c.index !== undefined &&
          (!Number.isInteger(c.index) || Number(c.index) < 1)
        );
      const catalog =
        c.kind === "member"
          ? cases
          : c.kind === "action"
            ? rows(extensions?.cases)
            : [];
      return (
        !Number.isInteger(c.index) ||
        Number(c.index) < 1 ||
        Number(c.index) > catalog.length
      );
    });
    const source = sources[Number(r.source) - 1];
    return {
      description: r.description,
      quote: r.sourceQuote,
      type: r.type,
      expectations,
      ...(!source || !source.text.includes(String(r.sourceQuote))
        ? { invalidSource: r.source }
        : {}),
      ...(invalidChecks.length ? { checks: invalidChecks } : {}),
    };
  });
  const known = new Set([
    "requirements",
    "workflowRules",
    "summary",
    "changes",
    "outcome",
    "dataImpact",
    "excluded",
    "capabilityChanges",
    "requiredCapabilities",
    "writableScope",
    "compatibility",
    "dependencies",
    "intent",
    "acceptanceReason",
    "memberAdditions",
    "memberUpgrades",
    "memberEnabled",
    "memberCases",
    "extensions",
  ]);
  const orphaned = cases.filter(
    (c) => !members.some((m) => m.pluginId === c.member),
  );
  return targetFixture({
    summary: draft.summary,
    workflow,
    members,
    requirements,
    ...(orphaned.length ? { memberCases: orphaned } : {}),
    ...(Array.isArray(draft.dependencies) && draft.dependencies.length
      ? { dependencies: draft.dependencies }
      : {}),
    ...(draft.intent ? { intent: draft.intent } : {}),
    ...(draft.acceptanceReason
      ? { acceptanceReason: draft.acceptanceReason }
      : {}),
    uses: rows(draft.requiredCapabilities).map((c) => ({
      member: c.providerId,
      feature: feature(c.interfaceId),
    })),
    ...Object.fromEntries(
      Object.entries(draft).filter(([key]) => !known.has(key)),
    ),
  });
}

/** Test-only migration. Production has exactly one target-based write contract. */
export function targetFixture(input: Record<string, unknown>): Record<string, unknown> {
  const { workflow, members, ...rest } = input;
  return { ...rest, changes: [
    ...(workflow ? [{ target: "workflow", ...(workflow as Record<string, unknown>) }] : []),
    ...((members ?? []) as Record<string, unknown>[]).map(({ operation, pluginId, ...change }) => ({
      target: pluginId,
      ...(operation === "enable" || operation === "disable" ? { enabled: operation === "enable" } : change),
    })),
  ] };
}
