import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver } from "./planning-fixture.js";
import { settleEvolution } from "./evolution-adapter.js";
import {
  compileDefaults,
  parseDefaultReviews,
  answerText,
  questionsFor,
} from "../../src/evolution/interaction.js";
import { budgetPause } from "../../src/evolution/budget-authorization.js";
import { BudgetScheduler } from "../../src/evolution/budget.js";

test("预算暂停原地追加、幂等且跨重启保留原授权与阶段结果", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-budget-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  const driver = new PlanningDriver();
  let e = new Evolution(w.db, driver, new EvolutionDomain(w), {
    calls: 5,
    candidates: 3,
    milliseconds: 600000,
  });
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    operationId: randomUUID(),
    text: "完成任务前必须填写复盘",
  });
  let run = await settleEvolution(e, "awaiting-budget");
  if (run.status !== "awaiting-budget") throw new Error("not paused");
  const id = run.id,
    pause = run.pause;
  assert.equal(run.budget?.callsUsed, 0);
  await assert.rejects(
    e.command({
      type: "request",
      operationId: randomUUID(),
      text: "另一项改进",
    }),
    /请先完成或取消/,
  );
  await assert.rejects(
    e.command({
      type: "resume-budget",
      runId: id,
      operationId: randomUUID(),
      pauseRevision: pause.revision,
      amounts: { calls: 0, candidates: 0, milliseconds: 0 },
    }),
    /不足/,
  );
  await e.close();
  e = new Evolution(w.db, driver, new EvolutionDomain(w), {
    calls: 99,
    candidates: 99,
    milliseconds: 9999999,
  });
  assert.equal((await e.observe()).run?.budget?.authorized?.calls, 5);
  const command = {
    type: "resume-budget" as const,
    runId: id,
    operationId: randomUUID(),
    pauseRevision: pause.revision,
    amounts: pause.suggested,
  };
  const first = await e.command(command);
  assert.deepEqual(await e.command(command), first);
  run = await settleEvolution(e, "ready");
  assert.equal(run.id, id);
  assert.equal(run.budget?.authorized?.calls, 11);
  assert.equal(run.budget?.efficiencyTarget, 5);
  assert.equal(run.budget?.grants?.length, 1);
  assert.equal(
    driver.requests.filter(
      (r) => JSON.parse(r.message ?? "{}").kind === "request-admission/2",
    ).length,
    1,
  );
  await assert.rejects(
    e.command({ ...command, operationId: randomUUID() }),
    /过期/,
  );
});

test("建议追加同时补齐后续阶段时间与候选缺口", () => {
  const pause = budgetPause({
    revision: 1,
    resume: "plan",
    resource: "calls",
    phase: "planning",
    limits: { calls: 12, candidates: 3, milliseconds: 600000 },
    calls: 8,
    candidates: 3,
    elapsed: 590000,
    message: "不足",
  });
  assert.equal(pause.suggested.calls, 6);
  assert.equal(pause.suggested.candidates, 1);
  assert(pause.suggested.milliseconds >= 900000);
  const limits = {
    calls: 12 + pause.suggested.calls,
    candidates: 3 + pause.suggested.candidates,
    milliseconds: 600000 + pause.suggested.milliseconds,
  };
  new BudgetScheduler(limits).admit(
    8,
    "planning",
    limits.milliseconds - 590000,
  );
});

