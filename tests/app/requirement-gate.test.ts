import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { Evolution } from "./evolution-adapter.js";
import { PlanningDriver } from "./planning-fixture.js";
import type { Driver } from "../../src/evolution/driver.js";
import type {
  InvestigatedPlan,
  Requirement,
} from "../../src/shared/assistant.js";
import { hash } from "../../src/release/storage.js";

async function planned(
  t: test.TestContext,
  transform: (args: Record<string, unknown>) => void = () => {},
  issue?: "omission" | "extra-constraint",
) {
  const dir = await mkdtemp(join(tmpdir(), "requirements-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const fixture = new PlanningDriver();
  const driver: Driver = {
    async generate(request) {
      const reply = await fixture.generate(request);
      if (request.schema && issue) {
        const input = JSON.parse(request.message!) as {
          sources: { id: string; text: string }[];
        };
        const result = JSON.parse(reply.text) as { issues: unknown[] };
        result.issues = [
          {
            kind: issue,
            sourceRevision: input.sources[0].id,
            sourceQuote: input.sources[0].text,
            detail:
              issue === "omission"
                ? "遗漏新旧任务默认普通"
                : "额外增加填写复盘才能完成的限制",
          },
        ];
        reply.text = JSON.stringify(result);
      }
      if (reply.calls[0]?.name === "propose_plan")
        transform(reply.calls[0].args);
      return reply;
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: "标记重要，新旧任务默认普通，其他行为不变",
    operationId: "request",
  });
  const deadline = Date.now() + 10000;
  let run = (await e.observe()).run!;
  while (run.status === "planning" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    run = (await e.observe()).run!;
  }
  return { w, e, run, fixture };
}

test("公开规划入口拒绝没有需求清单和验收映射的计划", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "requirements-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const e = new Evolution(
    w.db,
    new PlanningDriver({ requirements: [] }),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
    await w.close();
    await rm(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘，其他行为不变",
    operationId: "missing-requirements",
  });
  const deadline = Date.now() + 10000;
  let run = (await e.observe()).run;
  while (run?.status === "planning" && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    run = (await e.observe()).run;
  }
  assert.equal(run?.status, "blocked");
  assert.match(run && "message" in run ? run.message : "", /需求|requirements/);
});

test("独立复核收到浏览器错误断言的真实匹配语义，仍使用空历史和原预算", async (t) => {
  const { run, fixture } = await planned(t);
  assert.equal(run.status, "ready");
  const reviews = fixture.requests.filter((request) => request.schema);
  assert.equal(reviews.length, 1);
  const input = JSON.parse(reviews[0].message!) as {
    checkerSemantics: { "browser/1": { error: string } };
  };
  assert.match(input.checkerSemantics["browser/1"].error, /空字符串/);
  assert.match(input.checkerSemantics["browser/1"].error, /可见/);
  assert.match(input.checkerSemantics["browser/1"].error, /包含/);
  assert.deepEqual(reviews[0].history, []);
  assert.equal(reviews[0].tools, undefined);
  assert.equal(run.budget?.callsUsed, fixture.requests.length + 1);
  assert.ok((run.budget?.callsUsed ?? 13) < 12);
});

for (const [name, transform] of [
  [
    "伪造案例引用",
    (args: Record<string, unknown>) => {
      (args.requirements as unknown as {checks:unknown[]}[])[0].checks = [{checker:"workflow/1",caseId:"invented"}];
    },
  ],
  [
    "界面仅由后端断言覆盖",
    (args: Record<string, unknown>) => {
      (args.requirements as Requirement[])[0].type = "interface";
      (args.changes as {target:string;fields:unknown[]}[]).find(c=>c.target==="workflow")!.fields = [];
    },
  ],
  [
    "原文引用不存在",
    (args: Record<string, unknown>) => {
      (args.requirements as unknown as {quote:string}[])[0].quote = "用户从未说过";
    },
  ],
] as const)
  test(`需求门禁拒绝${name}`, async (t) => {
    const { run } = await planned(t, transform);
    assert.equal(run.status, "blocked");
    assert.match("message" in run ? run.message : "", /需求|requirements/);
  });

