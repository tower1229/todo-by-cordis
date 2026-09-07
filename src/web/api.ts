import type { Command, CommandResult } from "../shared/contracts.js";

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "操作失败，请重试";
}
export function readStored<T>(
  key: string,
  fallback: T,
  valid: (value: unknown) => value is T,
): T {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    return valid(value) ? value : fallback;
  } catch {
    return fallback;
  }
}
export function isStringRecord(
  value: unknown,
): value is Record<string, string> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    signal: AbortSignal.timeout(15000),
    ...(body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.message ?? "连接失败，请重试"), {
      code: data.code,
    });
  return data;
}

// A lost response reuses the operation ID. A definitive server rejection allows
// a fresh attempt; a refresh failure after a successful write never replays it.
export async function sendOperation<T>(
  path: string,
  command: object,
): Promise<T> {
  const key = JSON.stringify({ path, command });
  const storage = "cordis-pending";
  const pending = readStored(storage, {}, isStringRecord);
  const operationId = pending[key] ?? crypto.randomUUID();
  pending[key] = operationId;
  localStorage.setItem(storage, JSON.stringify(pending));
  const clear = () => {
    const current = readStored(storage, {}, isStringRecord);
    delete current[key];
    localStorage.setItem(storage, JSON.stringify(current));
  };
  try {
    const result = await api<T>(path, { ...command, operationId });
    clear();
    return result;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code) clear();
    throw error;
  }
}
export function sendCommand(command: Omit<Command, "operationId">) {
  return sendOperation<CommandResult>("/commands", command);
}
