import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compilePlanInput,
  planInputSchema,
  planSchemaFor,
} from "../../src/evolution/plan-input.js";
import { parseReview } from "../../src/server/requirement-coverage.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";
import {
  capabilityCheckerContract,
  capabilityCheckerCoverage,
} from "../../src/server/capability-checkers.js";
import { schemaProblems } from "../../src/evolution/model-protocol.js";
import { capture, readInvestigation } from "../../src/server/planning.js";
import { Workspace } from "../../src/server/workspace.js";
import { memberUiReleaseInput } from "../fixtures/member-ui.js";
import { panelMemberCases } from "./member-case-fixtures.js";
import { Evolution } from "./evolution-adapter.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";

const quote = "完成前填写复盘，其他行为不变";
const base = {
  summary: quote,
  requirements: [
    {
      description: quote,
      quote,
      type: "behavior",
      expectations: [{ kind: "behavior" }],
    },
  ],
};

test("公开写入契约按目标限制属性，辅助目标不能带主流程 actions", () => {
  const value = {
    ...base,
    changes: [
      {
        target: "panel",
        actions: [{ id: "markNote", label: "标记", from: ["open"] }],
      },
    ],
  };
  assert.ok(
    schemaProblems(value, planInputSchema).some((p) => p.includes("actions")),
  );
});

test("原文没有固定错误文案时，宿主不能编译模型新增的文字限制", () => {
  const context = {
    pluginId: "primary",
    members: [],
    capabilities: [],
    files: {
      "active-acceptance": {
        hash: "a",
        content: JSON.stringify({ rules: [] }),
      },
      "active-contract": {
        hash: "b",
        content: JSON.stringify({
          id: "primary",
          initialState: "open",
          actions: [{ id: "complete" }],
        }),
      },
    },
  };
  const value = {
    ...base,
    changes: [
      {
        target: "workflow",
        fields: [
          {
            key: "review",
            label: "复盘",
            required: true,
            minLength: 1,
            maxLength: 100,
          },
        ],
      },
    ],
    requirements: [
      {
        ...base.requirements[0],
        expectations: [
          { kind: "error", action: "complete", text: "请填写复盘" },
        ],
      },
    ],
  };
  assert.throws(
    () => compilePlanInput(value, context, [{ id: "request:1", text: quote }]),
    /错误文案.*来源/,
  );
});

test("静态接口检查器说明与真实字段能力来自同一目录", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "catalog-closure-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const input = await memberUiReleaseInput("catalog-closure");
  const panel = w.release.record(input.panel);
  const version = w.release.record({
    ...input.composition,
    members: input.composition.members!.map((m) =>
      m.pluginId === "panel" ? { ...m, versionId: panel.id } : m,
    ),
    evidence: { ...input.composition.evidence, memberCases: panelMemberCases },
  });
  await w.activate(
    {
      versionId: version.id,
      compositionRevision: w.composition().revision,
      operationId: version.id,
    },
    () => undefined,
  );
  const context = capture(w);
  const result = readInvestigation("inspect_application", {}, context);
  assert.ok("content" in result);
  const document = result.content as {
    capabilityContracts: { id: string; checkers: string[] }[];
    planningRequirements: {
      writeContract: { targets: unknown[]; hostDerived: string[] };
    };
  };
  assert.deepEqual(
    document.planningRequirements.writeContract.targets,
    planSchemaFor(context).properties.changes.items.anyOf.map((branch) => ({
      target: branch.properties.target,
      properties: Object.keys(branch.properties),
    })),
  );
  assert.ok(
    document.planningRequirements.writeContract.hostDerived.includes("role"),
  );
  const live = context.capabilities.find(
    (c) => c.id === "fields.register:panel",
  )!;
  assert.deepEqual(live.checkerCoverage, ["workspace/1"]);
  assert.deepEqual(
    document.capabilityContracts.find((c) => c.id === "fields.register")
      ?.checkers,
    live.checkerCoverage,
  );
});

