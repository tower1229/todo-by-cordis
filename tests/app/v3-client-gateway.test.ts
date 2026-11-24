import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Context } from "cordis";
import { ClientCordisRuntime } from "../../src/v3/client/client-runtime.js";
import { SupervisedCordisRuntime } from "../../src/v3/cordis-runtime.js";
import { startV3HttpServer } from "../../src/v3/http-gateway.js";
import { compileFullStackPluginArtifact } from "../../src/v3/plugin-builder.js";
import { loadPluginPackage } from "../../src/v3/plugin-loader.js";
import {
  compilePluginTailwindCss,
  extractTailwindCandidates,
} from "../../src/v3/tailwind-compiler.js";
import type {
  ActiveClientComposition,
  CompositionSnapshot,
} from "../../src/v3/types.js";

function makeSnapshot(
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

describe("V3 Tailwind per-plugin compiler & full-stack plugin builder", () => {
  it("compiles utility classes including template-expression ternaries and preserves nested variant @media queries without preflight", async () => {
    const source = `
      export function Badge({ done }: { done: boolean }) {
        return (
          <span
            className={\`inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-[13px] text-amber-800 border border-accent md:flex md:w-[340px] hover:md:bg-red-500 \${
              done ? "line-through text-muted" : "text-transparent border-muted/60"
            }\`}
          >
            NotAClassWord
          </span>
        );
      }
    `;
    const candidates = extractTailwindCandidates([source]);
    assert.ok(candidates.includes("bg-amber-100"));
    assert.ok(candidates.includes("border-accent"));
    assert.ok(candidates.includes("md:w-[340px]"));
    assert.ok(candidates.includes("line-through"));
    assert.ok(candidates.includes("text-transparent"));
    assert.ok(candidates.includes("border-muted/60"));
    assert.ok(candidates.includes("hover:md:bg-red-500"));

    const css = await compilePluginTailwindCss([source]);
    assert.match(css, /@layer utilities/);
    assert.match(css, /@layer utilities-md/);
    assert.match(css, /\.bg-amber-100/);
    assert.match(css, /\.text-amber-800/);
    assert.match(css, /\.border-accent/);
    assert.match(css, /\.line-through/);
    assert.match(css, /\.text-transparent/);
    assert.match(css, /oklch\(0\.49 0\.16 263\)/);
    assert.match(css, /340px/);
    // Nested @media (hover: hover) { @media (width >= 48rem) { ... } } must stay intact without leaving empty @media
    assert.match(css, /@media \(hover: hover\)\s*\{\s*@media \(width >= 48rem\)/);
    assert.doesNotMatch(css, /@media \(hover: hover\)\s*\{\s*\}/);
    // Must not inject preflight reset rules
    assert.doesNotMatch(css, /@layer base \{/);
    assert.doesNotMatch(css, /NotAClassWord/);
  });

  it("loads full-stack todo-core package with serverCode, externalized clientCode, and complete conditional styleCss", async () => {
    const pkg = await loadPluginPackage(
      resolve(process.cwd(), "plugins/todo-core"),
    );
    assert.equal(pkg.pluginId, "todo-core");
    assert.ok(pkg.serverCode && pkg.serverCode.length > 0);
    assert.ok(pkg.clientCode && pkg.clientCode.length > 0);
    assert.ok(pkg.styleCss && pkg.styleCss.length > 0);
    // Conditional classes inside template literal expressions must be compiled into todo-core styleCss
    assert.match(pkg.styleCss, /\.line-through/);
    assert.match(pkg.styleCss, /\.text-transparent/);
    assert.match(pkg.styleCss, /\.border-accent\\\/40/);
    // Client module must keep bare specifiers external for browser importmap
    assert.match(pkg.clientCode, /from\s+["']react["']/);
    assert.match(pkg.clientCode, /from\s+["']react\/jsx-runtime["']/);
    assert.match(pkg.clientCode, /from\s+["']@host\/client-sdk["']/);
    assert.doesNotMatch(pkg.clientCode, /from\s+["']\.\/contract\.d\.ts["']/);
  });
});

describe("V3 ClientCordisRuntime (Node unit checks)", () => {
  it("binds router and slots to Fiber effect, enforces slot ordering & route conflict, and reconciles idempotently", async () => {
    const modules = new Map<string, Record<string, unknown>>();
    const mountCounts = new Map<string, number>();

    const DummyA = () => null;
    const DummyB = () => null;
    const PageHome = () => null;

    modules.set("/plugins/core/v1/client.mjs", {
      default: (ctx: Context) => {
        mountCounts.set("core@v1", (mountCounts.get("core@v1") ?? 0) + 1);
        ctx.router.registerPage({
          path: "/",
          navLabel: "Home",
          order: 0,
          component: PageHome,
        });
      },
    });

    modules.set("/plugins/slot-late/v1/client.mjs", {
      default: (ctx: Context) => {
        mountCounts.set("late@v1", (mountCounts.get("late@v1") ?? 0) + 1);
        ctx.slots.register("demo.badges", DummyB, { order: 20, id: "late" });
      },
    });

    modules.set("/plugins/slot-early/v1/client.mjs", {
      default: (ctx: Context) => {
        mountCounts.set("early@v1", (mountCounts.get("early@v1") ?? 0) + 1);
        ctx.slots.register("demo.badges", DummyA, { order: 5, id: "early" });
      },
    });

    modules.set("/plugins/conflict-route/v1/client.mjs", {
      default: (ctx: Context) => {
        ctx.router.registerPage({
          path: "/",
          navLabel: "Conflict",
          component: DummyA,
        });
      },
    });

    const runtime = new ClientCordisRuntime({
      diagnosticsUrl: "",
      moduleImporter: async (url) => {
        const mod = modules.get(url);
        if (!mod) throw new Error(`Module not found: ${url}`);
        return mod;
      },
    });

    const snap1: ActiveClientComposition = {
      compositionId: "c1",
      plugins: [
        {
          pluginId: "core",
          versionId: "v1",
          dependencies: [],
          clientEntryUrl: "/plugins/core/v1/client.mjs",
        },
        {
          pluginId: "slot-late",
          versionId: "v1",
          dependencies: ["core"],
          clientEntryUrl: "/plugins/slot-late/v1/client.mjs",
        },
        {
          pluginId: "slot-early",
          versionId: "v1",
          dependencies: ["core"],
          clientEntryUrl: "/plugins/slot-early/v1/client.mjs",
        },
      ],
    };

    await runtime.reconcile(snap1);
    assert.equal(runtime.getRoutes().length, 1);
    assert.equal(runtime.getRoutes()[0]?.pluginId, "core");
    assert.deepEqual(
      runtime.getSlotEntries("demo.badges").map((e) => e.id),
      ["early", "late"],
    );

    // Idempotent duplicate reconcile must not remount unchanged plugins
    await runtime.reconcile(snap1);
    assert.equal(mountCounts.get("core@v1"), 1);
    assert.equal(mountCounts.get("early@v1"), 1);
    assert.equal(mountCounts.get("late@v1"), 1);

    // Adding a conflicting route plugin reports diagnostic without breaking core
    await runtime.reconcile({
      compositionId: "c2",
      plugins: [
        ...snap1.plugins,
        {
          pluginId: "conflict-route",
          versionId: "v1",
          dependencies: ["core"],
          clientEntryUrl: "/plugins/conflict-route/v1/client.mjs",
        },
      ],
    });
    assert.equal(runtime.getRoutes().length, 1);
    assert.equal(runtime.getRoutes()[0]?.pluginId, "core");
    assert.ok(
      runtime
        .getDiagnostics()
        .some(
          (d) =>
            d.pluginId === "conflict-route" &&
            /route conflict/i.test(d.message),
        ),
    );
    // Core was not remounted
    assert.equal(mountCounts.get("core@v1"), 1);

    // Disabling slot-early automatically removes its slot entry via Fiber effect
    await runtime.reconcile({
      compositionId: "c3",
      plugins: [snap1.plugins[0]!, snap1.plugins[1]!],
    });
    assert.deepEqual(
      runtime.getSlotEntries("demo.badges").map((e) => e.id),
      ["late"],
    );
    assert.equal(mountCounts.get("core@v1"), 1);

    await runtime.close();
    assert.equal(runtime.getRoutes().length, 0);
    assert.equal(runtime.getSlotEntries("demo.badges").length, 0);
  });

  it("skips mounting downstream plugins when upstream fails to load, then mounts in strict topological order on recovery", async () => {
    let failUpstream = true;
    const mountOrder: string[] = [];

    const runtime = new ClientCordisRuntime({
      diagnosticsUrl: "",
      moduleImporter: async (url) => {
        if (url === "/plugins/upstream/v1/client.mjs") {
          if (failUpstream) {
            throw new Error("Transient upstream network failure");
          }
          return {
            default: () => {
              mountOrder.push("upstream");
            },
          };
        }
        if (url === "/plugins/downstream/v1/client.mjs") {
          return {
            default: () => {
              mountOrder.push("downstream");
            },
          };
        }
        throw new Error(`Unknown module: ${url}`);
      },
    });

    const target: ActiveClientComposition = {
      compositionId: "c-topo",
      plugins: [
        {
          pluginId: "upstream",
          versionId: "v1",
          dependencies: [],
          clientEntryUrl: "/plugins/upstream/v1/client.mjs",
        },
        {
          pluginId: "downstream",
          versionId: "v1",
          dependencies: ["upstream"],
          clientEntryUrl: "/plugins/downstream/v1/client.mjs",
        },
      ],
    };

    // First attempt: upstream fails -> downstream MUST NOT mount
    await runtime.reconcile(target);
    assert.deepEqual(mountOrder, []);
    assert.equal(runtime.getRuntimeSnapshot().mountedPlugins.length, 0);
    assert.ok(
      runtime
        .getDiagnostics()
        .some(
          (d) =>
            d.pluginId === "downstream" &&
            /dependency "upstream" is not active/i.test(d.message),
        ),
    );

    // Retry once upstream recovers -> mounts strictly upstream before downstream
    failUpstream = false;
    await runtime.reconcile({ ...target, compositionId: "c-topo-retry" });
    assert.deepEqual(mountOrder, ["upstream", "downstream"]);
    assert.deepEqual(
      runtime.getRuntimeSnapshot().mountedPlugins.map((p) => p.pluginId),
      ["upstream", "downstream"],
    );

    await runtime.close();
  });

  it("coalesces concurrent reconcile snapshots and aborts mounting when closed mid-load", async () => {
    let releaseFirstLoad!: () => void;
    const firstLoadGate = new Promise<void>((r) => {
      releaseFirstLoad = r;
    });
    const loadedUrls: string[] = [];

    const runtime = new ClientCordisRuntime({
      moduleImporter: async (url) => {
        loadedUrls.push(url);
        if (url.includes("/slow/")) {
          await firstLoadGate;
        }
        return { default: () => {} };
      },
    });

    const p1 = runtime.reconcile({
      compositionId: "c-1",
      plugins: [
        {
          pluginId: "slow",
          versionId: "v1",
          dependencies: [],
          clientEntryUrl: "/plugins/slow/v1/client.mjs",
        },
      ],
    });
    // Queue two more snapshots while c-1 is suspended -> c-2 should be coalesced away by c-3
    const p2 = runtime.reconcile({
      compositionId: "c-2",
      plugins: [
        {
          pluginId: "mid",
          versionId: "v1",
          dependencies: [],
          clientEntryUrl: "/plugins/mid/v1/client.mjs",
        },
      ],
    });
    const p3 = runtime.reconcile({
      compositionId: "c-3",
      plugins: [
        {
          pluginId: "final",
          versionId: "v1",
          dependencies: [],
          clientEntryUrl: "/plugins/final/v1/client.mjs",
        },
      ],
    });

    releaseFirstLoad();
    await Promise.all([p1, p2, p3]);
    assert.equal(runtime.getRuntimeSnapshot().compositionId, "c-3");
    assert.equal(
      loadedUrls.some((u) => u.includes("/mid/")),
      false,
      "superseded c-2 snapshot should be coalesced",
    );
    await runtime.close();

    // Now verify close() mid-import does not leak mounted plugins
    let releaseClosingLoad!: () => void;
    const closingGate = new Promise<void>((r) => {
      releaseClosingLoad = r;
    });
    const runtime2 = new ClientCordisRuntime({
      moduleImporter: async () => {
        await closingGate;
        return { default: () => {} };
      },
    });
    const pending = runtime2.reconcile({
      compositionId: "c-closing",
      plugins: [
        {
          pluginId: "late",
          versionId: "v1",
          dependencies: [],
          clientEntryUrl: "/plugins/late/v1/client.mjs",
        },
      ],
    });
    await runtime2.close();
    releaseClosingLoad();
    await pending;
    assert.equal(runtime2.getRuntimeSnapshot().mountedPlugins.length, 0);
  });
});

describe("V3 HTTP gateway importmap, plugin assets & SSE composition snapshots", () => {
  const dirs: string[] = [];
  const closers: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const close of closers.splice(0).reverse()) {
      await close();
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves importmap HTML, client plugin ESM, and pushes full snapshots over SSE on connect, switch, and reconnect", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v3-gateway-sse-"));
    dirs.push(dir);

    const runtime = new SupervisedCordisRuntime({
      dbPath: join(dir, "app.db"),
      workDir: dir,
    });
    closers.push(() => runtime.close());

    const server = await startV3HttpServer(runtime, { port: 0 });
    closers.push(() => server.close());

    const todoPkg = await loadPluginPackage(
      resolve(process.cwd(), "plugins/todo-core"),
    );
    const badgePkg = await compileFullStackPluginArtifact({
      pluginId: "badge",
      name: "Badge",
      dependencies: ["todo-core"],
      clientSource: `
        import type { Context } from "cordis";
        export default function apply(ctx: Context) {
          ctx.slots.register("todo.item.badges", () => <span className="bg-amber-100">B</span>);
        }
      `,
    });

    runtime.registerArtifact(todoPkg);
    runtime.registerArtifact(badgePkg);

    await runtime.applyComposition(
      makeSnapshot("comp-1", [
        { pluginId: "todo-core", versionId: todoPkg.versionId },
      ]),
    );

    // 1. Host HTML contains importmap & separated roots
    const htmlRes = await fetch(`${server.url}/`);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.match(html, /<script type="importmap">/);
    assert.match(html, /"react": "\/assets\/v3\/vendor-react\.mjs"/);
    assert.match(html, /"cordis": "\/assets\/v3\/vendor-cordis\.mjs"/);
    assert.match(
      html,
      /"@host\/client-sdk": "\/assets\/v3\/client-sdk\.mjs"/,
    );
    assert.match(html, /id="supervisor-root"/);
    assert.match(html, /id="app-root"/);

    // 2. Client module endpoint serves compiled ESM
    const modRes = await fetch(
      `${server.url}/plugins/todo-core/${todoPkg.versionId}/client.mjs`,
    );
    assert.equal(modRes.status, 200);
    assert.match(
      modRes.headers.get("content-type") ?? "",
      /javascript/,
    );

    // 3. SSE streams initial authoritative snapshot immediately and pushes subsequent switch
    const abortController = new AbortController();
    const sseRes = await fetch(`${server.url}/api/v3/client/events`, {
      signal: abortController.signal,
    });
    assert.equal(sseRes.status, 200);
    const reader = sseRes.body!.getReader();
    const decoder = new TextDecoder();

    async function readNextCompositionEvent(
      r: ReadableStreamDefaultReader<Uint8Array>,
      bufRef: { text: string },
    ): Promise<ActiveClientComposition> {
      while (true) {
        const sepIdx = bufRef.text.indexOf("\n\n");
        if (sepIdx !== -1) {
          const frame = bufRef.text.slice(0, sepIdx);
          bufRef.text = bufRef.text.slice(sepIdx + 2);
          if (frame.includes("event: composition")) {
            const dataLine = frame
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (dataLine) {
              return JSON.parse(
                dataLine.slice("data: ".length),
              ) as ActiveClientComposition;
            }
          }
          continue;
        }
        const { value, done } = await r.read();
        if (done) throw new Error("SSE stream closed before event arrived");
        bufRef.text += decoder.decode(value, { stream: true });
      }
    }

    const buf = { text: "" };
    const initial = await readNextCompositionEvent(reader, buf);
    assert.equal(initial.compositionId, "comp-1");
    assert.deepEqual(
      initial.plugins.map((p) => p.pluginId),
      ["todo-core"],
    );

    await runtime.applyComposition(
      makeSnapshot(
        "comp-2",
        [
          { pluginId: "todo-core", versionId: todoPkg.versionId },
          { pluginId: "badge", versionId: badgePkg.versionId },
        ],
        "comp-1",
      ),
    );

    const updated = await readNextCompositionEvent(reader, buf);
    assert.equal(updated.compositionId, "comp-2");
    assert.deepEqual(
      updated.plugins.map((p) => p.pluginId),
      ["todo-core", "badge"],
    );
    assert.ok(updated.plugins[1]?.styleCss?.includes(".bg-amber-100"));

    abortController.abort();
    await reader.cancel().catch(() => {});

    // 4. Reconnecting client receives latest authoritative full snapshot immediately
    const abort2 = new AbortController();
    const sseRes2 = await fetch(`${server.url}/api/v3/client/events`, {
      signal: abort2.signal,
    });
    const reader2 = sseRes2.body!.getReader();
    const reconnected = await readNextCompositionEvent(reader2, { text: "" });
    assert.equal(reconnected.compositionId, "comp-2");
    assert.deepEqual(
      reconnected.plugins.map((p) => p.pluginId),
      ["todo-core", "badge"],
    );
    abort2.abort();
    await reader2.cancel().catch(() => {});
  });
});
