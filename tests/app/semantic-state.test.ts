import test from "node:test";
import assert from "node:assert/strict";
import { businessChoices } from "../../src/evolution/technical-facts.js";
import {
  parseAdmission,
  adjudicateAdmission,
} from "../../src/evolution/request-admission.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";

test("宿主派生字段和已确定必填性不自行生成待澄清项", () => {
  const plan = {
    workflowRules: [
      {
        key: "review",
        label: "复盘",
        required: true,
        minLength: 1,
        maxLength: 100,
      },
    ],
    requirements: [
      {
        id: "r",
        sourceRevision: "s:1",
        sourceQuote: "完成前填写复盘",
        description: "填写复盘",
        type: "interface",
        checks: [],
        obligations: [
          {
            version: 1,
            id: "field",
            kind: "field",
            member: "workflow",
            field: "review",
            initialOrigin: "host",
            initial: { kind: "absent" },
            scenarios: [],
          },
        ],
      },
    ],
  } satisfies Pick<InvestigatedPlan, "requirements" | "workflowRules">;
  assert.deepEqual(businessChoices(plan), []);
});

test("整体认可不能替代完整规划中的逐字段初始来源解释", async () => {
  const {parseFieldDecisions} = await import("../../src/evolution/field-review.js");
  const p={requirements:[{id:"r",sourceRevision:"s:1",sourceQuote:"复盘必填",obligations:[{id:"f",kind:"field",field:"review",initialOrigin:"host",initial:{kind:"absent"}}]}]} as unknown as InvestigatedPlan;
  assert.throws(()=>parseFieldDecisions([{target:1,source:1,sourceQuote:"复盘必填",verdict:"entailed"}],p,[{id:"s:1",text:"复盘必填"}]),/宿主派生|完整|初始/);
});

test("同一契约将字段名称与字面初始内容分开，不能伪造条件和效果引用", async () => {
  const { parseInitialMeaning } = await import(
    "../../src/evolution/requirement-semantics.js"
  );
  const source = "复盘必填";
  assert.deepEqual(parseInitialMeaning({kind:"unspecified"},source).initial,{kind:"unspecified"});
  assert.throws(()=>parseInitialMeaning({kind:"literal",value:"复盘",valueRole:"field-label",conditionQuote:source,effectQuote:source},source),/未授权/);
  assert.throws(
    () =>
      parseInitialMeaning(
        {
          kind:"literal",value:"复盘",
          conditionQuote: "初始为空时",
          effectQuote: source,
        },
        source,
      ),
    /条件或效果/,
  );
  assert.throws(
    () => parseInitialMeaning({ kind: "undetermined" }, source),
    /完整命题/,
  );
  const admission = parseAdmission(
    JSON.stringify({
      presentations: [
        {
          source: 1,
          sourceQuote: source,
          target: {kind:"new",name:"复盘"},
          meaning: {kind:"unspecified"},
        },
      ],
      questions: [],
    }),
    "base",
    [{ id: "s:1", text: source }],
    technicalFacts({ workflowRules: [], binding: undefined }),
  );
  assert.equal(admission.claims.length, 0);
  assert.equal(admission.presentations.length, 0);
  assert.equal(admission.initialMeanings[0].initial.kind, "unspecified");
});

test("宿主只复用来源未变的具体裁决，不复用旧门禁收据", async () => {
  const { semanticReuse } = await import(
    "../../src/evolution/requirement-semantics.js"
  );
  const sources = [{ id: "s:1", text: "复盘必填" }];
  const admission = parseAdmission(
    JSON.stringify({
      presentations: [
        {
          source: 1,
          sourceQuote: sources[0].text,
          target: {kind:"new",name:"复盘"},
          meaning: {
            kind:"literal",value:"复盘",
            conditionQuote: sources[0].text,
            effectQuote: sources[0].text,
          },
        },
      ],
      questions: [],
    }),
    "base",
    sources,
    technicalFacts({ workflowRules: [], binding: undefined }),
  );
  const reviewed = adjudicateAdmission(
    JSON.stringify({
      decisions: [
        {
          claim: 1,
          source: 1,
          sourceQuote: sources[0].text,
          verdict: "not-requested",
          detail: "字段名不是初始内容",
        },
      ],
    }),
    admission,
    sources,
  );
  assert.equal(
    semanticReuse([reviewed], [...sources, { id: "s:2", text: "长度最多100" }])
      .length,
    1,
  );
  assert.equal(
    semanticReuse([reviewed], [{ id: "s:1", text: "初始显示复盘" }]).length,
    0,
  );
  assert.equal(semanticReuse([reviewed], []).length, 0);
});

test("同一字段的名称、必填性、初始内容、动作后值与保留分别冻结，矛盾不覆盖", async () => {
  const { compileSemantics } = await import(
    "../../src/evolution/requirement-semantics.js"
  );
  const quote = "复盘必填，完成后显示复盘，重新打开保留";
  const field: Extract<
    import("../../src/shared/acceptance-obligations.js").AcceptanceObligation,
    { kind: "field" }
  > = {
    version: 1 as const,
    id: "f",
    kind: "field" as const,
    member: "workflow",
    field: "review",
    initialOrigin: "host" as const,
    initial: { kind: "absent" as const },
    scenarios: [{ id: "after", steps: [], value: "已填写" }],
    history: {
      baseVersion: "base",
      actions: [],
      expected: { state: "open", fields: { review: "旧值" } },
      sourceHash: "frozen",
    },
  };
  const p = {
    workflowRules: [
      {
        key: "review",
        label: "复盘",
        required: true,
        minLength: 1,
        maxLength: 100,
      },
    ],
    requirements: [
      {
        id: "r",
        description: quote,
        type: "interface" as const,
        sourceRevision: "s:1",
        sourceQuote: quote,
        checks: [],
        obligations: [field],
      },
    ],
  };
  const state = compileSemantics(p, [{ id: "s:1", text: quote }]);
  const { hash } = await import("../../src/release/storage.js");
  assert.equal(
    hash(state),
    hash(JSON.parse(JSON.stringify(state))),
    "冻结语义必须经持久化往返保持摘要",
  );
  assert.deepEqual(
    state.entries.map((e) => e.target.aspect),
    [
      "label",
      "required",
      "initial-display",
      "post-action-value",
      "preservation",
    ],
  );
  assert.equal(
    state.entries.find((e) => e.target.aspect === "initial-display")!.status,
    "unspecified",
  );
  const modified = structuredClone(p);
  modified.requirements[0].obligations.push({
    ...field,
    initialOrigin: "requirement",
    initial: { kind: "visible", value: "复盘" },
  });
  assert.ok(
    compileSemantics(modified, [{ id: "s:1", text: quote }]).entries.some(
      (e) => e.status === "conflicting",
    ),
  );
  assert.throws(
    () => compileSemantics(p, [{ id: "s:1", text: "已修改来源" }]),
    /依赖失效/,
  );
});
