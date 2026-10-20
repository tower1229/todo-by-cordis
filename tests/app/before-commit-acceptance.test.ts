import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Workspace } from "../../src/server/workspace.js";
import {
  verifyViaIsolatedWorkspace,
  type WorkspaceCaseEvidence,
} from "../../src/server/workspace-acceptance.js";
import { activateWorkflowOnly } from "./dual-composition-fixture.js";
import type { Version } from "../../src/release/types.js";
import type { MemberAcceptanceCase } from "../../src/shared/acceptance-cases.js";
import { capture } from "../../src/server/planning.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import type { Driver } from "../../src/evolution/driver.js";

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "before-commit-proof-"));
  const formal = await Workspace.open(join(directory, "formal.db"));
  t.after(async () => {
    await formal.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { composition: base } = await activateWorkflowOnly(formal);
  function candidate(hook: string, workflow = base.source) {
    const member = formal.release.record({
      pluginId: "guard",
      name: "钩子",
      service: "plugin:guard",
      contractVersion: "extensions/1",
      source: hook,
      code: hook,
      definition: { id: "guard" },
      evidence: { passed: true, origin: "test" },
    });
    const version = formal.release.record({
      pluginId: base.pluginId,
      name: base.name,
      service: base.service,
      contractVersion: base.contractVersion,
      source: workflow,
      code: workflow,
      definition: base.definition,
      evidence: { passed: false, origin: "test" },
      members: [
        {
          pluginId: base.pluginId,
          ...(workflow === base.source ? { versionId: base.id } : {}),
          role: "workflow",
          enabled: true,
        },
        {
          pluginId: "guard",
          versionId: member.id,
          role: "auxiliary",
          enabled: true,
        },
      ],
    });
    return { member, version };
  }
  return { formal, base, candidate };
}

const noopHook = `export default { contribute() { return {beforeCommit:true}; }, beforeCommit() { return {kind:"ok"}; } };`;
const effectHook = `export default { contribute() { return {beforeCommit:true}; }, beforeCommit({draft}) { return {kind:"ok",fields:{...draft.fields,reviewed:"yes"}}; } };`;
const frozenCase: MemberAcceptanceCase = {
  name: "reviewed",
  member: "guard",
  state: "open",
  fields: {},
  action: "complete",
  input: {},
  expected: { kind: "commit", state: "done", fields: { reviewed: "yes" } },
};
const executionCase = () => ({
  ...structuredClone(frozenCase),
  name: `workspace:member:guard:${frozenCase.name}`,
});
function withEvidence(
  formal: Workspace,
  version: Version,
  evidence: Record<string, unknown>,
) {
  const {
    id: _id,
    entry: _entry,
    createdAt: _createdAt,
    ...artifact
  } = version;
  return formal.release.record({ ...artifact, evidence });
}
async function activate(formal: Workspace, version: Version) {
  await formal.activate(
    {
      versionId: version.id,
      compositionRevision: formal.composition().revision,
      operationId: crypto.randomUUID(),
    },
    () => undefined,
  );
}

// Seam: trusted isolated Workspace acceptance, the same public verifier used by candidates.
test("辅助钩子可在主工作流动作上验收，证据证明真实调用及跳过该钩子的反事实差异", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "before-commit-acceptance-"));
  const formal = await Workspace.open(join(directory, "formal.db"));
  t.after(async () => {
    await formal.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { composition: base } = await activateWorkflowOnly(formal);
  const source = `export default {
    contribute() { return { beforeCommit: true }; },
    decide() { return { kind: "reject", message: "unknown" }; },
    beforeCommit({draft, action}) { return { kind: "ok", fields: action === "complete" ? {...draft.fields, reviewed: "yes"} : draft.fields }; }
  };`;
  const member = formal.release.record({
    pluginId: "guard",
    name: "评审钩子",
    service: "plugin:guard",
    contractVersion: "extensions/1",
    source,
    code: source,
    definition: { id: "guard" },
    evidence: { passed: true, origin: "test" },
  });
  const candidate = formal.release.record({
    pluginId: base.pluginId,
    name: base.name,
    service: base.service,
    contractVersion: base.contractVersion,
    source: base.source,
    code: base.code,
    definition: base.definition,
    evidence: { passed: false, origin: "test" },
    members: [
      {
        pluginId: base.pluginId,
        versionId: base.id,
        role: "workflow",
        enabled: true,
      },
      {
        pluginId: "guard",
        versionId: member.id,
        role: "auxiliary",
        enabled: true,
      },
    ],
  });
  const before = JSON.stringify({
    composition: formal.composition(),
    tasks: formal.query(),
  });
  const evidence: WorkspaceCaseEvidence[] = [];
  const checks = await verifyViaIsolatedWorkspace(
    formal,
    candidate,
    [
      {
        name: "complete-review",
        member: "guard",
        state: "open",
        fields: { legacy: "keep" },
        action: "complete",
        input: {},
        expected: {
          kind: "commit",
          state: "done",
          fields: { legacy: "keep", reviewed: "yes" },
        },
      },
    ],
    new AbortController().signal,
    (r) => evidence.push(r),
    [],
    ["guard"],
  );
  assert.ok(checks.includes(`beforeCommit/1:guard@${member.id}`));
  const proof = evidence.find(
    (r) => r.name === "complete-review",
  )?.beforeCommit;
  assert.equal(proof?.providerVersionId, member.id);
  assert.equal(proof?.invoked, true);
  assert.equal(proof?.witness, true);
  assert.deepEqual(proof?.counterfactual?.fields, { legacy: "keep" });
  assert.equal(
    JSON.stringify({
      composition: formal.composition(),
      tasks: formal.query(),
    }),
    before,
  );
});

