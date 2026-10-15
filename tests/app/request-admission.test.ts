import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import { PlanningDriver } from "./planning-fixture.js";
import {
  providerSchema,
  schemaProblems,
} from "../../src/evolution/model-protocol.js";
import { clarificationSchema } from "../../src/evolution/clarification-review.js";
import {
  parseAdmission,
  admissionSchema,
} from "../../src/evolution/request-admission.js";
import { technicalFacts } from "../../src/evolution/technical-facts.js";
import { BudgetScheduler } from "../../src/evolution/budget.js";
import { ModelTransportError } from "../../src/evolution/driver.js";

const reply = (value: unknown) => ({
  text: JSON.stringify(value),
  calls: [],
  history: [],
  raw: { fixture: value },
  usage: { totalTokenCount: 7 },
});
const empty = () => ({ presentations: [], questions: [], facts: [] });
const input = (r: ModelRequest) => JSON.parse(r.message ?? "{}");
async function setup(t: test.TestContext, driver: Driver, calls = 12) {
  const dir = await mkdtemp(join(tmpdir(), "cordis-admission-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const e = new Evolution(w.db, driver, new EvolutionDomain(w), {
    calls,
    candidates: 3,
    milliseconds: 600000,
  });
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { w, e };
}
async function settle(e: Evolution) {
  for (let i = 0; i < 1000; i++) {
    const r = (await e.observe()).run!;
    if (r.status !== "planning") return r;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("模型桩规划未结束");
}

test("供应商投影显式声明根必填及分支字段；宿主仍拒绝空对象和跨分支伪造", () => {
  const strict = clarificationSchema();
  const wire = providerSchema(strict);
  assert.ok(Array.isArray(wire.anyOf));
  assert.ok(schemaProblems({}, wire).length);
  assert.ok(schemaProblems({}, strict).length);
  const valid = {
    kind: "business-ambiguity",
    source: 1,
    sourceQuote: "未决定",
    detail: "未决定",
  };
  assert.deepEqual(schemaProblems(valid, strict), []);
  assert.deepEqual(schemaProblems(valid, wire), []);
  assert.ok(
    schemaProblems(
      { ...valid, fact: 1, property: "lengthMetric", expected: "x" },
      wire,
    ).some((p) => p.includes("fact")),
  );
  assert.ok(
    schemaProblems(
      { ...valid, fact: 1, property: "lengthMetric", expected: "x" },
      strict,
    ).length,
  );
  assert.deepEqual(strict, clarificationSchema(), "投影不能改写原验收契约");
  const strings = { type: "string", minLength: 1, maxLength: 8, pattern: "^a" };
  assert.deepEqual(providerSchema(strings), { type: "string" });
  assert.ok(schemaProblems("", strings).length);
  assert.ok(schemaProblems("wrong", strings).length);
  const bounded = {
    type: "array",
    minItems: 1,
    maxItems: 20,
    items: { type: "integer", minimum: 1, maximum: 5 },
  };
  assert.deepEqual(providerSchema(bounded), {
    type: "array",
    minItems: 1,
    items: { type: "integer" },
  });
  assert.ok(schemaProblems([], bounded).length);
  assert.ok(schemaProblems([6], bounded).length);
});

test("互斥步骤不能因供应商投影而混填字段，错误反馈绑定实际kind和具体字段", () => {
  const original = {
    anyOf: [
      {
        type: "object",
        additionalProperties: false,
        required: ["kind"],
        properties: { kind: { type: "string", enum: ["open"] } },
      },
      {
        type: "object",
        additionalProperties: false,
        required: ["kind", "value"],
        properties: {
          kind: { type: "string", enum: ["field"] },
          value: { type: "string" },
        },
      },
    ],
  };
  const wire = providerSchema(original);
  assert.ok(Array.isArray(wire.anyOf));
  assert.deepEqual(schemaProblems({ kind: "open" }, wire), []);
  assert.ok(
    schemaProblems({ kind: "open", value: "非法混填" }, wire).some((p) =>
      p.includes("value: 未授权字段"),
    ),
  );
  assert.ok(
    schemaProblems({ kind: "field" }, wire).some((p) =>
      p.includes("value: 缺少必填字段"),
    ),
  );
});

test("预检不存在状态只提交kind，空值由宿主派生；禁止混入其他分支的value", () => {
  const sources = [{ id: "source", text: "未填写时显示空白" }];
  const facts = technicalFacts({ workflowRules: [], binding: undefined });
  const presentation = {
    source: 1,
    sourceQuote: sources[0].text,
    surface: "auxiliary",
    kind: "absent",
  };
  const admitted = parseAdmission(
    JSON.stringify({ ...empty(), presentations: [presentation] }),
    "base",
    sources,
    facts,
  );
  assert.equal(admitted.presentations[0].value, "");
  assert.ok(admitted.blockers.length);
  assert.throws(
    () =>
      parseAdmission(
        JSON.stringify({
          ...empty(),
          presentations: [{ ...presentation, value: "（空）" }],
        }),
        "base",
        sources,
        facts,
      ),
    /契约分支|未授权字段/,
  );
});

test("JSON合法但来源绑定非法时也在同一交换内有界纠正，不重开运行或丢弃usage", async (t) => {
  const fixture = new PlanningDriver();
  let attempts = 0;
  const { w, e } = await setup(t, {
    async generate(request, signal) {
      if (input(request).kind === "request-admission/1") {
        if (++attempts === 1)
          return reply({
            ...empty(),
            questions: [
              { source: 1, sourceQuote: "伪造引用", question: "是否必填？" },
            ],
          });
        assert.ok(
          input(request)
            .protocolCorrection.problems.join(";")
            .includes("来源原文"),
        );
        assert.ok(
          input(request).protocolCorrection.rejected.text.includes("伪造引用"),
        );
        return reply(empty());
      }
      return fixture.generate(request, signal);
    },
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const r = await settle(e);
  assert.equal(r.status, "ready");
  assert.equal(r.budget?.callsUsed, 4);
  assert.equal(r.protocolFailures?.length, 1);
  assert.equal(
    w.db.prepare("SELECT count(*) AS n FROM evolution_calls").get()!.n,
    4,
  );
});

test("供应商400作为模型契约故障独立阻塞，保留精确传输摘要且不重试或转交业务澄清", async (t) => {
  const { w, e } = await setup(t, {
    async generate() {
      throw new ModelTransportError(
        "synthetic invalid contract",
        { profile: "gemini-3.1-shape/1", schemaHash: "synthetic-wire" },
        400,
      );
    },
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const r = await settle(e);
  assert.equal(r.status, "blocked");
  assert.equal(r.budget?.callsUsed, 1);
  const rows = w.db.prepare("SELECT body FROM evolution_calls").all();
  assert.equal(rows.length, 1);
  const call = JSON.parse(String(rows[0].body));
  assert.equal(call.httpStatus, 400);
  assert.equal(call.transport.schemaHash, "synthetic-wire");
  assert.match("message" in r ? r.message : "", /供应商拒绝.*HTTP 400/);
});

for (const twice of [false, true])
  test(`空对象复核由协议模块统一处理，共用原预算且有界：${twice ? "重复阻塞" : "一次纠正"}`, async (t) => {
    const fixture = new PlanningDriver();
    let intake = 0;
    const { w, e } = await setup(t, {
      async generate(r, s) {
        if (input(r).kind === "request-admission/1") {
          intake++;
          assert.deepEqual(r.history, []);
          assert.equal(r.tools, undefined);
          return reply(twice || intake === 1 ? {} : empty());
        }
        return fixture.generate(r, s);
      },
    });
    await e.command({
      type: "request",
      text: "完成前填写复盘",
      operationId: "request",
    });
    const run = await settle(e);
    assert.equal(run.status, twice ? "blocked" : "ready");
    assert.equal(run.budget?.callsUsed, twice ? 2 : 4);
    assert.equal(run.protocolFailures?.length, twice ? 2 : 1);
    assert.equal(run.budget!.callsUsed + run.budget!.callsRemaining, 12);
    const calls = w.db
      .prepare("SELECT body FROM evolution_calls")
      .all()
      .map((r) => JSON.parse(String(r.body)));
    assert.equal(calls.length, run.budget!.callsUsed);
    assert.deepEqual(
      calls.slice(0, 2).map((c) => c.usage.totalTokenCount),
      [7, 7],
    );
    if (!twice) assert.equal(run.requestAdmissions?.length, 1);
  });

for (const malformed of ["empty", "unknown-tool"])
  test(`无效工具响应在执行任何工具前校验，原调用预算内最多纠正一次：${malformed}`, async (t) => {
    const fixture = new PlanningDriver();
    let failed = false;
    const { e } = await setup(t, {
      async generate(r, s) {
        if (input(r).kind === "request-admission/1") return reply(empty());
        if (r.tools && !failed) {
          failed = true;
          return {
            ...reply({}),
            text: "",
            calls:
              malformed === "empty"
                ? []
                : [{ name: "not-authorized", args: {} }],
          };
        }
        return fixture.generate(r, s);
      },
    });
    await e.command({
      type: "request",
      text: "完成前填写复盘",
      operationId: "request",
    });
    const run = await settle(e);
    assert.equal(run.status, "ready");
    assert.equal(run.budget?.callsUsed, 4);
    assert.equal(run.protocolFailures?.length, 1);
  });

test("明确但无法支持的空白初始呈现在源码调查前阻塞，不能改成降级提问", async (t) => {
  const { w, e } = await setup(t, {
    async generate(r) {
      const v = input(r);
      assert.equal(v.kind, "request-admission/1");
      assert.equal(v.materials, undefined);
      return reply({
        presentations: [
          {
            source: 1,
            sourceQuote: "尚未填写时显示空白",
            surface: "auxiliary",
            kind: "visible",
            value: "",
          },
        ],
        questions: [
          {
            source: 1,
            sourceQuote: "尚未填写时显示空白",
            question: "可否改成（空）？",
          },
        ],
        facts: [],
      });
    },
  });
  const before = JSON.stringify({
    tasks: w.query(),
    composition: w.composition(),
  });
  await e.command({
    type: "request",
    text: "独立备注面板尚未填写时显示空白",
    operationId: "request",
  });
  const run = await settle(e);
  assert.equal(run.status, "blocked");
  assert.equal(run.budget?.callsUsed, 1);
  assert.match("message" in run ? run.message : "", /维护者.*不能替换/);
  assert.equal((await e.observe()).candidates?.length, 0);
  assert.equal(
    JSON.stringify({ tasks: w.query(), composition: w.composition() }),
    before,
  );
  const stored = JSON.parse(
    String(w.db.prepare("SELECT body FROM evolution_runs").get()!.body),
  );
  assert.deepEqual(stored.investigation.deliveries, []);
});

test("必要澄清在预检集中提出，回答使旧预检失效，同一运行4次调用ready", async (t) => {
  const fixture = new PlanningDriver();
  const seen: ModelRequest[] = [];
  const { e } = await setup(t, {
    async generate(r, s) {
      seen.push(r);
      const v = input(r);
      if (v.kind === "request-admission/1")
        return reply({
          ...empty(),
          questions:
            v.sources.length === 1
              ? [
                  {
                    source: 1,
                    sourceQuote: "复盘是否必填尚未决定",
                    question: "复盘是否必填？",
                  },
                ]
              : [],
        });
      return fixture.generate(r, s);
    },
  });
  await e.command({
    type: "request",
    text: "复盘是否必填尚未决定",
    operationId: "request",
  });
  const waiting = await settle(e);
  assert.equal(waiting.status, "awaiting-input");
  assert.equal(waiting.budget?.callsUsed, 1);
  await e.command({
    type: "answer",
    runId: waiting.id,
    text: "复盘必填",
    operationId: "answer",
  });
  const ready = await settle(e);
  assert.equal(ready.id, waiting.id);
  assert.equal(ready.status, "ready");
  assert.equal(ready.budget?.callsUsed, 4);
  assert.equal(ready.requestAdmissions?.length, 2);
  assert.notEqual(
    ready.requestAdmissions![0].sourceHash,
    ready.requestAdmissions![1].sourceHash,
  );
  assert.deepEqual(
    seen
      .filter((r) => input(r).kind === "request-admission/1")
      .map((r) => r.history),
    [[], []],
  );
});

test("澄清预留包含回答后的预检，未达到完整路径预算即阻塞且不提问", async (t) => {
  const { e } = await setup(
    t,
    {
      async generate() {
        return reply({
          ...empty(),
          questions: [
            { source: 1, sourceQuote: "必填未决定", question: "是否必填？" },
          ],
        });
      },
    },
    6,
  );
  await e.command({
    type: "request",
    text: "必填未决定",
    operationId: "request",
  });
  const r = await settle(e);
  assert.equal(r.status, "blocked");
  assert.equal(r.budget?.callsUsed, 1);
  const s = new BudgetScheduler({
    calls: 12,
    candidates: 3,
    milliseconds: 600000,
  });
  assert.equal(s.canClarify(6, true), true);
  assert.equal(s.canClarify(7, true), false);
});

test("预检不能伪造来源和技术事实；环境缺失在模型调用前阻塞", async (t) => {
  const facts = technicalFacts({ workflowRules: [], binding: undefined });
  assert.throws(
    () =>
      parseAdmission(
        JSON.stringify({
          ...empty(),
          questions: [{ source: 1, sourceQuote: "不存在", question: "问题" }],
        }),
        "base",
        [{ id: "s", text: "原文" }],
        facts,
      ),
    /来源/,
  );
  assert.throws(
    () =>
      parseAdmission(
        JSON.stringify({
          ...empty(),
          facts: [
            {
              source: 1,
              sourceQuote: "原文",
              fact: 999,
              property: "p",
              expected: "v",
            },
          ],
        }),
        "base",
        [{ id: "s", text: "原文" }],
        facts,
      ),
    /事实/,
  );
  assert.ok(schemaProblems({}, admissionSchema).length);
  const { w, e } = await setup(t, {
    async generate() {
      throw new Error("不能调用模型");
    },
  });
  // The same public domain seam is exercised with a missing installed checker.
  const domain = new EvolutionDomain(w);
  domain.admission = () => ({ facts, missing: ["Chromium"] });
  await e.close();
  const blocked = new Evolution(
    w.db,
    {
      async generate() {
        throw new Error("不能调用模型");
      },
    },
    domain,
  );
  t.after(() => blocked.close());
  await blocked.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const r = await settle(blocked);
  assert.equal(r.status, "blocked");
  assert.equal(r.budget?.callsUsed, 0);
});
