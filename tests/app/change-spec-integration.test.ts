import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import { panelMemberCases } from "./member-case-fixtures.js";
import { panelPluginCode } from "../fixtures/member-ui.js";
import { hash } from "../../src/release/storage.js";
import type { AssistantRun } from "../../src/shared/assistant.js";

async function settle(e: Evolution): Promise<AssistantRun> {
  const deadline = Date.now() + 30000;
  for (;;) {
    const r = (await e.observe()).run!;
    if (!["planning", "executing"].includes(r.status)) return r;
    if (Date.now() > deadline)
      throw new Error("运行超时：" + JSON.stringify(r));
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function setup(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-change-v2-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  return workspace;
}

test("正式新协议：一次业务规格加一次独立复核即可ready，派生步骤和稳定需求ID由宿主冻结", async (t) => {
  const w = await setup(t);
  const driver = new PlanningDriver();
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(() => e.close());
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  assert.equal(ready.budget?.callsUsed, 2);
  assert.equal(ready.plan.changeSpec?.version, "change/3");
  assert.deepEqual(
    ready.plan.steps.map((s) => s.id),
    ["build", "verify", "experience"],
  );
  assert.match(ready.plan.requirements![0].id, /^requirement-[a-f0-9]{24}$/);
  assert.equal(ready.plan.changeSpec?.requirementOrigins[0].origin, "request");
  assert.equal(driver.requests[0].history.length, 0);
  const materials = JSON.parse(driver.requests[0].message!).materials;
  const supplied = materials.documents;
  assert.ok(supplied.some((d: { ref: string }) => d.ref === "active-source"));
  for (const c of supplied.find((d: {ref: string}) => d.ref === "inspect_application").content.capabilityContracts)
    for (const ref of c.consumers)
      assert.ok(supplied.some((d: {ref: string; content: string}) => d.ref === ref && d.content.length), `目录消费者须实际交付：${ref}`);
  assert.equal(supplied[0].documents, undefined, "资料不得通过嵌套再复制一次");
  const stored = JSON.parse(
    String(
      w.db.prepare("SELECT body FROM evolution_runs WHERE id=?").get(ready.id)!
        .body,
    ),
  );
  assert.equal(stored.investigation.deliveries[0].call, 1);
  assert.equal(stored.investigation.deliveries[0].phase, "planning");
  assert.deepEqual(
    stored.investigation.deliveries[0].materials.map(
      (d: { ref: string }) => d.ref,
    ),
    supplied.map((d: { ref: string }) => d.ref),
  );
});

test("独立复核API故障直接阻塞，不消耗调用反复重做规划", async (t) => {
  const w = await setup(t);
  const fixture = new PlanningDriver();
  let calls = 0;
  const e = new Evolution(
    w.db,
    {
      async generate(request, signal) {
        calls++;
        if (request.schema) throw new Error("review transport unavailable");
        return fixture.generate(request, signal);
      },
    },
    new EvolutionDomain(w),
  );
  t.after(() => e.close());
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const done = await settle(e);
  assert.equal(done.status, "blocked");
  assert.equal(done.budget?.callsUsed, 2);
  assert.equal(calls, 2);
  assert.match(
    "message" in done ? done.message : "",
    /review transport unavailable/,
  );
});

test("合成任务属性不得手填：冻结前退回同一规划循环，宿主绑定后进入ready且预算不变", async (t) => {
  const w = await setup(t);
  const fixture = new PlanningDriver({browserCases: [{id: "attributes", task: "new", steps: [{kind: "task"}]}]});
  let corrupted = false;
  const e = new Evolution(w.db, {
    async generate(request, signal) {
      const reply = await fixture.generate(request, signal);
      if (!corrupted && reply.calls[0]?.name === "propose_plan") {
        corrupted = true;
        const cases = reply.calls[0].args.browserCases as {steps: Record<string, unknown>[]}[];
        cases[0].steps[0] = {kind: "task", title: "模型猜测的名称", description: ""};
      }
      return reply;
    },
  }, new EvolutionDomain(w));
  t.after(() => e.close());
  await e.command({type: "request", text: "完成前填写复盘", operationId: "request"});
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  assert.equal(ready.budget?.callsUsed, 3);
  assert.equal(ready.budget!.callsUsed + ready.budget!.callsRemaining, 12);
  assert.deepEqual(ready.plan.browserCases![0].steps, [{kind: "task"}]);
  assert.ok(JSON.stringify(fixture.requests).includes("不得提交手工期望"));
});

test("生成阶段补读按下一次实际调用记录精确资料，失败读取不计交付且冻结规格不变", async (t) => {
  const w = await setup(t);
  const fixture = new PlanningDriver();
  const member = w.composition().members[0];
  let generated = false;
  const e = new Evolution(
    w.db,
    {
      async generate(request, signal) {
        if (!request.tools?.some((tool) => tool.name === "submit_candidate"))
          return fixture.generate(request, signal);
        if (generated)
          return toolReply("report_blocker", { reason: "收集交付回执后停止" });
        generated = true;
        return {
          text: "",
          history: request.history,
          calls: [
            { name: "read_contract", args: {} },
            { name: "read_current_source", args: {} },
            { name: "read_scaffold", args: {} },
            {
              name: "read_member",
              args: { pluginId: member.pluginId, versionId: member.versionId },
            },
            { name: "read_scaffold", args: { unknown: true } },
          ],
        };
      },
    },
    new EvolutionDomain(w),
  );
  t.after(() => e.close());
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const frozen = hash(ready.plan);
  await e.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "start",
  });
  const done = await settle(e);
  assert.equal(done.status, "blocked");
  assert.equal(done.budget?.callsUsed, 4);
  const stored = JSON.parse(
    String(
      w.db.prepare("SELECT body FROM evolution_runs WHERE id=?").get(done.id)!
        .body,
    ),
  );
  assert.equal(hash(stored.plan), frozen);
  const receipt = stored.investigation.deliveries.at(-1);
  assert.equal(receipt.call, 4);
  assert.equal(receipt.phase, "generation");
  assert.deepEqual(
    receipt.materials.map((m: { ref: string }) => m.ref),
    [
      "candidate-contract",
      "active-source",
      "candidate-scaffold",
      `member-source/${member.pluginId}@${member.versionId}`,
      `member-contract/${member.pluginId}@${member.versionId}`,
      `member-acceptance/${member.pluginId}@${member.versionId}`,
    ],
  );
});

