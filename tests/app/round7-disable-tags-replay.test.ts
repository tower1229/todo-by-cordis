import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  compileReferences,
  inheritBrowserCases,
} from "../../src/evolution/references.js";
import {
  dedupeBrowserCases,
  remapBrowserChecks,
  browserCaseContentHash,
} from "../../src/evolution/browser-case-content.js";
import { planningStructureTerminal } from "../../src/evolution/historical-preparation.js";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";
import type { AcceptanceObligation } from "../../src/shared/acceptance-obligations.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import type {
  Requirement,
  RequirementGate,
} from "../../src/shared/assistant.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import { v1Requests } from "../../scripts/lib/v1-scenario.js";
import { hash } from "../../src/release/storage.js";

const outcomePath = new URL(
  "../../docs/reports/r11-20261104/bounded-probe-beca405-outcome.json",
  import.meta.url,
);

type BrowserCaseRow = {
  id: string;
  task: string;
  steps: unknown;
  prepare?: unknown;
  classification?: string;
  obligationId?: string;
};

type CompiledPlan = {
  requirements: Requirement[];
  browserCases: BrowserCaseRow[];
};

type InheritedAcceptance = {
  memberCases: MemberAcceptanceCase[];
  requirements: Requirement[];
  browserCases: BrowserCaseRow[];
  requirementGate: RequirementGate;
  fieldIdentities: {
    member: string;
    field: string;
    label: string;
    contribution: string;
  }[];
  uiContributions: {
    id: string;
    providerId: string;
    fields: { key: string }[];
    actions: { commandId: string }[];
  }[];
  baseVersion: string;
};

type Draft = {
  workflowRules: { key: string; required?: boolean; minLength?: number; maxLength?: number }[];
  memberCases: MemberAcceptanceCase[];
  browserCases: unknown[];
  memberEnabled?: { pluginId: string; enabled: boolean };
  requirements: {
    id: string;
    source: number;
    sourceQuote: string;
    description: string;
    type: string;
    checks: { kind: string; index?: number }[];
    obligations: Record<string, unknown>[];
  }[];
};

const tagCases: MemberAcceptanceCase[] = [
  {
    member: "tags",
    name: "save",
    state: "open",
    fields: {},
    action: "setTag",
    input: { tag: " Alpha " },
    expected: { kind: "commit", state: "open", fields: { tag: "Alpha" } },
  },
  {
    member: "tags",
    name: "overwrite",
    state: "open",
    fields: { tag: "Alpha" },
    action: "setTag",
    input: { tag: " Beta " },
    expected: { kind: "commit", state: "open", fields: { tag: "Beta" } },
  },
];
const tagLowerCases: MemberAcceptanceCase[] = [
  { ...tagCases[0], expected: { kind: "commit", state: "open", fields: { tag: "alpha" } } },
  { ...tagCases[1], expected: { kind: "commit", state: "open", fields: { tag: "beta" } } },
];
const counterCases: MemberAcceptanceCase[] = [
  {
    member: "counter",
    name: "increment",
    state: "open",
    fields: {},
    action: "increment",
    input: {},
    expected: { kind: "commit", state: "open", fields: { count: "1" } },
  },
  {
    member: "counter",
    name: "increment-again",
    state: "open",
    fields: { count: "1" },
    action: "increment",
    input: {},
    expected: { kind: "commit", state: "open", fields: { count: "2" } },
  },
];

const ui = {
  tags: {
    id: "tag-detail",
    providerId: "tags",
    fields: [{ key: "tag" }],
    actions: [{ commandId: "setTag" }],
  },
  counter: {
    id: "count-detail",
    providerId: "counter",
    fields: [{ key: "count" }],
    actions: [{ commandId: "increment" }],
  },
};

function workflow(fields: { key: string }[] = []) {
  return {
    id: "default",
    fields,
    actions: [{ id: "complete" }, { id: "reopen" }],
  };
}

