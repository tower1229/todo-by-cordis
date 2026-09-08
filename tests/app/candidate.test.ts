import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Workspace } from "../../src/server/workspace.js";
import { Evolution } from "../../src/evolution/evolution.js";
import { EvolutionDomain } from "../../src/server/evolution-domain.js";
import { PlanningDriver } from "./planning-fixture.js";
import { ExecutionDriver } from "./execution-fixture.js";
import { source } from "./evolution-fixture.js";
import type { Driver } from "../../src/evolution/driver.js";

async function settled(e: Evolution) {
  for (let i = 0; i < 1000; i++) {
    const snapshot = await e.observe();
    if (
      snapshot.run &&
      !["planning", "executing"].includes(snapshot.run.status)
    )
      return snapshot;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("execution timeout");
}

test("A05: complete multifile candidate repairs a real compiler failure and retains immutable attempts", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-candidate-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const original = w.composition();
  const fallback = new ExecutionDriver(
    new PlanningDriver({
      writableScope: [
        "business/entry.ts",
        "business/provider.ts",
        "business/view.ts",
        "business/config.json",
        "business/compatibility.json",
      ],
    }),
  );
  let attempts = 0;
  const driver: Driver = {
    async generate(request, signal) {
      const reply = await fallback.generate(request);
      if (reply.calls[0]?.name !== "submit_candidate") return reply;
      attempts++;
      return {
        ...reply,
        calls: [
          {
            name: "submit_candidate",
            args: {
              files: [
                {
                  path: "business/entry.ts",
                  content:
                    'import plugin from "./provider.js"; export default plugin;',
                },
                {
                  path: "business/provider.ts",
                  content:
                    attempts === 1
                      ? "const broken: string = 42; export default broken;"
                      : source("default", "轻快完成"),
                },
                {
                  path: "business/view.ts",
                  content:
                    'export default { title: "复盘", fields: ["reflection"] };',
                },
                { path: "business/config.json", content: "{}" },
                {
                  path: "business/compatibility.json",
                  content: '{"preserveUnknownFields":true}',
                },
              ],
            },
          },
        ],
      };
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: "完成前填写复盘",
    operationId: "request",
  });
  const ready = (await settled(e)).run!;
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  await e.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "start",
  });
  const snapshot = await settled(e);
  assert.equal(
    snapshot.run?.status,
    "awaiting-apply",
    JSON.stringify(snapshot),
  );
  assert.equal(attempts, 2);
  assert.equal(snapshot.run?.budget?.candidatesRemaining, 1);
  assert.equal(w.composition().versionId, original.versionId);
  assert.ok(
    snapshot.events?.some(
      (event) =>
        event.status === "failed" && /string|number/.test(event.detail ?? ""),
    ),
  );
  const candidates = snapshot.candidates!;
  assert.equal(candidates.length, 2);
  assert.notEqual(candidates[0].id, candidates[1].id);
  assert.equal(candidates[0].passed, false);
  assert.equal(candidates[1].passed, true);
  assert.ok(candidates[0].diagnostic);
  assert.equal(candidates[1].planId, ready.plan.id);
  assert.ok(candidates[1].evidenceHash);
  const version = w.release.get(snapshot.run!.versionId!);
  assert.ok(version.bundle?.outputs["business/view.js"]);
  const path = join(w.release.directory, version.id, "business/view.js");
  const alias = join(dir, "aliased-view.js");
  writeFileSync(alias, readFileSync(path));
  unlinkSync(path);
  symlinkSync(alias, path);
  await assert.rejects(w.release.start(version), /路径|符号链接/);
});