test("澄清直接等待用户，回答沿同一运行和预算复用已验证指南并重做最终复核", async (t) => {
  const w = await setup(t);
  const fixture = new PlanningDriver();
  let phase = 0;
  let continuationMaterials: { ref: string }[] = [];
  const e = new Evolution(
    w.db,
    {
      async generate(request, signal) {
        if (phase++ === 0)
          return {
            ...toolReply("read_guides", { refs: ["guide/command.register"] }),
            history: request.history,
          };
        if (phase === 2)
          return {
            ...toolReply("request_clarification", {
              question: "必填还是选填？",
            }),
            history: request.history,
          };
        if (request.message && !request.schema)
          continuationMaterials = JSON.parse(request.message).materials
            .documents;
        return fixture.generate(request, signal);
      },
    },
    new EvolutionDomain(w),
  );
  t.after(() => e.close());
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const waiting = await settle(e);
  assert.equal(waiting.status, "awaiting-input");
  await e.command({
    type: "answer",
    runId: waiting.id,
    text: "必填",
    operationId: "answer",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  assert.equal(ready.id, waiting.id);
  assert.equal(ready.budget?.callsUsed, 4);
  assert.ok(
    continuationMaterials.some((d) => d.ref === "guide/command.register"),
  );
  assert.equal(fixture.requests.filter((r) => r.schema).length, 1);
});

test("正式差异协议：辅助新增files为空，精确继承旧主工作流，浏览器通过后才待应用（模型桩）", async (t) => {
  const w = await setup(t);
  const base = w.activeVersion();
  const before = w.composition();
  const fixture = new PlanningDriver({
    workflowRules: [],
    writableScope: [],
    memberAdditions: [{ pluginId: "panel", name: "备注面板" }],
    memberCases: panelMemberCases,
    capabilityChanges: [
      {
        capability: "command.register",
        provider: "member:panel",
        consumers: ["src/web/TaskEditor.tsx"],
        change: "增加备注动作",
      },
    ],
  });
  const member = await panelPluginCode();
  const e = new Evolution(
    w.db,
    {
      async generate(request, signal) {
        if (!request.tools?.some((tool) => tool.name === "submit_candidate"))
          return fixture.generate(request, signal);
        const input = JSON.parse(request.message!);
        return {
          ...toolReply("submit_candidate", {
            files: [],
            members: [{ pluginId: "panel", source: member }],
          }),
          history: request.history,
        };
      },
    },
    new EvolutionDomain(w),
  );
  t.after(() => e.close());
  await e.command({
    type: "request",
    text: "增加备注动作，原工作流不变",
    operationId: "request",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  await e.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "start",
  });
  const done = await settle(e);
  assert.equal(
    done.status,
    "awaiting-apply",
    "message" in done ? done.message : done.status,
  );
  assert.equal(done.budget?.callsUsed, 3);
  assert.deepEqual(w.composition(), before);
  const candidate = (await e.observe()).candidates!.find((c) => c.passed)!;
  assert.ok(candidate.browser?.results.every((r) => r.status === "passed"));
  const version = w.release.get(candidate.versionId!);
  assert.equal(
    version.members!.find((m) => m.role === "workflow")!.versionId,
    base.id,
  );
  assert.equal(
    (version.evidence as { changeSpec: { version: string } }).changeSpec
      .version,
    "change/3",
  );
});

test("独立复核可直接提出业务澄清；同一运行回答后复核必须显式消解原问题", async (t) => {
  const w = await setup(t);
  const fixture = new PlanningDriver();
  let reviewed = false;
  const e = new Evolution(
    w.db,
    {
      async generate(request, signal) {
        const reply = await fixture.generate(request, signal);
        if (request.schema && !reviewed) {
          reviewed = true;
          const input = JSON.parse(request.message!);
          reply.text = JSON.stringify({
            reviewedIds: input.requirements.map((r: { id: string }) => r.id),
            issues: [
              {
                kind: "unverifiable",
                sourceRevision: input.sources[0].id,
                sourceQuote: input.sources[0].text,
                detail: "缺少必填预期",
                target: { subject: input.requirements[0].id, aspect: "input" },
                stance: "undetermined",
                clarification: "复盘必填还是选填？",
              },
            ],
          });
        }
        return reply;
      },
    },
    new EvolutionDomain(w),
  );
  t.after(() => e.close());
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const waiting = await settle(e);
  assert.equal(waiting.status, "awaiting-input");
  assert.equal(waiting.budget?.callsUsed, 2);
  assert.equal(waiting.reviewLedger!.findings[0].status, "open");
  await e.command({
    type: "answer",
    runId: waiting.id,
    text: "复盘必填",
    operationId: "answer",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  assert.equal(ready.budget?.callsUsed, 4);
  assert.equal(ready.reviewLedger!.findings[0].status, "resolved");
  if (ready.status !== "ready") return;
  assert.deepEqual(
    ready.plan.requirementGate!.reviewLedger,
    ready.reviewLedger,
  );
  const row = w.db
    .prepare("SELECT body FROM evolution_runs WHERE id=?")
    .get(ready.id)!;
  const stored = JSON.parse(String(row.body));
  stored.run.reviewLedger.findings = [];
  w.db
    .prepare("UPDATE evolution_runs SET body=? WHERE id=?")
    .run(JSON.stringify(stored), ready.id);
  await assert.rejects(
    e.command({
      type: "start",
      runId: ready.id,
      planId: ready.plan.id,
      operationId: "tamper-ledger",
    }),
    /冻结/,
  );
});

test("宿主字段投影与修正基线贯穿构建、后端及双视口浏览器；同一规格预算内修正（模型桩）", async (t) => {
  const w = await setup(t);
  const before = { composition: w.composition(), tasks: w.query() };
  const fixture = new PlanningDriver({
    writableScope: [
      "business/entry.ts",
      "business/view.ts",
      "business/config.json",
      "business/compatibility.json",
    ],
    requirements: [
      {
        id: "behavior",
        description: "完成前填写复盘",
        source: 1,
        sourceQuote: "完成前填写复盘",
        type: "behavior",
        checks: [{ kind: "workflow", index: 1 }],
      },
      {
        id: "display",
        description: "保存后界面显示复盘",
        source: 1,
        sourceQuote: "保存后界面显示复盘",
        type: "interface",
        checks: [
          { kind: "browser", index: 1 },
          { kind: "browser", index: 2 },
        ],
      },
    ],
    browserCases: ["existing", "new"].map((task) => ({
      id: task,
      task,
      steps: [
        { kind: "task" },
        { kind: "action", action: "complete", input: { reflection: "   " } },
        { kind: "error", text: "" },
        { kind: "action", action: "complete", input: { reflection: "x".repeat(5001) } },
        { kind: "error", text: "" },
        { kind: "action", action: "complete", input: { reflection: "复盘" } },
        { kind: "action", action: "reopen", input: {} },
        { kind: "field", field: "reflection", value: "复盘" },
        { kind: "refresh" },
        { kind: "field", field: "reflection", value: "复盘" },
        { kind: "restart" },
        { kind: "field", field: "reflection", value: "复盘" },
      ],
    })),
  });
  const implementation = `import { frozenWorkflow } from './contract.js';
import type { Plugin } from './contract.js';
const plugin: Plugin = {
 describe(){return frozenWorkflow;},
 decide({task,action,input}) {
  if (action==='complete' && task.state==='open') {
   const value=(input.reflection ?? '').trim();
   if (!value) return {kind:'input-required',fields:frozenWorkflow.fields};
   if ([...value].length>5000) return {kind:'reject',message:'过长'};
   return {kind:'commit',state:'done',fields:{...task.fields,reflection:value}};
  }
  if (action==='reopen' && task.state==='done') return {kind:'commit',state:'open',fields:{...task.fields}};
  return {kind:'reject',message:'不可执行'};
 }
}; export default plugin;`;
  let generated = 0;
  const e = new Evolution(
    w.db,
    {
      async generate(request, signal) {
        if (!request.tools?.some((tool) => tool.name === "submit_candidate"))
          return fixture.generate(request, signal);
        generated++;
        return {
          ...toolReply("submit_candidate", {
            files: [
              {
                path: "business/entry.ts",
                content:
                  generated === 1
                    ? implementation.replace(
                        "const value=",
                        "throw new Error('synthetic business defect'); const value=",
                      )
                    : implementation,
              },
            ],
            members: [],
          }),
          history: request.history,
        };
      },
    },
    new EvolutionDomain(w),
  );
  t.after(() => e.close());
  await e.command({
    type: "request",
    text: "完成前填写复盘，保存后界面显示复盘",
    operationId: "request",
  });
  const ready = await settle(e);
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const seal = ready.plan.requirementGate!.seal;
  await e.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "start",
  });
  const done = await settle(e);
  assert.equal(
    done.status,
    "awaiting-apply",
    "message" in done ? done.message : done.status,
  );
  assert.equal(done.budget?.callsUsed, 4);
  assert.equal(done.budget!.callsUsed + done.budget!.callsRemaining, 12);
  const candidates = (await e.observe()).candidates!;
  const first = candidates.find((c) => c.attempt === 1)!;
  const passed = candidates.find((c) => c.passed)!;
  assert.equal(passed.delta!.parentCandidateId, first.id);
  assert.equal(passed.delta!.requirementSeal, seal);
  assert.deepEqual(
    passed.delta!.files.map((f) => f.key),
    ["business/entry.ts"],
  );
  assert.equal(
    passed.browser?.results.filter((r) => r.requirementIds.length).length,
    4,
  );
  assert.ok(passed.browser?.results.every((r) => r.status === "passed"));
  assert.deepEqual({ composition: w.composition(), tasks: w.query() }, before);
  const row = w.db
    .prepare(
      "SELECT id,body FROM evolution_candidates WHERE runId=? ORDER BY id DESC LIMIT 1",
    )
    .get(done.id)!;
  const stored = JSON.parse(String(row.body));
  stored.delta.parentCandidateId = "forged";
  w.db
    .prepare("UPDATE evolution_candidates SET body=? WHERE id=?")
    .run(JSON.stringify(stored), row.id);
  await assert.rejects(
    e.command({
      type: "apply",
      runId: done.id,
      candidateId: passed.id,
      operationId: "forged-delta",
    }),
    /证据|候选|验收/,
  );
});
