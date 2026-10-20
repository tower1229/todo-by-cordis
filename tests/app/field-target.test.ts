import test from "node:test";
import assert from "node:assert/strict";
import { hash } from "../../src/release/storage.js";
import { readFileSync } from "node:fs";
import {
  fieldFacts,
  fieldTargetId,
  fieldTargets,
  baselineFields,
} from "../../src/evolution/field-identity.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import {
  parseAdmission,
  adjudicateAdmission,
  admissionRequest,
  admissionResolved,
  admissionKey,
} from "../../src/evolution/request-admission.js";
import {
  compileSemantics,
  type SemanticPlan,
} from "../../src/evolution/requirement-semantics.js";
import { schemaProblems } from "../../src/evolution/model-protocol.js";

const identity = {
  member: "panel",
  contribution: "note-panel",
  field: "noteMark",
  label: "备注标记",
};
const targetId =
  "field-target:" +
  hash([identity.member, identity.contribution, identity.field]).slice(0, 24);
const sources = [{ id: "s:1", text: "panel 的 noteMark 尚未填写时显示空白" }];
const facts = [
  ...technicalFacts({ workflowRules: [], binding: undefined }),
  ...fieldFacts([identity]),
];
const payload = (target: unknown) => ({
  effects: [], initials: [
    {
      source: 1,
      sourceQuote: sources[0].text,
      target,
      meaning: {
        kind: "blank",
        conditionQuote: "尚未填写时",
        effectQuote: "显示空白",
      },
    },
  ],
  questions: [],
});
const parse = (target: unknown) =>
  parseAdmission(JSON.stringify(payload(target)), "base", sources, facts);

test("已注册数据字段没有UI贡献时仍有宿主身份，有贡献时保留精确界面身份", () => {
  const context = {pluginId:"primary", files:{"active-contract":{content:JSON.stringify({fields:[]}),hash:"base"}},
    registeredFields:[{providerId:"tags",key:"tags",label:"标签"},{providerId:"due",key:"dueAt",label:"截止时间"}],uiContributions:[]};
  const fields = baselineFields(context);
  assert.deepEqual(fields,[{member:"tags",field:"tags",label:"标签"},{member:"due",field:"dueAt",label:"截止时间"}]);
  assert.equal(fieldTargets(fieldFacts(fields)).length,2);
  assert.deepEqual(baselineFields({...context,uiContributions:[{id:"tags-detail",providerId:"tags",fields:[{key:"tags",label:"标签"}],actions:[]}]}),[
    {member:"due",field:"dueAt",label:"截止时间"},
    {member:"tags",contribution:"tags-detail",field:"tags",label:"标签"},
  ]);
});

test("已有字段以宿主目标绑定，不支持的初始要求仍在预检裁决后阻塞", () => {
  const a = parse({ kind: "existing", targetId });
  assert.equal(a.initialMeanings[0].surface, "auxiliary");
  assert.equal(a.technicalChecks[0].outcome, "unsupported");
  assert.equal(a.technicalChecks[0].target?.member, "panel");
  const reviewed = adjudicateAdmission(
    JSON.stringify({
      decisions: [
        {
          claim: 1,
          source: 1,
          sourceQuote: sources[0].text,
          layer: "initial-display", verdict: "entailed",
          detail: "明确要求空白",
        },
      ],
    }),
    a,
    sources,
  );
  assert.equal(reviewed.blockers.length, 1);
});

test("新字段声明不能把目录中的裸键、标签或宿主限定身份退回 deferred", () => {
  for (const name of ["noteMark", "备注标记", "panel.noteMark"])
    assert.throws(() => parse({ kind: "new", name }), /已有字段|目标/);
});

test("旧自由字段写入契约被拒绝，不继续接收 panel.noteMark 字符串", () => {
  const old = {
    source: 1,
    sourceQuote: sources[0].text,
    field: "panel.noteMark",
    meaning: {
      kind: "blank",
      conditionQuote: "尚未填写时",
      effectQuote: "显示空白",
    },
  };
  assert.throws(() =>
    parseAdmission(
      JSON.stringify({ effects: [], initials: [old], questions: [] }),
      "base",
      sources,
      facts,
    ),
  );
});

