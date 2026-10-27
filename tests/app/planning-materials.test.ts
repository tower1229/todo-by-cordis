import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Evolution } from "../../src/evolution/evolution.js";
import type { ModelRequest } from "../../src/evolution/driver.js";
import { Workspace } from "../../src/server/workspace.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import type {
  Investigation,
  InvestigationDocument,
} from "../../src/server/planning.js";
import { capabilityGuides } from "../../src/server/capability-guides.js";
import { hash } from "../../src/release/storage.js";
import { admissionFixture, toolReply } from "./planning-fixture.js";
import { settleEvolution } from "./evolution-adapter.js";

const guide = "guide/command.register";

async function capturePlanning(
  t: TestContext,
  change?: (context: Investigation) => void,
) {
  const directory = mkdtempSync(join(tmpdir(), "cordis-planning-materials-"));
  const w = await Workspace.open(join(directory, "workspace.db"));
  await w.command({
    type: "create",
    operationId: "private",
    compositionRevision: w.composition().revision,
    title: "private-task-never-deliver",
  });
  const context = new EvolutionDomain(w).context();
  change?.(context);
  const domain = new EvolutionDomain(w);
  domain.context = () => context;
  const requests: ModelRequest[] = [];
  const e = new Evolution(
    w.db,
    {
      async generate(request) {
        const admission = admissionFixture(request);
        if (admission) return admission;
        requests.push(request);
        const input = JSON.parse(request.message ?? "{}");
        const documents = input.materials?.documents as
          | InvestigationDocument[]
          | undefined;
        // A controlled planner reads the missing protocol, then stops after capturing it.
        const needsRead =
          requests.length === 1 && !documents?.some((d) => d.ref === guide);
        return {
          ...toolReply(
            needsRead ? "read_guides" : "report_blocker",
            needsRead
              ? { refs: [guide] }
              : { reason: "synthetic capture completed" },
          ),
          history: request.history,
        };
      },
    },
    domain,
    undefined,
    { calls: 12, candidates: 3, milliseconds: 600000 },
  );
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(directory, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    operationId: "request",
    text: "请增加标签插件：给任务设置一个文本标签，保存时去掉首尾空格，拒绝空白标签，保留大小写；其他行为不变。",
  });
  const run = await settleEvolution(e);
  const documents = requests[0]?.message
    ? (JSON.parse(requests[0].message).materials
        .documents as InvestigationDocument[])
    : [];
  return { w, context, requests, run, documents };
}

test("原生规划首轮交付未注册的基础动作指南，避免仅为取得协议再调模型（受控桩）", async (t) => {
  const { w, context, requests, run, documents } = await capturePlanning(t);
  const capability = context.capabilities.find(
    (c) => c.interfaceId === "command.register",
  )!;
  assert.equal(capability.ready, false);
  assert.equal(capability.inUse, false);
  const delivered = documents.find((d) => d.ref === guide);
  assert.ok(
    delivered,
    "新增动作尚未注册时也需要精确协议，不能等 ready 才交付指南",
  );
  assert.equal(delivered.content, capabilityGuides[guide]);
  assert.equal(delivered.hash, hash(delivered.content));
  assert.ok(
    run.evidence?.some((e) => e.ref === guide && e.hash === delivered.hash),
  );
  assert.ok(
    w.db
      .prepare("SELECT body FROM evolution_materials WHERE hash=?")
      .get(delivered.hash),
  );
  assert.equal(
    requests.length,
    1,
    "已有精确资料时不需要受控规划器额外读取指南",
  );
  assert.equal(run.budget?.callsUsed, 2, "需求预检与规划照常计数");
  assert.equal(run.status, "blocked", "捕获桩不构成 ready 或验收通过");
  assert.equal(
    documents.some(
      (d) =>
        d.ref === "guide/task.events" || d.ref === "guide/schedule.register",
    ),
    false,
    "其余未使用能力继续按需读取",
  );
  assert.ok(
    documents.some((d) => d.ref === "src/server/workflow-acceptance.ts"),
    "独立检查器全文仍须交付",
  );
  assert.doesNotMatch(JSON.stringify(requests), /private-task-never-deliver/);
});

test("基础动作指南不因提前交付而越过安装、启用或授权边界", async (t) => {
  for (const key of ["installed", "enabled", "authorized"] as const) {
    await t.test(key, async (t) => {
      const { documents, context } = await capturePlanning(t, (context) => {
        context.capabilities.find((c) => c.interfaceId === "command.register")![
          key
        ] = false;
      });
      assert.equal(
        context.capabilities.find((c) => c.interfaceId === "command.register")![
          key
        ],
        false,
      );
      assert.equal(
        documents.some((d) => d.ref === guide),
        false,
      );
    });
  }
});

test("首轮指南摘要失效时停止，不能补造资料或跳过复核", async (t) => {
  const { requests, run } = await capturePlanning(t, (context) => {
    context.guideHashes[guide] = "stale";
  });
  assert.equal(requests.length, 0);
  assert.equal(run.status, "failed", "沿用 PLAN_STALE 的失败状态");
  assert.equal(run.budget?.callsUsed, 0);
  assert.match(JSON.stringify(run), /能力指南与调查目录不一致/);
});
