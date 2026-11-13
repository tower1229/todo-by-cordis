import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compilePlanInput } from "../../src/evolution/plan-input.js";
import {
  compileReferences,
  inheritBrowserCases,
} from "../../src/evolution/references.js";
import {
  classifyBrowserCaseAgainstSurface,
  danglingBrowserChecks,
  dedupeBrowserCases,
  mergeBrowserCaseAliases,
  remapBrowserChecks,
} from "../../src/evolution/browser-case-content.js";
import {
  PlanStructureBlocked,
  planningStructureTerminal,
} from "../../src/evolution/historical-preparation.js";
import { obligationCases } from "../../src/shared/acceptance-obligations.js";
import type { Requirement } from "../../src/shared/assistant.js";
import { parseBrowserCases } from "../../src/server/requirement-coverage.js";
import { v1Requests } from "../../scripts/lib/v1-scenario.js";
import { hash } from "../../src/release/storage.js";

const frozenPath = new URL(
  "../../tests/fixtures/phase3-review-461699a-frozen.json",
  import.meta.url,
);
const proposePath = new URL(
  "../../tests/fixtures/phase3-review-461699a-propose.json",
  import.meta.url,
);
const outcomePath = new URL(
  "../../docs/reports/r11-20261104/bounded-probe-461699a-outcome.json",
  import.meta.url,
);

const PHASE2_VERSION =
  "9347d93c45f9014b5b9ecdd688b5de8fd8a8653486de25556126d1cc8845ba42";

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

const workflowBase = {
  id: "default",
  actions: [{ id: "complete" }, { id: "reopen" }],
  fields: [{ key: "review" }],
};

