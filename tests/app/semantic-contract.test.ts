import { fieldTargetId } from "../../src/evolution/field-identity.js";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "./evolution-adapter.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver } from "./planning-fixture.js";
import { ExecutionDriver } from "./execution-fixture.js";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseInitialMeaning } from "../../src/evolution/requirement-semantics.js";
import {
  parseAdmission,
  adjudicateAdmission,
  admissionResolved,
  admissionSchema,
} from "../../src/evolution/request-admission.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import { fieldFacts } from "../../src/evolution/field-identity.js";
import { parseFieldDecisions } from "../../src/evolution/field-review.js";
import type { InvestigatedPlan } from "../../src/shared/assistant.js";
import {
  ModelTransportError,
  type ModelReply,
} from "../../src/evolution/driver.js";
import { DeepSeek } from "../../src/evolution/deepseek.js";
import {
  scoreSemanticReply,
  semanticFailure,
} from "../../scripts/lib/semantic-evaluation.js";
import {
  admissionRequest,
  admissionReviewRequest,
} from "../../src/evolution/request-admission.js";

const quote =
  "尚未填写时显示空白；也可显示文字“空白”，或不显示字段；之后点击保存写入 reviewed";
const sources = [{ id: "source:1", text: quote }];
const facts = [
  ...technicalFacts({ workflowRules: [], binding: undefined }),
  ...fieldFacts([
    {
      member: "panel",
      contribution: "note-panel",
      field: "noteMark",
      label: "备注标记",
    },
  ]),
];
const meaning = (kind: string) => ({
  kind,
  conditionQuote: "尚未填写时",
  effectQuote: "显示空白",
});
const payload = (m: unknown) => ({
  presentations: [
    {
      source: 1,
      sourceQuote: quote,
      target: {
        kind: "existing",
        targetId: fieldTargetId({
          member: "panel",
          contribution: "note-panel",
          field: "noteMark",
        }),
      },
      meaning: m,
    },
  ],
  questions: [],
});
const parse = (m: unknown, fs = facts) =>
  parseAdmission(JSON.stringify(payload(m)), "base", sources, fs);
const judgment = (verdict: string) =>
  JSON.stringify({
    decisions: [
      {
        claim: 1,
        source: 1,
        sourceQuote: quote,
        verdict,
        detail: "独立来源裁决",
      },
    ],
  });

test("初始呈现的空白、字面文字、隐藏、未要求及未决定是互斥类型", () => {
  assert.deepEqual(parseInitialMeaning(meaning("blank"), quote).initial, {
    kind: "visible",
    value: "",
  });
  assert.deepEqual(
    parseInitialMeaning({ ...meaning("literal"), value: "空白" }, quote)
      .initial,
    { kind: "visible", value: "空白" },
  );
  assert.deepEqual(parseInitialMeaning(meaning("hidden"), quote).initial, {
    kind: "absent",
  });
  assert.deepEqual(
    parseInitialMeaning({ kind: "unspecified" }, quote).initial,
    { kind: "unspecified" },
  );
  assert.deepEqual(
    parseInitialMeaning(
      { kind: "undetermined", questionQuote: "也可显示文字“空白”" },
      quote,
    ).initial,
    { kind: "undetermined" },
  );
  for (const m of [
    { ...meaning("blank"), value: "空白" },
    { ...meaning("literal"), value: "" },
    { ...meaning("hidden"), value: "" },
    { kind: "unspecified", effectQuote: quote },
  ])
    assert.throws(() => parseInitialMeaning(m, quote));
  assert.throws(
    () =>
      parseInitialMeaning(
        { ...meaning("blank"), conditionQuote: "伪造条件" },
        quote,
      ),
    /引用/,
  );
});

test("预检禁止模型事实三元组，实际绑定由宿主生成且与目录顺序无关", () => {
  assert.equal("facts" in admissionSchema(facts).properties, false);
  const a = parse(meaning("blank")),
    b = parse(meaning("blank"), [...facts].reverse());
  assert.deepEqual(a.technicalChecks, b.technicalChecks);
  assert.equal(
    a.technicalChecks[0].factId,
    "host-fact:initial-field-presentation",
  );
  assert.deepEqual(a.technicalChecks[0].expected, {
    kind: "visible",
    value: "",
  });
  assert.deepEqual(a.technicalChecks[0].actual, {
    kind: "visible",
    value: "（空）",
  });
  assert.equal(a.technicalChecks[0].outcome, "unsupported");
  assert.throws(
    () =>
      parseAdmission(
        JSON.stringify({
          ...payload(meaning("blank")),
          facts: [{ fact: 13, property: "field", expected: "noteMark" }],
        }),
        "base",
        sources,
        facts,
      ),
    /未授权/,
  );
});