test("反事实必须复用完整 Given；不同任务标题不能把无效钩子误证为有贡献", async (t) => {
  const { formal, base, candidate } = await fixture(t);
  const workflow = base.source.replace(
    "fields: task.fields",
    'fields: {...task.fields, marker: task.title.startsWith("case:") ? "same" : "different"}',
  );
  assert.notEqual(workflow, base.source);
  const { version } = candidate(noopHook, workflow);
  await assert.rejects(
    verifyViaIsolatedWorkspace(
      formal,
      version,
      [
        {
          name: "title-sensitive",
          member: "guard",
          state: "open",
          fields: {},
          action: "complete",
          input: {},
          expected: {
            kind: "commit",
            state: "done",
            fields: { marker: "same" },
          },
        },
      ],
      new AbortController().signal,
      undefined,
      [],
      ["guard"],
    ),
    /beforeCommit.*可观察差异/,
  );
});

test("缺失、无效、错误提供者及篡改期望都不能签发钩子验收；正式任务与组合保持不变", async (t) => {
  const { formal, candidate } = await fixture(t);
  const before = JSON.stringify({
    composition: formal.composition(),
    tasks: formal.query(),
  });
  const signal = new AbortController().signal;
  const missing = candidate(
    `export default { contribute() { return {}; } };`,
  ).version;
  await assert.rejects(
    verifyViaIsolatedWorkspace(
      formal,
      missing,
      [executionCase()],
      signal,
      undefined,
      [],
      ["guard"],
    ),
    /不是成员 guard 的贡献/,
  );
  const noop = candidate(noopHook).version;
  const noopCase = {
    ...executionCase(),
    expected: { kind: "commit" as const, state: "done", fields: {} },
  };
  await assert.rejects(
    verifyViaIsolatedWorkspace(
      formal,
      noop,
      [noopCase],
      signal,
      undefined,
      [],
      ["guard"],
    ),
    /beforeCommit.*可观察差异/,
  );
  const effective = candidate(effectHook).version;
  await assert.rejects(
    verifyViaIsolatedWorkspace(
      formal,
      effective,
      [executionCase()],
      signal,
      undefined,
      [],
      ["other"],
    ),
    /不是成员 guard 的贡献/,
  );
  const evidence: WorkspaceCaseEvidence[] = [];
  await assert.rejects(
    verifyViaIsolatedWorkspace(
      formal,
      effective,
      [
        {
          ...executionCase(),
          expected: {
            kind: "commit",
            state: "done",
            fields: { reviewed: "forged" },
          },
        },
      ],
      signal,
      (r) => evidence.push(r),
      [],
      ["guard"],
    ),
    /预期.*forged/,
  );
  assert.equal(evidence[0].status, "failed");
  assert.equal(
    JSON.stringify({
      composition: formal.composition(),
      tasks: formal.query(),
    }),
    before,
  );
});