function context(acceptance: Record<string, unknown>) {
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
        content: JSON.stringify({
          id: "default",
          name: "默认",
          version: "1",
          initialState: "open",
          fields: [{ key: "review", label: "复盘" }],
          states: {
            open: { label: "未完成", category: "open" },
            done: { label: "已完成", category: "done" },
          },
          actions: [
            { id: "complete", label: "完成", from: ["open"] },
            { id: "reopen", label: "重新打开", from: ["done"] },
          ],
        }),
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

function requirementRevisionBlockers(
  inherited: Requirement[],
  next: Requirement[],
  acceptanceReason: unknown,
) {
  const blockers: string[] = [];
  for (const old of inherited) {
    const replacement = next.find((item) => item.id === old.id);
    if (!replacement || hash(replacement) === hash(old)) continue;
    if (typeof acceptanceReason !== "string" || !acceptanceReason.trim())
      blockers.push(`既有需求 ${old.id} 改变，须说明验收修订原因`);
  }
  return blockers;
}

function loadFrozen() {
  return JSON.parse(readFileSync(frozenPath, "utf8")) as {
    tipSha: string;
    baseVersion: string;
    versionId?: string;
    browserCases: BrowserCaseRow[];
    requirements: Requirement[];
    memberCases: unknown[];
    workflowRules?: unknown[];
    requirementGate: { sources: { id: string; text: string }[] };
    fieldIdentities: unknown[];
    uiContributions: unknown[];
  };
}

function compileReviewProposal(
  proposal: unknown,
  options: { injectAcceptanceReason?: boolean } = {},
) {
  const injectAcceptanceReason = options.injectAcceptanceReason !== false;
  const frozen = loadFrozen();
  const inherited = {
    memberCases: frozen.memberCases,
    requirements: frozen.requirements,
    browserCases: frozen.browserCases,
    requirementGate: frozen.requirementGate,
    fieldIdentities: frozen.fieldIdentities,
    uiContributions: frozen.uiContributions,
    baseVersion: frozen.baseVersion,
    rules: frozen.workflowRules ?? [],
  };
  const sources = [
    ...frozen.requirementGate.sources,
    { id: "request:4", text: v1Requests[3] },
  ];
  const ctx = context({
    rules: inherited.rules,
    requirements: inherited.requirements,
    memberCases: inherited.memberCases,
    browserCases: inherited.browserCases,
  });
  const draft = compilePlanInput(proposal, ctx, sources);
  const draftReason = (draft as { acceptanceReason?: string }).acceptanceReason;
  const acceptanceReason = injectAcceptanceReason
    ? draftReason ??
      "用户新增必填复盘，已有标签与计数期望按兼容说明保留"
    : draftReason;
  const planInput = {
    ...draft,
    ...(acceptanceReason ? { acceptanceReason } : {}),
  };
  const compiled = compileReferences(
    { ...planInput, memberCases: inherited.memberCases },
    sources,
    workflowCases,
    workflowBase,
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

  const planRequirements = [...compiled.requirements];
  for (const old of inherited.requirements) {
    if (!planRequirements.some((r) => r.id === old.id))
      planRequirements.push(old);
  }
  const revisionBlockers = requirementRevisionBlockers(
    inherited.requirements,
    planRequirements,
    acceptanceReason,
  );
  const merged = inheritBrowserCases(
    {
      requirements: planRequirements,
      browserCases: compiled.browserCases,
    } as never,
    inherited as never,
    acceptanceReason,
  );
  const { cases, aliases: contentAliases } = dedupeBrowserCases(
    merged.browserCases,
  );
  const aliases = mergeBrowserCaseAliases(merged.aliases, contentAliases);
  const requirements = planRequirements.map((r) => ({
    ...r,
    checks: remapBrowserChecks(r.checks, aliases),
  }));
  return {
    inheritedCount: inherited.browserCases.length,
    acceptanceReason,
    revisionBlockers,
    compiled,
    merged,
    cases,
    aliases,
    requirements,
  };
}

test("461699a outcome 阻塞在 phase3 复盘的 33>30 与缺 acceptanceReason", () => {
  const outcome = JSON.parse(readFileSync(outcomePath, "utf8")) as {
    tipSha?: string;
    progress?: {
      browserCasesCapExceededReappeared?: boolean;
      acceptanceReasonMissingReappeared?: boolean;
    };
    stop?: { message?: string; code?: string; phase?: number };
  };
  assert.equal(outcome.tipSha, "461699a9fca97360a42d8f6d41248db6e020284a");
  assert.equal(outcome.stop?.code, "plan-compilation");
  assert.equal(outcome.stop?.phase, 3);
  assert.match(
    outcome.stop?.message ?? "",
    /浏览器验收案例超出上限：33 条，最多 30 条/,
  );
  assert.match(outcome.stop?.message ?? "", /须说明验收修订原因/);
  assert.equal(outcome.progress?.browserCasesCapExceededReappeared, true);
  assert.equal(outcome.progress?.acceptanceReasonMissingReappeared, true);
  const frozen = loadFrozen();
  assert.equal(frozen.baseVersion, PHASE2_VERSION);
  assert.equal(frozen.browserCases.length, 25);
});

test("call-629 缺顶层 acceptanceReason：须说明验收修订原因", () => {
  const proposal = JSON.parse(readFileSync(proposePath, "utf8")) as {
    acceptanceReason?: string;
  };
  assert.equal(
    proposal.acceptanceReason,
    undefined,
    "fixture 原样不得已带顶层 acceptanceReason",
  );

  const step = compileReviewProposal(proposal, {
    injectAcceptanceReason: false,
  });
  assert.ok(
    step.revisionBlockers.length > 0,
    "改变已接受需求且无 plan 根原因时必须有修订 blockers",
  );
  for (const blocker of step.revisionBlockers)
    assert.match(blocker, /既有需求 .+ 改变，须说明验收修订原因/);
  assert.equal(
    planningStructureTerminal({
      historical: false,
      structural: true,
      rejectionSeen: false,
      calls: 2,
      callLimit: 12,
    }),
    true,
  );
});

test("call-629 复盘提案对 phase2 冻结验收：≤30、无悬空、表面收缩、不抬上限", () => {
  const proposal = JSON.parse(readFileSync(proposePath, "utf8"));
  let step: ReturnType<typeof compileReviewProposal>;
  try {
    step = compileReviewProposal(proposal, { injectAcceptanceReason: true });
  } catch (error) {
    assert.fail(
      `真实复盘提案应可编译闭合，不应再抛 ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  assert.equal(step.inheritedCount, 25);
  assert.deepEqual(step.revisionBlockers, []);
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

  const obligationIds = new Set(
    step.requirements.flatMap((r) => (r.obligations ?? []).map((o) => o.id)),
  );
  const obsoleteFork = step.merged.browserCases.find((c) =>
    c.id.startsWith("field-c147f4295b8d198d4b6570b8-"),
  );
  assert.equal(
    obsoleteFork,
    undefined,
    "无 contribution 的旧 field 分叉不得再占配额",
  );
  const orphan = step.merged.browserCases.find((c) =>
    c.id.startsWith("obligation-18bc0c87c8a168378335ebb3-"),
  );
  assert.equal(orphan, undefined, "孤儿义务案例不得再占配额");

  const sample = {
    id: "field-c147f4295b8d198d4b6570b8-initial-host-existing",
    task: "existing" as const,
    obligationId: "field-c147f4295b8d198d4b6570b8",
    steps: [
      {
        kind: "field" as const,
        member: "tags",
        field: "tag",
        value: "（空）",
      },
      { kind: "refresh" as const },
      {
        kind: "field" as const,
        member: "tags",
        field: "tag",
        value: "（空）",
      },
      { kind: "restart" as const },
      {
        kind: "field" as const,
        member: "tags",
        field: "tag",
        value: "（空）",
      },
    ],
  };
  const role = classifyBrowserCaseAgainstSurface(sample, {
    currentCases: step.compiled.browserCases as never,
    obligationIds,
  });
  assert.equal(role.role, "obsolete");
  assert.ok(role.coveredBy?.startsWith("field-47ca9d2f"));

  assert.ok(
    step.cases.some(
      (c) =>
        c.id.includes("fc6f56b2") ||
        JSON.stringify(c.steps).includes('"review"'),
    ),
    "复盘字段案例必须进入浏览器清单",
  );
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
});
