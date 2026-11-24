import { expect, test } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SupervisedCordisRuntime } from "../../src/runtime/server/supervised-runtime.js";
import {
  startHostServer,
  type HostServerHandle,
} from "../../src/supervisor/server/gateway.js";
import { compileFullStackPluginArtifact } from "../../src/build/plugin-builder.js";
import { loadPluginPackage } from "../../src/build/plugin-builder.js";
import type { CompositionSnapshot } from "../../src/contracts/types.js";

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

test.describe("browser importmap Cordis runtime, per-plugin CSS, and todo-core hot-swap E2E", () => {
  let workDir = "";
  let runtime: SupervisedCordisRuntime | null = null;
  let server: HostServerHandle | null = null;

  test.afterEach(async () => {
    if (server) {
      await server.close();
      server = null;
    }
    if (runtime) {
      await runtime.close();
      runtime = null;
    }
    if (workDir) {
      rmSync(workDir, { recursive: true, force: true });
      workDir = "";
    }
  });

  test("full browser lifecycle: importmap singleton + todo-core CRUD + hot-mount with draft preservation & scoped CSS + ErrorBoundary isolation + disable cleanup + SSE reconnect reconciliation", async ({
    page,
  }) => {
    workDir = mkdtempSync(join(tmpdir(), "host-pw-e2e-"));
    runtime = new SupervisedCordisRuntime({
      dbPath: join(workDir, "app.db"),
      workDir,
    });
    server = await startHostServer(runtime, { port: 0 });

    const todoPkg = await loadPluginPackage(
      resolve(process.cwd(), "plugins/todo-core"),
    );

    // Handwritten plugin 1: stateful interactive badge + banner + custom Tailwind CSS + extra route
    const tagsWidgetPkg = await compileFullStackPluginArtifact({
      pluginId: "tags-widget",
      name: "Tags Widget",
      dependencies: ["todo-core"],
      clientSource: `
        import { useState } from "react";
        import type { Context } from "cordis";
        import { Tag } from "lucide-react";
        import { Button } from "@base-ui/react";
        import { useNavigate } from "@host/client-sdk";

        function TagBadge({ task }: { readonly task: { id: string; title: string } }) {
          const [clicks, setClicks] = useState(0);
          return (
            <Button
              type="button"
              data-tags-badge={task.id}
              onClick={() => setClicks((n) => n + 1)}
              className="inline-flex items-center gap-1 rounded-full border border-amber-300 bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-800"
            >
              <Tag className="size-3" />
              <span>标签 +{clicks}</span>
            </Button>
          );
        }

        function TagsBanner() {
          return (
            <div
              data-tags-banner="true"
              className="rounded-md border border-amber-300 bg-amber-100 px-3 py-2 text-xs text-amber-900"
            >
              标签扩展已热挂载生效
            </div>
          );
        }

        function TagsSummaryPage() {
          const navigate = useNavigate();
          return (
            <div data-tags-page="true" className="p-6">
              <h2 className="text-lg font-semibold">标签统计页</h2>
              <button
                type="button"
                data-tags-back-home="true"
                onClick={() => navigate("/")}
                className="mt-3 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
              >
                返回任务
              </button>
            </div>
          );
        }

        export default function apply(ctx: Context) {
          ctx.slots.register("todo.item.badges", TagBadge, {
            order: 20,
            id: "tags-badge",
          });
          ctx.slots.register("todo.list.banner", TagsBanner, {
            order: 10,
            id: "tags-banner",
          });
          ctx.router.registerPage({
            path: "/tags-summary",
            navLabel: "标签统计",
            order: 10,
            component: TagsSummaryPage,
          });
        }
      `,
    });

    // Handwritten plugin 1 v2: upgraded version with distinct Tailwind color to verify style replacement
    const tagsWidgetV2Pkg = await compileFullStackPluginArtifact({
      pluginId: "tags-widget",
      name: "Tags Widget v2",
      dependencies: ["todo-core"],
      clientSource: `
        import { useState } from "react";
        import type { Context } from "cordis";
        import { Tag } from "lucide-react";

        function TagBadgeV2({ task }: { readonly task: { id: string } }) {
          const [clicks, setClicks] = useState(0);
          return (
            <button
              type="button"
              data-tags-badge={task.id}
              data-tags-version="v2"
              onClick={() => setClicks((n) => n + 1)}
              className="inline-flex items-center gap-1 rounded-full border border-violet-300 bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-800"
            >
              <Tag className="size-3" />
              <span>标签v2 +{clicks}</span>
            </button>
          );
        }

        export default function apply(ctx: Context) {
          ctx.slots.register("todo.item.badges", TagBadgeV2, {
            order: 20,
            id: "tags-badge",
          });
        }
      `,
    });

    // Handwritten plugin 2: second dynamic plugin sharing React Hooks & testing slot ordering (order 5 < 20)
    const priorityBadgePkg = await compileFullStackPluginArtifact({
      pluginId: "priority-badge",
      name: "Priority Badge",
      dependencies: ["todo-core"],
      clientSource: `
        import { useState } from "react";
        import type { Context } from "cordis";

        function PriorityPill({ task }: { readonly task: { id: string } }) {
          const [level, setLevel] = useState("P1");
          return (
            <button
              type="button"
              data-priority-badge={task.id}
              onClick={() => setLevel((cur) => (cur === "P1" ? "P0" : "P1"))}
              className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-800"
            >
              {level}
            </button>
          );
        }

        export default function apply(ctx: Context) {
          ctx.slots.register("todo.item.badges", PriorityPill, {
            order: 5,
            id: "priority-pill",
          });
        }
      `,
    });

    // Handwritten plugin 3: intentionally throws during render to test ErrorBoundary isolation
    const brokenSlotPkg = await compileFullStackPluginArtifact({
      pluginId: "broken-slot",
      name: "Broken Slot",
      dependencies: ["todo-core"],
      clientSource: `
        import type { Context } from "cordis";

        function CrashingWidget(): never {
          throw new Error("Simulated plugin render crash");
        }

        export default function apply(ctx: Context) {
          ctx.slots.register("todo.item.badges", CrashingWidget, {
            order: 30,
            id: "crashing-badge",
          });
        }
      `,
    });

    // Handwritten plugin 4: mounted while SSE is disconnected to verify automatic reconnect reconciliation
    const reconnectBannerPkg = await compileFullStackPluginArtifact({
      pluginId: "reconnect-banner",
      name: "Reconnect Banner",
      dependencies: ["todo-core"],
      clientSource: `
        import type { Context } from "cordis";

        function ReconnectNotice() {
          return (
            <div
              data-reconnect-banner="true"
              className="rounded-md border border-sky-300 bg-sky-100 px-3 py-2 text-xs font-medium text-sky-900"
            >
              SSE 断线重连后自动对齐的扩展横幅
            </div>
          );
        }

        export default function apply(ctx: Context) {
          ctx.slots.register("todo.list.banner", ReconnectNotice, {
            order: 1,
            id: "reconnect-notice",
          });
        }
      `,
    });

    runtime.registerArtifact(todoPkg);
    runtime.registerArtifact(tagsWidgetPkg);
    runtime.registerArtifact(tagsWidgetV2Pkg);
    runtime.registerArtifact(priorityBadgePkg);
    runtime.registerArtifact(brokenSlotPkg);
    runtime.registerArtifact(reconnectBannerPkg);

    await runtime.applyComposition(
      makeSnapshot("comp-1-core", [
        { pluginId: "todo-core", versionId: todoPkg.versionId },
      ]),
    );

    const pageErrors: string[] = [];
    const hookErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") {
        const text = msg.text();
        if (/invalid hook call|multiple copies of react/i.test(text)) {
          hookErrors.push(text);
        }
      }
    });

    // 1. Open host page and verify importmap, independent supervisor root, and todo-core UI
    await page.goto(server.url);
    await expect(page.locator("[data-supervisor-shell='true']")).toBeVisible();
    await expect(page.locator("[data-todo-core='true']")).toBeVisible();

    const structureCheck = await page.evaluate(() => {
      const importMapScript = document.querySelector('script[type="importmap"]');
      const importMap = importMapScript
        ? JSON.parse(importMapScript.textContent || "{}")
        : {};
      const sup = document.getElementById("supervisor-root");
      const app = document.getElementById("app-root");
      return {
        imports: Object.keys(importMap.imports ?? {}),
        independentRoots:
          Boolean(sup && app) && !sup!.contains(app) && !app!.contains(sup),
        hasTodoStyle: Boolean(
          document.head.querySelector('style[data-cordis-plugin-id="todo-core"]'),
        ),
      };
    });

    expect(structureCheck.independentRoots).toBe(true);
    expect(structureCheck.hasTodoStyle).toBe(true);
    for (const key of [
      "react",
      "react-dom",
      "react-dom/client",
      "react/jsx-runtime",
      "cordis",
      "lucide-react",
      "@base-ui/react",
      "@host/client-sdk",
    ]) {
      expect(structureCheck.imports).toContain(key);
    }

    // Exercise todo-core full CRUD + filter + detail + state transition
    const addInput = page.locator("[data-todo-add-input='true']");
    await addInput.fill("验证浏览器端真 Cordis 运行时");
    await page.locator("[data-todo-add-submit='true']").click();
    await expect(page.locator("[data-todo-item]")).toHaveCount(1);

    await addInput.fill("待删除临时任务");
    await page.locator("[data-todo-add-submit='true']").click();
    await expect(page.locator("[data-todo-item]")).toHaveCount(2);

    // Open detail of first task, edit title & notes, save
    await page.getByText("验证浏览器端真 Cordis 运行时").click();
    await expect(page.locator("[data-todo-detail]")).toBeVisible();
    await page.locator("#todo-detail-notes").fill("已通过 importmap 单例加载");
    await page.locator("[data-todo-detail-save='true']").click();
    await expect(page.getByText("已通过 importmap 单例加载").first()).toBeVisible();

    // Delete second task from detail panel
    await page.getByText("待删除临时任务").click();
    await page.locator("[data-todo-detail-delete='true']").click();
    await expect(page.locator("[data-todo-item]")).toHaveCount(1);

    // Complete first task -> verify done filter + conditional line-through style -> reopen back to open
    const openCheckColor = await page.evaluate(() => {
      const checkCircle = document.querySelector("[data-todo-toggle] span");
      return checkCircle ? getComputedStyle(checkCircle).color : "";
    });
    expect(openCheckColor).toBe("rgba(0, 0, 0, 0)");

    await page.locator("[data-todo-toggle]").first().click();
    await expect(page.locator("[data-todo-empty='true']")).toBeVisible();
    await page.locator("[data-todo-filter='done']").click();
    await expect(page.locator("[data-todo-item]")).toHaveCount(1);
    const doneTextDecoration = await page.evaluate(() => {
      const titleEl = document.querySelector("[data-todo-select] div");
      return titleEl ? getComputedStyle(titleEl).textDecorationLine : "";
    });
    expect(doneTextDecoration).toContain("line-through");

    await page.locator("[data-todo-toggle]").first().click();
    await page.locator("[data-todo-filter='open']").click();
    await expect(page.locator("[data-todo-item]")).toHaveCount(1);

    // 2. Enter uncommitted draft, set no-reload sentinel, and hot-mount 2 stateful plugins
    await page.evaluate(() => {
      (window as unknown as Record<string, string>).__hostNoReloadSentinel =
        "alive";
    });
    const draftText = "正在编辑的未提交任务草稿";
    await addInput.fill(draftText);

    await runtime.applyComposition(
      makeSnapshot(
        "comp-2-hot-mount",
        [
          { pluginId: "todo-core", versionId: todoPkg.versionId },
          { pluginId: "tags-widget", versionId: tagsWidgetPkg.versionId },
          {
            pluginId: "priority-badge",
            versionId: priorityBadgePkg.versionId,
          },
        ],
        "comp-1-core",
      ),
    );

    // Wait for hot-mounted widgets & banner to appear without page reload
    await expect(page.locator("[data-tags-banner='true']")).toBeVisible();
    await expect(page.locator("[data-tags-badge]").first()).toBeVisible();
    await expect(page.locator("[data-priority-badge]").first()).toBeVisible();

    // Verify no page reload and draft fully preserved
    expect(
      await page.evaluate(
        () =>
          (window as unknown as Record<string, string>).__hostNoReloadSentinel,
      ),
    ).toBe("alive");
    await expect(addInput).toHaveValue(draftText);

    // Verify slot ordering: priority-badge (order 5) rendered before tags-widget (order 20)
    const slotOrder = await page.evaluate(() => {
      const slot = document.querySelector('[data-slot="todo.item.badges"]');
      if (!slot) return [];
      const buttons = [...slot.querySelectorAll("button")];
      return buttons.map((b) =>
        b.hasAttribute("data-priority-badge")
          ? "priority-badge"
          : b.hasAttribute("data-tags-badge")
            ? "tags-widget"
            : "other",
      );
    });
    expect(slotOrder).toEqual(["priority-badge", "tags-widget"]);

    // Verify both dynamic plugins execute React Hooks cleanly without multi-React crash
    await page.locator("[data-tags-badge]").first().click();
    await expect(page.locator("[data-tags-badge]").first()).toContainText(
      "标签 +1",
    );
    await page.locator("[data-priority-badge]").first().click();
    await expect(page.locator("[data-priority-badge]").first()).toHaveText("P0");

    // Verify per-plugin <style> injection and computed Tailwind background colors
    const styleCheck = await page.evaluate(() => {
      const tagsStyle = document.head.querySelector(
        'style[data-cordis-plugin-id="tags-widget"]',
      );
      const priorityStyle = document.head.querySelector(
        'style[data-cordis-plugin-id="priority-badge"]',
      );
      const tagsEl = document.querySelector("[data-tags-badge]");
      const priorityEl = document.querySelector("[data-priority-badge]");
      return {
        hasTagsStyle: Boolean(tagsStyle),
        hasPriorityStyle: Boolean(priorityStyle),
        tagsBg: tagsEl ? getComputedStyle(tagsEl).backgroundColor : "",
        priorityBg: priorityEl
          ? getComputedStyle(priorityEl).backgroundColor
          : "",
      };
    });
    expect(styleCheck.hasTagsStyle).toBe(true);
    expect(styleCheck.hasPriorityStyle).toBe(true);
    expect(styleCheck.tagsBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(styleCheck.priorityBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(styleCheck.tagsBg).not.toBe(styleCheck.priorityBg);

    // Verify ClientRouter extra route registered by tags-widget works without reload
    await page.getByRole("button", { name: "标签统计" }).click();
    await expect(page.locator("[data-tags-page='true']")).toBeVisible();
    await page.locator("[data-tags-back-home='true']").click();
    await expect(page.locator("[data-todo-core='true']")).toBeVisible();
    // Re-enter uncommitted draft after route roundtrip for remaining hot-swap checks
    await addInput.fill(draftText);

    // 2b. Hot-upgrade tags-widget v1 -> v2 -> old <style> removed, new <style> applied, draft preserved
    const tagsBgBeforeUpgrade = styleCheck.tagsBg;
    await runtime.applyComposition(
      makeSnapshot(
        "comp-2b-upgrade",
        [
          { pluginId: "todo-core", versionId: todoPkg.versionId },
          { pluginId: "tags-widget", versionId: tagsWidgetV2Pkg.versionId },
          {
            pluginId: "priority-badge",
            versionId: priorityBadgePkg.versionId,
          },
        ],
        "comp-2-hot-mount",
      ),
    );

    await expect(page.locator("[data-tags-version='v2']").first()).toBeVisible();
    await expect(addInput).toHaveValue(draftText);
    const upgradeStyleCheck = await page.evaluate(
      ({ v1Key, v2Key }) => {
        const oldStyle = document.head.querySelector(
          `style[data-cordis-plugin="${v1Key}"]`,
        );
        const newStyle = document.head.querySelector(
          `style[data-cordis-plugin="${v2Key}"]`,
        );
        const el = document.querySelector("[data-tags-version='v2']");
        return {
          hasOldStyle: Boolean(oldStyle),
          hasNewStyle: Boolean(newStyle),
          newBg: el ? getComputedStyle(el).backgroundColor : "",
          sentinel: (window as unknown as Record<string, string>)
            .__hostNoReloadSentinel,
        };
      },
      {
        v1Key: `tags-widget@${tagsWidgetPkg.versionId}`,
        v2Key: `tags-widget@${tagsWidgetV2Pkg.versionId}`,
      },
    );
    expect(upgradeStyleCheck.hasOldStyle).toBe(false);
    expect(upgradeStyleCheck.hasNewStyle).toBe(true);
    expect(upgradeStyleCheck.newBg).not.toBe("rgba(0, 0, 0, 0)");
    expect(upgradeStyleCheck.newBg).not.toBe(tagsBgBeforeUpgrade);
    expect(upgradeStyleCheck.sentinel).toBe("alive");

    // 3. Hot-mount rendering-crash plugin -> isolated local ErrorBoundary fallback + supervisor diagnostic
    await runtime.applyComposition(
      makeSnapshot(
        "comp-3-broken",
        [
          { pluginId: "todo-core", versionId: todoPkg.versionId },
          { pluginId: "tags-widget", versionId: tagsWidgetV2Pkg.versionId },
          {
            pluginId: "priority-badge",
            versionId: priorityBadgePkg.versionId,
          },
          { pluginId: "broken-slot", versionId: brokenSlotPkg.versionId },
        ],
        "comp-2b-upgrade",
      ),
    );

    await expect(
      page.locator("[data-plugin-error-boundary='broken-slot']"),
    ).toBeVisible();
    // Sibling widgets, main todo-core app, uncommitted draft, and supervisor shell all stay intact
    await expect(page.locator("[data-tags-badge]").first()).toBeVisible();
    await expect(page.locator("[data-priority-badge]").first()).toBeVisible();
    await expect(page.locator("[data-todo-core='true']")).toBeVisible();
    await expect(addInput).toHaveValue(draftText);
    await expect(page.locator("[data-supervisor-shell='true']")).toBeVisible();
    await expect(
      page.locator("[data-supervisor-diagnostics-badge]"),
    ).toBeVisible();

    // Open supervisor drawer (Base UI Dialog), confirm diagnostic is visible, and close with Escape key
    await page.locator("[data-supervisor-diagnostics-badge]").click();
    await expect(
      page.locator("[data-supervisor-diagnostic-plugin='broken-slot']").first(),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-supervisor-drawer='true']")).toHaveCount(
      0,
    );

    await expect
      .poll(() =>
        server!
          .getClientDiagnostics()
          .some(
            (d) =>
              d.pluginId === "broken-slot" &&
              d.kind === "render-error" &&
              /Simulated plugin render crash/.test(d.message),
          ),
      )
      .toBe(true);

    // 4. Disable all auxiliary plugins -> components, error fallback, and <style> nodes vanish without reload
    await runtime.applyComposition(
      makeSnapshot(
        "comp-4-disabled",
        [
          { pluginId: "todo-core", versionId: todoPkg.versionId },
          {
            pluginId: "tags-widget",
            versionId: tagsWidgetV2Pkg.versionId,
            enabled: false,
          },
          {
            pluginId: "priority-badge",
            versionId: priorityBadgePkg.versionId,
            enabled: false,
          },
          {
            pluginId: "broken-slot",
            versionId: brokenSlotPkg.versionId,
            enabled: false,
          },
        ],
        "comp-3-broken",
      ),
    );

    await expect(page.locator("[data-tags-banner='true']")).toHaveCount(0);
    await expect(page.locator("[data-tags-badge]")).toHaveCount(0);
    await expect(page.locator("[data-priority-badge]")).toHaveCount(0);
    await expect(
      page.locator("[data-plugin-error-boundary='broken-slot']"),
    ).toHaveCount(0);

    const cleanupStyles = await page.evaluate(() => ({
      todoStyle: Boolean(
        document.head.querySelector('style[data-cordis-plugin-id="todo-core"]'),
      ),
      tagsStyle: Boolean(
        document.head.querySelector(
          'style[data-cordis-plugin-id="tags-widget"]',
        ),
      ),
      priorityStyle: Boolean(
        document.head.querySelector(
          'style[data-cordis-plugin-id="priority-badge"]',
        ),
      ),
      brokenStyle: Boolean(
        document.head.querySelector(
          'style[data-cordis-plugin-id="broken-slot"]',
        ),
      ),
      sentinel: (window as unknown as Record<string, string>)
        .__hostNoReloadSentinel,
    }));
    expect(cleanupStyles).toEqual({
      todoStyle: true,
      tagsStyle: false,
      priorityStyle: false,
      brokenStyle: false,
      sentinel: "alive",
    });
    await expect(addInput).toHaveValue(draftText);

    // 5. Disconnect SSE, switch composition while offline, then allow reconnect -> auto-reconcile
    let blockSse = true;
    await page.route("**/api/host/client/events", async (route) => {
      if (blockSse) {
        await route.abort("failed");
        return;
      }
      await route.continue();
    });

    // Drop active SSE stream from server so browser enters reconnect loop while route is blocked
    const closedCount = server.disconnectSseClients();
    expect(closedCount).toBeGreaterThanOrEqual(1);

    await expect(
      page.locator("[data-supervisor-connection='reconnecting']"),
    ).toBeVisible();

    // Switch composition while browser is disconnected
    await runtime.applyComposition(
      makeSnapshot(
        "comp-5-reconnected",
        [
          { pluginId: "todo-core", versionId: todoPkg.versionId },
          {
            pluginId: "reconnect-banner",
            versionId: reconnectBannerPkg.versionId,
          },
        ],
        "comp-4-disabled",
      ),
    );

    // Restore SSE route -> EventSource reconnects and receives full authoritative snapshot
    blockSse = false;

    await expect(page.locator("[data-reconnect-banner='true']")).toBeVisible({
      timeout: 10000,
    });
    await expect(
      page.locator("[data-supervisor-connection='connected']"),
    ).toBeVisible();
    await expect(
      page.locator("[data-supervisor-composition='comp-5-reconnected']"),
    ).toBeVisible();

    // Still zero page reloads, uncommitted draft preserved, and reconnect-banner CSS injected
    expect(
      await page.evaluate(
        () =>
          (window as unknown as Record<string, string>).__hostNoReloadSentinel,
      ),
    ).toBe("alive");
    await expect(addInput).toHaveValue(draftText);
    expect(
      await page.evaluate(() =>
        Boolean(
          document.head.querySelector(
            'style[data-cordis-plugin-id="reconnect-banner"]',
          ),
        ),
      ),
    ).toBe(true);

    expect(hookErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test("mobile viewport (390x844): search, filter, 16px inputs, and >=44px touch targets work cleanly", async ({
    page,
  }) => {
    workDir = mkdtempSync(join(tmpdir(), "host-pw-mobile-"));
    runtime = new SupervisedCordisRuntime({
      dbPath: join(workDir, "app.db"),
      workDir,
    });
    server = await startHostServer(runtime, { port: 0 });

    const todoPkg = await loadPluginPackage(
      resolve(process.cwd(), "plugins/todo-core"),
    );
    runtime.registerArtifact(todoPkg);
    await runtime.applyComposition(
      makeSnapshot("comp-mobile", [
        { pluginId: "todo-core", versionId: todoPkg.versionId },
      ]),
    );

    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(server.url);
    await expect(page.locator("[data-todo-core='true']")).toBeVisible();

    const searchInput = page.locator("[data-todo-search-input='true']");
    const addInput = page.locator("[data-todo-add-input='true']");
    const addSubmit = page.locator("[data-todo-add-submit='true']");

    await expect(searchInput).toBeVisible();
    await addInput.fill("移动端买牛奶");
    await addSubmit.click();
    await expect(page.locator("[data-todo-item]")).toHaveCount(1);

    await addInput.fill("整理会议纪要");
    await addSubmit.click();
    await expect(page.locator("[data-todo-item]")).toHaveCount(2);

    // Search works on mobile viewport
    await searchInput.fill("牛奶");
    await expect(page.locator("[data-todo-item]")).toHaveCount(1);
    await searchInput.fill("");
    await expect(page.locator("[data-todo-item]")).toHaveCount(2);

    // Verify DESIGN.md mobile constraints: 16px inputs & >=44px primary touch targets
    const metrics = await page.evaluate(() => {
      const searchEl = document.querySelector("[data-todo-search-input='true']");
      const addEl = document.querySelector("[data-todo-add-input='true']");
      const submitEl = document.querySelector("[data-todo-add-submit='true']");
      const toggleEl = document.querySelector("[data-todo-toggle]");
      const filterEl = document.querySelector("[data-todo-filter='open']");
      return {
        searchFontSize: searchEl
          ? parseFloat(getComputedStyle(searchEl).fontSize)
          : 0,
        addFontSize: addEl ? parseFloat(getComputedStyle(addEl).fontSize) : 0,
        submitHeight: submitEl ? submitEl.getBoundingClientRect().height : 0,
        toggleHeight: toggleEl ? toggleEl.getBoundingClientRect().height : 0,
        filterHeight: filterEl ? filterEl.getBoundingClientRect().height : 0,
      };
    });

    expect(metrics.searchFontSize).toBeGreaterThanOrEqual(16);
    expect(metrics.addFontSize).toBeGreaterThanOrEqual(16);
    expect(metrics.submitHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.toggleHeight).toBeGreaterThanOrEqual(44);
    expect(metrics.filterHeight).toBeGreaterThanOrEqual(44);
  });
});
