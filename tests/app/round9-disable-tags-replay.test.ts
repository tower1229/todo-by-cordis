import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compilePlanInput } from "../../src/evolution/plan-input.js";
import {
  compileReferences,
  inheritBrowserCases,
} from "../../src/evolution/references.js";
import {
  danglingBrowserChecks,
  dedupeBrowserCases,
  mergeBrowserCaseAliases,
  remapBrowserChecks,
} from "../../src/evolution/browser-case-content.js";
import { planningStructureTerminal } from "../../src/evolution/historical-preparation.js";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import type {
  Requirement,
  RequirementGate,
} from "../../src/shared/assistant.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import { v1Requests } from "../../scripts/lib/v1-scenario.js";
import { hash } from "../../src/release/storage.js";

const outcomePath = new URL(
  "../../docs/reports/r11-20261104/bounded-probe-97a95fd-outcome.json",
  import.meta.url,
);
const plansPath = new URL(
  "../../tests/fixtures/round9-disable-tags-propose-plans.json",
  import.meta.url,
);

const ROUND9_BASE =
  "772fee6c8340b3ded3a81d4fc4739a762a55d030f240d325db767a9e4285e147";

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

const workflowBase = {
  id: "default",
  name: "默认",
  version: "1",
  initialState: "open",
  fields: [] as { key: string; label?: string }[],
  states: {
    open: { label: "未完成", category: "open" },
    done: { label: "已完成", category: "done" },
  },
  actions: [
    { id: "complete", label: "完成", from: ["open"] },
    { id: "reopen", label: "重新打开", from: ["done"] },
  ],
};

const ui = {
  tags: {
    id: "tags-detail",
    providerId: "tags",
    fields: [{ key: "tags" }],
    actions: [{ commandId: "setTags" }],
  },
  counter: {
    id: "count-detail",
    providerId: "counter",
    fields: [{ key: "count" }],
    actions: [{ commandId: "increment" }],
  },
};

const tagCases = [
  {
    name: "标签去空格",
    state: "open",
    fields: {},
    action: "setTags",
    input: { tags: "  Hello " },
    expected: { kind: "commit", state: "open", fields: { tags: "Hello" } },
  },
  {
    name: "空白标签拒绝",
    state: "open",
    fields: {},
    action: "setTags",
    input: { tags: "   " },
    expected: { kind: "reject" },
  },
  {
    name: "标签覆盖",
    state: "open",
    fields: { tags: "Hello" },
    action: "setTags",
    input: { tags: "  World " },
    expected: { kind: "commit", state: "open", fields: { tags: "World" } },
  },
];
const tagLower = tagCases.map((c) =>
  c.expected.kind === "commit"
    ? {
        ...c,
        expected: {
          ...c.expected,
          fields: Object.fromEntries(
            Object.entries(c.expected.fields).map(([k, v]) => [
              k,
              typeof v === "string" ? v.toLowerCase() : v,
            ]),
          ),
        },
      }
    : c,
);
const counterCases = [
  {
    name: "计数增加",
    state: "open",
    fields: {},
    action: "increment",
    input: {},
    expected: { kind: "commit", state: "open", fields: { count: "1" } },
  },
  {
    name: "再加一",
    state: "open",
    fields: { count: "1" },
    action: "increment",
    input: {},
    expected: { kind: "commit", state: "open", fields: { count: "2" } },
  },
  {
    name: "完成后拒绝计数",
    state: "done",
    fields: {},
    action: "increment",
    input: {},
    expected: { kind: "reject" },
  },
];

const reviewRule = {
  key: "review",
  label: "复盘",
  required: true,
  minLength: 1,
  maxLength: 5000,
};

const workflowCases = [
  {
    given: "未完成任务",
    when: "完成",
    then: "进入已完成",
    checker: "workflow/1",
  },
];

function members(enabledTags = true) {
  return [
    {
      pluginId: "default",
      role: "workflow" as const,
      enabled: true,
      versionId: "wf",
    },
    {
      pluginId: "tags",
      role: "auxiliary" as const,
      enabled: enabledTags,
      versionId: "tags-v",
    },
    {
      pluginId: "counter",
      role: "auxiliary" as const,
      enabled: true,
      versionId: "counter-v",
    },
  ];
}

function context(
  acceptance: Record<string, unknown>,
  contractFields: { key: string; label?: string }[] = [],
  enabledTags = true,
) {
  return {
    pluginId: "default",
    capabilities: [],
    members: members(enabledTags),
    files: {
      "active-contract": {
        hash: "c",
        content: JSON.stringify({ ...workflowBase, fields: contractFields }),
      },
      "active-acceptance": {
        hash: "a",
        content: JSON.stringify(acceptance),
      },
    },
  };
}