test("new provider and consumer implement an additional action with frozen independent cases", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "cordis-capability-"));
  const w = await Workspace.open(join(dir, "workspace.db"));
  const planning = new PlanningDriver({
    writableScope: [
      "business/entry.ts",
      "business/counter.ts",
      "business/metadata.json",
      "business/view.ts",
      "business/config.json",
      "business/compatibility.json",
    ],
    capabilityChanges: [
      {
        capability: "workflow",
        provider: "business/entry.ts",
        consumers: ["business/view.ts"],
        change: "保留复盘消费界面",
      },
      {
        capability: "counter",
        provider: "business/counter.ts",
        consumers: ["business/entry.ts", "business/view.ts"],
        change: "增加独立计数提供者并接入动作",
      },
    ],
    extensions: {
      actions: [{ id: "increment", label: "计数", from: ["open"] }],
      fields: [{ key: "count", label: "次数", type: "text" }],
      cases: [
        {
          name: "新增计数",
          state: "open",
          fields: {},
          action: "increment",
          input: {},
          expected: { kind: "commit", state: "open", fields: { count: "1" } },
        },
        {
          name: "保留并累加",
          state: "open",
          fields: { count: "7" },
          action: "increment",
          input: {},
          expected: { kind: "commit", state: "open", fields: { count: "8" } },
        },
        {
          name: "完成后不能计数",
          state: "done",
          fields: {},
          action: "increment",
          input: {},
          expected: { kind: "reject" },
        },
      ],
    },
  });
  const fallback = new ExecutionDriver(planning);
  let attempt = 0;
  const driver: Driver = {
    async generate(request) {
      const reply = await fallback.generate(request);
      if (reply.calls[0]?.name !== "submit_candidate") return reply;
      attempt++;
      const code = source("default", "轻快完成").replace(
        "export default",
        "const base =",
      );
      return {
        ...reply,
        calls: [
          {
            name: "submit_candidate",
            args: {
              files: [
                { path: "business/metadata.json", content: '{"label":"keep"}' },
                {
                  path: "business/entry.ts",
                  content: `import { increment } from './counter.js';\n${code}\nexport default { describe() { const d = base.describe(); return {...d, actions: [...d.actions, {id:'increment',label:'计数',from:['open']}], fields:[...d.fields,{key:'count',label:'次数',type:'text'}]}; }, decide(data: Parameters<typeof base.decide>[0]) { if (data.action !== 'increment') return base.decide(data); if(data.task.state !== 'open') return {kind:'reject',message:'不可用'}; return {kind:'commit',state:data.task.state,fields:{...data.task.fields,count:String(increment(Number(data.task.fields.count ?? '0')))}}; } };`,
                },
                {
                  path: "business/counter.ts",
                  content: `export function increment(value: number) { return value + ${attempt === 1 ? 2 : 1}; }`,
                },
                {
                  path: "business/view.ts",
                  content:
                    "export default { title: '计数', fields: ['reflection', 'count'] };",
                },
                { path: "business/config.json", content: "{}" },
                {
                  path: "business/compatibility.json",
                  content: '{"preserveUnknownFields":true}',
                },
              ],
            },
          },
        ],
      };
    },
  };
  const e = new Evolution(w.db, driver, new EvolutionDomain(w));
  t.after(async () => {
    await e.close();
    await w.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await e.command({
    type: "request",
    text: "给未完成任务增加计数动作，保留原复盘",
    operationId: "plan",
  });
  const ready = (await settled(e)).run!;
  assert.equal(
    ready.status,
    "ready",
    ready.status === "blocked" ? ready.message : ready.status,
  );
  if (ready.status !== "ready") return;
  await e.command({
    type: "start",
    runId: ready.id,
    planId: ready.plan.id,
    operationId: "start",
  });
  const snapshot = await settled(e);
  assert.equal(
    snapshot.run?.status,
    "awaiting-apply",
    snapshot.candidates?.map((c) => c.diagnostic).join("\n"),
  );
  assert.equal(attempt, 2);
  assert.ok(ready.plan.acceptance?.some((c) => c.includes("increment")));
  assert.match(snapshot.candidates![0].diagnostic!, /新增计数/);
  assert.ok(snapshot.candidates![0].versionId);
  assert.ok(w.release.get(snapshot.candidates![0].versionId!).bundle);
  const experience = await e.command({
    type: "experience",
    operationId: "preview-counter",
    runId: ready.id,
    candidateId: snapshot.candidates!.find((c) => c.passed)!.id,
  });
  assert.equal(experience.run?.status, "awaiting-apply");
  if (experience.run?.status !== "awaiting-apply")
    throw new Error("expected candidate");
  assert.ok(experience.run.experience?.checks.includes("extension:保留并累加"));
  assert.equal(w.composition().revision, 1);
  assert.equal(w.query().total, 0);
  const runtime = await w.release.start(
    w.release.get(snapshot.run!.versionId!),
  );
  t.after(() => runtime.close());
  const decision = await runtime.invoke("decide", {
    task: { state: "open", fields: { count: "12", retained: "keep" } },
    action: "increment",
    input: {},
  });
  assert.deepEqual(decision, {
    kind: "commit",
    state: "open",
    fields: { count: "13", retained: "keep" },
  });
  assert.equal(w.query().total, 0);
  await runtime.close();
  const firstVersion = w.release.get(snapshot.run!.versionId!);
  // Synthetic host publication creates a real base for a later independent plan.
  await w.activate(
    {
      versionId: firstVersion.id,
      operationId: "synthetic-publish",
      compositionRevision: 1,
    },
    () => {},
  );
  await e.command({
    type: "cancel",
    runId: ready.id,
    operationId: "finish-first",
  });
  await e.close();
  const nextPlanning = new PlanningDriver({
    writableScope: ["business/counter.ts"],
    capabilityChanges: [
      {
        capability: "counter",
        provider: "business/counter.ts",
        consumers: ["business/entry.ts", "business/view.ts"],
        change: "在原能力内修正实现并保留验收",
      },
    ],
  });
  const nextFallback = new ExecutionDriver(nextPlanning);
  let repairs = 0;
  let omitMetadata = false;
  const next = new Evolution(
    w.db,
    {
      async generate(request) {
        const reply = await nextFallback.generate(request);
        if (reply.calls[0]?.name === "read_source")
          reply.calls.push(
            ...[
              "business/counter.ts",
              "business/entry.ts",
              "business/view.ts",
            ].map((ref) => ({ name: "read_source", args: { ref } })),
          );
        if (reply.calls[0]?.name !== "submit_candidate") return reply;
        repairs++;
        return {
          ...reply,
          calls: [
            {
              name: "submit_candidate",
              args: {
                files: Object.entries(firstVersion.bundle!.files)
                  .filter(
                    ([path]) =>
                      path !== "business/contract.ts" &&
                      !(omitMetadata && path === "business/metadata.json"),
                  )
                  .map(([path, content]) => ({
                    path,
                    content:
                      path === "business/counter.ts"
                        ? `export function increment(value:number) { return ${repairs === 1 ? 2 : 1} + value; }`
                        : content,
                  })),
              },
            },
          ],
        };
      },
    },
    new EvolutionDomain(w),
  );
  t.after(() => next.close());
  await next.command({
    type: "request",
    text: "继续改进计数实现，保留原有业务行为",
    operationId: "next-plan",
  });
  const nextReady = (await settled(next)).run!;
  assert.equal(
    nextReady.status,
    "ready",
    nextReady.status === "blocked" ? nextReady.message : nextReady.status,
  );
  if (nextReady.status !== "ready") return;
  assert.deepEqual(nextReady.plan.extensions, ready.plan.extensions);
  await next.command({
    type: "start",
    runId: nextReady.id,
    planId: nextReady.plan.id,
    operationId: "next-start",
  });
  const nextDone = await settled(next);
  assert.equal(
    nextDone.run?.status,
    "awaiting-apply",
    nextDone.candidates?.map((c) => c.diagnostic).join("\n"),
  );
  assert.equal(repairs, 2);
  assert.match(nextDone.candidates![0].diagnostic!, /新增计数/);
  const firstCapabilities = firstVersion.evidence as {
    capabilities: { id: string }[];
  };
  const nextCapabilities = w.release.get(nextDone.run!.versionId!).evidence as {
    capabilities: { id: string }[];
  };
  assert.deepEqual(
    nextCapabilities.capabilities.map((c) => c.id).sort(),
    firstCapabilities.capabilities.map((c) => c.id).sort(),
  );
  await next.command({
    type: "cancel",
    runId: nextReady.id,
    operationId: "end-second",
  });
  omitMetadata = true;
  await next.command({
    type: "request",
    text: "继续改进计数",
    operationId: "scope-plan",
  });
  const scopeReady = (await settled(next)).run!;
  assert.equal(scopeReady.status, "ready");
  if (scopeReady.status !== "ready") return;
  await next.command({
    type: "start",
    runId: scopeReady.id,
    planId: scopeReady.plan.id,
    operationId: "scope-start",
  });
  const blocked = await settled(next);
  assert.equal(blocked.run?.status, "blocked");
  assert.match(blocked.candidates![0].diagnostic!, /冻结可写范围/);
});

