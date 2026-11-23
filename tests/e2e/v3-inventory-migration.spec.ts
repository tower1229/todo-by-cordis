import { expect, test } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureV3ClientAssets } from "../../src/v3/client-bundle-builder.js";
import { CompositionRelease } from "../../src/v3/composition-release.js";
import { EvolutionLoop } from "../../src/v3/evolution-loop.js";
import { startV3HttpServer } from "../../src/v3/http-gateway.js";
import { buildPluginPackage } from "../../src/v3/plugin-builder.js";
import type { CompositionSnapshot } from "../../src/v3/types.js";
import {
  createStepStubDriver,
  executeEvolutionStepInBrowser,
  type EvolutionStepPlan,
} from "./v3-acceptance-helpers.js";

const INVENTORY_CORE_DIR = resolve("plugins/inventory-core");
const INVENTORY_CORE_CONTRACT = readFileSync(
  join(INVENTORY_CORE_DIR, "contract.d.ts"),
  "utf8",
);
const INVENTORY_CORE_SERVER = readFileSync(
  join(INVENTORY_CORE_DIR, "server.ts"),
  "utf8",
);
const INVENTORY_CORE_CLIENT = readFileSync(
  join(INVENTORY_CORE_DIR, "client.tsx"),
  "utf8",
);

const INVENTORY_CORE_TEST = `
import assert from "node:assert/strict";
export default async function (ctx) {
  const created = await ctx.request({
    method: "POST",
    path: "/api/app/inventory-core/items",
    body: { sku: "CONTRACT-SKU", name: "测试商品", quantity: 10 },
  });
  assert.equal(created.status, 201);
  const id = created.body.item.id;
  const stocked = await ctx.request({
    method: "POST",
    path: \`/api/app/inventory-core/items/\${id}/stock\`,
    body: { delta: -4 },
  });
  assert.equal(stocked.status, 200);
  assert.equal(stocked.body.item.quantity, 6);
}
`;

// Step 1: inventory-low-stock plugin
const LOW_STOCK_SERVER = `
import type { Context } from "cordis";
import "@host/server-sdk";

interface ThresholdRow {
  readonly sku: string;
  readonly min_qty: number;
}

export const name = "inventory-low-stock";
export const inject = ["inventory"];

export function apply(ctx: Context) {
  ctx.db.exec(\`
    CREATE TABLE IF NOT EXISTS plg_inventory_low_stock__thresholds (
      sku TEXT PRIMARY KEY,
      min_qty INTEGER NOT NULL
    )
  \`);

  ctx.http.route("GET", "/thresholds", () => {
    const rows = ctx.db
      .prepare("SELECT sku, min_qty FROM plg_inventory_low_stock__thresholds ORDER BY sku ASC")
      .all<ThresholdRow>();
    return {
      thresholds: rows.map((r) => ({ sku: r.sku, minQty: Number(r.min_qty) })),
    };
  });

  ctx.http.route("POST", "/thresholds", (req) => {
    const body = (req.body ?? {}) as { sku?: unknown; minQty?: unknown };
    if (typeof body.sku !== "string" || !body.sku.trim()) {
      return { status: 400, body: { error: "sku is required" } };
    }
    const minQty = typeof body.minQty === "number" ? Math.trunc(body.minQty) : NaN;
    if (!Number.isFinite(minQty) || minQty < 0) {
      return { status: 400, body: { error: "minQty must be >= 0" } };
    }
    ctx.db
      .prepare(
        "INSERT INTO plg_inventory_low_stock__thresholds (sku, min_qty) VALUES (?, ?) ON CONFLICT(sku) DO UPDATE SET min_qty = excluded.min_qty",
      )
      .run(body.sku.trim(), minQty);
    return { status: 201, body: { threshold: { sku: body.sku.trim(), minQty } } };
  });
}
`;

