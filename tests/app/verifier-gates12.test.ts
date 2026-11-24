import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compileFullStackPluginArtifact } from "../../src/build/plugin-builder.js";
import { compileServerPluginArtifact } from "../../src/build/package-loader.js";
import {
  verifyCompositionDag,
  verifyStaticBoundaries,
} from "../../src/verify/static-verifier.js";
import { verifyCandidateGates1And2 } from "../../src/verify/index.js";
import { artifactKey } from "../../src/contracts/topology.js";
import type { CompositionSnapshot, PluginArtifact } from "../../src/contracts/types.js";

describe("PluginVerifier Gate 1a: Static boundaries & DAG", () => {
  it("allows whitelisted server/client imports and intra-package relative imports", () => {
    const artifact: PluginArtifact = {
      pluginId: "review",
      versionId: "v1",
      name: "Review",
      dependencies: ["todo-core"],
      contractTypes: "",
      sourceFiles: {
        "server.ts": `
import type { Context } from "cordis";
import "@host/server-sdk";
import { formatReason } from "./helper.js";
export const name = "review";
export function apply(ctx: Context) { void formatReason; void ctx; }
`,
        "helper.ts": `export function formatReason(s: string) { return s.trim(); }`,
        "client.tsx": `
import type { Context } from "cordis";
import { useState } from "react";
import { Check } from "lucide-react";
import "@host/client-sdk";
import { Badge } from "./components/Badge.tsx";
export const name = "review";
export function apply(ctx: Context) { void useState; void Check; void Badge; void ctx; }
`,
        "components/Badge.tsx": `
import { formatReason } from "../helper.js";
export function Badge() { return <span>{formatReason("ok")}</span>; }
`,
      },
      testFiles: {},
    };

    const violations = verifyStaticBoundaries(artifact);
    assert.deepEqual(violations, []);
  });

  it("rejects Node builtins, dynamic import, require, supervisor shell, and cross-plugin imports", () => {
    const artifact: PluginArtifact = {
      pluginId: "evil",
      versionId: "v1",
      name: "Evil",
      dependencies: [],
      contractTypes: "",
      sourceFiles: {
        "server.ts": `
import fs from "node:fs";
import { exec } from "child_process";
import { SupervisedCordisRuntime } from "../../src/runtime/server/supervised-runtime.js";
import { apply as todoApply } from "../todo-core/server.ts";
export async function apply() {
  const mod = "node:os";
  await import(mod);
  const cp = require("node:path");
  const builtin = process.getBuiltinModule("node:fs");
  eval("1+1");
  const fn = new Function("return 1");
  return { fs, exec, SupervisedCordisRuntime, todoApply, cp, builtin, fn };
}
`,
      },
      testFiles: {},
    };

    const violations = verifyStaticBoundaries(artifact);
    assert.ok(violations.length >= 9, `Expected >= 9 violations, got ${violations.length}`);
    assert.ok(violations.some((v) => v.specifier === "node:fs"));
    assert.ok(violations.some((v) => v.specifier === "child_process"));
    assert.ok(violations.some((v) => v.specifier.includes("src/runtime/server/supervised-runtime")));
    assert.ok(violations.some((v) => v.specifier.includes("../todo-core/server.ts")));
    assert.ok(violations.some((v) => v.reason.includes("dynamic import")));
    assert.ok(violations.some((v) => v.reason.includes("require")));
    assert.ok(violations.some((v) => v.specifier === "process.getBuiltinModule"));
    assert.ok(violations.some((v) => v.specifier === "eval"));
    assert.ok(violations.some((v) => v.specifier === "new Function"));
  });

  it("scans compiled serverCode/clientCode even when sourceFiles look clean", () => {
    const tampered: PluginArtifact = {
      pluginId: "tampered",
      versionId: "v1",
      name: "Tampered",
      dependencies: [],
      contractTypes: "",
      sourceFiles: {
        "server.ts": `export const name = "tampered"; export function apply() {}`,
      },
      serverCode: `import fs from "node:fs"; export const name = "tampered"; export function apply() { void fs; }`,
      testFiles: {},
    };

    const violations = verifyStaticBoundaries(tampered);
    assert.ok(violations.some((v) => v.file === "__compiled__/server.mjs" && v.specifier === "node:fs"));
  });

  it("rejects cyclic dependencies and disabled upstream dependencies in DAG check", () => {
    const a = compileServerPluginArtifact({
      pluginId: "a",
      name: "A",
      dependencies: ["b"],
      serverSource: `export const name = "a"; export function apply() {}`,
    });
    const b = compileServerPluginArtifact({
      pluginId: "b",
      name: "B",
      dependencies: ["a"],
      serverSource: `export const name = "b"; export function apply() {}`,
    });

    const artifacts = new Map<string, PluginArtifact>([
      [artifactKey(a.pluginId, a.versionId), a],
      [artifactKey(b.pluginId, b.versionId), b],
    ]);

    const cyclicComp: CompositionSnapshot = {
      compositionId: "c-cycle",
      parentCompositionId: null,
      createdAt: new Date().toISOString(),
      members: [
        { pluginId: "a", versionId: a.versionId, enabled: true },
        { pluginId: "b", versionId: b.versionId, enabled: true },
      ],
    };

    const dagErrors = verifyCompositionDag(cyclicComp, artifacts);
    assert.ok(dagErrors.length > 0);
    assert.ok(dagErrors[0].message.includes("Cyclic plugin dependency"));

    const disabledDepComp: CompositionSnapshot = {
      compositionId: "c-disabled-dep",
      parentCompositionId: null,
      createdAt: new Date().toISOString(),
      members: [
        { pluginId: "a", versionId: a.versionId, enabled: true },
        { pluginId: "b", versionId: b.versionId, enabled: false },
      ],
    };
    const disabledErrors = verifyCompositionDag(disabledDepComp, artifacts);
    assert.ok(disabledErrors.length > 0);
    assert.ok(disabledErrors[0].message.includes('requires enabled dependency "b"'));
  });
});