function gate(
  sources: { id: string; text: string }[],
  requirements: { id: string }[],
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
  const diagnostic = (raw as { stop?: { diagnostic?: unknown } }).stop
    ?.diagnostic;
  if (typeof diagnostic !== "string") throw new Error("缺少 stop.diagnostic");
  const json = diagnostic.split("\n\n")[0];
  return JSON.parse(json) as {
    request: string;
    diagnostics?: string[];
    message?: string;
    status?: string;
    stop?: { code?: string };
    plans?: unknown[];
    protocolFailures?: {
      problems?: string[];
    }[];
    parentRunId?: string;
    baseVersion?: string;
    evidence?: { ref: string; hash: string }[];
  };
}

function assertNoDanglingBrowserChecks(
  requirements: Requirement[],
  browserCases: BrowserCaseRow[],
  aliases: Map<string, string>,
) {
  const dangling = danglingBrowserChecks(requirements, browserCases).map(
    (c) => c.caseId,
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
}

function compileProposal(
  proposal: unknown,
  sources: { id: string; text: string }[],
  inherited: {
    memberCases: unknown[];
    requirements: unknown[];
    browserCases: unknown[];
    requirementGate?: unknown;
    fieldIdentities: unknown[];
    uiContributions: unknown[];
    baseVersion: string;
    rules?: unknown[];
  },
  contractFields: { key: string; label?: string }[] = [],
  enabledTags = true,
  reason?: string,
) {
  const ctx = context(
    {
      rules: inherited.rules ?? [],
      requirements: inherited.requirements,
      memberCases: inherited.memberCases,
      browserCases: inherited.browserCases,
    },
    contractFields,
    enabledTags,
  );
  const draft = compilePlanInput(proposal, ctx, sources);
  const workflow = {
    id: "default",
    fields: contractFields,
    actions: workflowBase.actions.map((a) => ({ id: a.id })),
  };
  const submitted = (draft as { memberCases?: { member: string; name: string }[] })
    .memberCases;
  const mergedMemberCases = submitted?.length
    ? [
        ...(inherited.memberCases as { member: string; name: string }[]).filter(
          (old) =>
            !submitted.some(
              (c) => c.member === old.member && c.name === old.name,
            ),
        ),
        ...submitted,
      ]
    : inherited.memberCases;
  const compiled = compileReferences(
    { ...draft, memberCases: mergedMemberCases },
    sources,
    contractFields.length ? workflowCases : [],
    workflow,
    {
      memberCases: inherited.memberCases as never,
      requirements: inherited.requirements as never,
      browserCases: inherited.browserCases as never,
      requirementGate: inherited.requirementGate as never,
      fieldIdentities: inherited.fieldIdentities as never,
      uiContributions: inherited.uiContributions as never,
      baseVersion: inherited.baseVersion,
    },
  ) as CompiledPlan;
  parseBrowserCases(compiled.browserCases);
  const merged = inheritBrowserCases(
    compiled,
    inherited as never,
    reason ?? (draft as { acceptanceReason?: string }).acceptanceReason,
  );
  const { cases, aliases: contentAliases } = dedupeBrowserCases(
    merged.browserCases,
  );
  const aliases = mergeBrowserCaseAliases(merged.aliases, contentAliases);
  const requirements = compiled.requirements.map((r) => ({
    ...r,
    checks: remapBrowserChecks(r.checks, aliases),
  }));
  return {
    draft,
    compiled,
    merged,
    cases,
    aliases,
    requirements,
    memberCases: mergedMemberCases as MemberAcceptanceCase[],
  };
}

function freeze(
  step: ReturnType<typeof compileProposal>,
  sources: { id: string; text: string }[],
  identities: unknown[],
  contributions: unknown[],
  baseVersion: string,
  rules: unknown[] = [],
) {
  return {
    memberCases: step.memberCases,
    requirements: step.requirements,
    browserCases: step.cases,
    requirementGate: gate(sources, step.requirements),
    fieldIdentities: identities,
    uiContributions: contributions,
    baseVersion,
    rules,
  };
}

function assertClosedCompile(
  label: string,
  step: ReturnType<typeof compileProposal>,
) {
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
    planningStructureTerminal({
      historical: false,
      structural: true,
      rejectionSeen: false,
      calls: 2,
      callLimit: 12,
    }),
    true,
    `${label} 超限/悬空必须不可重试`,
  );
}