test("目录为同名字段和重复标签签发不同目标，顺序变化不改变身份", () => {
  const identities = [
    identity,
    { ...identity, member: "other" },
    { ...identity, contribution: "second-panel" },
  ];
  const fs = [
    ...facts.filter((f) => !f.id.startsWith("host-fact:field-identity:")),
    ...fieldFacts(identities),
  ];
  const catalog = fieldTargets(fs);
  assert.equal(catalog.length, 3);
  assert.equal(new Set(catalog.map((f) => f.targetId)).size, 3);
  assert.deepEqual(fieldTargets([...fs].reverse()), catalog);
  for (const target of catalog) {
    const receipt = parseAdmission(
      JSON.stringify(payload({ kind: "existing", targetId: target.targetId })),
      "base",
      sources,
      fs,
    );
    assert.deepEqual(receipt.technicalChecks[0].target, target);
  }
  const changedLabel = { ...identity, label: "changed" };
  assert.equal(fieldTargetId(changedLabel), targetId);
  assert.notEqual(
    admissionKey("base", sources, fs),
    admissionKey("base", sources, [
      ...fs,
      ...fieldFacts([{ ...identity, label: "changed" }]),
    ]),
  );
});

test("同一来源中的同名字段各有独立命题及裁决，不能借一个目标的裁决覆盖另一目标", () => {
  const identities = [identity, { ...identity, member: "other" }];
  const fs = [
    ...facts.filter((f) => !f.id.startsWith("host-fact:field-identity:")),
    ...fieldFacts(identities),
  ];
  const raw = {
    effects: [], initials: identities.map(
      (i) =>
        payload({ kind: "existing", targetId: fieldTargetId(i) })
          .initials[0],
    ),
    questions: [],
  };
  const a = parseAdmission(JSON.stringify(raw), "base", sources, fs);
  assert.equal(new Set(a.claims.map((c) => c.id)).size, 2);
  const reviewed = adjudicateAdmission(
    JSON.stringify({
      decisions: a.claims.map((c, index) => ({
        claim: index + 1,
        source: 1,
        sourceQuote: sources[0].text,
        layer: "initial-display", verdict:
          c.interpretation.member === "panel" ? "not-requested" : "entailed",
        detail: "各自裁决",
      })),
    }),
    a,
    sources,
  );
  const state = compileSemantics(plan(reviewed, identities), sources);
  assert.equal(
    state.entries.find((e) => e.target.subject === "other:note-panel:noteMark")
      ?.status,
    "specified",
  );
  assert.ok(
    state.entries.some(
      (e) =>
        e.target.subject === "panel:note-panel:noteMark" &&
        e.status === "conflicting",
    ),
  );
});

test("原生 schema 与宿主解析共同拒绝伪造目标和跨分支参数，不依赖供应商 strict", () => {
  const request = admissionRequest(sources, facts);
  assert.deepEqual(
    JSON.parse(request.message!).fieldTargets,
    fieldTargets(facts),
  );
  for (const target of [
    { kind: "existing", targetId: "missing" },
    { kind: "existing", targetId, name: "noteMark" },
    { kind: "new", name: "brandNew", targetId },
  ]) {
    assert.ok(schemaProblems(payload(target), request.schema!).length);
    assert.throws(() => parse(target));
  }
  const altered = structuredClone(facts);
  altered.find((f) => f.properties.targetId === targetId)!.properties.member =
    "workflow";
  assert.throws(() => admissionRequest(sources, altered), /目录证据/);
});

const plan = (
  receipt: ReturnType<typeof parse>,
  fields: { member: string; field: string; contribution?: string }[],
): SemanticPlan => ({
  workflowRules: [],
  requestAdmission: receipt,
  requirements: fields.map((field, index) => ({
    id: "r" + index,
    sourceRevision: sources[0].id,
    sourceQuote: sources[0].text,
    description: sources[0].text,
    type: "interface",
    checks: [],
    obligations: [
      {
        version: 1,
        id: "f" + index,
        kind: "field",
        ...field,
        initial: { kind: "visible", value: "" },
        initialOrigin: "requirement",
        scenarios: [],
      },
    ],
  })),
});
const conflicting = (p: SemanticPlan) =>
  compileSemantics(p, sources).entries.some((e) => e.status === "conflicting");

