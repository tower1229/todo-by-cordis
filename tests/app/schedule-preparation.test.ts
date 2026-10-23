import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../../src/server/workspace.js";
import { capture, compilePlanDraft, readInvestigation } from "../../src/server/planning.js";
import { coverage } from "../../src/server/requirement-coverage.js";
import { BrowserDefinitionError, verifyBrowser } from "../../src/server/browser-acceptance.js";
import { dueAutoExpireSource } from "../../src/server/capability-guides.js";
import { hash } from "../../src/release/storage.js";
import { activateWorkflowOnly } from "./dual-composition-fixture.js";

const due = "2030-02-01T09:00:00.000Z";
const later = "2030-03-01T09:00:00.000Z";
const quote = "设置截止时间，到期自动标记过期，任务详情展示截止和过期值；修改截止清除原过期标记。";
const sources = [{ id: "preparation:1", text: quote }];

function proposal(reachable: boolean) {
  const setting = reachable ? due : later;
  return {
    changes: [{
      target: "deadline", features: ["commands", "fields", "detail", "schedules"],
      cases: [
        { name: "set", state: "open", fields: {}, action: "setDue", input: { dueAt: setting }, expected: { kind: "commit", state: "open", fields: { dueAt: setting } } },
        { name: "invalid", state: "open", fields: {}, action: "setDue", input: { dueAt: "invalid" }, expected: { kind: "reject" } },
        { name: "fire", state: "open", fields: { dueAt: due }, action: "expire", input: { scheduledAt: due }, expected: { kind: "commit", state: "open", fields: { dueAt: due, expired: "true" } } },
        { name: "completed", state: "done", fields: { dueAt: due }, action: "expire", input: { scheduledAt: due }, expected: { kind: "reject" } },
        { name: "reset", state: "open", fields: { dueAt: due, expired: "true" }, action: "setDue", input: { dueAt: later }, expected: { kind: "commit", state: "open", fields: { dueAt: later } } },
      ],
    }],
    requirements: [{ quote, type: "behavior", expectations: [
      { kind: "behavior" },
      { kind: "field", field: "expired" },
      { kind: "field", field: "dueAt" },
      { kind: "schedule-policy", action: "expire", policies: ["reset-clears-effect"] },
    ] }],
  };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "schedule-preparation-contract-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  await activateWorkflowOnly(workspace);
  const context = capture(workspace);
  const initial = readInvestigation("inspect_application", {}, context, []);
  assert.ok("ref" in initial);
  const seen = [initial, ...(initial.documents ?? [])].map(({ ref, hash }) => ({ ref, hash }));
  return { workspace, context, seen };
}

test("定时字段案例的完整前置必须在规划时可达，不能交给候选代码修正冻结夹具", async (t) => {
  const { context, seen } = await fixture(t);
  const parsed = compilePlanDraft(proposal(false), context, seen, sources);
  assert.ok(parsed.blockers.some((reason) => reason.includes("前置状态") && reason.includes("可达路径")), JSON.stringify(parsed.blockers));
  assert.ok(parsed.blockers.some(reason => reason.includes(`"dueAt":"${due}"`) && reason.includes("从空任务经非到期动作")), "纠错须指明不可达的完整前置及所缺路径");
  assert.equal(parsed.retryable, true, "缺少可达案例在同一规划预算中纠正，不新增业务澄清");
  assert.ok(coverage(parsed.plan, sources, Object.keys(context.checkerVersions))
    .some((item) => item.reasons.some((reason) => reason.includes("前置状态") && reason.includes("可达路径"))),
  "开始执行和应用时的覆盖重放也必须检查同一条冻结路径");
});

test("定时前置可达时保留正常字段探针，不把后端历史字段升级为所有界面操作的前置", async (t) => {
  const { context, seen } = await fixture(t);
  const parsed = compilePlanDraft(proposal(true), context, seen, sources);
  assert.deepEqual(parsed.blockers, []);
  assert.ok(parsed.plan.browserCases?.some((item) => item.steps.some((step) => step.kind === "case-action" && step.field === "expired")));
  assert.deepEqual(coverage(parsed.plan, sources, Object.keys(context.checkerVersions)).flatMap((item) => item.reasons), []);
});

test("绕过规划的不可达定时夹具仍记为定义故障，保留截图且正式组合和任务不变", async (t) => {
  const { workspace, context, seen } = await fixture(t);
  const plan = compilePlanDraft(proposal(false), context, seen, sources).plan;
  const base = workspace.activeVersion();
  const formal = JSON.stringify({ composition: workspace.composition(), tasks: workspace.query() });
  const member = workspace.release.record({
    pluginId: "deadline", name: "截止", service: "plugin:deadline", contractVersion: "extensions/1",
    source: dueAutoExpireSource, code: dueAutoExpireSource, definition: {},
    evidence: { passed: true, origin: "model-stub-preparation-counterexample" },
  });
  const candidate = workspace.release.record({
    pluginId: base.pluginId, name: base.name, service: base.service, contractVersion: base.contractVersion,
    source: base.source, code: base.code, definition: base.definition, parentId: base.id,
    evidence: { passed: false }, members: [
      { pluginId: base.pluginId, role: "workflow", enabled: true },
      { pluginId: "deadline", role: "auxiliary", enabled: true, versionId: member.id },
    ],
  });
  const probe = plan.browserCases!.find((item) => item.steps.some((step) => step.kind === "case-action" && step.field === "expired"));
  assert.ok(probe);
  let failure: unknown;
  try {
    await verifyBrowser(workspace, candidate, base, [probe], plan.requirements!, hash([probe]), new AbortController().signal, plan.memberCases);
  } catch (error) { failure = error; }
  assert.ok(failure instanceof BrowserDefinitionError, String(failure));
  assert.match(failure.message, /前置状态.*可达路径/);
  assert.equal(JSON.stringify({ composition: workspace.composition(), tasks: workspace.query() }), formal);
  assert.ok(failure.evidence);
  const failed = failure.evidence.results.find((result) => result.status === "failed");
  assert.ok(failed?.screenshot);
  assert.ok((await readFile(failed.screenshot)).length > 0);
});
