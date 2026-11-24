import { useCallback, useEffect, useState, type FormEvent } from "react";
import type { Context } from "cordis";
import {
  Slot,
  dispatchClientBail,
  useClientContext,
  useClientRoutes,
  useNavigate,
} from "@host/client-sdk";
import type { InventoryItem } from "./contract.d.ts";

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!response.ok) {
    const message =
      typeof data.error === "string" && data.error.length > 0
        ? data.error
        : `请求失败 (${response.status})`;
    throw new Error(message);
  }
  return data as T;
}

function InventoryWorkspacePage() {
  const clientCtx = useClientContext();
  const routes = useClientRoutes();
  const navigate = useNavigate();

  const [items, setItems] = useState<InventoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [sku, setSku] = useState("");
  const [name, setName] = useState("");
  const [quantity, setQuantity] = useState("10");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    try {
      const data = await requestJson<{ items: InventoryItem[] }>(
        "/api/app/inventory-core/items",
      );
      setItems(data.items ?? []);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreate = async (event: FormEvent) => {
    event.preventDefault();
    if (!sku.trim() || !name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      await requestJson<{ item: InventoryItem }>(
        "/api/app/inventory-core/items",
        {
          method: "POST",
          body: JSON.stringify({
            sku: sku.trim(),
            name: name.trim(),
            quantity: Number(quantity) || 0,
          }),
        },
      );
      setSku("");
      setName("");
      setQuantity("10");
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleAdjust = async (item: InventoryItem, delta: number) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const nextQuantity = item.quantity + delta;
      const verdict = await dispatchClientBail(
        clientCtx,
        "inventory:before-stock-change",
        { item, delta, nextQuantity },
      );
      if (verdict === false) {
        setError("库存变动已被扩展规则阻止");
        return;
      }
      if (typeof verdict === "string" && verdict.length > 0) {
        setError(verdict);
        return;
      }
      await requestJson<{ item: InventoryItem }>(
        `/api/app/inventory-core/items/${encodeURIComponent(item.id)}/stock`,
        {
          method: "POST",
          body: JSON.stringify({ delta }),
        },
      );
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const extraRoutes = routes.filter((route) => route.path !== "/");
  const listSlotProps = { items, refresh };

  return (
    <div
      data-inventory-workspace="true"
      className="mx-auto max-w-4xl p-6 text-ink"
    >
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-line pb-3">
        <div>
          <h1 className="text-lg font-semibold">库存管理</h1>
          <p className="text-xs text-muted">商品 SKU 库存台账与出入库操作</p>
        </div>
        <div className="flex items-center gap-2">
          {extraRoutes.map((route) => (
            <button
              key={route.path}
              type="button"
              data-inventory-nav={route.path}
              onClick={() => navigate(route.path)}
              className="rounded-md border border-line bg-surface px-3 py-1.5 text-xs font-medium text-ink hover:bg-canvas"
            >
              {route.navLabel}
            </button>
          ))}
          <Slot name="inventory.header.actions" props={listSlotProps} />
        </div>
      </header>

      <Slot name="inventory.list.banner" props={listSlotProps} />

      {error && (
        <div
          role="alert"
          data-inventory-error="true"
          className="mb-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger"
        >
          {error}
        </div>
      )}

      <form
        onSubmit={(e) => void handleCreate(e)}
        data-inventory-create-form="true"
        className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-line bg-surface p-3"
      >
        <input
          type="text"
          value={sku}
          onChange={(e) => setSku(e.target.value)}
          placeholder="SKU 编码"
          data-inventory-sku-input="true"
          className="w-32 rounded border border-line bg-canvas px-2.5 py-1.5 text-sm"
        />
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="商品名称"
          data-inventory-name-input="true"
          className="min-w-40 flex-1 rounded border border-line bg-canvas px-2.5 py-1.5 text-sm"
        />
        <input
          type="number"
          min={0}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          placeholder="初始库存"
          data-inventory-qty-input="true"
          className="w-24 rounded border border-line bg-canvas px-2.5 py-1.5 text-sm"
        />
        <button
          type="submit"
          disabled={busy}
          data-inventory-create-submit="true"
          className="rounded-md bg-accent px-3.5 py-1.5 text-sm font-medium text-surface hover:bg-accent/90 disabled:opacity-50"
        >
          新增商品
        </button>
      </form>

      {loading ? (
        <div className="py-8 text-center text-sm text-muted">加载库存中…</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line py-8 text-center text-sm text-muted">
          暂无商品库存记录
        </div>
      ) : (
        <ul className="space-y-2" data-inventory-list="true">
          {items.map((item) => (
            <li
              key={item.id}
              data-inventory-item={item.sku}
              className="rounded-lg border border-line bg-surface p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="rounded bg-canvas px-2 py-0.5 font-mono text-xs text-muted">
                    {item.sku}
                  </span>
                  <span className="text-sm font-medium">{item.name}</span>
                  <Slot
                    name="inventory.item.badges"
                    props={{ item, refresh }}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <span
                    data-inventory-qty={item.sku}
                    className="font-mono text-sm font-semibold"
                  >
                    {item.quantity} {item.unit}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    data-stock-in={item.sku}
                    onClick={() => void handleAdjust(item, 5)}
                    className="rounded border border-line bg-canvas px-2.5 py-1 text-xs font-medium hover:bg-line/40"
                  >
                    入库 +5
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    data-stock-out={item.sku}
                    onClick={() => void handleAdjust(item, -3)}
                    className="rounded border border-line bg-canvas px-2.5 py-1 text-xs font-medium hover:bg-line/40"
                  >
                    出库 -3
                  </button>
                </div>
              </div>
              <Slot name="inventory.item.detail" props={{ item, refresh }} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const name = "inventory-core";

export function apply(ctx: Context) {
  ctx.router.registerPage({
    path: "/",
    navLabel: "库存",
    component: InventoryWorkspacePage,
  });
}