test("既有目标贯穿规划语义，不能借同键字段或另一贡献替换身份", () => {
  const a = parse({ kind: "existing", targetId });
  assert.equal(conflicting(plan(a, [identity])), false);
  assert.equal(conflicting(plan(a, [{ ...identity, member: "other" }])), true);
  assert.equal(
    conflicting(plan(a, [{ ...identity, contribution: "other-panel" }])),
    true,
  );
  assert.equal(conflicting(plan(a, [])), true);
});

test("新字段只能绑定唯一的新编译身份，不能借来源引用回落到已有字段", () => {
  const a = parse({ kind: "new", name: "brandNew" });
  assert.equal(
    conflicting(plan(a, [{ member: "added", field: "brandNew" }])),
    false,
  );
  assert.equal(conflicting(plan(a, [identity])), true);
  assert.equal(
    conflicting(plan(a, [{ member: identity.member, field: identity.field }])),
    true,
  );
  assert.equal(
    conflicting(plan(a, [{ ...identity, contribution: "new-panel" }])),
    true,
  );
  assert.equal(
    conflicting(
      plan(a, [
        { member: "added", field: "brandNew" },
        { member: "other", field: "brandNew" },
      ]),
    ),
    true,
  );
  assert.equal(conflicting(plan(a, [])), true);
});

test("未知归属不代表技术上可支持：两类渲染器都不支持空白时经来源复核提前阻塞", () => {
  const a = parse({ kind: "new", name: "brandNew" });
  assert.equal(a.initialMeanings[0].surface, "unbound");
  assert.equal(a.technicalChecks[0].outcome, "unsupported");
  assert.deepEqual(a.technicalChecks[0].possible, [
    { kind: "absent" },
    { kind: "visible", value: "（空）" },
  ]);
  const reviewed = adjudicateAdmission(
    JSON.stringify({
      decisions: [
        {
          claim: 1,
          source: 1,
          sourceQuote: sources[0].text,
          layer: "initial-display", verdict: "entailed",
          detail: "来源明确",
        },
      ],
    }),
    a,
    sources,
  );
  assert.ok(admissionResolved(reviewed));
  assert.equal(reviewed.blockers.length, 1);
  // A renderer match or missing technical facts cannot fabricate a unique supported owner.
  const hidden = payload({ kind: "new", name: "brandNew" });
  hidden.initials[0].meaning.kind = "hidden";
  const deferred = parseAdmission(
    JSON.stringify(hidden),
    "base",
    sources,
    facts,
  );
  assert.equal(deferred.technicalChecks[0].outcome, "deferred");
  const incomplete = parseAdmission(
    JSON.stringify(payload({ kind: "new", name: "brandNew" })),
    "base",
    sources,
    fieldFacts([identity]),
  );
  assert.equal(incomplete.technicalChecks[0].outcome, "deferred");
});

test("目录、目标和派生证据不可同步篡改，旧收据要求重新规划", () => {
  const a = parse({ kind: "existing", targetId });
  for (const alter of [
    (r: typeof a) => {
      r.contract = "host-admission/5" as typeof r.contract;
    },
    (r: typeof a) => {
      r.initialMeanings[0].target!.member = "workflow";
      r.technicalChecks[0].target!.member = "workflow";
    },
    (r: typeof a) => {
      r.fieldCatalog = [];
      r.technicalChecks = [];
      r.initialMeanings = [];
      r.presentations = [];
      r.claims = [];
    },
  ]) {
    const r = structuredClone(a);
    alter(r);
    assert.equal(admissionResolved(r), false);
  }
});

test("两份旧真实限定名称响应原文重放被拒绝，定向宿主目标示例只计离线证据", () => {
  const archive = JSON.parse(
    readFileSync(
      new URL("../fixtures/field-target-replay.json", import.meta.url),
      "utf8",
    ),
  ) as {
    responses: {
      id: string;
      sources: typeof sources;
      text: string;
      actualModel: string;
    }[];
  };
  assert.equal(archive.responses.length, 2);
  for (const response of archive.responses) {
    assert.equal(response.actualModel, "deepseek-flash");
    assert.equal(
      JSON.parse(response.text).presentations[0].field,
      "panel.noteMark",
    );
    assert.throws(() =>
      parseAdmission(response.text, "base", response.sources, facts),
    );
  }
});
