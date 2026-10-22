import test from "node:test";
import assert from "node:assert/strict";
import {
  frozenClarificationAnswer,
  frozenClarificationReceiptMatches,
} from "../../scripts/lib/stability-eval/clarification.js";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";
import {
  parseAdmission,
  questionReviewKey,
  admissionRequest,
  admissionQuestionState,
  admissionResolved,
} from "../../src/evolution/request-admission.js";
import { parseClarificationReview, clarificationRequest } from "../../src/evolution/clarification-review.js";
import { sourceItems } from "../../src/evolution/source-items.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import { hostEffectIds } from "../../src/evolution/capability-admission.js";

const scenario = currentManifest("a".repeat(40)).scenarios.find(
  (s) => s.id === "clarification-reflection",
)!;
const undecided = "复盘是否必填尚未决定";

test("需求预检公开宿主来源条目，结构化澄清选择条目而不重新抄写引用", () => {
  const sources=[{id:"run:1",text:scenario.request}];
  const facts=technicalFacts({workflowRules:[]});
  const request=admissionRequest(sources,facts);
  const input=JSON.parse(request.message!);
  assert.ok(Array.isArray(input.sourceItems),"宿主必须提供可引用的稳定来源条目");
  const index=input.sourceItems.findIndex((item:{text:string})=>item.text===undecided);
  assert.ok(index>=0);
  const admission=parseAdmission(JSON.stringify({initials:[],effects:[],questions:[{sourceItem:index+1,choice:{kind:"field-required"}}]}),"base",sources,facts);
  assert.equal(admission.questions[0].sourceQuote,undecided);
  assert.equal(admission.questions[0].sourceRevision,"run:1");
});
function awaiting(freeQuestion?: string, sourceQuote = undecided, request = scenario.request) {
  const sources = [{ id: "run:1", text: request }];
  const facts = technicalFacts({ workflowRules: [] });
  const items=JSON.parse(admissionRequest(sources,facts).message!).sourceItems as {text:string}[];
  const itemIndex=items.findIndex(item=>item.text===sourceQuote);
  if(!freeQuestion && itemIndex<0)throw new Error("结构化来源条目不存在");
  const admission = parseAdmission(
    JSON.stringify({
      initials: [],
      effects: [],
      questions: [
        {
          ...(freeQuestion
            ? { source: 1, sourceQuote, question: freeQuestion }
            : { sourceItem:itemIndex+1, choice: { kind: "field-required" } }),
        },
      ],
    }),
    "base",
    sources,
    facts,
  );
  const question = admission.questions[0].question;
  const [{ decision, admissionChoice }] = parseClarificationReview(
    JSON.stringify({
      effects: hostEffectIds.map((effect) => ({
        effect,
        verdict: "not-requested",
      })),
      decisions: [
        {
          kind: "business-ambiguity",
          ...(freeQuestion ? {source:1,sourceQuote} : {}),
          detail: "来源明确只将复盘必填性留待用户决定",
        },
      ],
    }),
    [question],
    sources,
    facts,
    admission.questions,
  );
  return {
    id: "run",
    status: "awaiting-input",
    question,
    requestAdmissions: [admission],
    clarificationReviews: [
      {
        key: questionReviewKey(question, sources, facts),
        question,
        call: 2,
        decision,
        ...(admissionChoice ? {admissionChoice} : {}),
      },
    ],
  };
}

test("冻结答案绑定宿主生成的结构化选择及独立审查，不分析模型自由问法", () => {
  const run = awaiting();
  assert.equal(run.question, `请确认第 ${run.requestAdmissions[0].questions[0].choice!.sourceItem.ordinal} 项原文“${undecided}”中的未决要求：必须填写，还是可以留空？`);
  const result = frozenClarificationAnswer(scenario, run);
  assert.equal(result.answer, scenario.clarification!.answer);
  assert.equal(result.binding.sourceRevision, "run:1");
  assert.equal(result.binding.sourceQuote, undecided);
  assert.equal(
    result.binding.choiceId,
    run.requestAdmissions[0].questions[0].choice!.id,
  );
  for (const question of [
    "完成前填写的复盘是否必须填写？",
    "复盘是必填还是可选？",
  ])
    assert.throws(
      () => frozenClarificationAnswer(scenario, awaiting(question)),
      /结构化/,
    );
});