describe("PluginVerifier Gate 1b: Sandbox hot-swap dispose -> remount probe", () => {
  it("verifies all enabled plugins reach ACTIVE and survive dispose -> remount cleanly", async () => {
    const cleanPlugin = compileServerPluginArtifact({
      pluginId: "ping",
      name: "Ping",
      dependencies: [],
      serverSource: `
import type { Context } from "cordis";
import "@host/server-sdk";
export const name = "ping";
export function apply(ctx: Context) {
  ctx.http.route("GET", "/ping", () => ({ status: 200, body: { ok: true } }));
}
`,
    });

    const artifacts = new Map<string, PluginArtifact>([
      [artifactKey(cleanPlugin.pluginId, cleanPlugin.versionId), cleanPlugin],
    ]);

    const candidate: CompositionSnapshot = {
      compositionId: "c-ping-1",
      parentCompositionId: null,
      createdAt: new Date().toISOString(),
      members: [
        { pluginId: "ping", versionId: cleanPlugin.versionId, enabled: true },
      ],
    };

    const report = await verifyCandidateGates1And2({
      candidate,
      artifacts,
    });

    assert.equal(report.ok, true, `Expected ok, got: ${JSON.stringify(report.errors)}`);
    assert.deepEqual(report.probedPlugins, ["ping"]);
  });

  it("rejects plugins that leave residual routes or fail on dispose -> remount", async () => {
    const leakyPlugin = compileServerPluginArtifact({
      pluginId: "leaky",
      name: "Leaky",
      dependencies: [],
      serverSource: `
import type { Context } from "cordis";
import "@host/server-sdk";
export const name = "leaky";
export function apply(ctx: Context) {
  // Deliberately register on root context to bypass fiber disposal, leaving a residual route
  ctx.root.http.route("GET", "/leak", () => ({ status: 200, body: { leaked: true } }));
}
`,
    });

    const artifacts = new Map<string, PluginArtifact>([
      [artifactKey(leakyPlugin.pluginId, leakyPlugin.versionId), leakyPlugin],
    ]);

    const candidate: CompositionSnapshot = {
      compositionId: "c-leaky-1",
      parentCompositionId: null,
      createdAt: new Date().toISOString(),
      members: [
        { pluginId: "leaky", versionId: leakyPlugin.versionId, enabled: true },
      ],
    };

    const report = await verifyCandidateGates1And2({
      candidate,
      artifacts,
    });

    assert.equal(report.ok, false);
    assert.equal(report.failedGate, "gate1-hotswap-probe");
    assert.ok(report.errors.length > 0);
  });

  it("probes client-side mount -> dispose -> remount and rejects client route conflicts", async () => {
    const pluginA = await compileFullStackPluginArtifact({
      pluginId: "client-a",
      name: "Client A",
      dependencies: [],
      serverSource: `export const name = "client-a"; export function apply() {}`,
      clientSource: `
import type { Context } from "cordis";
import "@host/client-sdk";
export const name = "client-a";
export function apply(ctx: Context) {
  ctx.router.registerPage({
    path: "/shared",
    navLabel: "A",
    component: () => <div>A</div>,
  });
}
`,
    });

    const pluginB = await compileFullStackPluginArtifact({
      pluginId: "client-b",
      name: "Client B",
      dependencies: [],
      serverSource: `export const name = "client-b"; export function apply() {}`,
      clientSource: `
import type { Context } from "cordis";
import "@host/client-sdk";
export const name = "client-b";
export function apply(ctx: Context) {
  ctx.router.registerPage({
    path: "/shared",
    navLabel: "B",
    component: () => <div>B</div>,
  });
}
`,
    });

    const artifacts = new Map<string, PluginArtifact>([
      [artifactKey(pluginA.pluginId, pluginA.versionId), pluginA],
      [artifactKey(pluginB.pluginId, pluginB.versionId), pluginB],
    ]);

    // Single valid client plugin passes mount -> dispose -> remount
    const okReport = await verifyCandidateGates1And2({
      candidate: {
        compositionId: "c-client-ok",
        parentCompositionId: null,
        createdAt: new Date().toISOString(),
        members: [{ pluginId: "client-a", versionId: pluginA.versionId, enabled: true }],
      },
      artifacts,
    });
    assert.equal(okReport.ok, true, `Expected ok, got: ${JSON.stringify(okReport.errors)}`);

    // Two client plugins registering the same route "/shared" are rejected
    const conflictReport = await verifyCandidateGates1And2({
      candidate: {
        compositionId: "c-client-conflict",
        parentCompositionId: null,
        createdAt: new Date().toISOString(),
        members: [
          { pluginId: "client-a", versionId: pluginA.versionId, enabled: true },
          { pluginId: "client-b", versionId: pluginB.versionId, enabled: true },
        ],
      },
      artifacts,
    });
    assert.equal(conflictReport.ok, false);
    assert.equal(conflictReport.failedGate, "gate1-hotswap-probe");
    assert.ok(conflictReport.errors.some((e) => e.includes("/shared")));
  });
});

