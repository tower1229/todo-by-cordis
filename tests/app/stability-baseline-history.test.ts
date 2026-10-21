import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { runStabilityScenario } from "../../scripts/lib/stability-eval/scenario.js";
import { currentManifest } from "../../scripts/lib/stability-eval/current.js";
import { freezeManifest } from "../../scripts/lib/stability-eval/manifest.js";
import type { CommandResult, Composition } from "../../src/shared/contracts.js";
import { Workspace } from "../../src/server/workspace.js";
import { activateDual } from "./dual-composition-fixture.js";
import { activateStabilityBaseline } from "../../scripts/lib/stability-eval/baseline.js";
import { capture, compilePlanDraft, readInvestigation } from "../../src/server/planning.js";
import { verifyViaIsolatedWorkspace } from "../../src/server/workspace-acceptance.js";
import { verifyBrowser } from "../../src/server/browser-acceptance.js";
import { hash } from "../../src/release/storage.js";

test("标签升级评测的基础版本已实现去空格、拒绝空白并保留大小写", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stability-tag-baseline-"));
  const manifest = freezeManifest(currentManifest("a".repeat(40)));
  const scenario = manifest.scenarios.find((s) => s.id === "member-upgrade-tags")!;
  let observed: { saved?: string; rejectedBlank?: boolean; preserved?: string } = {};
  let calls = 0;
  try {
    const result = await runStabilityScenario({
      directory,
      scenario,
      manifest,
      evidenceKind: "model-stub",
      driver: { async generate() { calls++; throw new Error("基线探针不应调用模型"); } },
      browserRun: async ({ app }) => {
        const composition = await (await app.request("/api/composition")).json() as Composition;
        const send = (body: Record<string, unknown>) => app.request("/api/commands", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, operationId: randomUUID(), compositionRevision: composition.revision }),
        });
        const created = await (await send({ type: "create", title: "已有标签任务" })).json() as CommandResult;
        assert.ok(created.task);
        const saved = await (await send({ type: "action", taskId: created.task.id,
          expectedRevision: created.task.revision, actionId: "setTags", input: { tags: "  Legacy Tag  " } })).json() as CommandResult;
        assert.ok(saved.task);
        const rejected = await send({ type: "action", taskId: saved.task.id,
          expectedRevision: saved.task.revision, actionId: "setTags", input: { tags: "   " } });
        const retained = await (await app.request(`/api/tasks/${saved.task.id}`)).json() as NonNullable<CommandResult["task"]>;
        observed = { saved: saved.task.fields.tags, rejectedBlank: !rejected.ok, preserved: retained.fields.tags };
        return { status: "failed", viewport: { width: 390, height: 844 }, openedImprovePanel: false,
          recoveryEntryVisible: false, screenshot: "", pageErrors: [], message: "基础版本契约探针，不冒充模型或完整浏览器验收" };
      },
    });
    assert.deepEqual(observed, { saved: "Legacy Tag", rejectedBlank: true, preserved: "Legacy Tag" });
    assert.equal(result.record.fullPathSucceeded, false);
    assert.equal(calls, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("基线证据封存失败会释放本机运行时并保留原文件，不调用模型", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stability-baseline-cleanup-"));
  try {
    await writeFile(join(directory, "baseline-evidence.json"), "sentinel");
    const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { readFile } from 'node:fs/promises';
      import { join } from 'node:path';
      import { runStabilityScenario } from './scripts/lib/stability-eval/scenario.ts';
      import { currentManifest } from './scripts/lib/stability-eval/current.ts';
      import { freezeManifest } from './scripts/lib/stability-eval/manifest.ts';
      const directory = process.argv[1];
      const manifest = freezeManifest(currentManifest('a'.repeat(40)));
      let calls = 0;
      const result = await runStabilityScenario({directory,manifest,
        scenario:manifest.scenarios.find(s=>s.id==='member-upgrade-tags'), evidenceKind:'model-stub',
        driver:{async generate(){calls++;throw new Error('unexpected model call');}}});
      assert.equal(result.record.evidenceComplete,false);
      assert.equal(result.record.fullPathSucceeded,false);
      assert.equal(calls,0);
      assert.equal(await readFile(join(directory,'baseline-evidence.json'),'utf8'),'sentinel');
      assert.match(await readFile(result.eventsPath,'utf8'),/EEXIST/);
      console.log('setup-cleanup-complete');
    `, directory], { timeout: 20_000, maxBuffer: 1_000_000 });
    assert.match(stdout, /setup-cleanup-complete/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("升级义务从已实际验收的基础版本通过真实页面准备历史，缺少基线案例仍阻塞", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "stability-tag-history-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => { await workspace.close(); await rm(directory, { recursive: true, force: true }); });
  const quote = "请升级标签插件：保存标签时统一为小写，仍去掉首尾空格、拒绝空白，已有标签保持原值，任务详情显示保存值；其他行为保持不变。";
  const proposal = { summary: quote, acceptanceReason: "用户要求新保存标签转为小写，旧标签保持原值",
    changes: [{ target: "tags", features: ["commands", "fields"], cases: [
      { state: "open", fields: {}, action: "setTags", input: { tags: "  Hello " }, expected: { kind: "commit", state: "open", fields: { tags: "hello" } } },
      { state: "open", fields: {}, action: "setTags", input: { tags: "   " }, expected: { kind: "reject" } },
    ] }],
    requirements: [{ quote, type: "behavior", expectations: [{ kind: "behavior" }, { kind: "history", field: "tags" }] }],
  };
  const compile = () => {
    const context = capture(workspace);
    const seen: { ref: string; hash: string }[] = [];
    for (const tool of ["inspect_application", "check_environment"] as const) {
      const observed = readInvestigation(tool, {}, context, seen);
      assert.ok("ref" in observed);
      seen.push({ ref: observed.ref, hash: observed.hash });
      for (const document of observed.documents ?? []) seen.push({ ref: document.ref, hash: document.hash });
    }
    return compilePlanDraft(proposal, context, seen, [{ id: "baseline-history:1", text: quote }]);
  };
  await activateDual(workspace);
  assert.throws(compile, /没有可达的冻结成功动作/);
  const baseline = await activateStabilityBaseline(workspace);
  assert.ok(baseline.evidence.workspaceCases.length > 0);
  assert.ok(baseline.evidence.workspaceCases.every((c) => c.status === "passed" && c.compositionVersionId === baseline.version.id));
  const compiled = compile();
  assert.deepEqual(compiled.blockers, []);
  const history = compiled.plan.requirements!.flatMap((r) => r.obligations ?? []).find((o) => o.kind === "history");
  assert.ok(history?.kind === "history");
  assert.equal(history.history.baseVersion, baseline.version.id);
  assert.equal(history.history.expected.fields.tags, "Hello");
  const original = JSON.stringify({ composition: workspace.composition(), tasks: workspace.query() });
  const tags = workspace.release.get(baseline.version.members!.find((m) => m.pluginId === "tags")!.versionId!);
  const source = tags.source.replace("String(input.tags).trim()", "String(input.tags).trim().toLowerCase()");
  assert.notEqual(source, tags.source);
  const member = workspace.release.record({ pluginId: tags.pluginId, name: tags.name, service: tags.service,
    contractVersion: tags.contractVersion, definition: tags.definition, source, code: source,
    evidence: { passed: false, origin: "model-stub-history-upgrade" } });
  const base = baseline.version;
  const candidate = workspace.release.record({ pluginId: base.pluginId, name: base.name, service: base.service,
    contractVersion: base.contractVersion, definition: base.definition, source: base.source, code: base.code,
    members: base.members!.map((m) => m.pluginId === "tags" ? { ...m, versionId: member.id } : m),
    evidence: { passed: false, origin: "model-stub-history-upgrade" } });
  const signal = new AbortController().signal;
  await verifyViaIsolatedWorkspace(workspace, candidate, compiled.plan.memberCases!, signal);
  const evidence = await verifyBrowser(workspace, candidate, base, compiled.plan.browserCases!, compiled.plan.requirements!, hash(compiled.plan.browserCases), signal, compiled.plan.memberCases);
  assert.ok(evidence.results.every((c) => c.status === "passed"));
  assert.ok(evidence.preparations!.length >= 2);
  assert.ok(evidence.preparations!.every((p) => p.status === "passed" && p.expected.fields.tags === "Hello" && p.actual.fields.tags === "Hello"));
  assert.equal(JSON.stringify({ composition: workspace.composition(), tasks: workspace.query() }), original);
});