test("结构化澄清绑定宿主来源条目，不接受自由范围、截断来源或旧主题身份", () => {
  const run = awaiting();
  assert.deepEqual(
    Object.keys(run.requestAdmissions[0].questions[0].choice!).sort(),
    ["id", "kind", "sourceItem"],
  );
  for (const quote of [
    "是否必填尚未决定",
    scenario.request,
  ])
    assert.throws(
      () => frozenClarificationAnswer(scenario, awaiting(undefined, quote)),
      /结构化|冻结/,
    );
  const legacy = awaiting();
  Object.assign(legacy.requestAdmissions[0], { contract: "host-admission/9" });
  assert.throws(
    () => frozenClarificationAnswer(scenario, legacy),
    /来源预检/,
  );
  for (const subjectQuote of ["复盘", "复盘是否必填"]) {
    const admission = run.requestAdmissions[0];
    assert.throws(() => parseAdmission(
      JSON.stringify({
        initials: [], effects: [],
        questions: [{
          source: 1, sourceQuote: undecided,
          choice: { kind: "field-required", subjectQuote },
        }],
      }),
      admission.baseVersion, admission.sources, admission.factsSnapshot,
    ));
  }
});

test("无独立审查、错来源、过期运行或未授权的澄清不能得到冻结答案", () => {
  const noAudit = awaiting();
  noAudit.clarificationReviews = [];
  const wrongSource = awaiting();
  wrongSource.clarificationReviews[0].decision.sourceQuote =
    "其他行为沿用现有工作流";
  const stale = awaiting();
  stale.id = "another-run";
  const corrupted = awaiting();
  corrupted.clarificationReviews[0].decision.effects!.sourceHash = "fabricated";
  for (const run of [noAudit, wrongSource, stale, corrupted])
    assert.throws(
      () => frozenClarificationAnswer(scenario, run),
      /冻结|审查|来源/,
    );
  assert.throws(
    () =>
      frozenClarificationAnswer(
        { ...scenario, clarification: undefined },
        awaiting(),
      ),
    /冻结/,
  );
});

test("同一段自由问题即使审查通过并引用正确，也不能领取结构化未决项的冻结答案", () => {
  const run = awaiting("复盘是否必须填写？另外，所有任务是否必须设置标签？");
  assert.throws(
    () => frozenClarificationAnswer(scenario, run),
    /结构化|冻结|未决项/,
  );
});

test("结构化选择不能夹带自由问题、伪造主题或修改宿主生成问句", () => {
  const sources = [{ id: "run:1", text: scenario.request }],
    facts = technicalFacts({ workflowRules: [] });
  for (const item of [
    {
      source: 1,
      sourceQuote: undecided,
      choice: { kind: "field-required" },
      question: "另外，标签是否必填？",
    },
    {
      source: 1,
      sourceQuote: undecided,
      choice: { kind: "field-required", subjectQuote: "标签" },
    },
  ])
    assert.throws(() =>
      parseAdmission(
        JSON.stringify({ initials: [], effects: [], questions: [item] }),
        "base",
        sources,
        facts,
      ),
    );
  const tampered = awaiting();
  tampered.requestAdmissions[0].questions[0].question +=
    "另外，所有任务是否必须设置标签？";
  assert.throws(
    () => frozenClarificationAnswer(scenario, tampered),
    /预检|冻结/,
  );
  const wrongChoice = {
    ...scenario,
    clarification: {
      ...scenario.clarification!,
      sourceQuote: "其他行为沿用现有工作流",
    },
  };
  assert.throws(
    () => frozenClarificationAnswer(wrongChoice, awaiting()),
    /结构化/,
  );
});

test("独立判定重放来源审查，不接受仅声称提交过正确答案的回执", () => {
  const run = awaiting();
  const proof = frozenClarificationAnswer(scenario, run);
  const receipt = { runId: run.id, question: run.question, ...proof };
  assert.equal(
    frozenClarificationReceiptMatches(
      scenario,
      { ...run, status: "succeeded" },
      receipt,
    ),
    true,
  );
  for (const bad of [
    { ...receipt, binding: undefined },
    { ...receipt, answer: "临时编造答案" },
    { ...receipt, runId: "other" },
    { ...receipt, binding: { ...receipt.binding, auditKey: "fabricated" } },
    { ...receipt, binding: { ...receipt.binding, choiceId: "another-choice" } },
    { ...receipt, binding: { ...receipt.binding, choiceHash: "fabricated" } },
    { ...receipt, binding: { ...receipt.binding, sourceItemId: "another-source-item" } },
  ])
    assert.equal(frozenClarificationReceiptMatches(scenario, run, bad), false);
});

