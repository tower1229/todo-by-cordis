import test from "node:test";
import assert from "node:assert/strict";
import { compilePlanInput, planSchemaFor } from "../../src/evolution/plan-input.js";
import { parseAdmission } from "../../src/evolution/request-admission.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { memberUiReleaseInput } from "../fixtures/member-ui.js";
import { panelMemberCases } from "./member-case-fixtures.js";
import {
  capture,
  bindPlan,
  planBindingFailure,
} from "../../src/server/planning.js";
import { planningTools } from "../../src/server/planning.js";
import { DeepSeek } from "../../src/evolution/deepseek.js";
import {
  verifyViaIsolatedWorkspace,
  type WorkspaceCaseEvidence,
} from "../../src/server/workspace-acceptance.js";

const quote = "完成前填写复盘，其他行为不变";
const sources = [{ id: "request:1", text: quote }];
const context = {
  pluginId: "primary",
  members: [
    {
      pluginId: "primary",
      role: "workflow" as const,
      versionId: "base",
      enabled: true,
    },
    {
      pluginId: "panel",
      role: "auxiliary" as const,
      versionId: "panel-base",
      enabled: true,
    },
  ],
  capabilities: [],
  files: {
    "active-contract": {
      content: JSON.stringify({
        id: "primary",
        initialState: "open",
        actions: [{ id: "complete" }],
      }),
      hash: "contract",
    },
    "active-acceptance": {
      content: JSON.stringify({ rules: [] }),
      hash: "acceptance",
    },
  },
};
const requirement = {
  description: quote,
  quote,
  type: "behavior",
  expectations: [{ kind: "behavior" }],
};
const base = { summary: quote, requirements: [requirement] };
const rule = {
  key: "reflection",
  label: "复盘",
  required: true,
  minLength: 1,
  maxLength: 100,
};

test("不可执行接口先报告授权与运行支持，已实现但无检查器的接口保留验证缺口归因", () => {
  const declared={id:"query.filter:panel",interfaceId:"query.filter",providerId:"panel",status:"declared" as const,count:0,ready:false,artifactVersion:"panel-base",providerVersion:"panel-base",contractVersion:"extensions/1",installed:true,enabled:true,healthy:true,inUse:false,authorized:false,dependencies:[],checkerCoverage:[],purpose:"查询占位",limitations:""};
  const use=(feature:string)=>({...base,uses:[{member:"panel",feature}]});
  assert.throws(()=>compilePlanInput(use("filter"),{...context,capabilities:[declared]},sources),/未授权/);
  assert.throws(()=>compilePlanInput(use("filter"),{...context,capabilities:[{...declared,status:"stub"}]},sources),/宿主尚不支持执行该接口/);
  assert.throws(()=>compilePlanInput(use("events"),context,sources),/尚无可信业务检查器/);
});

test("钩子缺少主工作流冻结案例时在规格编译入口明确拒绝，自有命令不能冒充钩子覆盖", () => {
  assert.throws(
    () => compilePlanInput({
      ...base,
      changes: [{ target: "panel", features: ["beforeCommit"], cases: [
        { state: "open", fields: {}, action: "markNote", input: {}, expected: { kind: "reject" } },
      ] }],
      uses: [{ member: "panel", feature: "beforeCommit" }],
    }, context, sources),
    /task\.beforeCommit.*主工作流.*冻结案例/,
  );
});

test("宿主从钩子特征及主工作流冻结案例生成检查器绑定，不虚构辅助命令或要求模型维护 uses", () => {
  const compiled=compilePlanInput({...base,changes:[{target:"panel",features:["beforeCommit"],cases:[
    {state:"open",fields:{},action:"complete",input:{},expected:{kind:"commit",state:"done",fields:{reviewed:"yes"}}},
    {state:"done",fields:{},action:"complete",input:{},expected:{kind:"reject"}},
  ]}]},context,sources);
  assert.ok(compiled.requiredCapabilities.some(c=>c.interfaceId==="task.beforeCommit"&&c.providerId==="panel"&&c.verification==="candidate"&&c.checker==="beforeCommit/1"));
  assert.equal(compiled.capabilityChanges.some(c=>c.capability==="command.register"),false);
});

test("主工作流案例不能被宿主擅自解释为新增钩子，跨提供者方案不明确时在规划入口拒绝", () => {
  assert.throws(()=>compilePlanInput({...base,changes:[{target:"panel",features:["schedules"],cases:[
    {state:"open",fields:{},action:"complete",input:{},expected:{kind:"commit",state:"done",fields:{}}},
  ]}]},context,sources),/跨提供者.*钩子/);
});