test("可修正的规划诊断在调用预留边界暂停，追加后保留诊断并继续独立复核", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-plan-correction-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  const driver = new PlanningDriver();
  const domain = new EvolutionDomain(w);
  const parse = domain.parse.bind(domain);
  let proposals = 0;
  domain.parse = (...args) => {
    const parsed = parse(...args);
    if (++proposals === 1) parsed.blockers.push("案例的前置状态缺少可达准备步骤");
    return parsed;
  };
  const e = new Evolution(w.db, driver, domain, {calls: 6, candidates: 3, milliseconds: 600000});
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(directory, {recursive: true, force: true});
  });
  await e.command({type: "request", operationId: randomUUID(), text: "完成任务前必须填写复盘"});
  const paused = await settleEvolution(e, "awaiting-budget");
  assert.equal(paused.status, "awaiting-budget");
  if (paused.status !== "awaiting-budget") throw new Error("not paused");
  assert.equal(paused.pause.resource, "calls");
  assert.equal(proposals, 1);
  assert.equal(paused.budget?.callsUsed, 2);
  assert.equal(paused.plans?.length, 1);
  await e.command({type: "resume-budget", operationId: randomUUID(), runId: paused.id, pauseRevision: paused.pause.revision, amounts: paused.pause.suggested});
  const ready = await settleEvolution(e, "ready");
  assert.equal(ready.status, "ready");
  assert.equal(ready.id, paused.id);
  assert.equal(proposals, 2);
  assert.equal(ready.budget?.efficiencyTarget, 6);
  assert.equal(ready.budget?.callsUsed, 4);
  assert(driver.requests.some(request => JSON.stringify(request.history).includes("案例的前置状态缺少可达准备步骤")));
  assert.equal(driver.requests.filter(request => JSON.parse(request.message ?? "{}").kind === "request-admission/2").length, 1);
  assert.equal(driver.requests.filter(request => request.phase === "review").length, 1);
});

test("默认记录必须有独立逐项裁决，用户回答必须绑定当前问题及合法选项", () => {
  const defaults = compileDefaults([
    {
      scope: "日期输入",
      behavior: "精确到分钟",
      basis: "常规日期控件",
      impact: "可在方案开始前修改",
    },
  ]);
  assert.throws(() => parseDefaultReviews([], defaults, []), /缺少独立复核/);
  const reviews = parseDefaultReviews(
    [
      {
        id: defaults[0].id,
        verdict: "safe-default",
        detail: "无冲突且可逆",
        targets: [],
      },
    ],
    defaults,
    [],
  );
  assert.equal(reviews.length, 1);
  const questions = questionsFor(
    "run",
    2,
    ["通知谁？"],
    [
      {
        question: "通知谁？",
        decision: {
          sourceRevision: "run:1",
          sourceQuote: "通知",
          detail: "收件人影响外部交付",
          presentation: {
            explanation: "请选择收件人",
            options: [{ label: "仅自己" }, { label: "全组" }],
            recommended: 1,
          },
        },
      },
    ],
  );
  assert.throws(
    () => answerText(questions, [{ questionId: "old", text: "所有人" }]),
    /不匹配/,
  );
  assert.throws(
    () =>
      answerText(questions, [
        { questionId: questions[0].id, optionId: "forged" },
      ]),
    /不匹配/,
  );
  assert.match(
    answerText(questions, [
      { questionId: questions[0].id, optionId: questions[0].options[0].id },
    ]),
    /仅自己/,
  );
  assert.equal(
    answerText(questions, [
      { questionId: questions[0].id, optionId: questions[0].options[0].id },
    ]),
    "仅自己",
  );
});

test("合理默认与计划同封存，独立复核不能被省略，冻结后默认被改会拒绝开始", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "cordis-default-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  const defaults = [
    {
      scope: "复盘显示",
      behavior: "沿用现有详情展示",
      basis: "现有应用规则",
      impact: "不改变数据与权限",
    },
  ];
  const driver = new PlanningDriver({ defaults });
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(directory, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    operationId: randomUUID(),
    text: "完成任务前必须填写复盘，其他细节按现有惯例",
  });
  const ready = await settleEvolution(e, "ready");
  if (ready.status !== "ready") throw new Error("not ready");
  assert.equal(ready.plan.defaults?.length, 1);
  assert.equal(ready.plan.defaultReviews?.[0].verdict, "safe-default");
  assert.deepEqual(
    ready.plan.defaults,
    ready.plan.changeSpec?.definition.defaults,
  );
  assert.deepEqual(
    ready.plan.defaultReviews,
    ready.plan.requirementGate?.review.defaultReviews,
  );
  const stored = JSON.parse(
    String(
      w.db.prepare("SELECT body FROM evolution_runs WHERE id=?").get(ready.id)!
        .body,
    ),
  );
  stored.run.plan.defaults[0].behavior = "删除数据";
  w.db
    .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
    .run(JSON.stringify(stored), ready.id);
  await assert.rejects(
    e.command({
      type: "start",
      operationId: randomUUID(),
      runId: ready.id,
      planId: ready.plan.id,
    }),
    /规格|冻结|默认/,
  );
});

