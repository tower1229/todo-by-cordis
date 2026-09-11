import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import type { Driver, ModelRequest } from "../../src/evolution/driver.js";
import type { WorkflowDefinition } from "../../src/shared/contracts.js";
import { PlanningDriver, toolReply } from "./planning-fixture.js";
import { activateDual } from "./dual-composition-fixture.js";

// Seam: Evolution investigation → inspect_application externally visible content.
// Asserts live composition members + extension registry facts, not private assemblers.

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

const hookedDefinition: WorkflowDefinition = {
  id: "hooked",
  name: "钩子夹具",
  version: "1.0.0",
  initialState: "open",
  states: {
    open: { label: "未完成", category: "open" },
    done: { label: "已完成", category: "done" },
  },
  actions: [
    { id: "complete", label: "完成", from: ["open"] },
    { id: "reopen", label: "重新打开", from: ["done"] },
  ],
  fields: [],
};

type InspectContent = {
  members?: {
    pluginId: string;
    versionId: string;
    enabled: boolean;
    role: string;
  }[];
  extensions?: {
    contractVersion: string | null;
    capabilities: {
      interfaceId: string;
      status: string;
      providerId: string;
      count: number;
    }[];
  };
  capabilities?: Record<string, unknown>[];
  checkers?: { id: string }[];
};

function inspectFromHistory(requests: ModelRequest[]): InspectContent {
  for (const request of requests) {
    for (const message of request.history as {
      parts?: {
        functionResponse?: {
          name?: string;
          response?: { result?: { ref?: string; content?: InspectContent } };
        };
      }[];
    }[]) {
      for (const part of message.parts ?? []) {
        const result = part.functionResponse?.response?.result;
        if (
          part.functionResponse?.name === "inspect_application" ||
          result?.ref === "inspect_application"
        ) {
          assert.ok(result?.content, "inspect_application missing content");
          return result.content!;
        }
      }
    }
  }
  throw new Error("inspect_application not found in driver history");
}