test("升级目标的自身能力由候选验收证明，不能误作已有覆盖充分的外部依赖", () => {
  const live={...context,capabilities:[{id:"command.register:panel",interfaceId:"command.register",providerId:"panel",status:"active" as const,count:1,ready:true,artifactVersion:"panel-base",providerVersion:"panel-base",contractVersion:"extensions/1",installed:true,enabled:true,healthy:true,inUse:true,authorized:true,dependencies:[],checkerCoverage:[],purpose:"动作",limitations:""}]};
  const input={...base,changes:[{target:"panel",cases:[{state:"open",fields:{},action:"markNote",input:{},expected:{kind:"reject"}}]}],uses:[{member:"panel",feature:"commands"}]};
  const compiled=compilePlanInput(input,live,sources);
  assert.ok(compiled.requiredCapabilities.some(c=>c.providerId==="panel"&&c.verification==="candidate"&&c.checker==="workspace/1"));
  assert.ok(compiled.capabilityChanges.some(c=>c.provider==="member:panel"&&c.capability==="command.register"));
  assert.throws(()=>compilePlanInput({...input,changes:[{target:"workflow",fields:[rule]}]},live,sources),/缺少可靠业务验收检查器/);
});

test("候选即使通过字段写入案例，删除被冻结的字段注册仍必须被 Workspace 检查器拒绝", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "host-field-registration-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = await memberUiReleaseInput("field-identity-counterexample");
  const code = fixture.panel.source.replace(
    'fields: [{ key: "noteMark",',
    'fields: [{ key: "unrelated",',
  );
  assert.notEqual(code, fixture.panel.source);
  const panel = w.release.record({ ...fixture.panel, source: code, code });
  const candidate = w.release.record({
    ...fixture.composition,
    members: [
      { pluginId: "aux-workflow", role: "workflow", enabled: true },
      {
        pluginId: "panel",
        role: "auxiliary",
        enabled: true,
        versionId: panel.id,
      },
    ],
  });
  const before = JSON.stringify({
    composition: w.composition(),
    tasks: w.query(),
  });
  await verifyViaIsolatedWorkspace(
    w,
    candidate,
    panelMemberCases,
    new AbortController().signal,
  );
  const evidence: WorkspaceCaseEvidence[] = [];
  await assert.rejects(
    verifyViaIsolatedWorkspace(
      w,
      candidate,
      panelMemberCases,
      new AbortController().signal,
      (r) => evidence.push(r),
      [{ member: "panel", fields: ["noteMark"] }],
    ),
    /字段注册.*noteMark/,
  );
  assert.equal(evidence[0].status, "failed");
  assert.deepEqual(evidence[0].requiredFields, ["noteMark"]);
  assert.deepEqual(evidence[0].actual.registeredFields, ["unrelated"]);
  assert.equal(
    JSON.stringify({ composition: w.composition(), tasks: w.query() }),
    before,
  );
});