test("复核完成后活动时间不足：恢复直接复用冻结结果，不重复模型请求", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "cordis-review-pause-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const fixture = new PlanningDriver();
  let offset = 0;
  const original = performance.now.bind(performance);
  t.mock.method(performance, "now", () => original() + offset);
  const e = new Evolution(
    w.db,
    {
      async generate(request) {
        const reply = await fixture.generate(request);
        if (request.phase === "review") offset = 590000;
        return reply;
      },
    },
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    operationId: "request",
    text: "完成任务前必须填写复盘",
  });
  const paused = await settleEvolution(e, "awaiting-budget");
  if (paused.status !== "awaiting-budget") throw Error("not paused");
  assert(paused.pause.suggested.milliseconds >= 900000);
  const count = fixture.requests.length;
  assert.equal(
    w.db.prepare("SELECT count(*) n FROM evolution_requirement_freezes").get()!
      .n,
    1,
  );
  offset = 0;
  await e.command({
    type: "resume-budget",
    operationId: "grant",
    runId: paused.id,
    pauseRevision: paused.pause.revision,
    amounts: paused.pause.suggested,
  });
  const ready = await settleEvolution(e, "ready");
  assert.equal(ready.id, paused.id);
  assert.equal(fixture.requests.length, count);
  assert.equal(
    w.db.prepare("SELECT count(*) n FROM evolution_requirement_freezes").get()!
      .n,
    1,
  );
});

test("默认会改变关键结果时必须提问，与明确要求冲突时不能进入可执行方案", async (t) => {
  for (const verdict of ["requires-choice", "conflict"] as const) {
    const dir = await mkdtemp(join(tmpdir(), "cordis-default-review-"));
    const w = await Workspace.open(join(dir, "workspace.db"));
    const fixture = new PlanningDriver({
      defaults: [
        {
          scope: "完成条件",
          behavior: "改变完成前的额外要求",
          basis: "候选默认",
          impact: "影响完成任务",
        },
      ],
    });
    const e = new Evolution(
      w.db,
      {
        async generate(request) {
          const reply = await fixture.generate(request);
          const input = JSON.parse(request.message ?? "{}");
          if (input.kind === "requirement-review/2") {
            const result = JSON.parse(reply.text);
            result.defaultReviews = input.defaults.map((d: { id: string }) => ({
              id: d.id,
              verdict,
              detail: "影响关键业务结果，不能按低风险默认处理",
              targets: [],
            }));
            reply.text = JSON.stringify(result);
          }
          return reply;
        },
      },
      new EvolutionDomain(w),
    );
    try {
      await e.command({
        type: "request",
        operationId: randomUUID(),
        text: "完成任务前填写复盘，保持已有明确要求",
      });
      const run = await settleEvolution(e);
      assert.equal(
        run.status,
        verdict === "requires-choice" ? "awaiting-input" : "blocked",
      );
      if (run.status === "awaiting-input") {
        assert.equal(run.questions?.length, 1);
        await assert.rejects(
          e.command({
            type: "answer",
            operationId: randomUUID(),
            runId: run.id,
            text: "采用",
          }),
          /旧回答|当前问题/,
        );
      }
      assert.equal((await e.observe()).candidates?.length, 0);
    } finally {
      await e.close();
      await w.close();
      await rm(dir, { recursive: true, force: true });
    }
  }
});