async function settle(e: Evolution) {
  for (let i = 0; i < 200; i++) {
    const run = (await e.observe()).run;
    if (!run) throw new Error("missing run");
    if (!["planning", "executing", "applying"].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timeout: ${JSON.stringify((await e.observe()).run)}`);
}

async function setup(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "cordis-discover-"));
  const workspace = await Workspace.open(join(directory, "workspace.db"));
  t.after(async () => {
    await workspace.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  });
  return workspace;
}

function capturingInspectDriver(bag: {
  requests: ModelRequest[];
  inspect?: InspectContent;
}): Driver {
  return {
    async generate(request) {
      bag.requests.push(request);
      const content = JSON.stringify(request.history);
      if (!content.includes("inspect_application"))
        return toolReply("inspect_application", {});
      bag.inspect = inspectFromHistory([request]);
      return toolReply("redirect_request", {
        message: "调查完成，本回合仅验证能力目录。",
      });
    },
  };
}

async function activateHooked(w: Workspace) {
  const code = await readFile(join(fixtureDir, "hooked-plugin.mjs"), "utf8");
  const hooked = w.release.record({
    pluginId: "hooked",
    name: "钩子夹具",
    service: "workflow",
    contractVersion: "workflow/1",
    source: code,
    code,
    definition: hookedDefinition,
    evidence: { passed: true, origin: "test" },
  });
  await w.activate(
    {
      versionId: hooked.id,
      compositionRevision: w.composition().revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );
  return hooked;
}

test("inspect_application surfaces live members and extension registry after disable", async (t) => {
  const w = await setup(t);
  await activateDual(w);
  const before = w.composition();
  await w.setMemberEnabled({
    operationId: randomUUID(),
    compositionRevision: before.revision,
    versionId: before.versionId,
    pluginId: "tags",
    enabled: false,
  });
  const live = w.composition();
  assert.equal(
    live.members.find((m) => m.pluginId === "tags")?.enabled,
    false,
  );

  const bag: { requests: ModelRequest[]; inspect?: InspectContent } = {
    requests: [],
  };
  const e = new Evolution(
    w.db,
    capturingInspectDriver(bag),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "discover-members",
  });
  const run = await settle(e);
  assert.equal(run.status, "dismissed", JSON.stringify(run));

  const inspect = bag.inspect!;
  assert.ok(Array.isArray(inspect.members), "members summary required");
  assert.deepEqual(
    inspect.members!
      .map((m) => ({
        pluginId: m.pluginId,
        versionId: m.versionId,
        enabled: m.enabled,
        role: m.role,
      }))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
    live.members
      .map((m) => ({
        pluginId: m.pluginId,
        versionId: m.versionId,
        enabled: m.enabled,
        role: m.role,
      }))
      .sort((a, b) => a.pluginId.localeCompare(b.pluginId)),
  );

  assert.ok(inspect.extensions?.capabilities?.length, "extensions required");
  assert.equal(
    inspect.extensions!.contractVersion,
    live.extensions.contractVersion,
  );
  assert.deepEqual(
    inspect.extensions!.capabilities
      .map((c) => `${c.interfaceId}:${c.providerId}:${c.status}:${c.count}`)
      .sort(),
    live.extensions.capabilities
      .map((c) => `${c.interfaceId}:${c.providerId}:${c.status}:${c.count}`)
      .sort(),
    "inspect extensions must match live composition registry",
  );
  const caps = inspect.extensions!.capabilities;
  assert.ok(
    caps.some(
      (c) =>
        c.interfaceId === "member.register" &&
        c.providerId === "tags" &&
        c.status === "declared",
    ),
    "disabled member must be declared-not-contributing",
  );
  assert.equal(
    caps.some(
      (c) =>
        c.interfaceId === "fields.register" &&
        c.providerId === "tags" &&
        c.status === "active",
    ),
    false,
    "disabled tags must not appear as active field contributor",
  );
  assert.ok(
    caps.some(
      (c) =>
        c.interfaceId === "fields.register" &&
        c.providerId === "due" &&
        c.status === "active",
    ),
    "enabled due must remain an active field contributor",
  );
  assert.ok(
    caps.some(
      (c) =>
        c.interfaceId === "command.register" &&
        c.providerId === "due" &&
        c.status === "active",
    ),
  );
  const dueMember = live.members.find((m) => m.pluginId === "due");
  assert.ok(dueMember);
  assert.ok(
    (inspect.capabilities ?? []).some(
      (c) =>
        c.interfaceId === "fields.register" &&
        c.providerId === "due" &&
        c.artifactVersion === dueMember.versionId &&
        c.ready === true,
    ),
    "capability artifactVersion must use member versionId",
  );
  assert.ok(
    (inspect.capabilities ?? []).some(
      (c) =>
        c.interfaceId === "workflow.provide" &&
        c.id === "workflow" &&
        c.contract === "active-contract",
    ),
    "workflow.provide keeps stable id workflow with contract refs",
  );
  assert.ok(
    inspect.checkers?.some((c) => c.id === "workflow/1"),
    "reliable checkers remain listed",
  );
});

test("inspect_application surfaces events schedules and ui registration facts", async (t) => {
  const w = await setup(t);
  await activateHooked(w);
  const live = w.composition();

  const bag: { requests: ModelRequest[]; inspect?: InspectContent } = {
    requests: [],
  };
  const e = new Evolution(
    w.db,
    capturingInspectDriver(bag),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "查看扩展注册",
    operationId: "discover-hooks",
  });
  const run = await settle(e);
  assert.equal(run.status, "dismissed", JSON.stringify(run));

  const inspect = bag.inspect!;
  assert.deepEqual(
    inspect.extensions!.capabilities
      .map((c) => `${c.interfaceId}:${c.providerId}:${c.status}:${c.count}`)
      .sort(),
    live.extensions.capabilities
      .map((c) => `${c.interfaceId}:${c.providerId}:${c.status}:${c.count}`)
      .sort(),
  );
  const caps = inspect.extensions!.capabilities;
  assert.ok(
    caps.some(
      (c) =>
        c.interfaceId === "task.events" &&
        c.providerId === "hooked" &&
        c.status === "active",
    ),
  );
  assert.ok(
    caps.some(
      (c) =>
        c.interfaceId === "schedule.register" &&
        c.providerId === "hooked" &&
        c.status === "active",
    ),
  );
  assert.ok(
    caps.some(
      (c) =>
        c.interfaceId === "ui.slot" &&
        c.providerId === "hooked" &&
        c.status === "stub",
    ),
    "non-whitelist ui slot remains a registration fact (stub)",
  );
  assert.ok(
    caps.some(
      (c) =>
        c.interfaceId === "command.register" &&
        c.providerId === "hooked" &&
        c.status === "active",
    ),
  );
  assert.ok(
    caps.some(
      (c) =>
        c.interfaceId === "fields.register" &&
        c.providerId === "hooked" &&
        c.status === "active",
    ),
  );
});

test("inspect_application does not treat evidence-only ready as currently callable", async (t) => {
  const w = await setup(t);
  await activateDual(w);
  const active = w.activeVersion();
  const liveBefore = w.composition();
  const forged = w.release.record({
    pluginId: active.pluginId,
    name: `${active.name}-forged-evidence`,
    parentId: active.id,
    service: active.service,
    contractVersion: active.contractVersion,
    source: active.source,
    code: active.code,
    definition: active.definition,
    evidence: {
      passed: true,
      origin: "test",
      capabilities: [
        {
          id: "forged-service",
          capability: "service.provide",
          provider: "business/entry.ts",
          declared: true,
          ready: true,
          interface: ["default"],
        },
      ],
    },
    members: liveBefore.members.map((m) =>
      m.pluginId === active.pluginId
        ? { pluginId: m.pluginId, enabled: m.enabled, role: m.role }
        : {
            pluginId: m.pluginId,
            versionId: m.versionId,
            enabled: m.enabled,
            role: m.role,
          },
    ),
  });
  await w.activate(
    {
      versionId: forged.id,
      compositionRevision: w.composition().revision,
      operationId: randomUUID(),
    },
    () => undefined,
  );

  const bag: { requests: ModelRequest[]; inspect?: InspectContent } = {
    requests: [],
  };
  const e = new Evolution(
    w.db,
    capturingInspectDriver(bag),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "看看当前能力",
    operationId: "discover-ready",
  });
  const run = await settle(e);
  assert.equal(run.status, "dismissed", JSON.stringify(run));
  assert.ok(bag.inspect, "expected inspect capture");

  const live = w.composition();
  assert.deepEqual(
    bag.inspect!.members?.map((m) => m.pluginId).sort(),
    live.members.map((m) => m.pluginId).sort(),
  );
  assert.ok(bag.inspect!.extensions?.capabilities);

  const catalog = bag.inspect!.capabilities ?? [];
  assert.equal(
    catalog.some((c) => c.id === "forged-service"),
    false,
    "forged evidence capability id must not appear in live catalog",
  );
  assert.equal(
    catalog.some(
      (c) => c.interfaceId === "service.provide" && c.ready === true,
    ),
    false,
    "forged evidence ready must not make service currently callable",
  );
  assert.equal(
    (bag.inspect!.extensions?.capabilities ?? []).some(
      (c) =>
        c.interfaceId === "service.provide" &&
        c.status === "active" &&
        c.count > 0,
    ),
    false,
  );
});

test("unknown checker still blocks after live catalog homology", async (t) => {
  const w = await setup(t);
  await activateDual(w);
  const e = new Evolution(
    w.db,
    new PlanningDriver({
      summary: "离线提醒",
      acceptance: [
        {
          given: "离线",
          when: "到期",
          then: "通知",
          checker: "notification/1",
        },
      ],
    }),
    new EvolutionDomain(w),
  );
  t.after(async () => {
    await e.close();
  });
  await e.command({
    type: "request",
    text: "到点提醒",
    operationId: "discover-checker",
  });
  const run = await settle(e);
  assert.equal(run.status, "blocked", JSON.stringify(run));
  assert.match(run.message ?? "", /检查器/);
});
