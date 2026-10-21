import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../../src/server/workspace.js";
import { capture, compilePlanDraft, readInvestigation } from "../../src/server/planning.js";
import { dueAutoExpireSource } from "../../src/server/capability-guides.js";
import { verifyBrowser, candidateProgramHash } from "../../src/server/browser-acceptance.js";
import { verifyViaIsolatedWorkspace } from "../../src/server/workspace-acceptance.js";
import { verifyScheduleViaIsolatedWorkspace } from "../../src/server/schedule-acceptance.js";
import { hash } from "../../src/release/storage.js";
import { activateWorkflowOnly } from "./dual-composition-fixture.js";
import { coverage } from "../../src/server/requirement-coverage.js";
import type { Version } from "../../src/release/types.js";
import type { BrowserCase } from "../../src/shared/browser-cases.js";

test("宿主生成的过期字段验收通过真实页面准备并由真实调度触发，内部命令仍不开放", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "schedule-browser-channel-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close();
    await rm(directory, { recursive: true, force: true });
  });
  await activateWorkflowOnly(workspace);
  const before = JSON.stringify({ tasks: workspace.query(), composition: workspace.composition() });
  const base = workspace.activeVersion();
  const quote = "任务可设置截止时间，未完成到点自动标记过期，任务详情显示截止值和过期标记保存值 true；完成后保留过期标记，截止后重新打开自动补标。";
  const at = "2030-01-01T00:01:00.000Z";
  const context = capture(workspace);
  const initial = readInvestigation("inspect_application", {}, context, []);
  assert.ok("ref" in initial);
  const seen = [initial, ...(initial.documents ?? [])].map(({ ref, hash }) => ({ ref, hash }));
  const parsed = compilePlanDraft({
    changes: [{
      target: "due", features: ["commands", "fields", "detail", "schedules"],
      cases: [
        { name: "set", state: "open", fields: {}, action: "setDue", input: { dueAt: at }, expected: { kind: "commit", state: "open", fields: { dueAt: at } } },
        { name: "invalid", state: "open", fields: {}, action: "setDue", input: { dueAt: "invalid" }, expected: { kind: "reject" } },
        { name: "fire", state: "open", fields: { dueAt: at }, action: "expire", input: { scheduledAt: at }, expected: { kind: "commit", state: "open", fields: { dueAt: at, expired: "true" } } },
        { name: "completed", state: "done", fields: { dueAt: at }, action: "expire", input: { scheduledAt: at }, expected: { kind: "reject" } },
      ],
    }],
    requirements: [{ quote, type: "behavior", expectations: [
      { kind: "behavior" },
      { kind: "field", field: "expired", examples: ["true"] },
      { kind: "field", field: "dueAt", examples: [at] },
      { kind: "schedule-policy", action: "expire", policies: ["complete-retains-effect", "reopen-after-due"] },
    ] }],
  }, context, seen, [{ id: "schedule-browser:1", text: quote }]);
  assert.deepEqual(parsed.blockers, []);
  assert.ok(parsed.plan.browserCases?.some((c) => c.steps.some((s) => s.kind === "field" && s.field === "expired" && s.value === "true")));
  const reference = parsed.plan.browserCases!.flatMap((c) => c.steps).find((s) => s.kind === "case-action");
  assert.ok(reference?.kind === "case-action");
  for (const mutation of ["digest", "provider", "missing-source"] as const) {
    const bad = structuredClone(parsed.plan);
    // Change both projections so the source-binding check, rather than a trivial
    // mismatch between obligation and case, must reject the stale reference.
    const steps = [
      ...bad.browserCases!.flatMap((c) => c.steps),
      ...bad.requirements!.flatMap((r) => (r.obligations ?? []).flatMap((o) => o.kind === "field" ? o.scenarios.flatMap((s) => s.steps) : [])),
    ];
    for (const step of steps) {
      if (step.kind !== "case-action" || step.caseId !== reference.caseId) continue;
      if (mutation === "digest") step.definitionHash = "f".repeat(64);
      if (mutation === "provider") step.member = "another-provider";
    }
    if (mutation === "missing-source")
      bad.memberCases = bad.memberCases!.filter((c) => `member:${c.member}:${c.name}` !== reference.caseId);
    assert.ok(coverage(bad, [{ id: "schedule-browser:1", text: quote }], Object.keys(context.checkerVersions))
      .some((r) => r.reasons.some((reason) => reason.includes("宿主动作案例步骤与冻结案例不一致"))), mutation);
  }
  const member = workspace.release.record({
    pluginId: "due", name: "截止", service: "plugin:due", contractVersion: "extensions/1",
    source: dueAutoExpireSource, code: dueAutoExpireSource, definition: {},
    evidence: { passed: true, origin: "synthetic-acceptance-fixture" },
  });
  const candidate = workspace.release.record({
    pluginId: base.pluginId, name: base.name, service: base.service, contractVersion: base.contractVersion,
    source: base.source, code: base.code, definition: base.definition, parentId: base.id, evidence: { passed: false },
    members: [
      { pluginId: base.pluginId, role: "workflow", enabled: true },
      { pluginId: "due", role: "auxiliary", enabled: true, versionId: member.id },
    ],
  });
  const signal = new AbortController().signal;
  await verifyViaIsolatedWorkspace(workspace, candidate, parsed.plan.memberCases ?? [], signal);
  const policies = parsed.plan.requirements!.flatMap((r) => r.obligations ?? []).filter((o) => o.kind === "schedule-policy");
  const timing = await verifyScheduleViaIsolatedWorkspace(workspace, candidate, parsed.plan.memberCases ?? [], signal, policies);
  assert.ok(timing.some((c) => c.endsWith(":complete-retains-effect")));
  const evidence = await verifyBrowser(workspace, candidate, base, parsed.plan.browserCases!, parsed.plan.requirements!, hash(parsed.plan.browserCases), signal, parsed.plan.memberCases);
  assert.ok(evidence.results.every((r) => r.status === "passed"));
  for (const task of ["existing", "new"])
    for (const width of [390, 1280])
      assert.ok(evidence.results.some((r) => r.caseId.includes("-after-") && r.caseId.endsWith(task) && r.viewport.width === width));
  assert.equal(JSON.stringify({ tasks: workspace.query(), composition: workspace.composition() }), before);
});

