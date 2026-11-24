import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { SupervisedCordisRuntime } from "../../src/runtime/server/supervised-runtime.js";
import type {
  CompositionSnapshot,
  PluginArtifact,
} from "../../src/contracts/types.js";

function makeArtifact(params: {
  pluginId: string;
  name?: string;
  dependencies?: string[];
  contractTypes?: string;
  serverCode: string;
}): PluginArtifact {
  const versionId = createHash("sha256")
    .update(
      JSON.stringify({
        pluginId: params.pluginId,
        dependencies: params.dependencies ?? [],
        serverCode: params.serverCode,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return {
    pluginId: params.pluginId,
    versionId,
    name: params.name ?? params.pluginId,
    dependencies: params.dependencies ?? [],
    contractTypes: params.contractTypes ?? "",
    serverCode: params.serverCode,
    sourceFiles: { "server.ts": params.serverCode },
    testFiles: {},
  };
}

function makeComposition(
  compositionId: string,
  members: Array<{ pluginId: string; versionId: string; enabled?: boolean }>,
  parentCompositionId: string | null = null,
): CompositionSnapshot {
  return {
    compositionId,
    parentCompositionId,
    members: members.map((m) => ({
      pluginId: m.pluginId,
      versionId: m.versionId,
      enabled: m.enabled ?? true,
    })),
    createdAt: new Date().toISOString(),
  };
}

describe("SupervisedCordisRuntime", () => {
  const dirs: string[] = [];
  const runtimes: SupervisedCordisRuntime[] = [];

  afterEach(async () => {
    for (const rt of runtimes.splice(0)) {
      await rt.close();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function createRuntime(opts?: {
    requestTimeoutMs?: number;
    applyTimeoutMs?: number;
    drainTimeoutMs?: number;
  }) {
    const dir = mkdtempSync(join(tmpdir(), "host-runtime-"));
    dirs.push(dir);
    const runtime = new SupervisedCordisRuntime({
      dbPath: join(dir, "app.db"),
      workDir: dir,
      ...opts,
    });
    runtimes.push(runtime);
    return { runtime, dir };
  }

  it("runs real shared Cordis Context in worker subprocess with Service, inject, hooks, and introspect", async () => {
    const { runtime } = createRuntime();

    const alpha = makeArtifact({
      pluginId: "alpha",
      serverCode: `
        import { Service } from "cordis";
        export default class AlphaService extends Service {
          constructor(ctx) {
            super(ctx, "alpha");
            this.db = ctx.db;
            this.db.exec("CREATE TABLE IF NOT EXISTS plg_alpha__items (id TEXT PRIMARY KEY, val TEXT NOT NULL)");
            ctx.http.route("POST", "/items", async (req) => {
              const verdict = await ctx.serial("alpha:before-create", req.body);
              if (typeof verdict === "string" && verdict.length > 0) {
                return { status: 422, body: { error: verdict } };
              }
              const item = this.create(req.body.id, req.body.val);
              return { status: 201, body: item };
            });
            ctx.http.route("GET", "/items", () => ({ items: this.list() }));
          }
          create(id, val) {
            this.db.prepare("INSERT INTO plg_alpha__items (id, val) VALUES (?, ?)").run(id, val);
            return { id, val };
          }
          list() {
            return this.db.prepare("SELECT id, val FROM plg_alpha__items ORDER BY id").all();
          }
        }
      `,
    });

    const beta = makeArtifact({
      pluginId: "beta",
      dependencies: ["alpha"],
      serverCode: `
        export const inject = ["alpha"];
        export function apply(ctx) {
          ctx.on("alpha:before-create", (payload) => {
            if (payload?.val === "forbidden") return "blocked by beta";
          });
          ctx.http.route("GET", "/summary", () => ({
            count: ctx.alpha.list().length,
          }));
        }
      `,
    });

    runtime.registerArtifact(alpha);
    runtime.registerArtifact(beta);

    const health = await runtime.applyComposition(
      makeComposition("comp-1", [
        { pluginId: "alpha", versionId: alpha.versionId },
        { pluginId: "beta", versionId: beta.versionId },
      ]),
    );

    assert.equal(health.compositionId, "comp-1");
    assert.deepEqual(health.activePlugins, ["alpha", "beta"]);
    assert.ok(health.workerPid > 0);

    const topology = await runtime.introspect();
    assert.equal(topology.compositionId, "comp-1");
    assert.equal(topology.workerPid, health.workerPid);
    assert.ok(topology.services.includes("alpha"));
    assert.equal(topology.plugins.length, 2);
    assert.equal(topology.plugins[0].state, "ACTIVE");
    assert.deepEqual(topology.plugins[0].providedServices, ["alpha"]);
    assert.equal(topology.plugins[1].state, "ACTIVE");
    assert.ok(
      topology.routes.some(
        (r) => r.pluginId === "beta" && r.method === "GET" && r.path === "/api/app/beta/summary",
      ),
    );

    // Hook blocks forbidden item
    const blocked = await runtime.handleHttpRequest({
      method: "POST",
      path: "/api/app/alpha/items",
      body: { id: "x", val: "forbidden" },
    });
    assert.equal(blocked.status, 422);
    assert.deepEqual(blocked.body, { error: "blocked by beta" });

    // Valid item succeeds and beta reads via injected alpha Service
    const created = await runtime.handleHttpRequest({
      method: "POST",
      path: "/api/app/alpha/items",
      body: { id: "1", val: "hello" },
    });
    assert.equal(created.status, 201);

    const summary = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/beta/summary",
    });
    assert.equal(summary.status, 200);
    assert.deepEqual(summary.body, { count: 1 });
  });

  it("enforces unforgeable host plugin identity: blocks spoofed plugin.name and preserves upstream ScopedDb across Service calls", async () => {
    const { runtime } = createRuntime();

    const alpha = makeArtifact({
      pluginId: "alpha",
      serverCode: `
        import { Service } from "cordis";
        export default class AlphaService extends Service {
          constructor(ctx) {
            super(ctx, "alpha");
            this.cachedDb = ctx.db;
            this.cachedDb.exec("CREATE TABLE IF NOT EXISTS plg_alpha__secrets (id TEXT PRIMARY KEY, secret TEXT NOT NULL)");
            this.cachedDb.prepare("INSERT OR REPLACE INTO plg_alpha__secrets (id, secret) VALUES (?, ?)").run("s1", "top-secret");
          }
          readCached() {
            return this.cachedDb.prepare("SELECT secret FROM plg_alpha__secrets WHERE id = ?").get("s1");
          }
          readDynamic() {
            return this.ctx.db.prepare("SELECT secret FROM plg_alpha__secrets WHERE id = ?").get("s1");
          }
        }
      `,
    });

    // Beta lies about its export name ("alpha") and tries direct table access,
    // while also legitimately calling AlphaService methods.
    const beta = makeArtifact({
      pluginId: "beta",
      dependencies: ["alpha"],
      serverCode: `
        export const name = "alpha";
        export const inject = ["alpha"];
        export function apply(ctx) {
          const ownDb = ctx.db;
          ctx.http.route("GET", "/spoof-read", () => {
            try {
              const rows = ownDb.prepare("SELECT * FROM plg_alpha__secrets").all();
              return { status: 200, body: { leaked: rows } };
            } catch (err) {
              return { status: 403, body: { denied: String(err.message), owner: ownDb.pluginId } };
            }
          });
          ctx.http.route("GET", "/service-call", () => ({
            cached: ctx.alpha.readCached(),
            dynamic: ctx.alpha.readDynamic(),
          }));
        }
      `,
    });

    runtime.registerArtifact(alpha);
    runtime.registerArtifact(beta);

    await runtime.applyComposition(
      makeComposition("comp-id", [
        { pluginId: "alpha", versionId: alpha.versionId },
        { pluginId: "beta", versionId: beta.versionId },
      ]),
    );

    const spoof = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/beta/spoof-read",
    });
    assert.equal(spoof.status, 403);
    assert.equal((spoof.body as { owner: string }).owner, "beta");
    assert.match((spoof.body as { denied: string }).denied, /prohibited|not authorized/i);

    const viaService = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/beta/service-call",
    });
    assert.equal(viaService.status, 200);
    assert.deepEqual(viaService.body, {
      cached: { secret: "top-secret" },
      dynamic: { secret: "top-secret" },
    });
  });

  it("cleans up HttpRouter and SchedulerService via Fiber effect on disable/replace and rejects route conflicts deterministically", async () => {
    const { runtime } = createRuntime();

    const tickerV1 = makeArtifact({
      pluginId: "ticker",
      serverCode: `
        export function apply(ctx) {
          const db = ctx.db;
          db.exec("CREATE TABLE IF NOT EXISTS plg_ticker__ticks (id INTEGER PRIMARY KEY AUTOINCREMENT, version TEXT NOT NULL)");
          ctx.schedule.every(25, () => {
            db.prepare("INSERT INTO plg_ticker__ticks (version) VALUES (?)").run("v1");
          });
          ctx.schedule.at(new Date(Date.now() + 25).toISOString(), "once", () => {
            db.prepare("INSERT INTO plg_ticker__ticks (version) VALUES (?)").run("at-v1");
          });
          ctx.http.route("GET", "/api/app/ticker/ping", () => ({ version: "v1" }));
          ctx.http.route("GET", "/ticks", () => ({
            count: db.prepare("SELECT COUNT(*) AS c FROM plg_ticker__ticks").get().c,
          }));
        }
      `,
    });

    const conflicting = makeArtifact({
      pluginId: "conflicting",
      serverCode: `
        export function apply(ctx) {
          ctx.http.route("GET", "/api/app/ticker/ping", () => ({ version: "conflict" }));
        }
      `,
    });

    const tickerV2 = makeArtifact({
      pluginId: "ticker",
      serverCode: `
        export function apply(ctx) {
          const db = ctx.db;
          ctx.http.route("GET", "/api/app/ticker/ping", () => ({ version: "v2" }));
          ctx.http.route("GET", "/ticks", () => ({
            count: db.prepare("SELECT COUNT(*) AS c FROM plg_ticker__ticks").get().c,
          }));
        }
      `,
    });

    runtime.registerArtifact(tickerV1);
    runtime.registerArtifact(conflicting);
    runtime.registerArtifact(tickerV2);

    const h1 = await runtime.applyComposition(
      makeComposition("c1", [{ pluginId: "ticker", versionId: tickerV1.versionId }]),
    );

    // Wait briefly for scheduler ticks
    await new Promise((r) => setTimeout(r, 90));
    const ticksBefore = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/ticker/ticks",
    });
    assert.ok((ticksBefore.body as { count: number }).count >= 2);

    // Route conflict must fail activation deterministically and preserve c1
    await assert.rejects(
      () =>
        runtime.applyComposition(
          makeComposition(
            "c-conflict",
            [
              { pluginId: "ticker", versionId: tickerV1.versionId },
              { pluginId: "conflicting", versionId: conflicting.versionId },
            ],
            "c1",
          ),
        ),
      /outside its namespace|route conflict/i,
    );

    // Previous composition remains healthy
    const stillV1 = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/ticker/ping",
    });
    assert.equal(stillV1.status, 200);
    assert.deepEqual(stillV1.body, { version: "v1" });

    // Disable ticker -> routes return 404 and timers stop firing
    await runtime.applyComposition(
      makeComposition(
        "c2-disabled",
        [{ pluginId: "ticker", versionId: tickerV1.versionId, enabled: false }],
        "c1",
      ),
    );
    const notFound = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/ticker/ping",
    });
    assert.equal(notFound.status, 404);

    // Upgrade to v2 (same explicit route path, no timers) -> in-process hot-swap succeeds cleanly
    const h3 = await runtime.applyComposition(
      makeComposition(
        "c3-v2",
        [{ pluginId: "ticker", versionId: tickerV2.versionId, enabled: true }],
        "c2-disabled",
      ),
    );
    assert.equal(h3.mode, "in-process-hot-swap");
    const v2Ping = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/ticker/ping",
    });
    assert.equal(v2Ping.status, 200);
    assert.deepEqual(v2Ping.body, { version: "v2" });

    // Verify no v1 timer is leaking after disable + v2 mount
    const countA = (
      await runtime.handleHttpRequest({ method: "GET", path: "/api/app/ticker/ticks" })
    ).body as { count: number };
    await new Promise((r) => setTimeout(r, 90));
    const countB = (
      await runtime.handleHttpRequest({ method: "GET", path: "/api/app/ticker/ticks" })
    ).body as { count: number };
    assert.equal(countA.count, countB.count);
    assert.ok(h1.workerPid > 0);
  });

  it("drains in-flight HTTP requests during hot-swap and disposes/remounts dependents in topological order", async () => {
    const { runtime } = createRuntime();

    const coreV1 = makeArtifact({
      pluginId: "core",
      serverCode: `
        import { Service } from "cordis";
        export default class CoreService extends Service {
          constructor(ctx) {
            super(ctx, "core");
            ctx.http.route("GET", "/slow", async () => {
              await new Promise((r) => setTimeout(r, 120));
              return { servedBy: "v1" };
            });
          }
          version() { return "v1"; }
        }
      `,
    });

    const coreV2 = makeArtifact({
      pluginId: "core",
      serverCode: `
        import { Service } from "cordis";
        export default class CoreService extends Service {
          constructor(ctx) {
            super(ctx, "core");
            ctx.http.route("GET", "/slow", async () => ({ servedBy: "v2" }));
          }
          version() { return "v2"; }
        }
      `,
    });

    const consumer = makeArtifact({
      pluginId: "consumer",
      dependencies: ["core"],
      serverCode: `
        export const inject = ["core"];
        export function apply(ctx) {
          const captured = ctx.core.version();
          ctx.http.route("GET", "/ver", () => ({
            captured,
            live: ctx.core.version(),
          }));
        }
      `,
    });

    runtime.registerArtifact(coreV1);
    runtime.registerArtifact(coreV2);
    runtime.registerArtifact(consumer);

    const h1 = await runtime.applyComposition(
      makeComposition("c1", [
        { pluginId: "core", versionId: coreV1.versionId },
        { pluginId: "consumer", versionId: consumer.versionId },
      ]),
    );

    // Start slow in-flight request, then trigger hot-swap immediately
    const slowPromise = runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/core/slow",
    });
    await new Promise((r) => setTimeout(r, 20));

    const swapPromise = runtime.applyComposition(
      makeComposition(
        "c2",
        [
          { pluginId: "core", versionId: coreV2.versionId },
          { pluginId: "consumer", versionId: consumer.versionId },
        ],
        "c1",
      ),
    );
    // Request arriving while draining must queue until hot-swap finishes
    const afterSwapPromise = runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/consumer/ver",
    });

    const [slowRes, h2, afterRes] = await Promise.all([
      slowPromise,
      swapPromise,
      afterSwapPromise,
    ]);

    assert.equal(slowRes.status, 200);
    assert.deepEqual(slowRes.body, { servedBy: "v1" });
    assert.equal(h2.mode, "in-process-hot-swap");
    assert.equal(h2.workerPid, h1.workerPid);
    assert.equal(afterRes.status, 200);
    assert.deepEqual(afterRes.body, { captured: "v2", live: "v2" });
  });

  it("hard-kills worker and auto-rebuilds to usable composition on infinite-loop during apply or HTTP request", async () => {
    const { runtime } = createRuntime({
      applyTimeoutMs: 400,
      requestTimeoutMs: 400,
      drainTimeoutMs: 300,
    });

    const good = makeArtifact({
      pluginId: "good",
      serverCode: `
        export function apply(ctx) {
          ctx.http.route("GET", "/ok", () => ({ ok: true }));
        }
      `,
    });

    const hangOnApply = makeArtifact({
      pluginId: "hang-apply",
      serverCode: `
        export function apply() {
          while (true) {}
        }
      `,
    });

    const hangOnHttp = makeArtifact({
      pluginId: "hang-http",
      serverCode: `
        export function apply(ctx) {
          ctx.http.route("GET", "/spin", () => {
            while (true) {}
          });
        }
      `,
    });

    runtime.registerArtifact(good);
    runtime.registerArtifact(hangOnApply);
    runtime.registerArtifact(hangOnHttp);

    const h1 = await runtime.applyComposition(
      makeComposition("c-good", [{ pluginId: "good", versionId: good.versionId }]),
    );

    // 1. Infinite loop during applyComposition -> SIGKILL + rebuild to c-good
    await assert.rejects(
      () =>
        runtime.applyComposition(
          makeComposition(
            "c-hang-apply",
            [
              { pluginId: "good", versionId: good.versionId },
              { pluginId: "hang-apply", versionId: hangOnApply.versionId },
            ],
            "c-good",
          ),
        ),
      /timeout|超时/i,
    );

    const afterApplyRecover = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/good/ok",
    });
    assert.equal(afterApplyRecover.status, 200);
    assert.deepEqual(afterApplyRecover.body, { ok: true });
    const topo1 = await runtime.introspect();
    assert.equal(topo1.compositionId, "c-good");
    assert.notEqual(topo1.workerPid, h1.workerPid);

    // 2. Infinite loop during HTTP request -> SIGKILL + auto-rebuild worker
    const h2 = await runtime.applyComposition(
      makeComposition(
        "c-with-hang-http",
        [
          { pluginId: "good", versionId: good.versionId },
          { pluginId: "hang-http", versionId: hangOnHttp.versionId },
        ],
        "c-good",
      ),
    );

    await assert.rejects(
      () =>
        runtime.handleHttpRequest({
          method: "GET",
          path: "/api/app/hang-http/spin",
        }),
      /timeout|超时/i,
    );

    // Immediately after timeout, healthy plugin recovers on freshly rebuilt worker
    const recovered = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/good/ok",
    });
    assert.equal(recovered.status, 200);
    assert.deepEqual(recovered.body, { ok: true });
    const topo2 = await runtime.introspect();
    assert.notEqual(topo2.workerPid, h2.workerPid);
  });

  it("rejects cyclic dependencies, disabled upstream dependencies, and unsatisfied inject services deterministically", async () => {
    const { runtime } = createRuntime();

    const ok = makeArtifact({
      pluginId: "ok",
      serverCode: `
        export function apply(ctx) {
          ctx.http.route("GET", "/ping", () => ({ ok: true }));
        }
      `,
    });

    const cycA = makeArtifact({
      pluginId: "cyc-a",
      dependencies: ["cyc-b"],
      serverCode: `export function apply() {}`,
    });

    const cycB = makeArtifact({
      pluginId: "cyc-b",
      dependencies: ["cyc-a"],
      serverCode: `export function apply() {}`,
    });

    const needsMissing = makeArtifact({
      pluginId: "needs-missing",
      serverCode: `
        export const inject = ["nonexistentService"];
        export function apply() {}
      `,
    });

    const childOfOk = makeArtifact({
      pluginId: "child-of-ok",
      dependencies: ["ok"],
      serverCode: `export function apply() {}`,
    });

    runtime.registerArtifact(ok);
    runtime.registerArtifact(cycA);
    runtime.registerArtifact(cycB);
    runtime.registerArtifact(needsMissing);
    runtime.registerArtifact(childOfOk);

    await runtime.applyComposition(
      makeComposition("c-base", [{ pluginId: "ok", versionId: ok.versionId }]),
    );

    // Cyclic DAG rejected
    await assert.rejects(
      () =>
        runtime.applyComposition(
          makeComposition(
            "c-cycle",
            [
              { pluginId: "cyc-a", versionId: cycA.versionId },
              { pluginId: "cyc-b", versionId: cycB.versionId },
            ],
            "c-base",
          ),
        ),
      /cyclic/i,
    );

    // Enabled plugin depending on disabled plugin rejected
    await assert.rejects(
      () =>
        runtime.applyComposition(
          makeComposition(
            "c-disabled-dep",
            [
              { pluginId: "ok", versionId: ok.versionId, enabled: false },
              {
                pluginId: "child-of-ok",
                versionId: childOfOk.versionId,
                enabled: true,
              },
            ],
            "c-base",
          ),
        ),
      /requires enabled dependency/i,
    );

    // Unsatisfied Cordis inject fails ACTIVE check and preserves c-base
    await assert.rejects(
      () =>
        runtime.applyComposition(
          makeComposition(
            "c-missing-inject",
            [
              { pluginId: "ok", versionId: ok.versionId },
              {
                pluginId: "needs-missing",
                versionId: needsMissing.versionId,
              },
            ],
            "c-base",
          ),
        ),
      /ACTIVE|PENDING/i,
    );

    const ping = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/ok/ping",
    });
    assert.equal(ping.status, 200);
    assert.deepEqual(ping.body, { ok: true });
  });

  it("prevents symbol-based plugin identity spoofing, blocks process.getBuiltinModule, and returns 400 on malformed URL encoding", async () => {
    const { runtime } = createRuntime();

    const probe = makeArtifact({
      pluginId: "probe",
      serverCode: `
        export function apply(ctx) {
          ctx.http.route("GET", "/check/:id", (req) => {
            const syms = Object.getOwnPropertySymbols(ctx);
            const spoofedOverrides = {};
            for (const s of syms) spoofedOverrides[s] = "todo-core";
            const extended = ctx.extend(spoofedOverrides);
            let builtinBlocked = false;
            try {
              process.getBuiltinModule("node:fs");
            } catch {
              builtinBlocked = true;
            }
            return {
              id: req.params.id,
              ownPluginId: extended.db.pluginId,
              builtinBlocked,
            };
          });
        }
      `,
    });

    runtime.registerArtifact(probe);
    await runtime.applyComposition(
      makeComposition("c-sec", [{ pluginId: "probe", versionId: probe.versionId }]),
    );

    const okRes = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/probe/check/abc",
    });
    assert.equal(okRes.status, 200);
    assert.deepEqual(okRes.body, {
      id: "abc",
      ownPluginId: "probe",
      builtinBlocked: true,
    });

    const badEnc = await runtime.handleHttpRequest({
      method: "GET",
      path: "/api/app/probe/check/%E0%A4%A",
    });
    assert.equal(badEnc.status, 400);
  });
});