test("97a95fd outcome 阻塞在 disable-tags 的 32>30 plan-compilation，plans 为空", () => {
  const outcome = JSON.parse(readFileSync(outcomePath, "utf8")) as {
    tipSha?: string;
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
    /浏览器验收案例超出上限：32 条，最多 30 条/,
  );
  assert.equal(run.baseVersion, ROUND9_BASE);
  assert.equal(run.parentRunId, "33faa07f-4b8a-4df4-b062-a10f7bc0fa80");
  assert.ok(
    run.protocolFailures?.some((f) =>
      f.problems?.some((p) =>
        p.includes("requirements[1].acceptanceReason: 未授权字段"),
      ),
    ),
    "call 1 协议失败：requirements[1..3] 带未授权 acceptanceReason",
  );
  assert.equal(outcome.progress?.browserCasesCapExceededReappeared, true);
  assert.ok(
    run.evidence?.some((e) => e.ref.startsWith("member-acceptance/tags@")),
    "阻塞 run 带 tags 成员验收哈希，但没有 propose_plan 草案，32 条案例不在 plans 里",
  );
});

test("v1Requests 0→3 冻结后再编译 545 单条需求：≤30、无悬空、不抬上限", () => {
  const plans = JSON.parse(readFileSync(plansPath, "utf8")) as {
    calls: Record<
      string,
      { uniqueProposePlans: Record<string, unknown>[] }
    >;
  };
  const fourReq = plans.calls["545"].uniqueProposePlans[0];
  const singleReq = plans.calls["545"].uniqueProposePlans[1];
  assert.ok(fourReq && singleReq, "fixture 必须包含 545 的两条 unique 提案");

  const sources0 = [{ id: "request:1", text: v1Requests[0] }];
  const step0 = compileProposal(
    {
      intent: "improve",
      summary: v1Requests[0],
      changes: [
        {
          target: "tags",
          name: "标签",
          features: ["commands", "fields", "detail"],
          cases: tagCases,
        },
      ],
      requirements: [
        {
          quote: v1Requests[0],
          type: "behavior",
          expectations: [
            { kind: "behavior" },
            { kind: "field", field: "tags" },
            { kind: "preserve-ui" },
          ],
        },
      ],
    },
    sources0,
    {
      memberCases: [],
      requirements: [],
      browserCases: [],
      fieldIdentities: [
        {
          member: "tags",
          field: "tags",
          label: "标签",
          contribution: "tags-detail",
        },
      ],
      uiContributions: [ui.tags],
      baseVersion: "a".repeat(64),
      rules: [],
    },
  );
  assertClosedCompile("step0-tags", step0);
  const inherited0 = freeze(
    step0,
    sources0,
    [
      {
        member: "tags",
        field: "tags",
        label: "标签",
        contribution: "tags-detail",
      },
    ],
    [ui.tags],
    "a".repeat(64),
  );

  const sources1 = [...sources0, { id: "request:2", text: v1Requests[1] }];
  const inherited0b = {
    ...inherited0,
    fieldIdentities: [
      ...inherited0.fieldIdentities,
      {
        member: "counter",
        field: "count",
        label: "计数",
        contribution: "count-detail",
      },
    ],
    uiContributions: [ui.tags, ui.counter],
  };
  const step1 = compileProposal(
    {
      intent: "improve",
      summary: v1Requests[1],
      changes: [
        {
          target: "counter",
          name: "计数",
          features: ["commands", "fields", "detail"],
          cases: counterCases,
        },
      ],
      requirements: [
        {
          quote: v1Requests[1],
          type: "behavior",
          expectations: [
            { kind: "behavior" },
            { kind: "field", field: "count" },
            {
              kind: "action-visible",
              action: "increment",
              state: "open",
              visible: true,
            },
            {
              kind: "action-visible",
              action: "increment",
              state: "done",
              visible: false,
            },
            { kind: "operation-rejected", action: "increment" },
            { kind: "preserve-ui" },
            { kind: "history", field: "tags" },
          ],
        },
      ],
    },
    sources1,
    inherited0b,
    [],
    true,
    "新增计数插件，已有标签按原规则保留，并冻结标签历史数据",
  );
  assertClosedCompile("step1-counter", step1);
  const inherited1 = freeze(
    step1,
    sources1,
    inherited0b.fieldIdentities,
    inherited0b.uiContributions,
    "b".repeat(64),
  );

  const sources2 = [...sources1, { id: "request:3", text: v1Requests[2] }];
  const step2 = compileProposal(
    {
      intent: "improve",
      summary: v1Requests[2],
      acceptanceReason: "用户要求标签统一小写",
      changes: [
        {
          target: "tags",
          features: ["commands", "fields", "detail"],
          cases: tagLower,
        },
      ],
      requirements: [
        {
          quote: v1Requests[2],
          revises: v1Requests[0],
          type: "behavior",
          expectations: [
            { kind: "behavior" },
            { kind: "field", field: "tags" },
            { kind: "history", field: "tags" },
            { kind: "preserve-ui" },
          ],
        },
      ],
    },
    sources2,
    inherited1,
    [],
    true,
    "用户要求标签统一小写",
  );
  assertClosedCompile("step2-lowercase", step2);
  const inherited2 = freeze(
    step2,
    sources2,
    inherited1.fieldIdentities,
    inherited1.uiContributions,
    "c".repeat(64),
  );

  const sources3 = [...sources2, { id: "request:4", text: v1Requests[3] }];
  const step3 = compileProposal(
    {
      intent: "improve",
      summary: v1Requests[3],
      acceptanceReason: "用户新增必填复盘",
      changes: [{ target: "workflow", fields: [reviewRule] }],
      requirements: [
        {
          quote: v1Requests[3],
          type: "behavior",
          expectations: [
            { kind: "behavior" },
            {
              kind: "field",
              field: "review",
              examples: [
                "  复盘：沟通顺畅，按时交付  ",
                "已复盘：需求澄清耗时较长，下次提前对齐验收范围",
              ],
            },
            { kind: "preserve-ui" },
            { kind: "history", field: "tags" },
          ],
        },
      ],
    },
    sources3,
    inherited2,
    [{ key: "review" }],
    true,
    "用户新增必填复盘",
  );
  assertClosedCompile("step3-review", step3);
  const inherited3 = freeze(
    step3,
    sources3,
    [
      ...inherited2.fieldIdentities,
      { member: "workflow", field: "review", label: "复盘" },
    ],
    inherited2.uiContributions,
    ROUND9_BASE,
    [reviewRule],
  );

  const sources4 = [...sources3, { id: "request:5", text: v1Requests[4] }];
  assert.throws(
    () =>
      compilePlanInput(
        fourReq,
        context(
          {
            rules: inherited3.rules,
            requirements: inherited3.requirements,
            memberCases: inherited3.memberCases,
            browserCases: inherited3.browserCases,
          },
          [{ key: "review" }],
          false,
        ),
        sources4,
      ),
    /相同业务要求重复/,
  );

  const step4 = compileProposal(
    singleReq,
    sources4,
    inherited3,
    [{ key: "review" }],
    false,
  );
  assertClosedCompile("step4-545-single-req", step4);
  assert.ok(
    step4.compiled.browserCases.length >= 8,
    `停用标签编译应继承多插件义务，不能只剩启停检查：${step4.compiled.browserCases.length}`,
  );
  assert.ok(
    step4.compiled.browserCases.some((c) => c.id.startsWith("ui-identity-")),
    "preserve-ui 必须落到 ui-identity 规范 ID，而不是按义务 ID 再发一套",
  );
  assert.ok(
    step4.compiled.browserCases.some((c) => c.id.includes("historical-")),
    "tags 历史案例必须保留",
  );

  const inherited4 = freeze(
    step4,
    sources4,
    inherited3.fieldIdentities,
    inherited3.uiContributions,
    "e".repeat(64),
    inherited3.rules,
  );
  const sources5 = [...sources4, { id: "request:6", text: v1Requests[5] }];
  const step5 = compileProposal(
    {
      intent: "improve",
      summary: v1Requests[5],
      acceptanceReason: "重新启用标签插件，保留小写规则、已有数据、计数和复盘",
      changes: [{ target: "tags", enabled: true }],
      requirements: [
        {
          quote: v1Requests[5],
          type: "behavior",
          expectations: [
            { kind: "behavior" },
            { kind: "preserve-ui" },
            { kind: "history", field: "tags" },
            {
              kind: "action-visible",
              action: "increment",
              state: "open",
              visible: true,
            },
            {
              kind: "action-visible",
              action: "increment",
              state: "done",
              visible: false,
            },
            { kind: "operation-rejected", action: "increment" },
            {
              kind: "field",
              field: "review",
              examples: [
                "  复盘：沟通顺畅，按时交付  ",
                "已复盘：需求澄清耗时较长，下次提前对齐验收范围",
              ],
            },
          ],
        },
      ],
    },
    sources5,
    inherited4,
    [{ key: "review" }],
    false,
    "重新启用标签插件，保留小写规则、已有数据、计数和复盘",
  );
  assertClosedCompile("step5-reenable-tags", step5);
  assert.ok(
    step5.compiled.browserCases.length >= 8,
    `启用标签编译应恢复多插件义务：${step5.compiled.browserCases.length}`,
  );
  assert.ok(
    step5.compiled.browserCases.some((c) => c.id.startsWith("ui-identity-")),
    "启用后 preserve-ui 仍须落到 ui-identity 规范 ID",
  );
  assert.ok(
    step5.compiled.browserCases.some((c) => c.id.includes("historical-")),
    "启用后 tags 历史案例必须保留",
  );
});