test("正式 Workspace 禁止钩子探针和任务复制；取消的验收不产生通过证据", async (t) => {
  const { formal, candidate } = await fixture(t);
  const created = await formal.command({
    type: "create",
    title: "正式合成任务",
    operationId: crypto.randomUUID(),
    compositionRevision: formal.composition().revision,
  });
  assert.ok(created.task);
  const before = JSON.stringify({
    composition: formal.composition(),
    tasks: formal.query(),
  });
  assert.throws(
    () => formal.replicateAcceptanceTask(created.task!),
    /仅隔离验收探针/,
  );
  await assert.rejects(
    Workspace.open(join(tmpdir(), `forbidden-hook-${crypto.randomUUID()}.db`), {
      acceptanceBeforeCommit: { skipProvider: "guard" },
    }),
    /仅隔离验收探针/,
  );
  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const evidence: WorkspaceCaseEvidence[] = [];
  await assert.rejects(
    verifyViaIsolatedWorkspace(
      formal,
      candidate(effectHook).version,
      [executionCase()],
      controller.signal,
      (r) => evidence.push(r),
      [],
      ["guard"],
    ),
    /cancelled/,
  );
  assert.equal(evidence.length, 0);
  assert.equal(
    JSON.stringify({
      composition: formal.composition(),
      tasks: formal.query(),
    }),
    before,
  );
});

test("动态钩子覆盖绑定真实成员产物，不能将旧钩子证据移植给新的无效实现", async (t) => {
  const { formal, candidate } = await fixture(t);
  const good = candidate(effectHook);
  const evidence: WorkspaceCaseEvidence[] = [];
  await verifyViaIsolatedWorkspace(
    formal,
    good.version,
    [executionCase()],
    new AbortController().signal,
    (r) => evidence.push(r),
    [],
    ["guard"],
  );
  const passed = withEvidence(formal, good.version, {
    passed: true,
    origin: "test",
    memberCases: [frozenCase],
    workspaceCases: evidence,
  });
  await activate(formal, passed);
  assert.deepEqual(
    capture(formal).capabilities.find(
      (c) => c.interfaceId === "task.beforeCommit" && c.providerId === "guard",
    )?.checkerCoverage,
    ["beforeCommit/1"],
  );
  const stale = structuredClone(evidence);
  for (const receipt of stale)
    if (receipt.beforeCommit)
      receipt.beforeCommit.checkerVersion = "obsolete-checker";
  await activate(
    formal,
    withEvidence(formal, good.version, {
      passed: true,
      origin: "test",
      memberCases: [frozenCase],
      workspaceCases: stale,
    }),
  );
  assert.deepEqual(
    capture(formal).capabilities.find(
      (c) => c.interfaceId === "task.beforeCommit" && c.providerId === "guard",
    )?.checkerCoverage,
    [],
  );
  const invalid = candidate(noopHook);
  const copied = structuredClone(evidence);
  for (const receipt of copied)
    if (receipt.beforeCommit)
      receipt.beforeCommit.finalProviderVersionId = invalid.member.id;
  const forged = withEvidence(formal, invalid.version, {
    passed: true,
    origin: "test",
    memberCases: [frozenCase],
    workspaceCases: copied,
  });
  await activate(formal, forged);
  assert.deepEqual(
    capture(formal).capabilities.find(
      (c) => c.interfaceId === "task.beforeCommit" && c.providerId === "guard",
    )?.checkerCoverage,
    [],
  );
});

