import { api, errorMessage, sendOperation } from "./api.js";
import type { ExperienceSessionView } from "../shared/assistant.js";
import type { ExperienceSessionSnapshot } from "../server/experience-session.js";
import type { CommandResult } from "../shared/contracts.js";

export async function readExperienceSession(input?: {
  sessionId?: string;
  runId?: string;
}) {
  const query = new URLSearchParams();
  if (input?.sessionId) query.set("sessionId", input.sessionId);
  if (input?.runId) query.set("runId", input.runId);
  const suffix = query.size ? `?${query}` : "";
  return api<
    | ExperienceSessionSnapshot
    | { status: "none" }
    | (ExperienceSessionView & { status: "invalid" })
  >(`/experience${suffix}`);
}

export function sendExperienceCommand(
  sessionId: string,
  command: Omit<Parameters<typeof sendOperation>[1], "sessionId">,
) {
  return sendOperation<CommandResult>("/experience/commands", {
    sessionId,
    ...command,
  });
}

export async function endExperienceSession(sessionId: string) {
  return api<{ ok: true }>("/experience/end", { sessionId });
}

export { errorMessage };

export type ExperienceClient = {
  sessionId: string;
  refresh: () => Promise<ExperienceSessionSnapshot>;
  sendCommand: (
    command: Omit<Parameters<typeof sendOperation>[1], "sessionId">,
  ) => Promise<CommandResult>;
  end: () => Promise<void>;
};

export function experienceClient(sessionId: string): ExperienceClient {
  return {
    sessionId,
    refresh: async () => {
      const snapshot = await readExperienceSession({ sessionId });
      if ("status" in snapshot && snapshot.status !== undefined)
        throw Object.assign(new Error("体验会话已结束或失效"), {
          code: "EXPERIENCE_SESSION",
        });
      return snapshot as ExperienceSessionSnapshot;
    },
    sendCommand: (command) => sendExperienceCommand(sessionId, command),
    end: async () => {
      await endExperienceSession(sessionId);
    },
  };
}
