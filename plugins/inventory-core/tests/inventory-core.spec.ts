import assert from "node:assert/strict";
import type { PluginTestContext } from "@host/server-sdk";

export default async function (ctx: PluginTestContext): Promise<void> {
  const created = await ctx.request({
    method: "POST",
    path: "/api/app/inventory-core/items",
    body: { sku: "CONTRACT-SKU", name: "测试商品", quantity: 10 },
  });
  assert.equal(created.status, 201);
  const id = (created.body as { item: { id: string } }).item.id;

  const stocked = await ctx.request({
    method: "POST",
    path: `/api/app/inventory-core/items/${id}/stock`,
    body: { delta: -4 },
  });
  assert.equal(stocked.status, 200);
  assert.equal((stocked.body as { item: { quantity: number } }).item.quantity, 6);
}
