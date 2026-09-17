import { api, errorMessage, sendCommand, sendOperation } from "./api.js";
import type { ExperienceSessionView } from "../shared/assistant.js";
import type { ExperienceSessionSnapshot } from "../server/experience-session.js";
import type { CommandResult } from "../shared/contracts.js";

export const experienceSessionStorageKey = "cordis-experience-session";

export type StoredExperienceSession = {
  sessionId: string;
  runId: string;
};

export type ExperienceReadResult =
  | ExperienceSessionSnapshot
  | { status: "none" }
  | (ExperienceSessionView & { status: "invalid" });

export function isExperienceSnapshot(
  value: ExperienceReadResult,
): value is ExperienceSessionSnapshot {
  return (
    value.status === "active" &&
    "composition" in value &&
    "task" in value &&
    value.composition !== undefined &&
    value.task !== undefined
  );
}

export function isExperienceGone(
  value: ExperienceReadResult,
): value is { status: "none" } | (ExperienceSessionView & { status: "invalid" }) {
  return value.status === "none" || value.status === "invalid";
}

export function readStoredExperienceSession(): StoredExperienceSession | null {
  try {
    const raw = localStorage.getItem(experienceSessionStorageKey);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      "sessionId" in parsed &&
      "runId" in parsed &&
      typeof (parsed as StoredExperienceSession).sessionId === "string" &&
      typeof (parsed as StoredExperienceSession).runId === "string"
    )
      return parsed as StoredExperienceSession;
    // Legacy: bare session id string
    if (typeof parsed === "string" && parsed)
      return { sessionId: parsed, runId: "" };
    if (typeof raw === "string" && raw && !raw.startsWith("{"))
      return { sessionId: raw, runId: "" };
  } catch {
    // ignore
  }
  return null;
}

export function writeStoredExperienceSession(session: StoredExperienceSession) {
  localStorage.setItem(experienceSessionStorageKey, JSON.stringify(session));
}

export function clearStoredExperienceSession() {
  localStorage.removeItem(experienceSessionStorageKey);
}

export function experienceGoneError(
  result: ExperienceReadResult,
  hadLocalSession: boolean,
): Error {
  if (result.status === "invalid")
    return Object.assign(
      new Error(result.note ?? "体验会话已失效，请重新打开体验"),
      { code: "EXPERIENCE_STALE" },
    );
  return Object.assign(
    new Error(
      hadLocalSession
        ? "宿主重启后体验会话已失效，请重新打开体验"
        : "体验会话已结束",
    ),
    { code: "EXPERIENCE_SESSION" },
  );
}

export async function readExperienceSession(input?: {
  sessionId?: string;
  runId?: string;
}) {
  const query = new URLSearchParams();
  if (input?.sessionId) query.set("sessionId", input.sessionId);
  if (input?.runId) query.set("runId", input.runId);
  const suffix = query.size ? `?${query}` : "";
  return api<ExperienceReadResult>(`/experience${suffix}`);
}

export function sendExperienceCommand(
  sessionId: string,
  command: object,
) {
  return sendOperation<CommandResult>("/experience/commands", {
    sessionId,
    ...command,
  });
}

export function dispatchWorkspaceCommand(
  experienceSessionId: string | undefined,
  payload: Parameters<typeof sendCommand>[0],
) {
  if (experienceSessionId)
    return sendExperienceCommand(experienceSessionId, payload);
  return sendCommand(payload);
}

export async function endExperienceSession(sessionId: string) {
  return api<{ ok: true }>("/experience/end", { sessionId });
}

export { errorMessage };

export type ExperienceClient = {
  sessionId: string;
  refresh: () => Promise<ExperienceSessionSnapshot>;
  sendCommand: (command: object) => Promise<CommandResult>;
  end: () => Promise<void>;
};

export function experienceClient(sessionId: string): ExperienceClient {
  return {
    sessionId,
    refresh: async () => {
      const snapshot = await readExperienceSession({ sessionId });
      if (isExperienceGone(snapshot))
        throw experienceGoneError(snapshot, true);
      if (!isExperienceSnapshot(snapshot))
        throw experienceGoneError({ status: "none" }, true);
      return snapshot;
    },
    sendCommand: (command) => sendExperienceCommand(sessionId, command),
    end: async () => {
      await endExperienceSession(sessionId);
    },
  };
}