for (const issue of ["omission", "extra-constraint"] as const)
  test(`独立语义复核拒绝 ${issue}，保持原预算与规划历史`, async (t) => {
    const { run, fixture } = await planned(t, undefined, issue);
    assert.equal(run.status, "blocked");
    const reviews = fixture.requests.filter((r) => r.schema);
    assert.equal(reviews.length, 2);
    assert.ok(reviews.every((r) => r.history.length === 0 && !r.tools));
    assert.equal(run.budget?.callsUsed, fixture.requests.length + 1);
    assert.equal(run.budget?.callsUsed, 5);
    assert.ok(
      fixture.requests
        .filter((r) => !r.schema)
        .some((r) => JSON.stringify(r.history).includes("需求独立复核")),
    );
  });

test("冻结要求的删除、期望替换、摘要篡改及修订均不能开始", async (t) => {
  const { run, w, e } = await planned(t);
  assert.equal(run.status, "ready");
  if (run.status !== "ready") throw new Error("expected ready");
  const row = w.db
    .prepare("SELECT body FROM evolution_runs WHERE id=?")
    .get(run.id)!;
  for (const mutate of [
    (p: InvestigatedPlan) => {
      p.questionAdjudications = [
        {
          key: "forged",
          question: "伪造问题",
          call: 1,
          decision: {
            kind: "unnecessary",
            sourceRevision: "forged",
            sourceQuote: "forged",
            detail: "forged",
          },
        },
      ];
    },
    (p: InvestigatedPlan) => {
      delete p.requestAdmission;
    },
    (p: InvestigatedPlan) => {
      p.requestAdmission!.factsHash = "forged";
    },
    (p: InvestigatedPlan) => {
      p.requirements = [];
    },
    (p: InvestigatedPlan) => {
      p.cases[0].then = "替换预期";
    },
    (p: InvestigatedPlan) => {
      p.requirementGate!.seal = hash("forged");
    },
    (p: InvestigatedPlan) => {
      p.excluded.push(p.requirements![0].description);
    },
  ]) {
    const stored = JSON.parse(String(row.body)) as {
      run: { plan: InvestigatedPlan };
    };
    mutate(stored.run.plan);
    w.db
      .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
      .run(JSON.stringify(stored), run.id);
    await assert.rejects(
      e.command({
        type: "start",
        runId: run.id,
        planId: run.plan.id,
        operationId: `tamper-${Math.random()}`,
      }),
      /需求|冻结/,
    );
  }
  const stored = JSON.parse(String(row.body)) as {
    run: { revisions: { text: string }[] };
  };
  stored.run.revisions[0].text += "修改来源";
  w.db
    .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
    .run(JSON.stringify(stored), run.id);
  await assert.rejects(
    e.command({
      type: "start",
      runId: run.id,
      planId: run.plan.id,
      operationId: "tamper-revision",
    }),
    /修订/,
  );
});

test("缺少新门禁证据的旧待执行与待应用计划重启后要求重新规划，保留历史和活动版本", async (t) => {
  const { run, w, e } = await planned(t);
  assert.equal(run.status, "ready");
  if (run.status !== "ready") throw new Error("expected ready");
  await e.close();
  const active = w.activeVersion().id;
  const row = w.db
    .prepare("SELECT body FROM evolution_runs WHERE id=?")
    .get(run.id)!;
  for (const status of ["ready", "awaiting-apply"] as const) {
    const stored = JSON.parse(String(row.body)) as {
      run: { status: string; plan: InvestigatedPlan };
    };
    stored.run.status = status;
    delete stored.run.plan.requirementGate;
    delete stored.run.plan.requirements;
    w.db
      .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
      .run(JSON.stringify(stored), run.id);
    const reopened = new Evolution(
      w.db,
      new PlanningDriver(),
      new EvolutionDomain(w),
    );
    const restored = (await reopened.observe()).run!;
    assert.equal(restored.status, "interrupted");
    assert.equal(restored.historicalPlan?.id, run.plan.id);
    assert.match("message" in restored ? restored.message : "", /重新规划/);
    assert.equal(w.activeVersion().id, active);
    await reopened.close();
  }
});
