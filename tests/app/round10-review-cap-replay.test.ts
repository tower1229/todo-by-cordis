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
import { PlanStructureBlocked } from "../../src/evolution/historical-preparation.js";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";
import type { Requirement } from "../../src/shared/assistant.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import { v1Requests } from "../../scripts/lib/v1-scenario.js";
import { hash } from "../../src/release/storage.js";

const definitionPath = new URL(
  "../../tests/fixtures/round10-phase2-plan-definition.json",
  import.meta.url,
);
const contractPath = new URL(
  "../../tests/fixtures/round10-phase2-active-contract.json",
  import.meta.url,
);
const plansPath = new URL(
  "../../tests/fixtures/round10-review-propose-plans.json",
  import.meta.url,
);
const outcomePath = new URL(
  "../../docs/reports/r11-20261104/bounded-probe-bdba58e-outcome.json",
  import.meta.url,
);

const ROUND10_BASE =
  "f36915efc7023d449c78cbaadbf9a8f016e2e8baa168d3519ed2325a39bdb1e6";

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

const workflowCases = [
  {
    given: "未完成任务",
    when: "完成",
    then: "进入已完成",
    checker: "workflow/1",
  },
];

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

function context(
  acceptance: Record<string, unknown>,
  contract: Record<string, unknown>,
) {
  return {
    pluginId: "default",
    capabilities: [],
    members: [
      {
        pluginId: "default",
        role: "workflow" as const,
        enabled: true,
        versionId: "wf",
      },
      {
        pluginId: "tags",
        role: "auxiliary" as const,
        enabled: true,
        versionId: "tags-v",
      },
      {
        pluginId: "counter",
        role: "auxiliary" as const,
        enabled: true,
        versionId: "counter-v",
      },
    ],
    files: {
      "active-contract": {
        hash: "c",
        content: JSON.stringify(contract),
      },
      "active-acceptance": {
        hash: "a",
        content: JSON.stringify(acceptance),
      },
    },
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

function compileReviewProposal(proposal: unknown) {
  const frozen = JSON.parse(readFileSync(definitionPath, "utf8")) as {
    baseVersion: string;
    definition: {
      requirements: Requirement[];
      browserCases: BrowserCaseRow[];
      memberCases: unknown[];
      requirementGate?: unknown;
      workflowRules?: unknown[];
    };
    requirementGate: unknown;
  };
  const contract = JSON.parse(readFileSync(contractPath, "utf8")) as Record<
    string,
    unknown
  >;
  const inherited = {
    memberCases: frozen.definition.memberCases,
    requirements: frozen.definition.requirements,
    browserCases: frozen.definition.browserCases,
    requirementGate: frozen.requirementGate ?? frozen.definition.requirementGate,
    fieldIdentities: [
      {
        member: "tags",
        field: "tags",
        label: "标签",
        contribution: "tags-detail",
      },
      {
        member: "counter",
        field: "count",
        label: "计数",
        contribution: "count-detail",
      },
    ],
    uiContributions: [ui.tags, ui.counter],
    baseVersion: frozen.baseVersion,
    rules: frozen.definition.workflowRules ?? [],
  };
  const sources = [
    { id: "request:1", text: v1Requests[0] },
    { id: "request:2", text: v1Requests[1] },
    { id: "request:3", text: v1Requests[2] },
    { id: "request:4", text: v1Requests[3] },
  ];
  const ctx = context(
    {
      rules: inherited.rules,
      requirements: inherited.requirements,
      memberCases: inherited.memberCases,
      browserCases: inherited.browserCases,
    },
    contract,
  );
  const draft = compilePlanInput(proposal, ctx, sources);
  const withReason = {
    ...draft,
    acceptanceReason:
      (draft as { acceptanceReason?: string }).acceptanceReason ??
      "用户新增必填复盘，已有标签与计数期望按兼容说明保留",
  };
  const workflow = {
    id: "default",
    fields: [{ key: "review" }],
    actions: [
      { id: "complete" },
      { id: "reopen" },
    ],
  };
  const compiled = compileReferences(
    { ...withReason, memberCases: inherited.memberCases },
    sources,
    workflowCases,
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
    withReason.acceptanceReason,
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
    inheritedCount: inherited.browserCases.length,
    compiled,
    merged,
    cases,
    aliases,
    requirements,
  };
}

test("bdba58e outcome 阻塞在复盘步 plan-compilation 的 33>30", () => {
  const outcome = JSON.parse(readFileSync(outcomePath, "utf8")) as {
    tipSha?: string;
    progress?: { browserCasesCapExceededReappeared?: boolean };
    stop?: { message?: string; code?: string };
  };
  assert.equal(outcome.tipSha, "bdba58eda1ffa1f2596a1c99afc132fccf673cec");
  assert.equal(outcome.stop?.code, "plan-compilation");
  assert.match(
    outcome.stop?.message ?? "",
    /浏览器验收案例超出上限：33 条，最多 30 条/,
  );
  assert.equal(outcome.progress?.browserCasesCapExceededReappeared, true);
  const frozen = JSON.parse(readFileSync(definitionPath, "utf8")) as {
    baseVersion: string;
    definition: { browserCases: unknown[] };
  };
  assert.equal(frozen.baseVersion, ROUND10_BASE);
  assert.equal(frozen.definition.browserCases.length, 23);
});

test("round-10 call-565 复盘提案对 phase-2 冻结验收：≤30、无悬空、不抬上限", () => {
  const plans = JSON.parse(readFileSync(plansPath, "utf8")) as {
    calls: Record<string, { uniqueProposePlans: unknown[] }>;
  };
  const proposal = plans.calls["565"].uniqueProposePlans[0];
  assert.ok(proposal, "fixture 必须包含 call-565 propose_plan");

  let step: ReturnType<typeof compileReviewProposal>;
  try {
    step = compileReviewProposal(proposal);
  } catch (error) {
    assert.fail(
      `真实复盘提案应可编译闭合，不应再抛 ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  assert.equal(step.inheritedCount, 23);
  assert.ok(
    step.compiled.browserCases.length <= 30,
    `compileReferences 输出 ${step.compiled.browserCases.length} > 30`,
  );
  assert.doesNotThrow(() => parseBrowserCases(step.compiled.browserCases));
  assert.ok(
    step.cases.length <= 30,
    `inherit+dedupe 后 ${step.cases.length} > 30`,
  );
  assert.doesNotThrow(() => parseBrowserCases(step.cases));
  assert.deepEqual(step.merged.blockers, []);
  assertNoDanglingBrowserChecks(
    step.compiled.requirements,
    step.compiled.browserCases,
    new Map(),
  );
  assertNoDanglingBrowserChecks(step.requirements, step.cases, step.aliases);
  assert.ok(
    step.cases.some((c) => c.id.startsWith("ui-identity-")),
    "preserve-ui 必须落到规范 ui-identity",
  );
  assert.ok(
    step.cases.some(
      (c) =>
        c.id.includes("review") ||
        JSON.stringify(c.steps).includes('"review"'),
    ),
    "复盘字段案例必须进入浏览器清单",
  );
  // Over-cap remains a structural hard stop if a future regression exceeds 30.
  assert.throws(
    () =>
      parseBrowserCases(
        Array.from({ length: 33 }, (_, i) => ({
          id: `x-${i}`,
          task: "new" as const,
          steps: [{ kind: "refresh" as const }],
        })),
      ),
    (error: unknown) => {
      assert.ok(error instanceof PlanStructureBlocked);
      return true;
    },
  );
  void hash;
});
