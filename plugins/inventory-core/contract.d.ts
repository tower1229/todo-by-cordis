import type {} from "cordis";

export interface InventoryItem {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly quantity: number;
  readonly unit: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateInventoryItemInput {
  readonly sku: string;
  readonly name: string;
  readonly quantity?: number;
  readonly unit?: string;
}

export interface BeforeStockChangePayload {
  readonly item: InventoryItem;
  readonly delta: number;
  readonly nextQuantity: number;
  readonly reason?: string;
}

export interface InventoryService {
  list(): InventoryItem[];
  get(id: string): InventoryItem | null;
  create(input: CreateInventoryItemInput): InventoryItem;
  adjustStock(
    id: string,
    delta: number,
    reason?: string,
  ): Promise<InventoryItem>;
}

declare module "cordis" {
  interface Context {
    inventory: InventoryService;
  }
  interface Events {
    "inventory:before-stock-change"(
      payload: BeforeStockChangePayload,
    ): Promise<void | false | string> | void | false | string;
    "inventory:changed"(item: InventoryItem): void;
  }
}

export interface InventoryListSlotContext {
  readonly items: readonly InventoryItem[];
  readonly refresh: () => Promise<void>;
}

export interface InventoryItemSlotContext {
  readonly item: InventoryItem;
  readonly refresh: () => Promise<void>;
}

declare module "@host/client-sdk" {
  interface SlotPropsMap {
    "inventory.header.actions": InventoryListSlotContext;
    "inventory.list.banner": InventoryListSlotContext;
    "inventory.item.badges": InventoryItemSlotContext;
    "inventory.item.detail": InventoryItemSlotContext;
  }
}
