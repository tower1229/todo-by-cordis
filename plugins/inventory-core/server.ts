import { Service, type Context } from "cordis";
import type { ScopedDb } from "@host/server-sdk";
import type {
  CreateInventoryItemInput,
  InventoryItem,
  InventoryService,
} from "./contract.d.ts";

interface InventoryRow {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unit: string;
  readonly created_at: string;
  readonly updated_at: string;
}

function toInventoryItem(row: InventoryRow): InventoryItem {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    quantity: Number(row.quantity),
    unit: row.unit,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function httpError(
  status: number,
  message: string,
): Error & { status: number } {
  const error = new Error(message) as Error & { status: number };
  error.status = status;
  return error;
}

export default class InventoryCoreService
  extends Service
  implements InventoryService
{
  private readonly db: ScopedDb;

  constructor(ctx: Context) {
    super(ctx, "inventory");
    this.db = ctx.db;

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS plg_inventory_core__items (
        id TEXT PRIMARY KEY,
        sku TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL DEFAULT 0,
        unit TEXT NOT NULL DEFAULT '件',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    ctx.http.route("GET", "/items", () => {
      return { items: this.list() };
    });

    ctx.http.route("POST", "/items", (req) => {
      const body = (req.body ?? {}) as {
        sku?: unknown;
        name?: unknown;
        quantity?: unknown;
        unit?: unknown;
      };
      if (typeof body.sku !== "string" || body.sku.trim().length === 0) {
        return { status: 400, body: { error: "SKU is required" } };
      }
      if (typeof body.name !== "string" || body.name.trim().length === 0) {
        return { status: 400, body: { error: "Product name is required" } };
      }
      const quantity =
        typeof body.quantity === "number" && Number.isFinite(body.quantity)
          ? Math.trunc(body.quantity)
          : 0;
      if (quantity < 0) {
        return { status: 400, body: { error: "Initial quantity must be >= 0" } };
      }
      try {
        const item = this.create({
          sku: body.sku,
          name: body.name,
          quantity,
          unit:
            typeof body.unit === "string" && body.unit.trim().length > 0
              ? body.unit.trim()
              : "件",
        });
        return { status: 201, body: { item } };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: 400, body: { error: message } };
      }
    });

    ctx.http.route("GET", "/items/:id", (req) => {
      const item = this.get(req.params.id);
      if (!item) {
        return { status: 404, body: { error: "Inventory item not found" } };
      }
      return { item };
    });

    ctx.http.route("POST", "/items/:id/stock", async (req) => {
      const body = (req.body ?? {}) as {
        delta?: unknown;
        reason?: unknown;
      };
      if (
        typeof body.delta !== "number" ||
        !Number.isFinite(body.delta) ||
        body.delta === 0
      ) {
        return {
          status: 400,
          body: { error: "Stock delta must be a non-zero number" },
        };
      }
      try {
        const item = await this.adjustStock(
          req.params.id,
          Math.trunc(body.delta),
          typeof body.reason === "string" ? body.reason : undefined,
        );
        return { item };
      } catch (err) {
        const status =
          typeof (err as { status?: unknown })?.status === "number"
            ? (err as { status: number }).status
            : 400;
        const message = err instanceof Error ? err.message : String(err);
        return { status, body: { error: message } };
      }
    });
  }

  list(): InventoryItem[] {
    const rows = this.db
      .prepare(
        `SELECT id, sku, name, quantity, unit, created_at, updated_at
         FROM plg_inventory_core__items
         ORDER BY created_at ASC, id ASC`,
      )
      .all<InventoryRow>();
    return rows.map(toInventoryItem);
  }

  get(id: string): InventoryItem | null {
    const row = this.db
      .prepare(
        `SELECT id, sku, name, quantity, unit, created_at, updated_at
         FROM plg_inventory_core__items
         WHERE id = ?`,
      )
      .get<InventoryRow>(id);
    return row ? toInventoryItem(row) : null;
  }

  create(input: CreateInventoryItemInput): InventoryItem {
    const sku = input.sku.trim();
    const name = input.name.trim();
    if (!sku) throw httpError(400, "SKU is required");
    if (!name) throw httpError(400, "Product name is required");
    const quantity = Math.max(0, Math.trunc(input.quantity ?? 0));
    const unit = (input.unit ?? "件").trim() || "件";
    const id = `inv_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO plg_inventory_core__items (id, sku, name, quantity, unit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, sku, name, quantity, unit, now, now);
    const created = this.get(id)!;
    this.ctx.emit("inventory:changed", created);
    return created;
  }

  async adjustStock(
    id: string,
    delta: number,
    reason?: string,
  ): Promise<InventoryItem> {
    const existing = this.get(id);
    if (!existing) {
      throw httpError(404, `Inventory item not found: ${id}`);
    }
    const nextQuantity = existing.quantity + delta;
    if (nextQuantity < 0) {
      throw httpError(
        409,
        `Insufficient stock for ${existing.sku}: current ${existing.quantity}, delta ${delta}`,
      );
    }

    const verdict = await this.ctx.serial("inventory:before-stock-change", {
      item: existing,
      delta,
      nextQuantity,
      reason,
    });
    if (verdict === false) {
      throw httpError(400, "Stock change blocked by extension rule");
    }
    if (typeof verdict === "string" && verdict.length > 0) {
      throw httpError(400, verdict);
    }

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE plg_inventory_core__items
         SET quantity = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(nextQuantity, now, id);
    const updated = this.get(id)!;
    this.ctx.emit("inventory:changed", updated);
    return updated;
  }
}