function gate(
  sources: RequirementGate["sources"],
  requirements: Requirement[],
): RequirementGate {
  return {
    gateVersion: "fixture",
    sources,
    requestHash: hash(sources.map((s) => s.id)).padEnd(64, "0").slice(0, 64),
    definitionHash: "b".repeat(64),
    review: { reviewedIds: requirements.map((r) => r.id), issues: [] },
    coverage: requirements.map((r) => ({ requirementId: r.id, reasons: [] })),
    seal: "c".repeat(64),
  };
}

function blockedRunFromOutcome(raw: unknown) {
  if (!raw || typeof raw !== "object") throw new Error("outcome 不是对象");
  const diagnostic = (raw as { stop?: { diagnostic?: unknown } }).stop?.diagnostic;
  if (typeof diagnostic !== "string") throw new Error("缺少 stop.diagnostic");
  const json = diagnostic.split("\n\n")[0];
  return JSON.parse(json) as {
    request: string;
    diagnostics?: string[];
    message?: string;
    status?: string;
    stop?: { code?: string };
    plans?: unknown[];
    evidence?: { ref: string; hash: string }[];
  };
}

const workflowCases = [
  {
    given: "未完成任务",
    when: "完成",
    then: "进入已完成",
    checker: "workflow/1",
  },
];

function compileStep(
  draft: Draft,
  sources: RequirementGate["sources"],
  inherited: InheritedAcceptance,
  reason: string | undefined,
  fields: { key: string }[] = [],
) {
  const compiled = compileReferences(
    draft,
    sources,
    fields.length ? workflowCases : [],
    workflow(fields),
    inherited,
  ) as CompiledPlan;
  let compileDiagnostic: string | undefined;
  try {
    parseBrowserCases(compiled.browserCases);
  } catch (error) {
    compileDiagnostic = error instanceof Error ? error.message : String(error);
  }
  const merged = inheritBrowserCases(compiled, inherited, reason);
  const { cases, aliases } = dedupeBrowserCases(merged.browserCases);
  const requirements = compiled.requirements.map((r) => ({
    ...r,
    checks: remapBrowserChecks(r.checks, aliases),
  }));
  return {
    compiled,
    merged,
    cases,
    aliases,
    requirements,
    compileDiagnostic,
  };
}

function assertNoDanglingBrowserChecks(
  requirements: Requirement[],
  browserCases: BrowserCaseRow[],
  aliases: Map<string, string>,
) {
  const dangling = requirements.flatMap((r) =>
    r.checks
      .filter(
        (c) =>
          c.checker === "browser/1" &&
          !browserCases.some((b) => b.id === c.caseId),
      )
      .map((c) => `${r.id}:${c.caseId}`),
  );
  assert.deepEqual(dangling, [], `悬空案例引用: ${dangling.join(",")}`);
  const missingGenerated = requirements.flatMap((r) =>
    (r.obligations ?? []).flatMap((o) =>
      obligationCases(o)
        .filter((c) => {
          const survivor =
            browserCases.find((b) => b.id === c.id) ??
            (aliases.has(c.id)
              ? browserCases.find((b) => b.id === aliases.get(c.id))
              : undefined);
          return !survivor;
        })
        .map((c) => `${r.id}:${o.kind}:${c.id}`),
    ),
  );
  assert.deepEqual(
    missingGenerated,
    [],
    `义务生成案例缺失且无内容等价别名: ${missingGenerated.join(",")}`,
  );
  for (const [dropped, kept] of aliases) {
    const survivor = browserCases.find((b) => b.id === kept);
    const generated = requirements
      .flatMap((r) => r.obligations ?? [])
      .flatMap((o) => obligationCases(o))
      .find((c) => c.id === dropped);
    assert.ok(survivor, `别名目标不存在: ${dropped}→${kept}`);
    if (generated)
      assert.equal(
        browserCaseContentHash(survivor),
        browserCaseContentHash(generated),
        `别名 ${dropped}→${kept} 必须指向内容等价存活案例`,
      );
  }
}