test("模型桩经公开控制面生成纯钩子候选，后端与真实浏览器通过后绑定最终成员，仍等待应用确认", async (t) => {
  const { formal } = await fixture(t);
  const quote =
    "对 needsReview=yes 的历史任务，完成时写入 reviewed=yes；其他行为不变";
  const businessCases = [
    {
      state: "open",
      fields: { needsReview: "yes" },
      action: "complete",
      input: {},
      expected: {
        kind: "commit",
        state: "done",
        fields: { needsReview: "yes", reviewed: "yes" },
      },
    },
    {
      state: "done",
      fields: { needsReview: "yes" },
      action: "complete",
      input: {},
      expected: { kind: "reject" },
    },
  ];
  const code = `export default {
    contribute() { return { beforeCommit: true }; },
    beforeCommit({draft,action}: {draft:{fields:Record<string,string>};action:string}) {
      return {kind:"ok",fields:action === "complete" && draft.fields.needsReview === "yes" ? {...draft.fields,reviewed:"yes"} : draft.fields};
    }
  };`;
  const planner = new PlanningDriver();
  const driver: Driver = {
    async generate(request, signal) {
      if (request.tools?.some((tool) => tool.name === "submit_candidate"))
        return toolReply("submit_candidate", {
          files: [],
          members: [{ pluginId: "guard", source: code }],
        });
      const reply = await planner.generate(request);
      const proposal = reply.calls.find((c) => c.name === "propose_plan");
      if (proposal)
        proposal.args = {
          changes: [
            {
              target: "guard",
              name: "评审钩子",
              features: ["beforeCommit"],
              cases: businessCases,
            },
          ],
          requirements: [
            { quote, type: "behavior", expectations: [{ kind: "behavior" }] },
          ],
        };
      signal.throwIfAborted();
      return reply;
    },
  };
  const evolution = new Evolution(
    formal.db,
    driver,
    new EvolutionDomain(formal),
  );
  t.after(() => evolution.close());
  async function settled() {
    const until = Date.now() + 90_000;
    while (Date.now() < until) {
      const run = (await evolution.observe()).run;
      if (run && !["planning", "executing", "applying"].includes(run.status))
        return run;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("钩子候选验证超时");
  }
  const before = JSON.stringify({
    composition: formal.composition(),
    tasks: formal.query(),
  });
  await evolution.command({
    type: "request",
    text: quote,
    operationId: "hook-request",
  });
  const ready = await settled();
  assert.equal(ready.status, "ready", JSON.stringify(ready));
  if (ready.status !== "ready") return;
  assert.ok(
    ready.plan.binding?.checkers.some((c) => c.id === "beforeCommit/1"),
  );
  await evolution.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "hook-start",
  });
  const finished = await settled();
  assert.equal(finished.status, "awaiting-apply", JSON.stringify(finished));
  const candidate = (await evolution.observe()).candidates?.find(
    (c) => c.passed && c.versionId,
  );
  assert.ok(candidate?.versionId);
  const version = formal.release.get(candidate.versionId);
  const evidence = version.evidence as {
    workspaceCases: WorkspaceCaseEvidence[];
    browser: { results: { status: string }[] };
  };
  const proof = evidence.workspaceCases.find(
    (c) => c.beforeCommit?.witness,
  )?.beforeCommit;
  const guard = version.members?.find((m) => m.pluginId === "guard");
  assert.ok(proof && guard?.versionId);
  assert.equal(proof.finalProviderVersionId, guard.versionId);
  assert.equal(
    evidence.browser.results.every((r) => r.status === "passed"),
    true,
  );
  assert.equal(
    JSON.stringify({
      composition: formal.composition(),
      tasks: formal.query(),
    }),
    before,
  );
});