test("独立来源复核只裁决命题，不重写 meaning；不支持的真要求仍阻塞", () => {
  const a = parse(meaning("blank"));
  const required = adjudicateAdmission(judgment("entailed"), a, sources);
  assert.ok(admissionResolved(required));
  assert.equal(required.blockers.length, 1);
  const notRequested = adjudicateAdmission(
    judgment("not-requested"),
    a,
    sources,
  );
  assert.ok(admissionResolved(notRequested));
  assert.equal(notRequested.blockers.length, 0);
  const uncertain = adjudicateAdmission(judgment("uncertain"), a, sources);
  assert.match(uncertain.blockers[0], /尚未裁决/);
  const illegal = JSON.parse(judgment("not-requested"));
  illegal.decisions[0].meaning = meaning("hidden");
  assert.throws(
    () => adjudicateAdmission(JSON.stringify(illegal), a, sources),
    /未授权/,
  );
  for (const change of [
    (r: typeof required) => {
      r.technicalChecks[0].expected = { kind: "visible", value: "（空）" };
    },
    (r: typeof required) => {
      r.claims = [];
      r.semanticReview = undefined;
      r.blockers = [];
    },
    (r: typeof required) => {
      r.initialMeanings = [];
      r.presentations = [];
    },
  ]) {
    const altered = structuredClone(required);
    change(altered);
    assert.equal(admissionResolved(altered), false);
  }
  const old = { ...required, contract: "host-admission/5" };
  assert.equal(admissionResolved(old as typeof required), false);
});

test("逐字段独立提取仍发现遗漏的空白要求，不能用来源裁决替代完整需求复核", () => {
  const p = {
    requirements: [
      {
        id: "r",
        sourceRevision: "source:1",
        sourceQuote: quote,
        obligations: [
          {
            id: "field",
            kind: "field",
            initialOrigin: "host",
            initial: { kind: "visible", value: "（空）" },
          },
        ],
      },
    ],
  } as unknown as InvestigatedPlan;
  const result = parseFieldDecisions(
    [{ target: 1, source: 1, sourceQuote: quote, initial: meaning("blank") }],
    p,
    sources,
  );
  assert.equal(result.issues.length, 1);
  assert.equal(result.issues[0].kind, "omission");
  assert.deepEqual(result.decisions[0].initial, { kind: "visible", value: "" });
});

test("旧真实错误响应不补造通过收据；保留三份失败原文", () => {
  const archive = JSON.parse(
    readFileSync(
      new URL("../fixtures/semantic-contract-replay.json", import.meta.url),
      "utf8",
    ),
  ) as { responses: { id: string; text: string }[] };
  assert.equal(archive.responses.length, 3);
  for (const r of archive.responses) {
    if (r.id.startsWith("admission-"))
      assert.throws(() => parseAdmission(r.text, "base", sources, facts));
    else
      assert.throws(() =>
        adjudicateAdmission(r.text, parse(meaning("blank")), sources),
      );
  }
});

test("真实阶段评测复用生产请求，协议错误、业务错误及完整成功分开计数", () => {
  const request = admissionRequest(sources, facts);
  assert.deepEqual(request.history, []);
  assert.equal(request.tools, undefined);
  const review = admissionReviewRequest(parse(meaning("blank")), sources);
  assert.deepEqual(review.history, []);
  assert.equal(review.tools, undefined);
  assert.equal(
    "meaning" in
      JSON.parse(JSON.stringify(review.schema)).properties.decisions.items
        .properties,
    false,
  );
  const response: ModelReply = {
    text: JSON.stringify({ presentations: [], questions: [] }),
    calls: [],
    history: [],
    raw: {},
    usage: null,
    transport: {
      requestedModel: "deepseek-flash",
      actualModel: "deepseek-flash",
      finishReason: "stop",
      envelopeValid: true,
    },
  };
  assert.equal(
    scoreSemanticReply(request, response, "deepseek-flash", () => true)
      .category,
    "passed",
  );
  assert.equal(
    scoreSemanticReply(request, response, "deepseek-flash", () => false)
      .category,
    "semantics",
  );
  assert.equal(
    scoreSemanticReply(
      request,
      { ...response, text: "{}" },
      "deepseek-flash",
      () => true,
    ).category,
    "protocol",
  );
});