function assertClosedCompile(
  label: string,
  step: ReturnType<typeof compileStep>,
) {
  assert.equal(
    step.compileDiagnostic,
    undefined,
    `${label} compileReferences 后 parseBrowserCases 失败: ${step.compileDiagnostic}（${step.compiled.browserCases.length} 条）`,
  );
  assert.ok(
    step.compiled.browserCases.length <= 30,
    `${label} compileReferences 输出 ${step.compiled.browserCases.length} > 30`,
  );
  assert.doesNotThrow(() => parseBrowserCases(step.compiled.browserCases));
  assert.ok(
    step.cases.length <= 30,
    `${label} inherit+dedupe 后 ${step.cases.length} > 30`,
  );
  assert.doesNotThrow(() => parseBrowserCases(step.cases));
  assert.deepEqual(step.merged.blockers, [], `${label} inherit blockers`);
  assertNoDanglingBrowserChecks(
    step.compiled.requirements,
    step.compiled.browserCases,
    new Map(),
  );
  assertNoDanglingBrowserChecks(step.requirements, step.cases, step.aliases);
  assert.equal(
    !step.compileDiagnostic ||
      planningStructureTerminal({
        historical: false,
        structural: true,
        rejectionSeen: false,
        calls: 2,
        callLimit: 12,
      }),
    true,
    `${label} 不得留下可重试的 plan-compilation（会把 planning 推到 3）`,
  );
}

function freeze(
  compiled: CompiledPlan,
  memberCases: MemberAcceptanceCase[],
  sources: RequirementGate["sources"],
  identities: InheritedAcceptance["fieldIdentities"],
  contributions: InheritedAcceptance["uiContributions"],
  baseVersion: string,
): InheritedAcceptance {
  return {
    memberCases,
    requirements: compiled.requirements,
    browserCases: compiled.browserCases,
    requirementGate: gate(sources, compiled.requirements),
    fieldIdentities: identities,
    uiContributions: contributions,
    baseVersion,
  };
}