test("A10: protected paths, type-only escapes and forged validation reports stop the frozen execution", async (t) => {
  for (const attack of ["path", "type-import", "report", "scope", "source"]) {
    await t.test(attack, async (t) => {
      const dir = mkdtempSync(join(tmpdir(), "cordis-protection-"));
      const w = await Workspace.open(join(dir, "workspace.db"));
      const fallback = new ExecutionDriver(
        new PlanningDriver({
          writableScope:
            attack === "source"
              ? ["business/view.ts"]
              : [
                  "business/entry.ts",
                  "business/view.ts",
                  "business/config.json",
                  "business/compatibility.json",
                ],
        }),
      );
      const driver: Driver = {
        async generate(request) {
          const reply = await fallback.generate(request);
          if (reply.calls[0]?.name !== "submit_candidate") return reply;
          if (attack === "source") return reply;
          return {
            ...reply,
            calls: [
              {
                name: "submit_candidate",
                args: {
                  ...(attack === "report"
                    ? { evidence: { passed: true } }
                    : {}),
                  files: [
                    {
                      path: "business/entry.ts",
                      content:
                        (attack === "type-import"
                          ? 'import type { Secret } from "/tmp/private.ts";\n'
                          : "") + source("default", "轻快完成"),
                    },
                    {
                      path: "business/view.ts",
                      content:
                        "export default {title:'复盘',fields:['reflection']};",
                    },
                    { path: "business/config.json", content: "{}" },
                    {
                      path: "business/compatibility.json",
                      content: '{"preserveUnknownFields":true}',
                    },
                    ...(attack === "path"
                      ? [
                          {
                            path: "business/../evolution/evolution.ts",
                            content: "export default {};",
                          },
                        ]
                      : []),
                    ...(attack === "scope"
                      ? [
                          {
                            path: "business/unplanned.ts",
                            content: "export default {};",
                          },
                        ]
                      : []),
                  ],
                },
              },
            ],
          };
        },
      };
      const e = new Evolution(w.db, driver, new EvolutionDomain(w));
      t.after(async () => {
        await e.close();
        await w.close();
        rmSync(dir, { recursive: true, force: true });
      });
      await e.command({
        type: "request",
        text: "完成前复盘",
        operationId: "plan",
      });
      const ready = (await settled(e)).run!;
      assert.equal(ready.status, "ready");
      if (ready.status !== "ready") return;
      await e.command({
        type: "start",
        runId: ready.id,
        planId: ready.plan.id,
        operationId: "start",
      });
      const snapshot = await settled(e);
      assert.equal(snapshot.run?.status, "blocked");
      assert.equal(snapshot.candidates?.length, 1);
      assert.equal(snapshot.candidates?.[0].passed, false);
      assert.equal(w.composition().revision, 1);
    });
  }
});
