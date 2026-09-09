import type {
  ExtensionContribution,
  ResolvedUiContribution,
  UiSlotRegistration,
} from "../business/contracts.js";

export const HOST_UI_SLOTS = ["task.detail"] as const;
export type HostUiSlot = (typeof HOST_UI_SLOTS)[number];

export type InvalidUiContribution = {
  id: string;
  slot?: string;
  reason: string;
  providerId: string;
};

function isHostSlot(slot: string): slot is HostUiSlot {
  return (HOST_UI_SLOTS as readonly string[]).includes(slot);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function resolveUiContributions(
  contribution: ExtensionContribution,
  knownCommandIds: ReadonlySet<string>,
  providerId: string,
): { valid: ResolvedUiContribution[]; invalid: InvalidUiContribution[] } {
  const valid: ResolvedUiContribution[] = [];
  const invalid: InvalidUiContribution[] = [];
  for (const slot of contribution.uiSlots ?? []) {
    const result = resolveOne(slot, knownCommandIds, providerId);
    if (result.ok) valid.push(result.value);
    else invalid.push(result.value);
  }
  return { valid, invalid };
}

function resolveOne(
  slot: UiSlotRegistration,
  knownCommandIds: ReadonlySet<string>,
  providerId: string,
):
  | { ok: true; value: ResolvedUiContribution }
  | { ok: false; value: InvalidUiContribution } {
  const id = text(slot.id);
  if (!id)
    return {
      ok: false,
      value: {
        id: String(slot.id ?? ""),
        slot: slot.slot,
        reason: "缺少 id",
        providerId,
      },
    };
  if (!isHostSlot(slot.slot))
    return {
      ok: false,
      value: {
        id,
        slot: slot.slot,
        reason: `未知槽位：${slot.slot}`,
        providerId,
      },
    };
  const title = text(slot.title);
  if (!title)
    return {
      ok: false,
      value: { id, slot: slot.slot, reason: "缺少 title", providerId },
    };
  const actions: Array<{ commandId: string; label: string }> = [];
  for (const action of slot.actions ?? []) {
    const commandId = text(action?.commandId);
    const label = text(action?.label);
    if (!commandId || !label)
      return {
        ok: false,
        value: { id, slot: slot.slot, reason: "动作缺必填", providerId },
      };
    if (!knownCommandIds.has(commandId))
      return {
        ok: false,
        value: {
          id,
          slot: slot.slot,
          reason: `未知命令：${commandId}`,
          providerId,
        },
      };
    actions.push({ commandId, label });
  }
  const fields: Array<{ key: string; label: string }> = [];
  for (const field of slot.fields ?? []) {
    const key = text(field?.key);
    const label = text(field?.label);
    if (!key || !label)
      return {
        ok: false,
        value: { id, slot: slot.slot, reason: "字段缺必填", providerId },
      };
    fields.push({ key, label });
  }
  const body = text(slot.body);
  return {
    ok: true,
    value: {
      id,
      slot: slot.slot,
      title,
      ...(body ? { body } : {}),
      actions,
      fields,
      providerId,
    },
  };
}