describe("PluginVerifier Gate 2: Ablation Invariant (Cases A, B, and parallel siblings)", () => {
  const TODO_CORE_TEST = `
import assert from "node:assert/strict";
export default async function verify(ctx) {
  const created = await ctx.request({
    method: "POST",
    path: "/api/app/todo-core/tasks",
    body: { title: "Ship V3" },
  });
  assert.equal(created.status, 201);
  const id = created.body.id;

  const done = await ctx.request({
    method: "PATCH",
    path: "/api/app/todo-core/tasks/" + id,
    body: { state: "done" },
  });
  assert.equal(done.status, 200, "todo-core alone must allow completing a task without review note");
  assert.equal(done.body.state, "done");
}
`;

  const TODO_CORE_V1_SERVER = `
import type { Context } from "cordis";
import "@host/server-sdk";
export const name = "todo-core";
export function apply(ctx: Context) {
  const tasks = new Map<string, { id: string; title: string; state: string }>();
  let seq = 1;
  ctx.http.route("POST", "/tasks", (req) => {
    const body = req.body as { title: string };
    const task = { id: "t" + seq++, title: body.title, state: "open" };
    tasks.set(task.id, task);
    return { status: 201, body: task };
  });
  ctx.http.route("PATCH", "/tasks/:id", (req) => {
    const task = tasks.get(req.params.id);
    if (!task) return { status: 404, body: { error: "not found" } };
    const body = req.body as { state?: string };
    if (body.state) task.state = body.state;
    return { status: 200, body: task };
  });
}
`;

  const TODO_CORE_V2_SEAM_SERVER = `
import type { Context } from "cordis";
import "@host/server-sdk";
export const name = "todo-core";
export function apply(ctx: Context) {
  const tasks = new Map<string, { id: string; title: string; state: string }>();
  let seq = 1;
  ctx.http.route("POST", "/tasks", (req) => {
    const body = req.body as { title: string };
    const task = { id: "t" + seq++, title: body.title, state: "open" };
    tasks.set(task.id, task);
    return { status: 201, body: task };
  });
  ctx.http.route("PATCH", "/tasks/:id", async (req) => {
    const task = tasks.get(req.params.id);
    if (!task) return { status: 404, body: { error: "not found" } };
    const body = req.body as { state?: string; meta?: Record<string, unknown> };
    if (body.state) {
      const veto = await ctx.serial("todo:before-transition" as never, {
        task,
        nextState: body.state,
        meta: body.meta,
      });
      if (typeof veto === "string" || veto === false) {
        return { status: 400, body: { error: typeof veto === "string" ? veto : "blocked" } };
      }
      task.state = body.state;
    }
    return { status: 200, body: task };
  });
}
`;

  const TODO_CORE_V2_HARDCODED_SERVER = `
import type { Context } from "cordis";
import "@host/server-sdk";
export const name = "todo-core";
export function apply(ctx: Context) {
  const tasks = new Map<string, { id: string; title: string; state: string }>();
  let seq = 1;
  ctx.http.route("POST", "/tasks", (req) => {
    const body = req.body as { title: string };
    const task = { id: "t" + seq++, title: body.title, state: "open" };
    tasks.set(task.id, task);
    return { status: 201, body: task };
  });
  ctx.http.route("PATCH", "/tasks/:id", (req) => {
    const task = tasks.get(req.params.id);
    if (!task) return { status: 404, body: { error: "not found" } };
    const body = req.body as { state?: string; meta?: { reviewNote?: string } };
    if (body.state === "done" && !body.meta?.reviewNote) {
      return { status: 400, body: { error: "reviewNote required" } };
    }
    if (body.state) task.state = body.state;
    return { status: 200, body: task };
  });
}
`;

  const REVIEW_SERVER = `
import type { Context } from "cordis";
import "@host/server-sdk";
export const name = "review";
export function apply(ctx: Context) {
  ctx.on("todo:before-transition" as never, (payload: { nextState: string; meta?: { reviewNote?: string } }) => {
    if (payload.nextState === "done" && !payload.meta?.reviewNote) {
      return "reviewNote is required by review plugin";
    }
  });
}
`;

  it("Case A (positive): passes when upstream opens a generic hook seam and downstream review plugin adds validation", async () => {
    const todoV1 = compileServerPluginArtifact({
      pluginId: "todo-core",
      name: "Todo Core",
      dependencies: [],
      serverSource: TODO_CORE_V1_SERVER,
      testFiles: { "tests/todo-core.spec.ts": TODO_CORE_TEST },
    });
    const todoV2 = compileServerPluginArtifact({
      pluginId: "todo-core",
      name: "Todo Core",
      dependencies: [],
      serverSource: TODO_CORE_V2_SEAM_SERVER,
      testFiles: { "tests/todo-core.spec.ts": TODO_CORE_TEST },
    });
    const review = compileServerPluginArtifact({
      pluginId: "review",
      name: "Review",
      dependencies: ["todo-core"],
      serverSource: REVIEW_SERVER,
    });

    const artifacts = new Map<string, PluginArtifact>([
      [artifactKey(todoV1.pluginId, todoV1.versionId), todoV1],
      [artifactKey(todoV2.pluginId, todoV2.versionId), todoV2],
      [artifactKey(review.pluginId, review.versionId), review],
    ]);

    const baseline: CompositionSnapshot = {
      compositionId: "c-base",
      parentCompositionId: null,
      createdAt: new Date().toISOString(),
      members: [{ pluginId: "todo-core", versionId: todoV1.versionId, enabled: true }],
    };

    const candidate: CompositionSnapshot = {
      compositionId: "c-cand-seam",
      parentCompositionId: "c-base",
      createdAt: new Date().toISOString(),
      members: [
        { pluginId: "todo-core", versionId: todoV2.versionId, enabled: true },
        { pluginId: "review", versionId: review.versionId, enabled: true },
      ],
    };

    const report = await verifyCandidateGates1And2({ baseline, candidate, artifacts });
    assert.equal(report.ok, true, `Expected ok, got: ${JSON.stringify(report.errors)}`);
    assert.equal(report.testChangeDisclosures.length, 0);
    assert.equal(report.ablationResults.length, 1);
    assert.equal(report.ablationResults[0].targetPluginId, "todo-core");
    assert.equal(report.ablationResults[0].kind, "upstream-seam");
    assert.deepEqual(report.ablationResults[0].ablatedPlugins, ["review"]);
    assert.equal(report.ablationResults[0].passed, true);
  });

  it("Case A (negative): rejects when review validation is hardcoded into todo-core", async () => {
    const todoV1 = compileServerPluginArtifact({
      pluginId: "todo-core",
      name: "Todo Core",
      dependencies: [],
      serverSource: TODO_CORE_V1_SERVER,
      testFiles: { "tests/todo-core.spec.ts": TODO_CORE_TEST },
    });
    const todoV2Bad = compileServerPluginArtifact({
      pluginId: "todo-core",
      name: "Todo Core",
      dependencies: [],
      serverSource: TODO_CORE_V2_HARDCODED_SERVER,
      testFiles: { "tests/todo-core.spec.ts": TODO_CORE_TEST },
    });
    const review = compileServerPluginArtifact({
      pluginId: "review",
      name: "Review",
      dependencies: ["todo-core"],
      serverSource: REVIEW_SERVER,
    });

    const artifacts = new Map<string, PluginArtifact>([
      [artifactKey(todoV1.pluginId, todoV1.versionId), todoV1],
      [artifactKey(todoV2Bad.pluginId, todoV2Bad.versionId), todoV2Bad],
      [artifactKey(review.pluginId, review.versionId), review],
    ]);

    const baseline: CompositionSnapshot = {
      compositionId: "c-base",
      parentCompositionId: null,
      createdAt: new Date().toISOString(),
      members: [{ pluginId: "todo-core", versionId: todoV1.versionId, enabled: true }],
    };

    const candidate: CompositionSnapshot = {
      compositionId: "c-cand-hardcoded",
      parentCompositionId: "c-base",
      createdAt: new Date().toISOString(),
      members: [
        { pluginId: "todo-core", versionId: todoV2Bad.versionId, enabled: true },
        { pluginId: "review", versionId: review.versionId, enabled: true },
      ],
    };

    const report = await verifyCandidateGates1And2({ baseline, candidate, artifacts });
    assert.equal(report.ok, false);
    assert.equal(report.failedGate, "gate2-ablation");
    assert.equal(report.ablationResults.length, 1);
    assert.equal(report.ablationResults[0].passed, false);
  });

  it("Case B: discloses upstream test changes and still verifies upstream independently without downstream", async () => {
    const todoV1 = compileServerPluginArtifact({
      pluginId: "todo-core",
      name: "Todo Core",
      dependencies: [],
      serverSource: TODO_CORE_V1_SERVER,
      testFiles: { "tests/todo-core.spec.ts": TODO_CORE_TEST },
    });

    const updatedTest = TODO_CORE_TEST + "\n// updated business rule assertion\n";
    const todoV2 = compileServerPluginArtifact({
      pluginId: "todo-core",
      name: "Todo Core",
      dependencies: [],
      serverSource: TODO_CORE_V2_SEAM_SERVER,
      testFiles: { "tests/todo-core.spec.ts": updatedTest },
    });
    const review = compileServerPluginArtifact({
      pluginId: "review",
      name: "Review",
      dependencies: ["todo-core"],
      serverSource: REVIEW_SERVER,
    });

    const artifacts = new Map<string, PluginArtifact>([
      [artifactKey(todoV1.pluginId, todoV1.versionId), todoV1],
      [artifactKey(todoV2.pluginId, todoV2.versionId), todoV2],
      [artifactKey(review.pluginId, review.versionId), review],
    ]);

    const baseline: CompositionSnapshot = {
      compositionId: "c-base",
      parentCompositionId: null,
      createdAt: new Date().toISOString(),
      members: [{ pluginId: "todo-core", versionId: todoV1.versionId, enabled: true }],
    };

    const candidate: CompositionSnapshot = {
      compositionId: "c-cand-case-b",
      parentCompositionId: "c-base",
      createdAt: new Date().toISOString(),
      members: [
        { pluginId: "todo-core", versionId: todoV2.versionId, enabled: true },
        { pluginId: "review", versionId: review.versionId, enabled: true },
      ],
    };

    const report = await verifyCandidateGates1And2({ baseline, candidate, artifacts });
    assert.equal(report.ok, true, `Expected ok, got: ${JSON.stringify(report.errors)}`);
    assert.equal(report.testChangeDisclosures.length, 1);
    assert.equal(report.testChangeDisclosures[0].pluginId, "todo-core");
    assert.deepEqual(report.testChangeDisclosures[0].modifiedFiles, [
      "tests/todo-core.spec.ts",
    ]);
    assert.equal(report.ablationResults[0].kind, "upstream-with-test-changes");
    assert.equal(report.ablationResults[0].passed, true);
  });

  it("Parallel siblings: verifies each independent sibling in its own closure without the other", async () => {
    const tags = compileServerPluginArtifact({
      pluginId: "tags",
      name: "Tags",
      dependencies: [],
      serverSource: `
import type { Context } from "cordis";
import "@host/server-sdk";
export const name = "tags";
export function apply(ctx: Context) {
  ctx.http.route("GET", "/list", () => ({ status: 200, body: ["urgent"] }));
}
`,
      testFiles: {
        "tests/tags.spec.ts": `
import assert from "node:assert/strict";
export default async function verify(ctx) {
  const res = await ctx.request({ method: "GET", path: "/api/app/tags/list" });
  assert.equal(res.status, 200);
  const topo = await ctx.introspect();
  assert.ok(!topo.plugins.some((p) => p.pluginId === "notes"), "notes must not be loaded in tags closure");
}
`,
      },
    });

    const notes = compileServerPluginArtifact({
      pluginId: "notes",
      name: "Notes",
      dependencies: [],
      serverSource: `
import type { Context } from "cordis";
import "@host/server-sdk";
export const name = "notes";
export function apply(ctx: Context) {
  ctx.http.route("GET", "/list", () => ({ status: 200, body: ["hello"] }));
}
`,
      testFiles: {
        "tests/notes.spec.ts": `
import assert from "node:assert/strict";
export default async function verify(ctx) {
  const res = await ctx.request({ method: "GET", path: "/api/app/notes/list" });
  assert.equal(res.status, 200);
  const topo = await ctx.introspect();
  assert.ok(!topo.plugins.some((p) => p.pluginId === "tags"), "tags must not be loaded in notes closure");
}
`,
      },
    });

    const artifacts = new Map<string, PluginArtifact>([
      [artifactKey(tags.pluginId, tags.versionId), tags],
      [artifactKey(notes.pluginId, notes.versionId), notes],
    ]);

    const candidate: CompositionSnapshot = {
      compositionId: "c-siblings",
      parentCompositionId: null,
      createdAt: new Date().toISOString(),
      members: [
        { pluginId: "tags", versionId: tags.versionId, enabled: true },
        { pluginId: "notes", versionId: notes.versionId, enabled: true },
      ],
    };

    const report = await verifyCandidateGates1And2({ candidate, artifacts });
    assert.equal(report.ok, true, `Expected ok, got: ${JSON.stringify(report.errors)}`);
    assert.equal(report.ablationResults.length, 2);
    assert.ok(report.ablationResults.every((r) => r.kind === "parallel-sibling" && r.passed));
  });
});
