import type { Command, CommandResult } from "../shared/contracts.js";
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(
    `/api${path}`,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(new Error(data.message ?? "连接失败，请重试"), {
      code: data.code,
    });
  return data;
}
export async function sendCommand(
  command: Omit<Command, "operationId">,
): Promise<CommandResult> {
  const key = JSON.stringify(command);
  const pending = JSON.parse(localStorage.getItem("cordis-pending") ?? "{}");
  const operationId = pending[key] ?? crypto.randomUUID();
  pending[key] = operationId;
  localStorage.setItem("cordis-pending", JSON.stringify(pending));
  const clearPending = () => {
    const current = JSON.parse(localStorage.getItem("cordis-pending") ?? "{}");
    delete current[key];
    localStorage.setItem("cordis-pending", JSON.stringify(current));
  };
  try {
    const result = await api<CommandResult>("/commands", {
      ...command,
      operationId,
    });
    clearPending();
    return result;
  } catch (error: any) {
    if (error.code) {
      clearPending();
    }
    throw error;
  }
}