test("宿主条目位置区分重复文本，修订和原文变化使旧身份失效", () => {
  const sources=[{id:"run:1",text:`🧪 复盘，${undecided}；${undecided}`}];
  const items=sourceItems(sources);
  for(const item of items)assert.equal(sources[0].text.slice(item.start,item.end),item.text);
  const duplicates=items.filter(item=>item.text===undecided);
  assert.equal(duplicates.length,2);
  assert.notEqual(duplicates[0].id,duplicates[1].id);
  assert.notEqual(items[0].id,sourceItems([{...sources[0],id:"run:2"}])[0].id);
  assert.notEqual(items[0].id,sourceItems([{...sources[0],text:sources[0].text+"；新要求"}])[0].id);
  const facts=technicalFacts({workflowRules:[]});
  const indexes=duplicates.map(item=>items.indexOf(item)+1);
  const admission=parseAdmission(JSON.stringify({initials:[],effects:[],questions:indexes.map(sourceItem=>({sourceItem,choice:{kind:"field-required"}}))}),"base",sources,facts);
  assert.notEqual(admission.questions[0].question,admission.questions[1].question);
  const [{decision,admissionChoice}]=parseClarificationReview(JSON.stringify({effects:hostEffectIds.map(effect=>({effect,verdict:"not-requested"})),decisions:[{kind:"business-ambiguity",detail:"只复核第一个问题"}]}),[admission.questions[0].question],sources,facts,[admission.questions[0]]);
  const state=admissionQuestionState(admission,sources,facts,[{key:questionReviewKey(admission.questions[0].question,sources,facts),decision,admissionChoice}]);
  assert.deepEqual(state.pendingTargets,[admission.questions[1]]);
  const repeatedScenario={...scenario,request:scenario.request+`；${undecided}`};
  assert.throws(()=>frozenClarificationAnswer(repeatedScenario,awaiting(undefined,undecided,repeatedScenario.request)),/唯一|冻结/);
});

test("结构化复核不接受模型重写引用、目标身份、跨问题分支或缺失证明",()=>{
  const run=awaiting();
  const admission=run.requestAdmissions[0],target=admission.questions[0];
  const request=clarificationRequest([target.question],admission.sources,admission.factsSnapshot,undefined,[target]);
  assert.deepEqual(request.history,[]);
  assert.equal(request.tools,undefined);
  const effects=hostEffectIds.map(effect=>({effect,verdict:"not-requested"}));
  const decision={kind:"business-ambiguity",detail:"原文明确尚未决定"};
  for(const extra of [{source:1,sourceQuote:undecided+"，请先集中问我这一项"},{targetId:"伪造"},{sourceItem:1}])
    assert.throws(()=>parseClarificationReview(JSON.stringify({effects,decisions:[{...decision,...extra}]}),[target.question],admission.sources,admission.factsSnapshot,[target]),/未授权|分支/);
  const free={sourceRevision:target.sourceRevision,sourceQuote:"其他行为沿用现有工作流",question:"是否修改其他行为？"};
  const freeDecision={kind:"unnecessary",source:1,sourceQuote:free.sourceQuote,detail:"原文已要求沿用既有行为"};
  const questions=[target.question,free.question],targets=[target,free];
  const mixed=parseClarificationReview(JSON.stringify({effects,decisions:[decision,freeDecision]}),questions,admission.sources,admission.factsSnapshot,targets);
  assert.ok(mixed[0].admissionChoice);
  assert.equal(mixed[1].admissionChoice,undefined);
  assert.throws(()=>parseClarificationReview(JSON.stringify({effects,decisions:[freeDecision,decision]}),questions,admission.sources,admission.factsSnapshot,targets),/未授权|分支|source/);
  const tampered=structuredClone(target);
  tampered.choice!.sourceItem.start++;
  assert.throws(()=>clarificationRequest([target.question],admission.sources,admission.factsSnapshot,undefined,[tampered]),/绑定/);
  const noProof=awaiting();
  delete noProof.clarificationReviews[0].admissionChoice;
  assert.throws(()=>frozenClarificationAnswer(scenario,noProof),/独立审查/);
  const notRequired=awaiting();
  notRequired.clarificationReviews[0].decision.kind="unnecessary";
  assert.throws(()=>frozenClarificationAnswer(scenario,notRequired),/独立审查/);
  const altered=awaiting();
  altered.requestAdmissions[0].questions[0].choice!.sourceItem.id="other-item";
  assert.equal(admissionResolved(altered.requestAdmissions[0]),false);
});

test("结构化来源索引由宿主校验，旧引用契约、重复选择和不存在条目都拒绝",()=>{
  const run=awaiting(),admission=run.requestAdmissions[0];
  const catalog=sourceItems(admission.sources);
  const selected=catalog.findIndex(item=>item.text===undecided)+1;
  for(const questions of [
    [{sourceItem:0,choice:{kind:"field-required"}}],
    [{sourceItem:catalog.length+1,choice:{kind:"field-required"}}],
    [{sourceItem:1.5,choice:{kind:"field-required"}}],
    [{sourceItem:selected,choice:{kind:"field-required"}},{sourceItem:selected,choice:{kind:"field-required"}}],
    [{sourceItem:selected,source:1,sourceQuote:undecided,choice:{kind:"field-required"}}],
    [{source:1,sourceQuote:undecided,choice:{kind:"field-required"}}],
  ])assert.throws(()=>parseAdmission(JSON.stringify({initials:[],effects:[],questions}),admission.baseVersion,admission.sources,admission.factsSnapshot));
});
