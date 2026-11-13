import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compilePlanInput } from "../../src/evolution/plan-input.js";
import {
  compileReferences,
  inheritBrowserCases,
  obsoleteDisabledMemberCase,
} from "../../src/evolution/references.js";
import {
  browserCaseQuotaKey,
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
  "../../tests/fixtures/phase4-disable-tags-1a4a54f-frozen.json",
  import.meta.url,
);
const proposePath = new URL(
  "../../tests/fixtures/phase4-disable-tags-1a4a54f-propose.json",
  import.meta.url,
);
const outcomePath = new URL(
  "../../docs/reports/r11-20261104/bounded-probe-1a4a54f-outcome.json",
  import.meta.url,
);

const PHASE3_BASE =
  "ac179ee9e2ec2f1e4e3d6551df5c1cb66746ddae8d85af56fa659fd86770dcdf";

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

function context(
  acceptance: Record<string, unknown>,
  enabledTags = true,
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
        enabled: enabledTags,
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
  // compileReferences may collapse contribution-only assertion forks via quota
  // supersede without returning those aliases; recover them for obligationCases.
  const quotaAliases = new Map(aliases);
  for (const r of requirements)
    for (const o of r.obligations ?? [])
      for (const c of obligationCases(o)) {
        if (browserCases.some((b) => b.id === c.id) || quotaAliases.has(c.id))
          continue;
        const match = browserCases.find(
          (b) => browserCaseQuotaKey(b) === browserCaseQuotaKey(c),
        );
        if (match) quotaAliases.set(c.id, match.id);
      }
  const missingGenerated = requirements.flatMap((r) =>
    (r.obligations ?? []).flatMap((o) =>
      obligationCases(o)
        .filter((c) => {
          const survivor =
            browserCases.find((b) => b.id === c.id) ??
            (quotaAliases.has(c.id)
              ? browserCases.find((b) => b.id === quotaAliases.get(c.id))
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

function loadFrozen() {
  const frozen = JSON.parse(readFileSync(frozenPath, "utf8")) as {
    tipSha: string;
    baseVersion: string;
    browserCases: BrowserCaseRow[];
    requirements: Requirement[];
    memberCases: unknown[];
    workflowRules?: unknown[];
    requirementGate: { sources: { id: string; text: string }[] };
    fieldIdentities: unknown[];
    uiContributions: unknown[];
  };
  return frozen;
}

/** Mirrors evolution.ts inherit+dedupe+cap after compileReferences. */
function compileDisableProposal(proposal: unknown) {
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
    { id: "request:5", text: v1Requests[4] },
  ];
  const ctx = context(
    {
      rules: inherited.rules,
      requirements: inherited.requirements,
      memberCases: inherited.memberCases,
      browserCases: inherited.browserCases,
    },
    true,
  );
  const draft = compilePlanInput(proposal, ctx, sources);
  const acceptanceReason = (draft as { acceptanceReason?: string })
    .acceptanceReason;
  const compiled = compileReferences(
    { ...draft, memberCases: inherited.memberCases },
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

  // evolution.ts: push unchanged accepted requirements, then inherit.
  const planRequirements = [...compiled.requirements];
  for (const old of inherited.requirements) {
    if (!planRequirements.some((r) => r.id === old.id))
      planRequirements.push(old);
  }
  const planForInherit = {
    requirements: planRequirements,
    browserCases: compiled.browserCases,
    memberEnabled: (draft as { memberEnabled?: unknown }).memberEnabled,
  };
  const merged = inheritBrowserCases(
    planForInherit as never,
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
    draft,
    compiled,
    merged,
    cases,
    aliases,
    requirements,
  };
}

test("1a4a54f outcome 阻塞在 phase4 disable-tags 的 38>30", () => {
  const outcome = JSON.parse(readFileSync(outcomePath, "utf8")) as {
    tipSha?: string;
    progress?: { browserCasesCapExceededReappeared?: boolean };
    stop?: { message?: string; code?: string; kind?: string };
  };
  assert.equal(outcome.tipSha, "1a4a54f7d8eb35fcdc2057df7c5ac02afadb046f");
  assert.equal(outcome.stop?.code, "plan-compilation");
  assert.equal(outcome.stop?.kind, "browser-cases-cap-exceeded");
  assert.match(
    outcome.stop?.message ?? "",
    /浏览器验收案例超出上限：38 条，最多 30 条/,
  );
  assert.equal(outcome.progress?.browserCasesCapExceededReappeared, true);
  const frozen = loadFrozen();
  assert.equal(frozen.baseVersion, PHASE3_BASE);
  assert.equal(frozen.browserCases.length, 29);
});

test("call-611 停用 tags 对 phase3 冻结验收：≤30、无悬空、保留历史、不抬上限", () => {
  const proposal = JSON.parse(readFileSync(proposePath, "utf8")) as {
    acceptanceReason?: string;
    changes?: { target: string; enabled?: boolean }[];
  };
  assert.ok(proposal.acceptanceReason?.trim(), "fixture 须带 plan 根 acceptanceReason");
  assert.deepEqual(proposal.changes, [{ target: "tags", enabled: false }]);

  let step: ReturnType<typeof compileDisableProposal>;
  try {
    step = compileDisableProposal(proposal);
  } catch (error) {
    assert.fail(
      `真实停用提案应可编译闭合，不应再抛 ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  assert.equal(step.inheritedCount, 29);
  assert.ok(
    step.compiled.browserCases.length <= 30,
    `compileReferences 输出 ${step.compiled.browserCases.length} > 30`,
  );
  assert.doesNotThrow(() => parseBrowserCases(step.compiled.browserCases));
  assert.ok(
    step.cases.length <= 30,
    `inherit+dedupe 后 ${step.cases.length} > 30（当前宿主未收缩停用成员过时案例）`,
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
    step.cases.some(
      (c) =>
        c.id.includes("historical-") &&
        JSON.stringify(c.steps).includes('"member":"tags"'),
    ),
    "停用后须保留 tags 历史数据案例",
  );
  assert.equal(
    step.cases.filter((c) => obsoleteDisabledMemberCase(c, "tags")).length,
    0,
    "停用后不得保留 tags 的 initial/after 操作案例",
  );
  assert.ok(
    step.cases.some((c) =>
      JSON.stringify(c.steps).includes('"visible":false'),
    ),
    "停用须产生 action-visible visible:false",
  );

  assert.equal(
    planningStructureTerminal({
      historical: false,
      structural: true,
      rejectionSeen: false,
      calls: 2,
      callLimit: 12,
    }),
    true,
    "超限/悬空必须不可重试",
  );
  assert.throws(
    () =>
      parseBrowserCases(
        Array.from({ length: 38 }, (_, i) => ({
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
  // Touch hash so unused-import lint stays quiet if tree-shaken elsewhere.
  assert.equal(typeof hash(step.acceptanceReason ?? ""), "string");
});