test("正文超时保留适配器抛出的完整 failure，不能只保存最后一次进度或按语义错误统计", async () => {
  let progress: ModelReply["transport"];
  const hold = setTimeout(() => undefined, 500);
  const http: typeof fetch = async (_url, init) =>
    new Response(
      new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener(
            "abort",
            () => controller.error(init!.signal!.reason),
            { once: true },
          );
        },
      }),
      { status: 200 },
    );
  try {
    await assert.rejects(
      new DeepSeek("synthetic-key", http).generate(
        { instruction: "synthetic", history: [], phase: "review" },
        AbortSignal.timeout(20),
        (p) => {
          progress = p;
        },
      ),
      (error) => {
        assert.ok(error instanceof ModelTransportError);
        const result = semanticFailure(error, progress);
        assert.equal(progress?.failure, undefined);
        assert.equal(result.category, "transport");
        assert.equal(result.transport?.failure?.kind, "timeout");
        assert.equal(result.transport?.http?.bodyBytes, 0);
        return true;
      },
    );
  } finally {
    clearTimeout(hold);
  }
});

for (const phase of ["start", "apply"] as const)
  for (const change of ["legacy", "catalog"] as const)
    test(`${change === "legacy" ? "旧语义收据" : "字段目录变化"}不能通过真实 ${phase} 门禁，不补造历史通过记录`, async (t) => {
      const directory = await mkdtemp(
        join(tmpdir(), "semantic-contract-gate-"),
      );
      const w = await Workspace.open(join(directory, "workspace.db"));
      const domain = new EvolutionDomain(w);
      const e = new Evolution(
        w.db,
        new ExecutionDriver(new PlanningDriver()),
        domain,
      );
      t.after(async () => {
        await e.close();
        await w.close();
        await rm(directory, { recursive: true, force: true });
      });
      const settle = async () => {
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline) {
          const r = (await e.observe()).run!;
          if (!["planning", "executing"].includes(r.status)) return r;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("合成门禁测试未结束");
      };
      await e.command({
        type: "request",
        text: "完成前填写复盘",
        operationId: "request",
      });
      let ready = await settle();
      assert.equal(ready.status, "ready");
      if (ready.status !== "ready") return;
      const before = w.composition();
      if (phase === "apply") {
        await e.command({
          type: "start",
          runId: ready.id,
          planId: ready.plan.id,
          operationId: "start",
        });
        ready = await settle();
        assert.equal(ready.status, "awaiting-apply");
        if (ready.status !== "awaiting-apply") return;
      }
      if (!("plan" in ready)) throw new Error("missing plan");
      const calls = ready.budget!.callsUsed,
        plan = structuredClone(ready.plan);
      if (change === "legacy") {
        Object.assign(plan.requestAdmission!, { contract: "host-admission/5" });
        const stored = JSON.parse(
          String(
            w.db
              .prepare("SELECT body FROM evolution_runs WHERE id=?")
              .get(ready.id)!.body,
          ),
        );
        stored.plan = plan;
        stored.run.plan = plan;
        w.db
          .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
          .run(JSON.stringify(stored), ready.id);
      } else {
        const current = domain.admission.bind(domain);
        domain.admission = (context) => {
          const inputs = current(context);
          return {
            ...inputs,
            facts: [
              ...inputs.facts,
              ...fieldFacts([
                { member: "added", field: "brandNew", label: "新增字段" },
              ]),
            ],
          };
        };
      }
      if (phase === "start")
        await assert.rejects(
          e.command({
            type: "start",
            runId: ready.id,
            planId: plan.id,
            operationId: "invalid-start",
          }),
          /预检|完整性|冻结|规格|规划/,
        );
      else {
        const candidate = (await e.observe()).candidates!.find(
          (c) => c.passed,
        )!;
        assert.ok(candidate.evidenceHash);
        await assert.rejects(
          e.command({
            type: "apply",
            runId: ready.id,
            candidateId: candidate.id,
            evidenceHash: candidate.evidenceHash!,
            compositionRevision: before.revision,
            operationId: "invalid-apply",
          }),
          /预检|完整性|冻结|规格|规划/,
        );
      }
      assert.equal((await e.observe()).run!.budget!.callsUsed, calls);
      assert.deepEqual(w.composition(), before);
    });