test("字段注册的检查器来自真实字段及成对写入案例，保留字段不能冒充字段写入验收", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "host-plan-binding-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  const fixture = await memberUiReleaseInput("host-plan-binding");
  const panel = w.release.record(fixture.panel);
  const activate = async (cases: typeof panelMemberCases) => {
    const v = w.release.record({
      ...fixture.composition,
      evidence: { passed: true, origin: "test", memberCases: cases },
      members: [
        { pluginId: "aux-workflow", enabled: true, role: "workflow" },
        {
          pluginId: "panel",
          enabled: true,
          role: "auxiliary",
          versionId: panel.id,
        },
      ],
    });
    await w.activate(
      {
        versionId: v.id,
        compositionRevision: w.composition().revision,
        operationId: v.id,
      },
      () => undefined,
    );
    return capture(w);
  };
  const covered = await activate(panelMemberCases);
  const inheritedFeatures = compilePlanInput(
    { ...base, changes: [{ target: "panel", cases: null }] },
    covered,
    sources,
  );
  assert.deepEqual(
    inheritedFeatures.capabilityChanges
      .map((c) => [c.provider, c.capability])
      .sort(),
    [
      ["member:panel", "command.register"],
      ["member:panel", "fields.register"],
      ["member:panel", "ui.slot"],
    ].sort(),
  );
  assert.deepEqual(
    covered.capabilities.find(
      (c) => c.providerId === "panel" && c.interfaceId === "fields.register",
    )!.checkerCoverage,
    ["workspace/1"],
  );
  const draft = compilePlanInput(
    {
      ...base,
      changes: [
        {
          target: "panel",
          cases: panelMemberCases.map(({ member: _member, ...c }) => c),
        },
      ],
      uses: [{ member: "panel", feature: "fields" }],
    },
    covered,
    sources,
  );
  assert.equal(
    draft.requiredCapabilities.find((c) => c.interfaceId === "fields.register")!
      .checker,
    "workspace/1",
  );
  const binding = bindPlan(
    {
      requiredCapabilities: draft.requiredCapabilities,
      capabilityChanges: draft.capabilityChanges,
      cases: [],
    },
    covered,
    [],
  );
  const boundFields = binding.capabilities.find(
    (c) => c.interfaceId === "fields.register" && c.providerId === "panel",
  )!;
  assert.deepEqual(boundFields.registeredFields, ["noteMark"]);
  assert.equal(planBindingFailure(binding, covered), undefined);
  boundFields.registeredFields = [];
  assert.match(planBindingFailure(binding, covered) ?? "", /所需能力已变化/);
  const fabricated = structuredClone(covered);
  fabricated.capabilities.find(
    (c) => c.providerId === "panel" && c.interfaceId === "fields.register",
  )!.checkerCoverage = [];
  assert.throws(
    () =>
      compilePlanInput(
        { ...base, uses: [{ member: "panel", feature: "fields" }] },
        fabricated,
        sources,
      ),
    /缺少可靠业务验收检查器/,
  );
  fabricated.capabilities.find(
    (c) => c.providerId === "panel" && c.interfaceId === "fields.register",
  )!.checkerCoverage = ["browser/1"];
  assert.throws(
    () =>
      compilePlanInput(
        { ...base, uses: [{ member: "panel", feature: "fields" }] },
        fabricated,
        sources,
      ),
    /缺少可靠业务验收检查器/,
  );
  const preservation = panelMemberCases.map((c) =>
    c.expected.kind === "commit" ? { ...c, fields: { noteMark: "ok" } } : c,
  );
  assert.deepEqual(
    (await activate(preservation)).capabilities.find(
      (c) => c.providerId === "panel" && c.interfaceId === "fields.register",
    )!.checkerCoverage,
    [],
  );
  assert.deepEqual(
    (await activate(panelMemberCases.slice(0, 1))).capabilities.find(
      (c) => c.providerId === "panel" && c.interfaceId === "fields.register",
    )!.checkerCoverage,
    [],
  );
});

test("写入目标的主辅及新增升级角色由宿主解析，模型不再提交 operation", () => {
  const main = compilePlanInput(
    { ...base, changes: [{ target: "primary", fields: [rule] }] },
    context,
    sources,
  );
  assert.deepEqual(main.writableScope, ["active-source"]);
  assert.equal(main.memberUpgrades, undefined);
  assert.deepEqual(main.workflowRules, [rule]);
  const alias = compilePlanInput(
    {
      ...base,
      changes: [{ target: "workflow", fields: [rule] }],
      uses: [{ member: "workflow", feature: "workflow" }],
    },
    context,
    sources,
  );
  assert.ok(
    alias.requiredCapabilities.every((c) => c.providerId === "primary"),
  );
  assert.throws(
    () =>
      compilePlanInput(
        { ...base, changes: [{ target: "workflow" }] },
        {
          ...context,
          members: [
            ...context.members,
            {
              pluginId: "workflow",
              role: "auxiliary",
              versionId: "alias",
              enabled: true,
            },
          ],
        },
        sources,
      ),
    /身份冲突/,
  );
  const auxiliary = compilePlanInput(
    { ...base, changes: [{ target: "panel", features: ["detail"] }] },
    context,
    sources,
  );
  assert.deepEqual(auxiliary.memberUpgrades, [{ pluginId: "panel" }]);
  const addition = compilePlanInput(
    { ...base, changes: [{ target: "new-panel", features: ["detail"] }] },
    context,
    sources,
  );
  assert.deepEqual(addition.memberAdditions, [
    { pluginId: "new-panel", name: "new-panel" },
  ]);
  const nullable = {
    target: "panel",
    features: ["detail"],
    cases: [],
  };
  assert.deepEqual(
    compilePlanInput({ ...base, changes: [nullable] }, context, sources),
    auxiliary,
  );
});