for (const corrupted of [false, true])
  test(`执行一次复用全部冻结资料并校验存储摘要：${corrupted ? "缓存损坏" : "有效缓存"}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "execution-closure-"));
    const w = await Workspace.open(join(directory, "workspace.db"));
    const fixture = new PlanningDriver();
    let names: string[] = [];
    const e = new Evolution(
      w.db,
      {
        async generate(request, signal) {
          if (request.tools?.some((t) => t.name === "submit_candidate")) {
            names = request.tools.map((t) => t.name);
            const input = JSON.parse(request.message!);
            for (const bound of input.plan.binding.materials)
              assert.ok(
                input.materials.catalog.some(
                  (doc: { ref: string; hash: string }) =>
                    doc.ref === bound.ref && doc.hash === bound.hash,
                ),
                bound.ref,
              );
            return {
              ...toolReply("report_blocker", {
                reason: "模型桩完成资料交付观察",
              }),
              history: request.history,
            };
          }
          return fixture.generate(request);
        },
      },
      new EvolutionDomain(w),
    );
    t.after(async () => {
      await e.close();
      await w.close();
      await rm(directory, { recursive: true, force: true });
    });
    const settle = async () => {
      for (let n = 0; n < 1000; n++) {
        const r = (await e.observe()).run!;
        if (!["planning", "executing"].includes(r.status)) return r;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("timeout");
    };
    await e.command({ type: "request", text: quote, operationId: "request" });
    const ready = await settle();
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") return;
    if (corrupted)
      w.db
        .prepare("UPDATE evolution_materials SET body=? WHERE hash=?")
        .run(
          JSON.stringify("tampered source"),
          ready.plan.binding!.materials.find((m) => m.ref === "active-source")!
            .hash,
        );
    await e.command({
      type: "start",
      runId: ready.id,
      planId: ready.plan.id,
      operationId: "start",
    });
    const done = await settle();
    if (corrupted) {
      assert.equal(done.status, "failed");
      assert.match("message" in done ? done.message : "", /调查资料已损坏/);
      assert.equal(done.budget?.callsUsed, ready.budget?.callsUsed);
      assert.deepEqual(names, []);
    } else assert.deepEqual(names, ["report_blocker", "submit_candidate"]);
  });

test("动态目标契约区分真实主成员、辅助成员和启停，不依赖供应商 strict", () => {
  const context = {
    pluginId: "primary",
    members: [
      {
        pluginId: "panel",
        role: "auxiliary" as const,
        versionId: "v",
        enabled: true,
      },
    ],
  };
  const schema = planSchemaFor(context);
  for (const change of [
    { target: "primary", fields: [] },
    { target: "workflow", actions: [] },
    { target: "panel", features: [] },
    { target: "panel", enabled: false },
  ])
    assert.deepEqual(
      schemaProblems({ ...base, changes: [change] }, schema),
      [],
    );
  for (const change of [
    { target: "primary", features: [] },
    { target: "panel", fields: null },
    { target: "panel", enabled: false, features: [] },
    { target: "missing", enabled: true },
    { target: "primary", enabled: false },
    { target: "panel", actions: [] },
  ])
    assert.ok(
      schemaProblems({ ...base, changes: [change] }, schema).length,
      JSON.stringify(change),
    );
});

test("静态目录声明的是检查器及先决条件，缺真实字段证据不能自报动态覆盖", () => {
  assert.deepEqual(capabilityCheckerContract("fields.register").checkers, [
    "workspace/1",
  ]);
  assert.ok(capabilityCheckerContract("fields.register").coverageRequirement);
  assert.deepEqual(
    capabilityCheckerCoverage("fields.register", {
      commands: false,
      fields: false,
    }),
    [],
  );
  assert.deepEqual(
    capabilityCheckerCoverage("unknown", { commands: true, fields: true }),
    [],
  );
});

function errorPlan(text: string): InvestigatedPlan {
  return {
    workflowRules: [],
    requirements: [
      {
        id: "requirement",
        description: quote,
        sourceRevision: "request:1",
        sourceQuote: quote,
        type: "interface",
        checks: [],
        obligations: [
          {
            version: 1,
            id: "error-1",
            kind: "assertion",
            steps: [],
            expected: { kind: "error", text },
          },
        ],
      },
    ],
  } as InvestigatedPlan;
}
const errorSources = [
  {
    id: "request:1",
    text: "空白复盘要显示错误。曾出现请填写复盘，但不限定文案。",
  },
];
const errorDecision = {
  target: 1,
  source: 1,
  sourceQuote: errorSources[0].text,
  feedback: "required",
  effectQuote: "空白复盘要显示错误",
  text: "",
};
const reviewed = (errorDecisions?: unknown) =>
  JSON.stringify({
    reviewedIds: ["requirement"],
    issues: [],
    fieldDecisions: [],
    ...(errorDecisions === undefined ? {} : { errorDecisions }),
  });

test("独立复核自报 issues 空不能绕过错误文案的逐项来源解释", () => {
  assert.throws(
    () => parseReview(reviewed(), errorPlan("请填写复盘"), errorSources),
    /错误文案解释/,
  );
  const result = parseReview(
    reviewed([errorDecision]),
    errorPlan("请填写复盘"),
    errorSources,
  );
  assert.equal(result.issues[0].kind, "extra-constraint");
  assert.equal(result.errorDecisions?.[0].text, "");
  assert.deepEqual(
    parseReview(reviewed([errorDecision]), errorPlan(""), errorSources).issues,
    [],
  );
});

test("用户明确要求的错误文字必须保留，伪造来源和不完整解释不能通过", () => {
  const sources = [{ id: "request:1", text: "错误必须显示：请填写复盘" }];
  const decision = {
    ...errorDecision,
    sourceQuote: sources[0].text,
    effectQuote: sources[0].text,
    text: "请填写复盘",
  };
  assert.deepEqual(
    parseReview(reviewed([decision]), errorPlan("请填写复盘"), sources).issues,
    [],
  );
  assert.equal(
    parseReview(reviewed([decision]), errorPlan(""), sources).issues[0].kind,
    "omission",
  );
  for (const values of [
    [],
    [decision, decision],
    [{ ...decision, target: 2 }],
    [{ ...decision, source: 2 }],
    [{ ...decision, sourceQuote: "伪造" }],
    [{ ...decision, text: "别的文字" }],
  ])
    assert.throws(
      () => parseReview(reviewed(values), errorPlan("请填写复盘"), sources),
      /错误文案解释/,
    );
});

test("执行期交付的能力指南不能再引用已经移除的读取工具", async () => {
  const { capabilityGuides } = await import(
    "../../src/server/capability-guides.js"
  );
  const { generationMaterialRefs } = await import(
    "../../src/shared/change-spec.js"
  );
  for (const ref of Object.values(generationMaterialRefs))
    assert.ok(capabilityGuides["guide/workflow.provide"].includes(ref));
  for (const [ref, guide] of Object.entries(capabilityGuides))
    assert.doesNotMatch(
      guide,
      /\bread_(?:current_source|contract|scaffold|member|guide)\b/,
      ref,
    );
});