const LOW_STOCK_CLIENT = `
import { useCallback, useEffect, useState } from "react";
import type { Context } from "cordis";
import "@host/client-sdk";

interface Threshold {
  readonly sku: string;
  readonly minQty: number;
}

const listeners = new Set<() => void>();
function notifyThresholdsChanged() {
  for (const fn of listeners) fn();
}

function useThresholds() {
  const [thresholds, setThresholds] = useState<Threshold[]>([]);
  const load = useCallback(async () => {
    const res = await fetch("/api/app/inventory-low-stock/thresholds");
    if (!res.ok) return;
    const data = (await res.json()) as { thresholds?: Threshold[] };
    setThresholds(data.thresholds ?? []);
  }, []);

  useEffect(() => {
    void load();
    const handler = () => void load();
    listeners.add(handler);
    return () => {
      listeners.delete(handler);
    };
  }, [load]);

  return thresholds;
}

function LowStockBanner() {
  const [sku, setSku] = useState("");
  const [minQty, setMinQty] = useState("15");

  const handleSave = async () => {
    if (!sku.trim()) return;
    const res = await fetch("/api/app/inventory-low-stock/thresholds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: sku.trim(), minQty: Number(minQty) || 0 }),
    });
    if (res.ok) {
      setSku("");
      notifyThresholdsChanged();
    }
  };

  return (
    <div
      data-low-stock-banner="true"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-line bg-surface px-3 py-2 text-xs"
    >
      <span className="font-medium text-muted">低库存预警阈值：</span>
      <input
        type="text"
        value={sku}
        onChange={(e) => setSku(e.target.value)}
        placeholder="SKU"
        data-low-stock-sku-input="true"
        className="w-28 rounded border border-line bg-canvas px-2 py-1"
      />
      <input
        type="number"
        min={0}
        value={minQty}
        onChange={(e) => setMinQty(e.target.value)}
        data-low-stock-qty-input="true"
        className="w-20 rounded border border-line bg-canvas px-2 py-1"
      />
      <button
        type="button"
        onClick={() => void handleSave()}
        data-low-stock-save-btn="true"
        className="rounded bg-accent px-2.5 py-1 font-medium text-surface"
      >
        设置预警
      </button>
    </div>
  );
}

function LowStockBadge({
  item,
}: {
  readonly item: { readonly sku: string; readonly quantity: number };
}) {
  const thresholds = useThresholds();
  const matched = thresholds.find((t) => t.sku === item.sku);
  if (!matched || item.quantity > matched.minQty) return null;
  return (
    <span
      data-low-stock-alert={item.sku}
      className="rounded bg-danger/15 px-1.5 py-0.5 text-[11px] font-medium text-danger"
    >
      低库存预警 (≤{matched.minQty})
    </span>
  );
}

export const name = "inventory-low-stock";

export function apply(ctx: Context) {
  ctx.slots.register("inventory.list.banner", () => <LowStockBanner />);
  ctx.slots.register("inventory.item.badges", (props) => (
    <LowStockBadge item={props.item} />
  ));
}
`;

const LOW_STOCK_TEST = `
import assert from "node:assert/strict";
export default async function (ctx) {
  const saved = await ctx.request({
    method: "POST",
    path: "/api/app/inventory-low-stock/thresholds",
    body: { sku: "SKU-TEST", minQty: 5 },
  });
  assert.equal(saved.status, 201);
  const list = await ctx.request({
    method: "GET",
    path: "/api/app/inventory-low-stock/thresholds",
  });
  assert.equal(list.status, 200);
  assert.equal(list.body.thresholds.length, 1);
  assert.equal(list.body.thresholds[0].minQty, 5);
}
`;

// Step 2: inventory-stats route page plugin
const STATS_SERVER = `
import type { Context } from "cordis";
import "@host/server-sdk";

export const name = "inventory-stats";
export const inject = ["inventory"];

export function apply(ctx: Context) {
  ctx.http.route("GET", "/summary", () => {
    const items = ctx.inventory.list();
    let totalUnits = 0;
    for (const item of items) {
      totalUnits += item.quantity;
    }
    return { skuCount: items.length, totalUnits };
  });
}
`;

const STATS_CLIENT = `
import { useEffect, useState } from "react";
import type { Context } from "cordis";
import { useNavigate } from "@host/client-sdk";

function InventoryStatsPage() {
  const navigate = useNavigate();
  const [summary, setSummary] = useState<{ skuCount: number; totalUnits: number } | null>(null);

  useEffect(() => {
    void (async () => {
      const res = await fetch("/api/app/inventory-stats/summary");
      if (res.ok) {
        setSummary((await res.json()) as { skuCount: number; totalUnits: number });
      }
    })();
  }, []);

  return (
    <div data-inventory-stats-page="true" className="mx-auto max-w-4xl p-6 text-ink">
      <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
        <h1 className="text-lg font-semibold">库存统计</h1>
        <button
          type="button"
          data-stats-back-btn="true"
          onClick={() => navigate("/")}
          className="rounded border border-line bg-surface px-3 py-1.5 text-xs"
        >
          返回库存列表
        </button>
      </div>
      {summary ? (
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg border border-line bg-surface p-4" data-stats-sku-count="true">
            SKU 总数: {summary.skuCount}
          </div>
          <div className="rounded-lg border border-line bg-surface p-4" data-stats-total-units="true">
            总库存量: {summary.totalUnits}
          </div>
        </div>
      ) : (
        <div className="text-sm text-muted">加载统计中…</div>
      )}
    </div>
  );
}

export const name = "inventory-stats";

export function apply(ctx: Context) {
  ctx.router.registerPage({
    path: "/stats",
    navLabel: "库存统计",
    component: InventoryStatsPage,
  });
}
`;