test("归档真实程序的多个同截止任务必须等待全部调度提交后再检查页面，不误报有效候选", async (t) => {
  const fixture = JSON.parse(await readFile(new URL("../fixtures/scheduled-field-real-program.json", import.meta.url), "utf8")) as {
    request: string;
    proposal: unknown;
    baseInputs: Omit<Version, "id" | "entry" | "createdAt">[];
    candidateInput: Omit<Version, "id" | "entry" | "createdAt">;
    candidateProgramHash: string;
  };
  const directory = await mkdtemp(join(tmpdir(), "archived-schedule-fanout-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"), { acceptanceProbe: true });
  t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  const [base] = fixture.baseInputs.map((input) => workspace.release.record(input));
  await workspace.activateForAcceptance(base.id);
  const before = JSON.stringify({ tasks: workspace.query(), composition: workspace.composition() });
  const candidate = workspace.release.record(fixture.candidateInput);
  assert.equal(candidateProgramHash(workspace, candidate), fixture.candidateProgramHash, "归档业务源码和编译模块不能被手工修补");
  const context = capture(workspace);
  const seen = Object.entries(context.files).map(([ref, file]) => ({ ref, hash: file.hash }));
  for (const tool of ["inspect_application", "check_environment"] as const) {
    const observed = readInvestigation(tool, {}, context, seen);
    assert.ok("ref" in observed);
    seen.push({ ref: observed.ref, hash: observed.hash });
    for (const document of observed.documents ?? []) seen.push({ ref: document.ref, hash: document.hash });
  }
  const parsed = compilePlanDraft(fixture.proposal, context, seen, [{ id: "archived-fanout:1", text: fixture.request }]);
  assert.deepEqual(parsed.blockers, []);
  const signal = new AbortController().signal;
  await verifyViaIsolatedWorkspace(workspace, candidate, parsed.plan.memberCases!, signal);
  const policies = parsed.plan.requirements!.flatMap((r) => r.obligations ?? []).filter((o) => o.kind === "schedule-policy");
  await verifyScheduleViaIsolatedWorkspace(workspace, candidate, parsed.plan.memberCases!, signal, policies);
  const evidence = await verifyBrowser(workspace, candidate, base, parsed.plan.browserCases!, parsed.plan.requirements!, hash(parsed.plan.browserCases), signal, parsed.plan.memberCases);
  assert.ok(evidence.results.every((r) => r.status === "passed"));
  assert.equal(JSON.stringify({ tasks: workspace.query(), composition: workspace.composition() }), before);
});

test("不可见动作断言允许已注册内部命令没有界面入口，但未知身份和实际可见动作仍失败", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "schedule-negative-visibility-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  const base = workspace.activeVersion();
  const before = JSON.stringify({ tasks: workspace.query(), composition: workspace.composition() });
  const member = workspace.release.record({ pluginId: "due", name: "截止", service: "plugin:due", contractVersion: "extensions/1",
    source: dueAutoExpireSource, code: dueAutoExpireSource, definition: {}, evidence: { passed: false, origin: "synthetic-visibility-fixture" } });
  const candidate = workspace.release.record({ pluginId: base.pluginId, name: base.name, service: base.service,
    contractVersion: base.contractVersion, source: base.source, code: base.code, definition: base.definition,
    evidence: { passed: false }, members: [
      { pluginId: base.pluginId, role: "workflow", enabled: true },
      { pluginId: "due", versionId: member.id, role: "auxiliary", enabled: true },
    ] });
  for (const action of ["expire", "missing-command", "setDue"]) {
    const cases: BrowserCase[] = [{ id: "hidden-command", task: "new", steps: [{ kind: "action-visible", member: "due", action, visible: false }] }];
    const check = () => verifyBrowser(workspace, candidate, base, cases, [], hash(cases), new AbortController().signal);
    if (action === "expire") assert.ok((await check()).results.every((r) => r.status === "passed"));
    else await assert.rejects(check(), /身份|不存在|可见/);
  }
  assert.equal(JSON.stringify({ tasks: workspace.query(), composition: workspace.composition() }), before);
});