function withDistinctFieldCopies(
  inherited: InheritedAcceptance,
  copies: number,
): InheritedAcceptance {
  const seen = new Set<string>();
  const fields = inherited.requirements.flatMap((r) =>
    (r.obligations ?? []).filter(
      (o): o is Extract<AcceptanceObligation, { kind: "field" }> => {
        if (o.kind !== "field" || o.member === "workflow") return false;
        const key = `${o.member}:${o.field}:${o.contribution ?? ""}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      },
    ),
  );
  const extras: Requirement[] = [];
  const extraCases: BrowserCaseRow[] = [];
  for (const [index, field] of fields.entries()) {
    for (let copy = 1; copy <= copies; copy++) {
      const clone = {
        ...structuredClone(field),
        id: `obligation-${hash({ field: field.id, copy }).slice(0, 24)}`,
      };
      const generated = obligationCases(clone);
      extraCases.push(...generated);
      extras.push({
        id: `dup-${index}-${copy}`,
        description: `投影副本 ${copy}`,
        sourceRevision: inherited.requirementGate.sources.at(-1)?.id ?? "request:1",
        sourceQuote: "保留已有行为",
        type: "behavior",
        checks: generated.map((c) => ({ checker: "browser/1", caseId: c.id })),
        obligations: [clone],
      });
    }
  }
  return {
    ...inherited,
    requirements: [...inherited.requirements, ...extras],
    browserCases: [...inherited.browserCases, ...extraCases],
  };
}

function backendRequirement(
  id: string,
  source: number,
  quote: string,
  checks: { kind: string; index?: number }[],
) {
  return {
    id,
    source,
    sourceQuote: quote,
    description: quote,
    type: "behavior",
    checks,
    obligations: [{ kind: "backend" } as Record<string, unknown>],
  };
}

test("beca405 outcome 阻塞在 v1Requests[4] 的 33>30 plan-compilation", () => {
  const outcome = JSON.parse(readFileSync(outcomePath, "utf8")) as {
    commit: string;
    progress?: { browserCasesCapExceededReappeared?: boolean };
  };
  const run = blockedRunFromOutcome(
    JSON.parse(readFileSync(outcomePath, "utf8")),
  );
  assert.equal(run.request, v1Requests[4]);
  assert.equal(run.status, "blocked");
  assert.equal(run.stop?.code, "plan-compilation");
  assert.deepEqual(run.plans, []);
  assert.match(
    `${run.diagnostics?.[0] ?? ""}${run.message ?? ""}`,
    /浏览器验收案例超出上限：33 条，最多 30 条/,
  );
  assert.equal(outcome.progress?.browserCasesCapExceededReappeared, true);
  assert.ok(
    run.evidence?.some((e) => e.ref.startsWith("member-acceptance/tags@")),
    "阻塞 run 带 tags 成员验收哈希，但没有 propose_plan 草案，不能直接重放 33 条提案",
  );
});

test("v1Requests 0→4 冻结验收零模型链：停用标签编译 ≤30、无悬空、不可重试第三次规划", () => {
  const sources0: RequirementGate["sources"] = [
    { id: "request:1", text: v1Requests[0] },
  ];
  const step0 = compileStep(
    {
      workflowRules: [],
      memberCases: tagCases,
      browserCases: [],
      requirements: [
        backendRequirement("tags-request", 1, v1Requests[0], [
          { kind: "member", index: 1 },
          { kind: "member", index: 2 },
        ]),
      ],
    },
    sources0,
    {
      memberCases: [],
      requirements: [],
      browserCases: [],
      requirementGate: gate(sources0, []),
      fieldIdentities: [
        { member: "tags", field: "tag", label: "标签", contribution: "tag-detail" },
      ],
      uiContributions: [ui.tags],
      baseVersion: "a".repeat(64),
    },
    undefined,
  );
  assertClosedCompile("step0-tags", step0);
  const inherited0 = freeze(
    { requirements: step0.requirements, browserCases: step0.cases },
    tagCases,
    sources0,
    [{ member: "tags", field: "tag", label: "标签", contribution: "tag-detail" }],
    [ui.tags],
    "a".repeat(64),
  );

  const sources1 = [...sources0, { id: "request:2", text: v1Requests[1] }];
  const inherited0WithCounterUi: InheritedAcceptance = {
    ...inherited0,
    fieldIdentities: [
      ...inherited0.fieldIdentities,
      { member: "counter", field: "count", label: "计数", contribution: "count-detail" },
    ],
    uiContributions: [...inherited0.uiContributions, ui.counter],
  };
  const step1 = compileStep(
    {
      workflowRules: [],
      memberCases: [...tagCases, ...counterCases],
      browserCases: [],
      requirements: [
        backendRequirement("counter-request", 2, v1Requests[1], [
          { kind: "member", index: 3 },
          { kind: "member", index: 4 },
        ]),
        backendRequirement("counter-preserve-tags", 2, "已有标签不变", [
          { kind: "member", index: 1 },
          { kind: "member", index: 2 },
        ]),
      ],
    },
    sources1,
    inherited0WithCounterUi,
    undefined,
  );
  assertClosedCompile("step1-counter", step1);
  const inherited1 = freeze(
    { requirements: step1.requirements, browserCases: step1.cases },
    [...tagCases, ...counterCases],
    sources1,
    [
      { member: "tags", field: "tag", label: "标签", contribution: "tag-detail" },
      { member: "counter", field: "count", label: "计数", contribution: "count-detail" },
    ],
    [ui.tags, ui.counter],
    "b".repeat(64),
  );

  const sources2 = [...sources1, { id: "request:3", text: v1Requests[2] }];
  const step2 = compileStep(
    {
      workflowRules: [],
      memberCases: [...tagLowerCases, ...counterCases],
      browserCases: [],
      requirements: [
        {
          ...backendRequirement("tags-request", 3, v1Requests[2], [
            { kind: "member", index: 1 },
            { kind: "member", index: 2 },
          ]),
          obligations: [
            { kind: "backend" },
            {
              kind: "field",
              field: "tag",
              initial: { kind: "baseline" },
              scenarios: [
                {
                  steps: [{ kind: "action", action: "setTag", input: { tag: " Alpha " } }],
                  value: "alpha",
                },
                {
                  steps: [
                    { kind: "action", action: "setTag", input: { tag: " Alpha " } },
                    { kind: "action", action: "setTag", input: { tag: " Beta " } },
                  ],
                  value: "beta",
                },
              ],
            },
          ],
        },
      ],
    },
    sources2,
    inherited1,
    "用户要求标签统一小写",
  );
  assertClosedCompile("step2-lowercase", step2);
  const inherited2 = freeze(
    { requirements: step2.requirements, browserCases: step2.cases },
    [...tagLowerCases, ...counterCases],
    sources2,
    inherited1.fieldIdentities,
    inherited1.uiContributions,
    "c".repeat(64),
  );

  const reviewRule = {
    key: "review",
    required: true,
    minLength: 1,
    maxLength: 5000,
  };
  const sources3 = [...sources2, { id: "request:4", text: v1Requests[3] }];
  const step3 = compileStep(
    {
      workflowRules: [reviewRule],
      memberCases: [...tagLowerCases, ...counterCases],
      browserCases: [],
      requirements: [
        backendRequirement("review-request", 4, v1Requests[3], [
          { kind: "workflow" },
        ]),
      ],
    },
    sources3,
    inherited2,
    "用户新增必填复盘，原可选完成按完整输入规则更新",
    [{ key: "review" }],
  );
  assertClosedCompile("step3-review", step3);
  const inherited3 = freeze(
    { requirements: step3.requirements, browserCases: step3.cases },
    [...tagLowerCases, ...counterCases],
    sources3,
    inherited2.fieldIdentities,
    inherited2.uiContributions,
    "d".repeat(64),
  );

  const sources4 = [...sources3, { id: "request:5", text: v1Requests[4] }];
  const step4 = compileStep(
    {
      workflowRules: [reviewRule],
      memberCases: counterCases,
      browserCases: [],
      memberEnabled: { pluginId: "tags", enabled: false },
      requirements: [
        backendRequirement("disable-tags", 5, v1Requests[4], [
          { kind: "enabled" },
        ]),
      ],
    },
    sources4,
    inherited3,
    "停用标签插件，保留已有标签数据和计数、复盘功能",
    [{ key: "review" }],
  );
  assertClosedCompile("step4-disable-tags", step4);
  assert.ok(
    step4.compiled.browserCases.length >= 8,
    `停用标签编译应继承多插件义务，不能只剩启停检查：${step4.compiled.browserCases.length}`,
  );
  assert.ok(
    step4.compiled.requirements.some((r) => r.id === "disable-tags"),
    "停用标签要求必须进入编译结果",
  );
  assert.ok(
    inherited3.requirements.some((r) => r.sourceQuote === v1Requests[3]) ||
      step4.compiled.requirements.some((r) => r.sourceQuote === v1Requests[3]),
    "复盘义务必须仍被继承或保留",
  );

  const leaked = withDistinctFieldCopies(inherited3, 3);
  const rawLeaked = leaked.requirements.flatMap((r) =>
    (r.obligations ?? []).flatMap((o) => obligationCases(o)),
  );
  assert.ok(
    rawLeaked.length > 30,
    `同字段不同义务 ID 的原始投影应超过 30 才能回归 round-7：${rawLeaked.length}`,
  );
  const stepLeak = compileStep(
    {
      workflowRules: [reviewRule],
      memberCases: counterCases,
      browserCases: [],
      memberEnabled: { pluginId: "tags", enabled: false },
      requirements: [
        backendRequirement("disable-tags", 5, v1Requests[4], [
          { kind: "enabled" },
        ]),
      ],
    },
    sources4,
    leaked,
    "停用标签插件，保留已有标签数据和计数、复盘功能",
    [{ key: "review" }],
  );
  assertClosedCompile("step4-distinct-obligation-ids", stepLeak);
});