test("可选空集合等价且不修复非集合；冻结规则、非空要求、角色及启停约束仍受保护", () => {
  const input = { ...base, changes: [{ target: "primary", fields: [rule] }] };
  const omitted = compilePlanInput(input, context, sources);
  assert.deepEqual(
    compilePlanInput(
      {
        ...input,
        uses: null,
        changes: [{ ...input.changes[0], cases: null }],
      },
      context,
      sources,
    ),
    omitted,
  );
  assert.throws(
    () => compilePlanInput({ ...input, changes: {} }, context, sources),
    /契约/,
  );
  assert.throws(
    () => compilePlanInput({ ...input, requirements: null }, context, sources),
    /契约/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        { ...input, changes: [{ target: "panel", fields: [rule] }] },
        context,
        sources,
      ),
    /未授权字段/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        { ...input, changes: [{ target: "primary", enabled: false }] },
        context,
        sources,
      ),
    /未授权字段/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        {
          ...input,
          changes: [
            {
              target: "panel",
              enabled: false,
              cases: [
                {
                  state: "open",
                  fields: {},
                  action: "markNote",
                  input: {},
                  expected: { kind: "reject" },
                },
              ],
            },
          ],
        },
        context,
        sources,
      ),
    /未授权字段|target/,
  );
  assert.deepEqual(compilePlanInput({...base,changes:[{target:"panel",enabled:false}]},context,sources).memberEnabled,{pluginId:"panel",enabled:false});
  for (const empty of [null, []]) assert.throws(()=>compilePlanInput({...base,changes:[{target:"panel",enabled:false,features:empty}]},context,sources),/未授权字段/);
  assert.throws(
    () =>
      compilePlanInput(
        { ...input, changes: [{ target: "primary" }, { target: "workflow" }] },
        context,
        sources,
      ),
    /重复/,
  );
  for (const input of [
    base,
    { ...base, changes: null },
    { ...base, changes: [] },
  ])
    assert.equal(
      compilePlanInput(input, context, sources).memberUpgrades,
      undefined,
    );
  assert.throws(
    () =>
      compilePlanInput(
        { ...input, changes: [{ target: "panel", operation: "upgrade" }] },
        context,
        sources,
      ),
    /未授权字段/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        { ...input, changes: [{ target: "panel", role: "workflow" }] },
        context,
        sources,
      ),
    /未授权字段/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        { ...input, changes: [{ target: "missing", enabled: true }] },
        context,
        sources,
      ),
    /未授权字段|target/,
  );
  assert.throws(
    () =>
      compilePlanInput(
        { ...input, changes: [{ target: "panel" }, { target: "new-panel" }] },
        context,
        sources,
      ),
    /一个辅助/,
  );
  const inherited = {
    ...context,
    files: {
      ...context.files,
      "active-acceptance": {
        content: JSON.stringify({ rules: [rule] }),
        hash: "previous",
      },
    },
  };
  assert.deepEqual(
    compilePlanInput(
      { ...base, changes: [{ target: "workflow", fields: null }] },
      inherited,
      sources,
    ).workflowRules,
    [rule],
  );
  assert.deepEqual(
    compilePlanInput(
      { ...base, changes: [{ target: "workflow", fields: [] }] },
      inherited,
      sources,
    ).workflowRules,
    [],
  );
});

test("原生模型参数的空集合经过实际 Adapter 和同一宿主编译入口，错误标量仍被拒绝", async () => {
  for (const uses of [null, {}, "none"]) {
    const args = {
      ...base,
      changes: [
        { target: "primary", fields: [rule], cases: null },
      ],
      uses,
    };
    let requests = 0;
    const reply = await new DeepSeek("synthetic-key", async (_url, init) => {
      requests++;
      const request = JSON.parse(String(init?.body));
      assert.ok(
        request.tools.every(
          (t: { function: { strict?: boolean } }) => t.function.strict !== true,
        ),
      );
      return new Response(
        JSON.stringify({
          model: "deepseek-flash",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "plan",
                    type: "function",
                    function: {
                      name: "propose_plan",
                      arguments: JSON.stringify(args),
                    },
                  },
                ],
              },
            },
          ],
          usage: { total_tokens: 7 },
        }),
      );
    }).generate(
      { history: [], instruction: "测试业务契约", tools: planningTools.map(t=>t.name==="propose_plan"?{...t,parameters:planSchemaFor(context)}:t) },
      new AbortController().signal,
    );
    assert.equal(requests, 1);
    assert.deepEqual(reply.usage, { total_tokens: 7 });
    if (uses === null) {
      assert.equal(reply.protocolErrors, undefined);
      assert.deepEqual(
        compilePlanInput(reply.calls[0].args, context, sources).workflowRules,
        [rule],
      );
    } else assert.ok(reply.protocolErrors?.length);
  }
});

test("来源预检中的字段标签不能仅凭一次模型解释变成已裁决的初始值阻塞", () => {
  const admission = parseAdmission(
    JSON.stringify({
      effects: [], initials: [
        {
          source: 1,
          sourceQuote: "完成前填写复盘",
          target: {kind:"new",name:"复盘"},
          meaning:{kind:"literal",value:"复盘",conditionQuote:"完成前填写复盘",effectQuote:"完成前填写复盘"},
        },
      ],
      questions: [],
    }),
    "base",
    sources,
    technicalFacts({ workflowRules: [], binding: undefined }),
  );
  assert.deepEqual(admission.blockers, []);
  assert.equal(admission.claims.length, 1);
  assert.match(admission.claims[0].diagnostic, /初始呈现/);
  assert.equal(admission.semanticReview, undefined);
});