const STATS_TEST = `
import assert from "node:assert/strict";
export default async function (ctx) {
  await ctx.request({
    method: "POST",
    path: "/api/app/inventory-core/items",
    body: { sku: "SKU-STAT", name: "统计测试品", quantity: 8 },
  });
  const res = await ctx.request({
    method: "GET",
    path: "/api/app/inventory-stats/summary",
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.skuCount, 1);
  assert.equal(res.body.totalUnits, 8);
}
`;

test.describe("V3 Second-Business Migration Acceptance (inventory-core, Zero Host Changes)", () => {
  test("runs 2-step self-iteration + disable/re-enable data preservation on inventory-core", async ({
    page,
  }) => {
    test.setTimeout(240_000);

    // Assert inventory-core contains zero Todo concepts
    const combinedSeed = `${INVENTORY_CORE_CONTRACT}\n${INVENTORY_CORE_SERVER}\n${INVENTORY_CORE_CLIENT}`;
    expect(combinedSeed.toLowerCase()).not.toContain("todo");
    expect(combinedSeed).not.toContain("待办");

    const dir = mkdtempSync(join(tmpdir(), "v3-inventory-e2e-"));
    const controlDbPath = join(dir, "supervisor.db");
    const businessDbPath = join(dir, "app.db");
    const assetsDir = await ensureV3ClientAssets();

    const release = new CompositionRelease({
      controlDbPath,
      businessDbPath,
      workDir: join(dir, "work"),
      clientAssetsDir: assetsDir,
      enablePreviewClientHost: true,
    });

    const inventoryCore = await buildPluginPackage({
      pluginId: "inventory-core",
      name: "Inventory Core",
      dependencies: [],
      contractTypes: INVENTORY_CORE_CONTRACT,
      serverSource: INVENTORY_CORE_SERVER,
      clientSource: INVENTORY_CORE_CLIENT,
      testFiles: {
        "inventory-core.contract.test.ts": INVENTORY_CORE_TEST,
      },
    });

    const initComp: CompositionSnapshot = {
      compositionId: "comp-inv-step0",
      parentCompositionId: null,
      members: [
        {
          pluginId: inventoryCore.pluginId,
          versionId: inventoryCore.versionId,
          enabled: true,
        },
      ],
      createdAt: new Date().toISOString(),
    };
    await release.bootstrap({
      composition: initComp,
      artifacts: [inventoryCore],
    });

    const steps: readonly EvolutionStepPlan[] = [
      {
        prompt: "Step 1: 新增低库存预警插件",
        stageArgs: {
          upserts: [
            {
              pluginId: "inventory-low-stock",
              name: "Inventory Low Stock",
              dependencies: ["inventory-core"],
              contractTypes: "",
              sourceFiles: {
                "server.ts": LOW_STOCK_SERVER,
                "client.tsx": LOW_STOCK_CLIENT,
              },
              testFiles: {
                "low-stock.contract.test.ts": LOW_STOCK_TEST,
              },
            },
          ],
        },
        summary: "Step 1: 新增低库存预警插件",
        highlights: ["支持按 SKU 设置低库存阈值", "库存不足时展示预警徽章"],
      },
      {
        prompt: "Step 2: 新增库存统计路由页插件",
        stageArgs: {
          upserts: [
            {
              pluginId: "inventory-stats",
              name: "Inventory Stats",
              dependencies: ["inventory-core"],
              contractTypes: "",
              sourceFiles: {
                "server.ts": STATS_SERVER,
                "client.tsx": STATS_CLIENT,
              },
              testFiles: {
                "stats.contract.test.ts": STATS_TEST,
              },
            },
          ],
        },
        summary: "Step 2: 新增库存统计路由页插件",
        highlights: ["新增 /stats 独立统计路由页", "实时汇总 SKU 总数与总库存量"],
      },
      {
        prompt: "Step 3: 停用低库存预警插件（保数据）",
        stageArgs: {
          toggles: [{ pluginId: "inventory-low-stock", enabled: false }],
        },
        summary: "Step 3: 停用低库存预警插件",
        highlights: ["双端热卸载预警插件", "预警阈值表数据零丢失"],
      },
      {
        prompt: "Step 4: 重新启用低库存预警插件",
        stageArgs: {
          toggles: [{ pluginId: "inventory-low-stock", enabled: true }],
        },
        summary: "Step 4: 重新启用低库存预警插件",
        highlights: ["双端热恢复预警插件", "历史预警阈值完整回归"],
      },
    ];

    const stubDriver = createStepStubDriver(steps, "inv");

    const loop = new EvolutionLoop({
      release,
      modelDriver: stubDriver,
    });
    release.setEvolutionController(loop);

    const server = await startV3HttpServer(release.runtime, {
      clientAssetsDir: assetsDir,
      enableClientHost: true,
      releaseController: release,
      evolutionController: loop,
    });
    release.setProductionUrl(server.url);

    try {
      // Step 0: Create item, stock in (+5 -> 15), stock out (-3 -> 12)
      await page.goto(server.url);
      await expect(page.locator("[data-inventory-workspace]")).toBeVisible({
        timeout: 15_000,
      });
      await page.locator("[data-inventory-sku-input]").fill("SKU-001");
      await page.locator("[data-inventory-name-input]").fill("机械键盘");
      await page.locator("[data-inventory-qty-input]").fill("10");
      await page.locator("[data-inventory-create-submit]").click();
      await expect(page.locator('[data-inventory-qty="SKU-001"]')).toContainText(
        "10 件",
      );

      await page.locator('[data-stock-in="SKU-001"]').click();
      await expect(page.locator('[data-inventory-qty="SKU-001"]')).toContainText(
        "15 件",
      );
      await page.locator('[data-stock-out="SKU-001"]').click();
      await expect(page.locator('[data-inventory-qty="SKU-001"]')).toContainText(
        "12 件",
      );

      // Step 1: Add inventory-low-stock
      await executeEvolutionStepInBrowser(
        page,
        server.url,
        steps[0]!.prompt,
        steps[0]!.summary,
      );
      await expect(page.locator("[data-low-stock-banner]")).toBeVisible({
        timeout: 10_000,
      });
      await page.locator("[data-low-stock-sku-input]").fill("SKU-001");
      await page.locator("[data-low-stock-qty-input]").fill("15");
      await page.locator("[data-low-stock-save-btn]").click();
      await expect(
        page.locator('[data-low-stock-alert="SKU-001"]'),
      ).toBeVisible({ timeout: 10_000 });

      // Step 2: Add inventory-stats route page
      await executeEvolutionStepInBrowser(
        page,
        server.url,
        steps[1]!.prompt,
        steps[1]!.summary,
      );
      await page.locator('[data-inventory-nav="/stats"]').click();
      await expect(page.locator("[data-inventory-stats-page]")).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.locator("[data-stats-sku-count]")).toContainText(
        "SKU 总数: 1",
      );
      await expect(page.locator("[data-stats-total-units]")).toContainText(
        "总库存量: 12",
      );
      await page.locator("[data-stats-back-btn]").click();
      await expect(page.locator("[data-inventory-workspace]")).toBeVisible();

      // Step 3: Disable inventory-low-stock (zero data loss)
      await executeEvolutionStepInBrowser(
        page,
        server.url,
        steps[2]!.prompt,
        steps[2]!.summary,
      );
      await expect(
        page.locator('[data-low-stock-alert="SKU-001"]'),
      ).toHaveCount(0);
      const dbDisabled = new DatabaseSync(businessDbPath, { readOnly: true });
      const thresholdRows = dbDisabled
        .prepare("SELECT sku, min_qty FROM plg_inventory_low_stock__thresholds")
        .all() as Array<{ sku: string; min_qty: number }>;
      dbDisabled.close();
      expect(thresholdRows).toEqual([{ sku: "SKU-001", min_qty: 15 }]);

      // Step 4: Re-enable inventory-low-stock (alert restored)
      await executeEvolutionStepInBrowser(
        page,
        server.url,
        steps[3]!.prompt,
        steps[3]!.summary,
      );
      await expect(
        page.locator('[data-low-stock-alert="SKU-001"]'),
      ).toBeVisible({ timeout: 10_000 });
    } finally {
      await loop.close();
      await server.close();
      await release.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
